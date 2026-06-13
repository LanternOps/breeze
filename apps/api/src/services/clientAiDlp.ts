/**
 * Client AI DLP / redaction seam (spec §6) — v1 PASSTHROUGH STUB.
 *
 * Plan 3 (docs/superpowers/plans/2026-06-12-ai-for-office-3-dlp.md) replaces
 * the internals with the real detector/redaction engine. The interface below
 * is PINNED across plans — do not change it here.
 *
 * Call sites (owned by Plan 2 — the chokepoints; spec §6 "nothing reaches the
 * model un-scanned"):
 *  (a) user message text — routes/clientAi/sessions.ts POST /:id/messages
 *  (b) every tool_result payload + workbookContext cells —
 *      services/clientAiTools.ts (applyDlpToToolOutput) and the messages route
 *  (c) template bodies — arrive inside (a) in v1 (the add-in inserts templates
 *      into the chat input).
 *
 * Persistence contract: callers store result.text / result.redactions, never
 * the raw input (Plan 3 Task 6 ships the unit-level proof; Plan 2's
 * sessions.messages.test.ts carries the integration assertion).
 *
 * `input.orgId` and `input.dlpConfig` are unused by the stub but pinned in the
 * signature (Plan 3's engine parses dlpConfig itself; orgId is reserved for
 * per-org compiled-rule caching/telemetry).
 */

export interface DlpRedactionEvent {
  rule: string;
  count: number;
  location: string;
}

export interface DlpResult {
  action: 'allow' | 'block';
  text?: string;
  cells?: unknown[][];
  redactions: DlpRedactionEvent[];
  blockReason?: string;
}

export async function applyDlp(input: {
  text?: string;
  cells?: unknown[][];
  dlpConfig: unknown;
  orgId: string;
}): Promise<DlpResult> {
  const result: DlpResult = { action: 'allow', redactions: [] };
  if (typeof input.text === 'string') result.text = input.text;
  if (input.cells !== undefined) {
    // Row-copied like the Plan-3 engine — callers may rely on a fresh matrix.
    result.cells = input.cells.map((row) => [...(row ?? [])]);
  }
  return result;
}
