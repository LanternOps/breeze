/**
 * Which avatar treatment the approval takeover header shows for a requester.
 *
 * Pure module (no React) so it stays unit-testable — the same pattern as
 * timerBarLogic.ts. `requestingClientLabel` is server-issued free text (see
 * `services/approvals.ts`); the AI chat flow is the one caller that always
 * sends the literal string 'Breeze AI' (apps/api/src/services/aiAgentSdk.ts).
 * Every other caller — agent elevation requests, MCP/desktop clients, patch
 * and hygiene agents — sends the requesting app or agent's own name, which
 * reads better as initials than as a generic icon.
 */
export function isBreezeAiRequester(clientLabel: string): boolean {
  return clientLabel.trim() === 'Breeze AI';
}
