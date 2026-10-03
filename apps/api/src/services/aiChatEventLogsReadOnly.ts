import { z } from 'zod';

/**
 * #7906 — payload-aware read-only classification for
 * `execute_command { commandType: 'event_logs_query' }` in interactive AI CHAT
 * sessions (advisor-quorum decision recorded on the issue).
 *
 * Why this is NOT a TIER2_READONLY_ACTIONS entry: that table is keyed on the
 * commandType alone, and `event_logs_query` takes a caller-controlled channel
 * (`logName`) plus a raw XPath (`query`). A static entry would auto-execute a
 * Security-log read — and a QueryList XPath can select Security even under
 * `logName: 'System'` (the agent passes it straight to `-FilterXPath`). So the
 * call is eligible only when ALL of these hold, otherwise it stays Tier 3:
 *
 *   - `logName` is exactly `System` or `Setup` (case-insensitive exact match;
 *     no wildcard, no padding). Application stays Tier 3: apps log arbitrary
 *     text at info level, a broader credential/PII surface. A MISSING logName
 *     also stays Tier 3, although the agent defaults it to System — eligibility
 *     is decided on what the caller sent, not on a downstream default.
 *   - `query` (XPath) is absent — the strict schema has no such key.
 *   - the payload passes the strict schema below: no unknown keys, no type
 *     coercion, paging bounded to the agent's own caps
 *     (agent/internal/remote/tools/result_limits.go maxEventLogQueryPage = 20;
 *     eventlogs.go limit 1-500), and a conservative `source` charset so a
 *     quote/escape attempt never qualifies (the agent escapes it, but an
 *     auto-executed call should not depend on that).
 *
 * CLASSIFY == DISPATCH. The classifier returns a frozen, detached copy of the
 * parsed payload. The chat gate pins it on the ToolExecutionContext and the
 * execute_command handler dispatches exactly those values — it never re-reads
 * the raw input payload for a classified call.
 *
 * Pure and DB-free: aiGuardrails.ts imports this module, and its import
 * surface is pinned (aiGuardrails.imports.contract.test.ts).
 */

const ELIGIBLE_LOG_NAMES: ReadonlySet<string> = new Set(['system', 'setup']);

// Event provider names: letters, digits, space, dot, underscore, hyphen
// (e.g. "Service Control Manager", "Microsoft-Windows-Kernel-General").
const SOURCE_PATTERN = /^[A-Za-z0-9 ._-]{1,255}$/;

export const MAX_READONLY_EVENT_LOG_PAGE = 20;
export const MAX_READONLY_EVENT_LOG_LIMIT = 500;

const strictEventLogsQueryPayloadSchema = z.object({
  logName: z.string().refine((v) => ELIGIBLE_LOG_NAMES.has(v.toLowerCase())),
  source: z.string().regex(SOURCE_PATTERN).optional(),
  level: z.union([
    z.enum(['critical', 'error', 'warning', 'information', 'info', 'verbose']),
    z.number().int().min(1).max(5),
  ]).optional(),
  eventId: z.number().int().min(0).max(0xffff).optional(),
  page: z.number().int().min(1).max(MAX_READONLY_EVENT_LOG_PAGE).optional(),
  limit: z.number().int().min(1).max(MAX_READONLY_EVENT_LOG_LIMIT).optional(),
}).strict();

export type ReadOnlyEventLogsQueryPayload = Readonly<z.infer<typeof strictEventLogsQueryPayloadSchema>>;

/** The parsed values a classified call is dispatched with. */
export interface PinnedEventLogsQuery {
  payload: ReadOnlyEventLogsQueryPayload;
}

/**
 * Returns the pinned, parsed payload when this call is an eligible read-only
 * `event_logs_query`, or `null` (stay at the base tier) otherwise.
 */
export function classifyChatReadOnlyEventLogsQuery(
  toolName: string,
  input: Record<string, unknown>,
): PinnedEventLogsQuery | null {
  if (toolName !== 'execute_command' || input.commandType !== 'event_logs_query') return null;
  const parsed = strictEventLogsQueryPayloadSchema.safeParse(input.payload);
  if (!parsed.success) return null;
  // zod builds a fresh object; freeze it so nothing between the gate and the
  // handler can change what was classified.
  return { payload: Object.freeze({ ...parsed.data }) };
}
