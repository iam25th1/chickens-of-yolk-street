// The AI tag: every AI farm and agent wears it wherever its name is shown (the Market page's farms,
// cast, orders and trades, and the ticker). Inline and a few pixels wide, so it never widens a row.
// Its tooltip, and every other line that says how the AI decides, follows the mode the server reports
// (MarketState.aiMode, or one agent's own AgentView.brain): while it is the rules, nothing says a model
// decides.
import type { AiMode } from '@coys/shared';
import { game } from '../state/game';
import { useStore } from '../state/store';

const PROVIDER: Record<Exclude<AiMode, 'rules'>, string> = { nearai: 'NEAR AI Cloud', serv: 'SERV Reasoning' };

/** The agents' mode as the server last reported it; the rules until it says otherwise. */
export function useAiMode(): AiMode {
  return useStore(game, (s) => s.market?.aiMode ?? 'rules');
}

/** The AI tag's tooltip. */
export function aiTooltip(mode: AiMode): string {
  if (mode === 'rules') return 'Run by an AI agent: rule-based strategy with its own wallet, memory and personality';
  return `Run by an AI agent with its own wallet, memory and personality: decides with ${PROVIDER[mode]} on the days that matter, by its rule-based strategy on the rest`;
}

/** How the AI decides, for the How to play guide. */
export function aiHowLine(mode: AiMode): string {
  if (mode === 'rules') return 'EACH AI PLAYS ITS OWN RULE-BASED STRATEGY, WITH ITS OWN COINS, MEMORY AND PERSONALITY.';
  return `EACH AI PLAYS ITS OWN STRATEGY, WITH ITS OWN COINS, MEMORY AND PERSONALITY, AND DECIDES WITH ${PROVIDER[mode].toUpperCase()} (AN AI MODEL) WHEN THE MARKET TURNS.`;
}

/** An AI farm's line on its public profile. */
export function aiFarmLine(mode: AiMode): string {
  if (mode === 'rules') return 'AN AI FARM: ITS AGENT PLAYS A RULE-BASED STRATEGY';
  return `AN AI FARM: ITS AGENT DECIDES WITH ${PROVIDER[mode].toUpperCase()} WHEN IT MATTERS`;
}

/** The AI tag. `brain` is one agent's own mode (the cast list); without it, the agents' mode. */
export function AiBadge({ brain }: { brain?: AiMode }) {
  const mode = useAiMode();
  return (
    <span className="ai-badge" aria-label="AI" title={aiTooltip(brain ?? mode)}>
      AI
    </span>
  );
}

/** The GUEST tag: a player farm started with PLAY and not signed in yet (the AI tag's size, in straw). */
export function GuestTag() {
  return (
    <span className="ai-badge guest-tag" aria-label="Guest" title="A guest farm: started with PLAY, not signed in yet">
      GUEST
    </span>
  );
}

/** The How to play guide's line on how the AI decides, following the mode. */
export function AiHowLine() {
  return <>{aiHowLine(useAiMode())}</>;
}
