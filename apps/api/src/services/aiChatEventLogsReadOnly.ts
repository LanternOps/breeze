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

/**
 * #12453 — the same decision for the dedicated `browse_device_event_log` tool:
 * `query` / `get_event` on System or Setup run without an approval card in an
 * interactive CHAT session (owner decision on the issue, the #7906 precedent).
 * Every other channel — Security and Application included, any custom,
 * path-style or wildcard name, a list, or a missing channel — keeps the
 * Tier 3 approval, and so does every non-chat principal.
 *
 * The rules differ from `event_logs_query` above in two ways, both because
 * this tool's input is not the agent payload:
 *   - `logName` is trimmed before the case-insensitive match (owner decision),
 *     and the CANONICAL channel name (`System` / `Setup`) is what is pinned and
 *     dispatched, so the agent never receives the padded string;
 *   - the schema is the tool's own: no XPath field exists, paging uses the
 *     tool's caps (page <= MAX_EVENT_LOG_PAGE, limit <= 100), level is the
 *     tool's string enum, and `get_event` takes only `recordId`.
 * `deviceId` is accepted but not pinned: device scope stays the handler's
 * `verifyDeviceAccess` on the call's own `deviceId`, exactly as before.
 *
 * Duplicates (not imports) the level list and page cap from
 * aiToolSchemasDeviceOps.ts — aiGuardrails' import surface is pinned
 * (aiGuardrails.imports.contract.test.ts); a parity test keeps them equal.
 */
export const READONLY_DEVICE_EVENT_LOG_LEVELS = ['information', 'warning', 'error', 'critical', 'verbose'] as const;
export const READONLY_DEVICE_EVENT_LOG_QUERY_LIMIT = 100;

const canonicalLogName = z.string().max(256).transform((v, ctx) => {
  const key = v.trim().toLowerCase();
  const canonical = key === 'system' ? 'System' as const : key === 'setup' ? 'Setup' as const : undefined;
  if (!canonical) {
    ctx.addIssue({ code: 'custom', message: 'not a read-only channel' });
    return z.NEVER;
  }
  return canonical;
});

const strictDeviceEventLogReadSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('query'),
    deviceId: z.string(),
    logName: canonicalLogName,
    level: z.enum(READONLY_DEVICE_EVENT_LOG_LEVELS).optional(),
    source: z.string().regex(SOURCE_PATTERN).optional(),
    eventId: z.number().int().min(0).max(0xffff).optional(),
    page: z.number().int().min(1).max(MAX_READONLY_EVENT_LOG_PAGE).optional(),
    limit: z.number().int().min(1).max(READONLY_DEVICE_EVENT_LOG_QUERY_LIMIT).optional(),
  }).strict(),
  z.object({
    action: z.literal('get_event'),
    deviceId: z.string(),
    logName: canonicalLogName,
    recordId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }).strict(),
]);

type ParsedDeviceEventLogRead = z.infer<typeof strictDeviceEventLogReadSchema>;

/**
 * The read a classified `browse_device_event_log` call is dispatched with:
 * the action, the canonical channel and that action's own fields. Frozen.
 */
export type PinnedDeviceEventLogRead =
  | Readonly<Omit<Extract<ParsedDeviceEventLogRead, { action: 'query' }>, 'deviceId'>>
  | Readonly<Omit<Extract<ParsedDeviceEventLogRead, { action: 'get_event' }>, 'deviceId'>>;

/**
 * Returns the pinned read when this call is an eligible read-only
 * `browse_device_event_log` query / get_event, or `null` (keep the Tier 3
 * approval) otherwise.
 */
export function classifyChatReadOnlyDeviceEventLogRead(
  toolName: string,
  input: Record<string, unknown>,
): PinnedDeviceEventLogRead | null {
  if (toolName !== 'browse_device_event_log') return null;
  const parsed = strictDeviceEventLogReadSchema.safeParse(input);
  if (!parsed.success) return null;
  // zod builds a fresh object; drop deviceId (not classified) and freeze the
  // rest so nothing between the gate and the handler can change it.
  const { deviceId: _deviceId, ...read } = parsed.data;
  return Object.freeze(read);
}
