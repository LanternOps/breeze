const REDACTED = '[REDACTED]';

const SECRET_KEY_PATTERN = /password|passwd|pwd|token|secret|api.*key|access.*key|private.*key|client.*secret|authorization|cookie|session|credential|community|authpassphrase|privacypassphrase|connection.?string|conn.?string|sas.?token|shared.?key/i;

const SECRET_ASSIGNMENT_PATTERNS: RegExp[] = [
  /\b(authorization\s*:\s*bearer\s+)[^\s,;]+/gi,
  // Includes `auth=` to catch Pi-hole's URL pattern `?auth=<apiKey>` —
  // these can leak into Node fetch error messages whose .cause echoes
  // the URL verbatim.
  /\b((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|community|authpassphrase|privacypassphrase|auth)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
  /\b(Cookie\s*:\s*)[^\r\n]+/g,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * SECRET_KEY_PATTERN minus `session` (#6140).
 *
 * Every other token in that pattern names a key whose VALUE is the secret
 * itself (`password`, `token`, `clientSecret`, `cookie`, `community`, …), so a
 * container under such a key is credential material and stays fail-closed.
 * `session` is the one token that is also an ordinary domain noun in this
 * product — a remote-support session, a Windows logon session — so a container
 * under it (`sessions: [...]`) is structure, not a secret. A session id is
 * still a bearer-ish string, so `session: "sid_…"` remains redacted; only the
 * container case is re-opened. See `redactToolOutputFields`.
 */
const SECRET_MATERIAL_KEY_PATTERN =
  /password|passwd|pwd|token|secret|api.*key|access.*key|private.*key|client.*secret|authorization|cookie|credential|community|authpassphrase|privacypassphrase|connection.?string|conn.?string|sas.?token|shared.?key/i;

/**
 * A key that names a session IDENTIFIER rather than a session's attributes
 * (#6140): `session`, `sessionId`, `session_key`, `rdpSession`. A string under
 * one of these is bearer-ish and stays redacted. `sessionType`, `sessionState`,
 * `sessionStartedAt`, `maxSessionDurationHours` describe a session instead of
 * naming one, so they fall through to the ordinary string pass.
 */
const SESSION_IDENTIFIER_KEY_PATTERN =
  /(?:^|_|[a-z0-9])sessions?(?:_?ids?|_?keys?|_?guids?|_?uuids?)?$/i;

/**
 * An ISO-8601 date or timestamp. A value of this shape cannot be credential
 * material, so it survives even under a secret-named key (`tokenExpiresAt`).
 */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/** What to do with one `key: value` pair. */
type FieldAction = 'redact' | 'keep' | 'recurse';

type FieldPolicy = (key: string, value: unknown) => FieldAction;

/**
 * Log/audit policy — the historical behaviour, unchanged: a key that looks
 * sensitive has its whole value replaced whatever the value's type is.
 */
const logFieldPolicy: FieldPolicy = (key) => (isSecretKey(key) ? 'redact' : 'recurse');

export function redactLogMessage(message: string): string {
  return SECRET_ASSIGNMENT_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, (_match, prefix) => `${prefix}${REDACTED}`),
    message
  );
}

/** Resolve one `key: value` pair against the policy and recurse if told to. */
function applyPolicy(
  key: string,
  entry: unknown,
  redactString: (text: string) => string,
  depth: number,
  policy: FieldPolicy
): unknown {
  const action = policy(key, entry);
  if (action === 'redact') return REDACTED;
  if (action === 'keep') return entry;
  return redactFieldsWith(entry, redactString, depth + 1, policy, key);
}

/**
 * Shared deep walk. `redactString` is applied to every string leaf, so callers
 * can layer extra passes (see redactAgentLogFields) without duplicating the
 * key denylist, the depth cap, or the `__proto__` handling below.
 */
function redactFieldsWith(
  value: unknown,
  redactString: (text: string) => string,
  depth: number,
  policy: FieldPolicy = logFieldPolicy,
  /**
   * The key that labels `value` when `value` is an array (#6140). An array
   * element has no key of its own, so the array's key is its nearest label and
   * the policy must be applied to the element under that key — otherwise
   * `activeSessions: ["sk_live_…"]` would walk straight past every key-based
   * rule and emit the raw string. Ignored for records, whose entries carry
   * their own keys.
   */
  arrayKey?: string
): unknown {
  if (depth > 8) return REDACTED;

  if (Array.isArray(value)) {
    return value.map((entry) =>
      arrayKey === undefined
        ? redactFieldsWith(entry, redactString, depth + 1, policy)
        : applyPolicy(arrayKey, entry, redactString, depth, policy)
    );
  }

  if (!isRecord(value)) {
    return typeof value === 'string' ? redactString(value) : value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const redactedEntry = applyPolicy(key, entry, redactString, depth, policy);

    // `redacted[key] = …` for the literal key `__proto__` does NOT create an own
    // property — it invokes the setter inherited from Object.prototype (#3129):
    //   * object value    -> the key vanishes from the output AND the returned
    //                        object's prototype is silently replaced, so it
    //                        inherits whatever the agent sent.
    //   * primitive value -> the key vanishes, silently.
    // Either way the field is lost from redacted logs; the object case also
    // reprototypes an object built from untrusted input. defineProperty writes a
    // real own property and leaves the prototype alone, so the field survives
    // under its true name and JSON.stringify round-trips it unchanged.
    if (key === '__proto__') {
      Object.defineProperty(redacted, key, {
        value: redactedEntry,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      continue;
    }

    redacted[key] = redactedEntry;
  }
  return redacted;
}

export function redactLogFields(value: unknown, depth = 0): unknown {
  return redactFieldsWith(value, redactLogMessage, depth);
}

// ---------------------------------------------------------------------------
// Tool-output redaction (#6140)
//
// `redactLogFields` was written for LOG LINES, where a `session` field is a
// session id and a `token` field is a bearer token. Reusing it on structured AI
// tool RESULTS made the substring key match destroy the payload itself:
// `list_remote_sessions` returned `sessions: "[REDACTED]"`, `get_active_users`
// returned its session counts as the string `"[REDACTED]"`, and the
// `hasAccessToken` booleans that exist precisely so the secret never leaves the
// database were themselves blanked.
//
// The policy below narrows by VALUE SHAPE rather than by a key allowlist, so it
// does not need updating every time a tool grows a key containing `session`:
//
//   * number / boolean / null / undefined  -> kept. A JSON number or boolean
//     cannot carry secret material, so the key name is irrelevant.
//   * ISO-8601 timestamp string            -> kept. Same argument
//     (`tokenExpiresAt`, `secretRotatedAt`). Any other string under a secret
//     key is still redacted, so `*At` naming does not license a payload.
//   * array ELEMENTS are policy-checked under the ARRAY's key, since an element
//     has no key of its own (`activeSessions: ["sk_live_…"]` -> redacted).
//   * array / object                       -> recursed, UNLESS the key names
//     secret material (SECRET_MATERIAL_KEY_PATTERN). Recursion keeps the
//     structure and still redacts every secret leaf inside it by key and by the
//     inline-assignment string pass. `credentials: {...}` / `tokens: [...]`
//     stay wiped wholesale.
//   * string under a secret-material key   -> redacted, exactly as before; so
//     is a string under a session-IDENTIFIER key (`session`, `sessionId`,
//     `rdpSession`). A string under a key that merely DESCRIBES a session
//     (`sessionType`, `sessionState`, `sessionName`) is an enum or a label, not
//     a credential, and falls through to the inline-assignment string pass.
//
// Scope: tool output only. Log, audit-payload and tool-INPUT callers keep
// `redactLogFields` — for a persisted `tool_input`, a `password` argument is the
// secret and there is no structure worth preserving.
// ---------------------------------------------------------------------------
const toolOutputFieldPolicy: FieldPolicy = (key, value) => {
  if (Array.isArray(value) || isRecord(value)) {
    return SECRET_MATERIAL_KEY_PATTERN.test(key) ? 'redact' : 'recurse';
  }
  if (typeof value === 'string') {
    const secretNamed =
      SECRET_MATERIAL_KEY_PATTERN.test(key) || SESSION_IDENTIFIER_KEY_PATTERN.test(key);
    if (!secretNamed) return 'recurse';
    return ISO_TIMESTAMP.test(value) ? 'keep' : 'redact';
  }
  // number | boolean | null | undefined | bigint — not secret-bearing.
  return 'keep';
};

/**
 * `redactLogFields` for AI tool results: same denylist, but it will not replace
 * a non-secret-bearing value with `[REDACTED]` just because its key contains
 * `session`/`token`/… See the note above.
 *
 * `redactString` runs on every surviving string leaf. Callers should pass the
 * tool-output string pass (`redactAiToolOutputText`, which layers the bare
 * vendor-token shapes on top of `redactLogMessage`) so a secret sitting under a
 * key that names nothing sensitive is still caught by its shape. It is injected
 * rather than imported to keep this module free of a cycle back into
 * `aiToolOutput`.
 */
export function redactToolOutputFields(
  value: unknown,
  redactString: (text: string) => string = redactLogMessage,
  depth = 0
): unknown {
  return redactFieldsWith(value, redactString, depth, toolOutputFieldPolicy);
}

// ---------------------------------------------------------------------------
// Value-shape redaction (#3109)
//
// The rules above are a KEY-NAME denylist: they blank a value whose *key* looks
// sensitive, and otherwise only match secret-*assignment* shapes inside a
// string. That leaves a hole for any value that EMBEDS an identifier rather
// than BEING one — the reported case was a Windows `DOMAIN\user` scrubbed from
// the `session` key and preserved verbatim inside the `error` string of the very
// same agent_logs row, because `(session "helper-DOMAIN\\HOST$-65864")` has no
// key shape around it.
//
// The pass below matches on the shape of the VALUE, so it fires regardless of
// which key carries it.
//
// SCOPE — deliberately NOT wired into redactLogMessage/redactLogFields.
// Those two are shared by callers where these shapes are the payload, not a
// leak, and scrubbing them would destroy the feature:
//   * services/aiToolOutput.ts redactAiToolOutputText — tool output handed to
//     the LLM; the network tools exist to report addresses and paths.
//   * services/aiToolOutput.ts redactSensitiveToolInput — persisted
//     ai_messages.tool_input; a path argument is the argument.
//   * jobs/dnsSyncJob.ts / jobs/s1Sync.ts / services/sentinelOne/actions.ts —
//     lastSyncError, where the unreachable host or IP IS the diagnostic.
//   * services/auditPayloadSanitizer.ts — audit payloads legitimately record
//     addresses and paths.
// Only the agent-log path (ingest in routes/agents/logs.ts, and every read via
// redactAgentLogRow) composes it, via redactAgentLogMessage below.
// ---------------------------------------------------------------------------

/**
 * Pre-#3109 helper session ids: `helper-<username>-<pid>`, and the Tauri assist
 * helper's `assist-<username>-<pid>` (apps/helper/src-tauri/src/ipc/client.rs).
 * The agent now mints an opaque `helper-<16 hex>` instead, but deployed agents
 * keep sending the old grammar until the fleet rolls, so ingest still has to
 * strip it. The trailing `-<digits>` is required, which is exactly what the new
 * opaque form lacks — so this never matches a post-fix id.
 *
 * The middle segment is length-bounded on purpose. `agentLogEntrySchema.message`
 * (routes/agents/schemas.ts) has no max length, so this runs on unbounded,
 * agent-supplied text; an unbounded `\\S*` here backtracks over the whole tail
 * once per `helper-` occurrence, which is quadratic — a 293KB message packed
 * with `helper-` prefixes took 116ms, and 500 of those are allowed per request.
 * A bounded quantifier caps the work per match attempt and keeps ingest linear.
 * Excluding quotes also stops a match escaping its quoted context.
 */
const LEGACY_HELPER_SESSION_ID = /\b(helper|assist)-[^\s"']{1,128}-\d{1,10}\b/g;

/** `C:\Users\jdoe\…`, `D:\Documents and Settings\jdoe\…` — keep the path, drop the name. */
const WINDOWS_PROFILE_PATH = /([A-Za-z]:\\(?:Users|Documents and Settings)\\)([^\\/:*?"<>|\r\n]+)/gi;

/** `/home/jdoe/…`, `/Users/jdoe/…`, `/var/home/jdoe/…`. */
const UNIX_HOME_PATH = /(\/(?:var\/)?(?:home|Users)\/)([^/\s:"'\\]+)/g;

/** UNC share `\\FILESRV01\share\…` — the host is the identifier, the share is not. */
const UNC_HOST = /(\\\\)([A-Za-z0-9._-]{1,63})(?=\\)/g;

/**
 * Windows machine account `DOMAIN\HOST$`. Restricted to the `$`-suffixed
 * machine-account form on purpose: a bare `DOMAIN\user` is not distinguishable
 * by shape from a relative Windows path (`scripts\install.ps1`), so matching it
 * would shred ordinary log text. Removing the identity at the source
 * (agent/internal/userhelper/sessionid.go) is what covers the plain-user case.
 */
const WINDOWS_MACHINE_ACCOUNT = /(?<![\\/:\w])[A-Za-z0-9._-]{1,63}\\[A-Za-z0-9._-]{1,63}\$/g;

/** `username=jdoe`, `user: CONTOSO\jdoe`, `upn: jdoe@contoso.com`. */
const USERNAME_ASSIGNMENT =
  /\b((?:user(?:name)?|login|samaccountname|upn)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;)&]+)/gi;

const IPV4_CANDIDATE = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;

/**
 * A colon-separated hex run. The replacer below only redacts it when it is
 * genuinely an IPv6 literal (contains `::`, or has all 8 hextets), which keeps
 * clock times (`14:23:45`) and MAC addresses (six groups, no `::`) intact.
 */
const IPV6_CANDIDATE = /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:.])/g;

/**
 * True for an address that identifies a subscriber or a public endpoint.
 *
 * Private, loopback, link-local, CGNAT, documentation and multicast addresses
 * are deliberately KEPT. They are internal topology the MSP already administers
 * and displays as first-class device data (`devices.ipAddress`), so scrubbing
 * them buys no privacy while destroying the diagnostic value of network
 * discovery and connectivity logs — the highest-volume users of this path. A
 * globally routable address, by contrast, identifies a customer site.
 */
function isRoutableIPv4(literal: string): boolean {
  const parts = literal.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  // A dotted quad with an out-of-range octet is a version string, not an
  // address (`schema 999.888.777.666`). Leave it alone.
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  const [a = -1, b = -1, c = -1] = octets;
  if (a === 0 || a === 127) return false; // unspecified / loopback
  if (a === 10) return false; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT, RFC6598
  if (a === 169 && b === 254) return false; // link-local
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking, RFC2544
  if (a === 192 && b === 0 && c === 2) return false; // documentation, RFC5737
  if (a === 198 && b === 51 && c === 100) return false; // documentation, RFC5737
  if (a === 203 && b === 0 && c === 113) return false; // documentation, RFC5737
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Global unicast is 2000::/3; every other IPv6 range in a LAN log is local. */
function isRoutableIPv6(token: string): boolean {
  const compressed = token.includes('::');
  const hextets = token.split(':').filter((part) => part !== '');
  if (!compressed && hextets.length !== 8) return false; // a clock or a MAC
  const leading = hextets[0];
  if (leading === undefined) return false; // bare `::`
  const first = Number.parseInt(leading, 16);
  if (!Number.isFinite(first)) return false;
  if (compressed && token.startsWith('::')) return false; // ::1, ::ffff:… loopback/mapped
  return first >= 0x2000 && first <= 0x3fff;
}

/**
 * Redact host- and user-identifying shapes from a string, regardless of the key
 * that carries it. Agent-log path only — see the SCOPE note above.
 */
export function redactSensitiveValueShapes(text: string): string {
  return text
    .replace(LEGACY_HELPER_SESSION_ID, (_m, prefix: string) => `${prefix}-${REDACTED}`)
    .replace(WINDOWS_PROFILE_PATH, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(UNIX_HOME_PATH, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(UNC_HOST, (_m, slashes: string) => `${slashes}${REDACTED}`)
    .replace(WINDOWS_MACHINE_ACCOUNT, REDACTED)
    .replace(USERNAME_ASSIGNMENT, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(IPV4_CANDIDATE, (match) => (isRoutableIPv4(match) ? REDACTED : match))
    .replace(IPV6_CANDIDATE, (match) => (isRoutableIPv6(match) ? REDACTED : match));
}

/**
 * The agent-log string pass: the shared secret-assignment rules PLUS the
 * value-shape rules. Used at ingest (routes/agents/logs.ts) and on every read
 * (redactAgentLogRow), so a row stored before this shipped is scrubbed on the
 * way out too.
 */
export function redactAgentLogMessage(message: string): string {
  return redactSensitiveValueShapes(redactLogMessage(message));
}

/** redactLogFields with the agent-log string pass applied to every leaf. */
export function redactAgentLogFields(value: unknown, depth = 0): unknown {
  return redactFieldsWith(value, redactAgentLogMessage, depth);
}

export function redactAgentLogRow<T extends { message?: unknown; fields?: unknown }>(row: T): T {
  return {
    ...row,
    message: typeof row.message === 'string' ? redactAgentLogMessage(row.message) : row.message,
    fields: row.fields == null ? row.fields : redactAgentLogFields(row.fields),
  };
}
