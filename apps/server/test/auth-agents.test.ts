import { describe, expect, it } from 'vitest';
import { NearAiClient } from '../src/ai/nearai';
import { createSessionSigner } from '../src/auth/session';
import { HeuristicBrain, NearAiBrain, RIVALS, parseDecision, type AgentView } from '../src/game/agents';
import { RateLimiter } from '../src/net/ratelimit';

describe('sessions', () => {
  it('verifies its own tokens and rejects tampered or expired ones', () => {
    let now = 1000;
    const s = createSessionSigner('secret', () => now);
    const token = s.sign('player-1', 500);
    expect(s.verify(token)).toBe('player-1');
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ p: 'player-2', e: 99999 })).toString('base64url');
    expect(s.verify(`${forged}.${sig}`)).toBeNull();
    expect(createSessionSigner('other').verify(token)).toBeNull();
    expect(s.verify(`${payload}`)).toBeNull();
    now = 2000;
    expect(s.verify(token)).toBeNull();
  });
});

describe('rate limiter', () => {
  it('allows a burst, then refills over time', () => {
    let now = 0;
    const r = new RateLimiter(3, 1, () => now);
    expect([r.take('a'), r.take('a'), r.take('a'), r.take('a')]).toEqual([true, true, true, false]);
    expect(r.take('b')).toBe(true);
    now = 1000;
    expect(r.take('a')).toBe(true);
  });
});

const view: AgentView = {
  farmId: 'f',
  key: 'upstart',
  name: 'Upstart Eggs',
  day: 4,
  cash: 120,
  hens: 20,
  capacity: 30,
  freePlots: 3,
  crate: { white: 10, cream: 5, brown: 2, golden: 0 },
  feedGrams: { cheap: 1000, standard: 0, premium: 0 },
  feedTier: 'cheap',
  unlocks: [],
  multiplier: 1.5,
  history: [],
  style: (RIVALS.find((r) => r.key === 'upstart') ?? RIVALS[0])?.style as AgentView['style'],
};

describe('agent brains', () => {
  it('the heuristic sells, restocks feed and grows while hens pay', async () => {
    const actions = await new HeuristicBrain().decide(view);
    expect(actions.map((a) => a.t)).toEqual(expect.arrayContaining(['sell', 'buyFeed', 'buyHens']));
  });

  it('reads a model reply, fenced or bare, and rejects junk', () => {
    expect(parseDecision('```json\n{"actions":[{"t":"buyHens","count":3}]}\n```')).toEqual([{ t: 'buyHens', count: 3 }]);
    expect(parseDecision('{"actions":[{"t":"setCash","cash":1e9}]}')).toBeNull();
    expect(parseDecision('no json here')).toBeNull();
  });

  it('calls NEAR AI Cloud with a Bearer key and falls back to the heuristic on failure', async () => {
    const calls: { url: string; auth: string | null; body: { model: string } }[] = [];
    const ok = new NearAiClient({
      apiKey: 'k',
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"actions":[{"t":"setFeedTier","tier":"premium"}]}' } }] }));
      }) as typeof fetch,
    });
    expect(await new NearAiBrain(ok, () => undefined).decide(view)).toEqual([{ t: 'setFeedTier', tier: 'premium' }]);
    expect(calls[0]).toMatchObject({ url: 'https://cloud-api.near.ai/v1/chat/completions', auth: 'Bearer k', body: { model: 'zai-org/GLM-5.1-FP8' } });

    const down = new NearAiClient({ apiKey: 'k', fetchImpl: (async () => new Response('nope', { status: 503 })) as typeof fetch });
    const fallback = await new NearAiBrain(down, () => undefined).decide(view);
    expect(fallback).toEqual(await new HeuristicBrain().decide(view));
  });
});
