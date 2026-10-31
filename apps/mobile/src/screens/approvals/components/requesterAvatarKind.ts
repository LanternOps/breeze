/**
 * Which avatar treatment the approval takeover header shows for a requester.
 *
 * Pure module (no React) so it stays unit-testable — the same pattern as
 * timerBarLogic.ts. `requestingClientLabel` is server-issued free text (see
 * `services/approvals.ts`); the AI chat flow always sends one of two literal
 * strings (apps/api/src/services/aiAgentSdk.ts `chatApprovalClientLabel`):
 * 'Breeze AI', or 'Wisp' when the chat runs under a Wisp grant (#10193).
 * Every other caller — agent elevation requests, MCP/desktop clients, patch
 * and hygiene agents — sends the requesting app or agent's own name, which
 * reads better as initials than as a generic icon.
 */
const AI_CHAT_LABELS: ReadonlySet<string> = new Set(['Breeze AI', 'Wisp']);

export function isBreezeAiRequester(clientLabel: string): boolean {
  return AI_CHAT_LABELS.has(clientLabel.trim());
}
