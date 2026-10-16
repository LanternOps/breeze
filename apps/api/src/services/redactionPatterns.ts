/**
 * Secret-redaction rule sets, in a leaf module with no imports.
 *
 * The redactors that apply them (secretRedaction.ts, logRedaction.ts,
 * aiToolOutput.ts) re-export them, and diagnosticAccess/contentRedaction.ts
 * reads them directly to find redaction spans. Keeping them here means a test
 * that mocks one of those redactor modules wholesale never removes a rule set
 * another module depends on.
 *
 * Each RegExp is global and shared: callers that iterate with exec/matchAll
 * must use their own copy (contentRedaction.ts clones them).
 */

const PRIVATE_KEY_REPLACEMENT = '[PRIVATE_KEY_REDACTED]';

// Pass 1: complete PEM block, BEGIN→END gap bounded to 16 KiB (ReDoS-safe).
const COMPLETE_PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]{0,16384}?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;

// Pass 2: truncated key (BEGIN header + base64 body, END missing). Single
// greedy char-class span = linear, no nested quantifiers.
const TRUNCATED_PRIVATE_KEY =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[A-Za-z0-9+/=\s]*/g;

/**
 * Ordered redaction rules mirrored from `SanitizeOutput` in
 * `agent/internal/executor/security.go`. Applied sequentially in this order so
 * server-side behavior matches what up-to-date agents already do to their own
 * output — no new false-positive surface beyond what the fleet already redacts.
 */
export const SECRET_OUTPUT_REDACTIONS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // api_key/apikey/token/secret/password/passwd/pwd = <value> pairs.
  {
    pattern:
      /(api[_-]?key|apikey|token|secret|password|passwd|pwd)\s*[=:]\s*['"]?[a-zA-Z0-9_-]{8,}['"]?/gi,
    replacement: '$1=[REDACTED]',
  },
  // AWS access key IDs.
  { pattern: /AKIA[0-9A-Z]{16}/gi, replacement: '[AWS_KEY_REDACTED]' },
  // Private keys — complete block first, then truncated fallback.
  { pattern: COMPLETE_PRIVATE_KEY_BLOCK, replacement: PRIVATE_KEY_REPLACEMENT },
  { pattern: TRUNCATED_PRIVATE_KEY, replacement: PRIVATE_KEY_REPLACEMENT },
  // Connection strings (mongodb/mysql/postgresql/redis/amqp URIs).
  {
    pattern: /(mongodb|mysql|postgresql|redis|amqp):\/\/[^\s]+/gi,
    replacement: '$1://[CONNECTION_STRING_REDACTED]',
  },
  // Bearer tokens.
  { pattern: /bearer\s+[a-zA-Z0-9_\-.]+/gi, replacement: 'Bearer [TOKEN_REDACTED]' },
  // JWTs (header.payload.signature).
  {
    pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
    replacement: '[JWT_REDACTED]',
  },
];

/**
 * Secret-assignment rules (logRedaction.ts redactLogMessage). Every pattern
 * keeps its capture group 1 (the key) and redacts the rest.
 */
export const SECRET_ASSIGNMENT_PATTERNS: readonly RegExp[] = [
  /\b(authorization\s*:\s*bearer\s+)[^\s,;]+/gi,
  // Includes `auth=` to catch Pi-hole's URL pattern `?auth=<apiKey>` —
  // these can leak into Node fetch error messages whose .cause echoes
  // the URL verbatim.
  /\b((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|community|authpassphrase|privacypassphrase|auth)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
  /\b(Cookie\s*:\s*)[^\r\n]+/g,
];

/** Whole-match vendor-token shapes (aiToolOutput.ts redactAiToolOutputText). */
export const BARE_SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g,
];
