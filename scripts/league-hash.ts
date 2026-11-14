// Checks a closed league season's standings hash from outside the game: fetches the season's board
// from the public API, rebuilds its canonical standings string (docs/league.md), prints its SHA-256
// and whether it matches the standingsSha256 the server published, and with --chain also reads the
// game contract's head for the season 'league' (a view call through the public testnet RPC) and
// whether its last stored digest is this hash. Read only: it signs nothing and writes nothing.
//
//   npx tsx scripts/league-hash.ts --id s-1 [--base https://yolkstreet.25th.dev] [--chain] [--contract <account>] [--rpc <url>]
//
// --contract defaults to the contract the server names on its mint page (GET /api/feathers).
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { canonicalStandings, type LeaderboardView } from '@coys/shared';

const fail = (message: string): never => {
  console.error(`league-hash: ${message}`);
  process.exit(1);
};
const { values } = parseArgs({
  options: {
    id: { type: 'string' },
    base: { type: 'string', default: 'https://yolkstreet.25th.dev' },
    chain: { type: 'boolean', default: false },
    contract: { type: 'string' },
    rpc: { type: 'string', default: 'https://rpc.testnet.near.org' },
  },
});
const id = values.id ?? fail('--id <season id> is required, for example s-1');
if (!/^s-\d{1,6}$/.test(id)) fail('--id must be a season id, for example s-1');
const base = values.base.replace(/\/+$/, '');

const getJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, init);
  if (!res.ok) fail(`${url} answered ${res.status}`);
  return (await res.json()) as T;
};

const view = await getJson<LeaderboardView>(`${base}/api/leaderboard?board=season&id=${encodeURIComponent(id)}`);
const w = view.window ?? fail(`no season ${id} on ${base}`);
if (w.status !== 'closed') fail(`season ${id} is still open: its standings are hashed when it closes`);
const canonical = canonicalStandings(w, view.entries);
const sha = createHash('sha256').update(canonical).digest('hex');
console.log(`season ${id} (league season ${w.seq}): ${view.entries.length} farms, canonical standings ${canonical.length} characters`);
console.log(`sha256      ${sha}`);
console.log(`published   ${w.standingsSha256 ?? 'none'}`);
console.log(sha === w.standingsSha256 ? 'MATCH: the standings rebuilt from the API hash to the published value' : 'MISMATCH: the standings do not hash to the published value');
if (w.chainTx) console.log(`stored by   ${w.chainTx}`);

let ok = sha === w.standingsSha256;
if (values.chain) {
  const contract = values.contract ?? (await getJson<{ contract: string | null }>(`${base}/api/feathers`)).contract ?? fail('the server names no contract: pass --contract');
  if (!/^([0-9a-f]{64}|[a-z0-9_.-]{2,64}\.testnet)$/.test(contract)) fail(`refusing ${contract}: not a testnet account`);
  // a view call: the public RPC runs the contract's season_head read only, nothing is signed
  const rpc = await getJson<{ result?: { result?: number[] }; error?: unknown }>(values.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'league-hash',
      method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: 'season_head', args_base64: Buffer.from(JSON.stringify({ season: 'league' })).toString('base64') },
    }),
  });
  const bytes = rpc.result?.result ?? fail(`the RPC did not answer the view: ${JSON.stringify(rpc.error ?? rpc).slice(0, 300)}`);
  const head = JSON.parse(Buffer.from(bytes).toString('utf8')) as { last_day: number; last_digest: string; days_settled: number };
  console.log(`chain       ${contract} season_head("league"): last day ${head.last_day}, last digest ${head.last_digest || 'none'}, ${head.days_settled} stored`);
  if (head.last_day === w.seq) {
    const onChain = head.last_digest === sha;
    console.log(onChain ? `ON CHAIN: the contract holds this hash as league season ${w.seq}` : 'MISMATCH: the contract holds another digest for this league season');
    ok = ok && onChain;
  } else {
    // the head keeps the last season stored; an earlier one is in its settle_day call (the explorer link)
    console.log(`the contract's last league season is ${head.last_day}: season ${w.seq}'s hash is in its own settle_day call${w.chainTx ? ` (${w.chainTx})` : ''}`);
  }
}
process.exit(ok ? 0 : 2);
