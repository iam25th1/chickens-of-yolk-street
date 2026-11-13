// The AI tag: every AI farm and agent wears it wherever its name is shown (the market board's farms,
// cast, orders and trades, and the ticker). Inline and a few pixels wide, so it never widens a row.
export function AiBadge() {
  return (
    <span className="ai-badge" aria-label="AI" title="Run by an AI agent">
      AI
    </span>
  );
}
