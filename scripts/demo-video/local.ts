// The local recording server for the demo video: the built game (apps/server/dist) on its own port,
// on a LOCAL COPY of the database (its name must contain "demo"), with no chain keys (settlements are
// a no-op) and no model keys (agents on their rule strategies, no credits spent), DEMO_MODE=1 on
// loopback (the demo session) and never production. Only this run's own child process is started
// and stopped here.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));

export interface LocalServer {
  url: string;
  port: number;
  stop(): Promise<void>;
}

/** The demo database URL, refusing anything that is not a local database named for the demo. */
export function demoDatabase(url = process.env.DEMO_DATABASE_URL ?? `postgres://${process.env.USER ?? 'postgres'}@127.0.0.1:5432/coys_demo`): string {
  const m = /^postgres(?:ql)?:\/\/(?:[^@/]*@)?([^/:]*)(?::\d+)?\/([^?]+)/.exec(url);
  if (!m || !/demo/.test(m[2] ?? '') || !['', 'localhost', '127.0.0.1'].includes(m[1] ?? '')) {
    throw new Error('the demo database must be a local database whose name contains "demo"');
  }
  return url;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const p = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(p));
    });
  });
}

/** Starts the local server; daySeconds shortens the in-game day (the warm-up), else the real 180 s. */
export async function startLocal(opts: { daySeconds?: number; log?: (line: string) => void } = {}): Promise<LocalServer> {
  const port = await freePort();
  // a clean environment: nothing from this shell (no chain or model keys) reaches the server
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    PORT: String(port),
    HOST: '127.0.0.1',
    DATABASE_URL: demoDatabase(),
    DEMO_MODE: '1',
    SETTLE_EVERY_DAYS: '10',
  };
  if (opts.daySeconds) env.DEMO_DAY_SECONDS = String(opts.daySeconds);
  const child: ChildProcess = spawn(process.execPath, ['apps/server/dist/main.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines: string[] = [];
  const onData = (d: Buffer) => {
    for (const l of String(d).split('\n')) {
      if (!l.trim()) continue;
      lines.push(l);
      opts.log?.(l);
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`${url}/healthz`);
      if (r.ok) {
        const cfg = (await (await fetch(`${url}/api/config`)).json()) as { demoSession?: boolean };
        if (!cfg.demoSession) throw new Error('the local server did not turn the demo session on');
        const h = (await r.json()) as { settlement?: string };
        if (h.settlement !== 'noop') throw new Error('the local server would write to the chain');
        return {
          url,
          port,
          stop: () =>
            new Promise((resolve) => {
              if (child.exitCode !== null) return resolve();
              child.once('exit', () => resolve());
              child.kill('SIGTERM');
              setTimeout(() => child.kill('SIGKILL'), 8000).unref();
            }),
        };
      }
    } catch (err) {
      if (err instanceof Error && /demo session|write to the chain/.test(err.message)) {
        child.kill('SIGTERM');
        throw err;
      }
    }
    if (child.exitCode !== null) throw new Error(`the local server exited: ${lines.slice(-5).join(' | ')}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill('SIGTERM');
  throw new Error('the local server did not start');
}
