/**
 * Shared AI tool error sanitization (#2603).
 *
 * Tool failures are streamed to the chat as `tool_result` content — read by both
 * the model and the user-facing tool card. Before this module, a thrown
 * Drizzle/postgres.js error went out verbatim, e.g.
 *
 *   {"error":"Failed query: select \"org_id\", \"baseline_id\", \"name\", ..."}
 *
 * which leaks the schema (table/column names), query shape, constraint names and
 * sometimes infrastructure hostnames to anyone who can open a chat session. The
 * full error belongs in the server logs; the stream gets a short generic string.
 *
 * Two entry points, deliberately different in strictness:
 *
 * - `sanitizeThrownToolError` — for `catch` blocks. A thrown error is by
 *   definition an unexpected internal fault, so this is **fail-closed**: the
 *   message is replaced with a generic string unless it matches a small
 *   allowlist of strings the application itself constructs (e.g. tool timeouts).
 *
 * - `scrubErrorText` / `scrubErrorFieldsDeep` — for error text a handler
 *   *returned* as a normal result (`{ error: 'Device not found' }`,
 *   `{ warning: ... }`, `{ queueError: ... }`). Those are usually author-written
 *   and useful to the model, so this is **pattern-based**: only text that looks
 *   like driver/runtime output is replaced. This runs inside
 *   `compactToolResultForChat`, which every tool result passes through, so it
 *   covers all `aiTools*.ts` handlers without per-file changes.
 */

export const GENERIC_TOOL_ERROR_MESSAGE =
  'The tool could not complete this request. Details were recorded in the server logs.';

/**
 * Messages the application constructs itself and which are safe (and useful) to
 * show. Anything not matching is genericized.
 */
const SAFE_THROWN_MESSAGE_PATTERNS: RegExp[] = [
  /^Tool execution timed out after \d+ms/i,
  /^Tool .{1,60} timed out/i,
];

/**
 * Signatures of driver / runtime / infrastructure output. Any error string
 * matching one of these is replaced wholesale — never partially masked, because
 * a partial mask still reveals the schema around it.
 */
const INTERNAL_DETAIL_PATTERNS: RegExp[] = [
  // postgres.js / Drizzle query echo
  /failed query/i,
  /\bselect\s+["'`]/i,
  /\b(?:insert\s+into|update|delete\s+from)\s+["'`]/i,
  // PostgreSQL error text
  /relation\s+"[^"]+"\s+does not exist/i,
  /column\s+(?:reference\s+)?"[^"]+"/i,
  /constraint\s+"[^"]+"/i,
  /duplicate key value violates/i,
  /violates (?:foreign key|not-null|check) constraint/i,
  /violates row-level security policy/i,
  /syntax error at or near/i,
  /operator does not exist/i,
  /invalid input syntax for/i,
  /permission denied for (?:table|relation|schema|sequence)/i,
  // Bare SQLSTATE codes
  /\b(?:23\d{3}|42\d{3}|22P02|40P01|57014)\b/,
  // Node / network / infrastructure
  /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|EPIPE|EAI_AGAIN)\b/,
  /getaddrinfo/i,
  /connect(?:ion)? (?:to server )?(?:failed|refused|terminated)/i,
  // Stack traces and module paths
  /\n\s+at\s+\S+/,
  /(?:\/(?:home|usr|opt|var|app)\/|node_modules\/|file:\/\/)/,
  // Redis / BullMQ internals
  /\bWRONGTYPE\b|\bNOSCRIPT\b|\bLOADING\b/,
];

/**
 * Author-written tool errors are short. Anything long is either a driver dump or
 * a stack trace, so it is genericized regardless of pattern match.
 */
const MAX_SAFE_ERROR_CHARS = 300;

/** Object keys whose string values are treated as error text during deep scrub. */
const ERROR_FIELD_PATTERN = /(?:^|[a-z])(?:error|warning)s?$/i;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) {
    const raw = (err as { message: unknown }).message;
    if (typeof raw === 'string') return raw;
  }
  return '';
}

/**
 * True when `text` looks like driver/runtime output rather than an
 * application-authored message.
 */
export function looksLikeInternalErrorDetail(text: string): boolean {
  if (text.length > MAX_SAFE_ERROR_CHARS) return true;
  return INTERNAL_DETAIL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Pattern-based scrub for error text a handler returned as a normal result.
 * Preserves short, author-written messages; replaces anything driver-shaped.
 */
export function scrubErrorText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return looksLikeInternalErrorDetail(text) ? GENERIC_TOOL_ERROR_MESSAGE : text;
}

/**
 * Recursively scrub string values under error-ish keys (`error`, `warning`,
 * `queueError`, `scheduleWarning`, `errors[]`, …) anywhere in a tool payload.
 * Non-error fields are left untouched — this must not degrade tool data.
 */
export function scrubErrorFieldsDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (Array.isArray(value)) {
    return value.map((item) => scrubErrorFieldsDeep(item, depth + 1));
  }
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'string' && ERROR_FIELD_PATTERN.test(key)) {
      out[key] = scrubErrorText(child);
    } else {
      out[key] = scrubErrorFieldsDeep(child, depth + 1);
    }
  }
  return out;
}

/**
 * Fail-closed sanitizer for a **thrown** error. Logs the full error (with stack)
 * server-side and returns a short string safe to stream.
 *
 * @param toolName tool the error escaped from — used for the log line only.
 * @param err      the caught value.
 * @param context  optional extra log context (never returned to the caller).
 */
export function sanitizeThrownToolError(
  toolName: string,
  err: unknown,
  context?: Record<string, unknown>,
): string {
  const raw = messageOf(err);
  console.error(
    `[aiTools] ${toolName} threw: ${raw || 'unknown error'}`,
    context ? { ...context } : '',
    err instanceof Error && err.stack ? `\n${err.stack}` : '',
  );

  if (
    raw &&
    raw.length <= MAX_SAFE_ERROR_CHARS &&
    SAFE_THROWN_MESSAGE_PATTERNS.some((pattern) => pattern.test(raw))
  ) {
    return raw;
  }
  return GENERIC_TOOL_ERROR_MESSAGE;
}

/**
 * Convenience wrapper: sanitize a thrown error and shape it as the
 * `{"error": "..."}` JSON string tool handlers return.
 */
export function toolErrorResult(
  toolName: string,
  err: unknown,
  context?: Record<string, unknown>,
): string {
  return JSON.stringify({ error: sanitizeThrownToolError(toolName, err, context) });
}
