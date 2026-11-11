// HTTP API, WebSocket game protocol and (in production) the built client, on one port.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { PROTOCOL_VERSION, parseClientMessage, type ServerMessage } from '@coys/shared';
import { BUILD } from '../build-info';
import type { PrivyVerifier } from '../auth/privy';
import type { SessionSigner } from '../auth/session';
import type { ActionResult, Game } from '../game/game';
import { RateLimiter } from './ratelimit';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The visitor's address, for rate limits. Behind a Cloudflare tunnel every request reaches the server
 * from loopback, so only then does CF-Connecting-IP name the visitor; from anywhere else it is ignored.
 */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  const header = req.headers['cf-connecting-ip'];
  const forwarded = typeof header === 'string' ? header.trim() : '';
  return LOOPBACK.has(remote) && isIP(forwarded) ? forwarded : remote;
}

export interface GameServerOptions {
  game: Game;
  sessions: SessionSigner;
  privy: PrivyVerifier | null;
  privyAppId: string | null;
  devLogin: boolean;
  clientDist: string | null;
  settlementMode: string;
  dbKind: string;
  /** Round trip to the database for /healthz. */
  pingDb?: () => Promise<unknown>;
  log?: (line: string) => void;
}

export interface HealthReport {
  ok: boolean;
  version: string;
  commit: string | null;
  season: string;
  day: number;
  db: { kind: string; ok: boolean; ms: number };
  settlement: string;
  uptimeS: number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

const displayName = z
  .string()
  .max(40)
  .transform((s) => s.replace(/[^\p{L}\p{N} '-]/gu, '').trim().slice(0, 20) || 'Farmer');
const devLoginBody = z.object({ name: displayName, deviceId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/) }).strict();
const privyLoginBody = z.object({ accessToken: z.string().min(20).max(4096), name: displayName.optional() }).strict();

export function createGameServer(opts: GameServerOptions): Server {
  const log = opts.log ?? ((line: string) => console.log(line));
  const { game, sessions } = opts;
  const loginLimiter = new RateLimiter(10, 1);
  const actionLimiter = new RateLimiter(12, 6);
  const connections = new Map<string, WebSocket>();
  const recentRids = new Map<string, Map<string, ActionResult>>();

  const send = (ws: WebSocket, msg: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  game.on(({ playerId, msg }) => {
    if (playerId === null) for (const ws of connections.values()) send(ws, msg);
    else {
      const ws = connections.get(playerId);
      if (ws) send(ws, msg);
    }
  });

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolveBody, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 8192) {
          reject(new Error('body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          reject(new Error('body is not JSON'));
        }
      });
      req.on('error', reject);
    });

  const health = async (): Promise<HealthReport> => {
    const started = Date.now();
    let ok = true;
    if (opts.pingDb) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([opts.pingDb(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), 3000)))]);
      } catch {
        ok = false;
      } finally {
        clearTimeout(timer);
      }
    }
    return {
      ok,
      version: BUILD.version,
      commit: BUILD.commit,
      season: game.season,
      day: game.getClock().day,
      db: { kind: opts.dbKind, ok, ms: Date.now() - started },
      settlement: opts.settlementMode,
      uptimeS: Math.round(process.uptime()),
    };
  };

  const issue = (res: ServerResponse, who: { playerId: string; name: string }): void =>
    json(res, 200, { session: sessions.sign(who.playerId), playerId: who.playerId, name: who.name });

  const serveStatic = (req: IncomingMessage, res: ServerResponse, path: string): boolean => {
    // normalised, so the containment check below holds for any spelling of the path
    const root = opts.clientDist ? resolve(opts.clientDist) : null;
    if (!root || !existsSync(root) || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    let file = join(root, rel);
    if (!file.startsWith(root + sep) && file !== root) return false;
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    if (!existsSync(file)) return false;
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    const served = relative(root, file).split(sep).join('/');
    // content-hashed names never change: cache them for a year; the rest is checked every time
    const hashed = served.startsWith('build/') || served.startsWith('assets/derived/');
    const packed = served.startsWith('assets/') && !served.endsWith('index.json');
    const headers: Record<string, string> = {
      'content-type': type,
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : packed ? 'public, max-age=86400' : 'no-cache',
      'x-content-type-options': 'nosniff',
      vary: 'Accept-Encoding',
    };
    // precompressed at build (scripts/compress-dist.mjs): brotli, else gzip, else the file itself
    const accepts = String(req.headers['accept-encoding'] ?? '');
    let body = file;
    for (const [enc, ext] of [['br', '.br'], ['gzip', '.gz']] as const) {
      if (new RegExp(`\\b${enc}\\b`).test(accepts) && existsSync(file + ext)) {
        body = file + ext;
        headers['content-encoding'] = enc;
        break;
      }
    }
    headers['content-length'] = String(statSync(body).size);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else createReadStream(body).pipe(res);
    return true;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const ip = clientIp(req);
      try {
        // the host's health check: version, season and a database round trip (503 when the database is down)
        if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/api/health')) {
          const report = await health();
          return json(res, report.ok ? 200 : 503, report);
        }
        if (req.method === 'GET' && url.pathname === '/api/config') {
          return json(res, 200, { protocol: PROTOCOL_VERSION, privyAppId: opts.privyAppId, devLogin: opts.devLogin });
        }
        if (req.method === 'GET' && url.pathname === '/api/market') {
          return json(res, 200, { market: await game.getMarketState(), clock: game.getClock() });
        }
        if (req.method === 'POST' && url.pathname === '/api/login/dev') {
          if (!opts.devLogin) return json(res, 403, { error: 'dev login is off' });
          if (!loginLimiter.take(ip)) return json(res, 429, { error: 'rate_limited' });
          const body = devLoginBody.safeParse(await readBody(req));
          if (!body.success) return json(res, 400, { error: 'bad_request' });
          const who = await game.ensurePlayer('dev', body.data.deviceId, body.data.name);
          if (who.created) log(`[login] dev player ${who.playerId} joined`);
          return issue(res, who);
        }
        if (req.method === 'POST' && url.pathname === '/api/login/privy') {
          if (!opts.privy) return json(res, 403, { error: 'Privy login is not configured' });
          if (!loginLimiter.take(ip)) return json(res, 429, { error: 'rate_limited' });
          const body = privyLoginBody.safeParse(await readBody(req));
          if (!body.success) return json(res, 400, { error: 'bad_request' });
          let did: string;
          try {
            did = (await opts.privy.verify(body.data.accessToken)).did;
          } catch {
            return json(res, 401, { error: 'unauthenticated' });
          }
          const who = await game.ensurePlayer('privy', did, body.data.name ?? 'Farmer');
          if (who.created) log(`[login] privy player ${who.playerId} joined`);
          return issue(res, who);
        }
        if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not_found' });
        if (serveStatic(req, res, url.pathname)) return;
        json(res, 404, { error: 'not_found' });
      } catch (err) {
        log(`[http] ${req.method} ${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) json(res, 500, { error: 'server_error' });
      }
    })();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket & { alive?: boolean }) => {
    let playerId: string | null = null;
    let strikes = 0;
    ws.alive = true;
    ws.on('pong', () => {
      ws.alive = true;
    });
    const strike = (): void => {
      if (++strikes > 20) ws.close(4400, 'too many bad messages');
    };

    ws.on('message', (data) => {
      void (async () => {
        let raw: unknown;
        try {
          raw = JSON.parse(data.toString());
        } catch {
          strike();
          return send(ws, { t: 'error', code: 'bad_message', message: 'not JSON' });
        }
        const parsed = parseClientMessage(raw);
        if (!parsed.ok) {
          strike();
          const rid = typeof (raw as { rid?: unknown })?.rid === 'string' ? (raw as { rid: string }).rid.slice(0, 40) : null;
          return send(ws, rid ? { t: 'ack', rid, ok: false, code: 'bad_message', message: parsed.error } : { t: 'error', code: 'bad_message', message: parsed.error });
        }
        const msg = parsed.msg;
        if (msg.t === 'ping') return send(ws, { t: 'pong', n: msg.n, serverNow: Date.now() });
        if (msg.t === 'hello') {
          const id = sessions.verify(msg.session);
          const info = id ? await game.playerInfo(id) : null;
          if (!id || !info) {
            send(ws, { t: 'error', code: 'unauthenticated', message: 'session expired, log in again' });
            return ws.close(4401, 'unauthenticated');
          }
          const previous = connections.get(id);
          if (previous && previous !== ws) previous.close(4000, 'replaced by a newer connection');
          playerId = id;
          connections.set(id, ws);
          return send(ws, {
            t: 'welcome',
            v: PROTOCOL_VERSION,
            playerId: id,
            name: info.name,
            farm: await game.getFarmState(info.farmId),
            market: await game.getMarketState(),
            clock: game.getClock(),
          });
        }
        if (!playerId) return send(ws, { t: 'ack', rid: msg.rid, ok: false, code: 'unauthenticated', message: 'say hello first' });
        if (!actionLimiter.take(playerId)) {
          return send(ws, { t: 'ack', rid: msg.rid, ok: false, code: 'rate_limited', message: 'slow down' });
        }
        // Retries after a reconnect reuse their rid; answer them without applying twice.
        const seen = recentRids.get(playerId) ?? new Map<string, ActionResult>();
        recentRids.set(playerId, seen);
        const prior = seen.get(msg.rid);
        if (prior) {
          return send(ws, prior.ok ? { t: 'ack', rid: msg.rid, ok: true, duplicate: true } : { t: 'ack', rid: msg.rid, ...prior });
        }
        const result = await game.act(playerId, msg);
        seen.set(msg.rid, result);
        if (seen.size > 100) seen.delete(seen.keys().next().value as string);
        send(ws, result.ok ? { t: 'ack', rid: msg.rid, ok: true } : { t: 'ack', rid: msg.rid, ...result });
      })().catch((err: unknown) => {
        log(`[ws] message failed: ${err instanceof Error ? err.message : String(err)}`);
        send(ws, { t: 'error', code: 'server_error', message: 'something went wrong' });
      });
    });

    ws.on('close', () => {
      if (playerId && connections.get(playerId) === ws) connections.delete(playerId);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients as Set<WebSocket & { alive?: boolean }>) {
      if (ws.alive === false) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, 30_000);
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });

  return server;
}
