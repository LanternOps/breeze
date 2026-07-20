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
  // PostgreSQL error text. These are deliberately anchored on the surrounding
  // Postgres phrasing rather than on a bare quoted identifier: Breeze is an RMM,
  // and tool results legitimately contain strings like
  // `Report column "hostname" is not valid` that must NOT be genericized.
  /relation\s+"[^"]+"\s+does not exist/i,
  /column\s+reference\s+"[^"]+"\s+is ambiguous/i,
  /column\s+"[^"]+"\s+(?:of relation\b|does not exist|cannot be null|is of type)/i,
  /(?:violates|on table|constraint)\s+"[^"]+"\s*$/i,
  /duplicate key value violates/i,
  /violates (?:foreign key|not-null|check|unique) constraint/i,
  /violates row-level security policy/i,
  /syntax error at or near/i,
  /operator does not exist/i,
  /invalid input syntax for/i,
  /permission denied for (?:table|relation|schema|sequence)/i,
  // SQLSTATE codes. Alphanumeric codes are distinctive enough to match bare;
  // purely numeric ones require SQLSTATE-ish context, because a bare five-digit
  // number is ordinary RMM data ("Upload exceeds the limit of 42000 bytes").
  /\b(?:22P02|40P01|42P01|42703|42883)\b/,
  /\b(?:sqlstate|error\s*code|pg\s*code)\b\D{0,16}\b(?:23\d{3}|42\d{3}|57014)\b/i,
  // Node / network / infrastructure
  /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|EPIPE|EAI_AGAIN)\b/,
  /getaddrinfo/i,
  /connection (?:refused|terminated|to server)/i,
  // Stack traces and server-side module paths. Managed-device filesystem paths
  // (/var/lib/..., /opt/..., /home/...) are core RMM domain data and are NOT
  // matched here — only markers that can only come from OUR runtime.
  /\n\s+at\s+\S+/,
  /(?:node_modules\/|file:\/\/|\/app\/dist\/|\.[cm]?[jt]sx?:\d+:\d+)/,
  // Redis / BullMQ internals
  /\bWRONGTYPE\b|\bNOSCRIPT\b|\bLOADING\b/,
];

/**
 * Author-written tool errors are short. Anything long is either a driver dump or
 * a stack trace, so it is genericized regardless of pattern match.
 */
const MAX_SAFE_ERROR_CHARS = 300;

/**
 * Object keys that mark an error context. Covers `error`, `errors`, `warning(s)`,
 * `queueError`, `scheduleWarning`, `errorMessage`, `errorDetail`, `errorLog`, and
 * snake_case forms like `db_error` / `sync_error`.
 */
const ERROR_FIELD_PATTERN = /(?:^|[a-z_])(?:error|warning)s?(?:message|text|detail|log)?$/i;

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
 * Recursively scrub string values under error-ish keys anywhere in a tool payload.
 * Non-error fields are left untouched — this must not degrade tool data.
 *
 * The error context is **inherited by everything beneath the matching key**, which
 * is what makes the common partial-failure shapes safe:
 *
 *   { errors: { "<deviceId>": "<raw driver text>" } }   // keys are UUIDs
 *   { errors: ["<raw driver text>", ...] }              // array of strings
 *   { errorMessage: "<raw driver text>" }
 *
 * Matching only the key directly adjacent to the string (the original approach)
 * missed all three, because the inner keys are UUIDs or array indices.
 *
 * NOTE: intended for values produced by `JSON.parse`. Non-plain objects (Date,
 * Map, class instances) are returned untouched rather than rebuilt, so this
 * cannot silently flatten them if it is ever reused on live objects.
 */
export function scrubErrorFieldsDeep(
  value: unknown,
  depth = 0,
  inErrorContext = false,
): unknown {
  if (typeof value === 'string') {
    return inErrorContext ? scrubErrorText(value) : value;
  }
  if (value === null || typeof value !== 'object') return value;

  // Fail CLOSED at the depth cap: inside an error context, an un-walkable subtree
  // is replaced rather than passed through unscrubbed.
  if (depth > 8) return inErrorContext ? GENERIC_TOOL_ERROR_MESSAGE : value;

  if (Array.isArray(value)) {
    return value.map((item) => scrubErrorFieldsDeep(item, depth + 1, inErrorContext));
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childInErrorContext = inErrorContext || ERROR_FIELD_PATTERN.test(key);
    // defineProperty rather than `out[key] =` so a JSON-parsed "__proto__" key is
    // preserved as an own property instead of hitting the prototype setter.
    Object.defineProperty(out, key, {
      value: scrubErrorFieldsDeep(child, depth + 1, childInErrorContext),
      enumerable: true,
      writable: true,
      configurable: true,
    });
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

  // The allowlist branch is ALSO detector-checked. `Tool execution timed out
  // after Nms: ${label}` interpolates a value, so the safe branch must not be a
  // way around the scrub.
  if (
    raw &&
    raw.length <= MAX_SAFE_ERROR_CHARS &&
    !looksLikeInternalErrorDetail(raw) &&
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
