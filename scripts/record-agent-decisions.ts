// Writes apps/server/test/fixtures/agent-replies.json: the recorded agent replies that the 30-day
// model-vs-rules comparison (apps/server/test/agent-compare.test.ts) replays in place of NEAR AI.
//
//   npx tsx scripts/record-agent-decisions.ts           # authored stand-ins, no model call
//   npx tsx scripts/record-agent-decisions.ts --live    # record from NEAR AI Cloud (NEARAI_API_KEY, credits)
//
// Offline it writes the authored in-character replies from apps/server/test/recorded-model.ts. With
// --live it sends every sample context (7 kinds, 3 situations) to the main model three times, with
// the real system prompt and structured output, keeps the replies that pass the server's validation
// (the authored ones where none does), and asks for two reflections per kind: 77 calls, a few cents.
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AGENT_KINDS } from '@coys/shared';
import { NearAiClient } from '../apps/server/src/ai/nearai';
import { REFLECT_SYSTEM, SYSTEM } from '../apps/server/src/agents/brain';
import { cleanText, decisionJsonSchema, validateDecision, type WeekNumbers } from '../apps/server/src/agents/decision';
import { SITUATIONS, authoredReplies, sampleContext, type AgentReplies } from '../apps/server/test/recorded-model';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = `${root}apps/server/test/fixtures/agent-replies.json`;
const { values } = parseArgs({ options: { live: { type: 'boolean', default: false } } });

async function record(fixture: AgentReplies): Promise<AgentReplies> {
  if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
  const apiKey = process.env.NEARAI_API_KEY;
  if (!apiKey) throw new Error('--live needs NEARAI_API_KEY (and credits on the NEAR AI account)');
  const client = new NearAiClient({ apiKey, baseUrl: process.env.NEARAI_BASE_URL, model: process.env.NEARAI_MODEL });
  const week: WeekNumbers = { fromDay: 5, toDay: 12, cashStart: 300, cashNow: 262, deals: 4, refusals: 3, bustsSeen: 1, multiplierLow: 0.62, multiplierHigh: 1.31, glutDays: 2 };
  for (const kind of AGENT_KINDS) {
    for (const situation of SITUATIONS) {
      const c = sampleContext(kind, situation);
      const kept = [];
      for (let i = 0; i < 3; i++) {
        const { content } = await client.chat(
          [
            { role: 'system', content: SYSTEM(c) },
            { role: 'user', content: JSON.stringify(c) },
          ],
          { maxTokens: 1500, timeoutMs: 60_000, responseFormat: { type: 'json_schema', json_schema: { name: 'decision', strict: true, schema: decisionJsonSchema() } } },
        );
        const d = validateDecision(content, c);
        if (d) kept.push(d);
      }
      if (kept.length) fixture.samples[kind][situation].replies = kept;
      console.log(`${kind} ${situation}: ${kept.length} of 3 replies usable`);
    }
    const c = sampleContext(kind, 'normal');
    const texts = [];
    for (let i = 0; i < 2; i++) {
      const { content } = await client.chat(
        [
          { role: 'system', content: REFLECT_SYSTEM(c) },
          { role: 'user', content: JSON.stringify({ week, cash: c.agent.cash, lastReflection: null, reasons: [], trend: c.market.trend }) },
        ],
        { maxTokens: 200, timeoutMs: 60_000 },
      );
      const text = cleanText(content, 400);
      if (text.length >= 20) texts.push(text);
    }
    if (texts.length) fixture.reflections[kind] = texts;
  }
  return { ...fixture, source: client.model };
}

const fixture = values.live ? await record(authoredReplies()) : authoredReplies();
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
const replies = Object.values(fixture.samples).reduce((n, k) => n + Object.values(k).reduce((m, s) => m + s.replies.length, 0), 0);
console.log(`wrote ${out}: ${replies} replies (${fixture.source}), ${fixture.invalid.length} unusable ones, reflections for ${Object.keys(fixture.reflections).length} kinds`);
