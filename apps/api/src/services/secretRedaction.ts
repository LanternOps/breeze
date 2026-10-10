/**
 * Server-side secret redaction for agent-reported command output.
 *
 * This mirrors the agent-side `SanitizeOutput` redaction rules
 * (`agent/internal/executor/security.go`) and exists as a defense-in-depth
 * layer: agent-side redaction only protects output produced by agents that
 * have already updated, so we ALSO strip secrets here at ingest time so that
 * pre-update agents (which persist stdout/stderr verbatim) can never store a
 * reconstructable private key, cloud credential, or bearer token that
 * `scripts:read` users could later view.
 *
 * Every pattern is ReDoS-safe: there are no nested quantifiers and any
 * open-ended span is either a single character class (`[^\s]+`, `[A-Za-z...]*`)
 * or a length-bounded `[\s\S]{0,N}?` gap, so each match attempt is linear in
 * the input length even on adversarial, attacker-controlled stdout.
 *
 * Private-key handling is a two-pass strategy (order matters):
 *   1. COMPLETE_PRIVATE_KEY_BLOCK removes a full PEM block (header + body +
 *      footer). The BEGIN/END gap is bounded to 16 KiB via `[\s\S]{0,16384}?`
 *      — a PEM private-key body is well under 8 KiB even for RSA-4096, so this
 *      is safe headroom while keeping the match bounded (the old unbounded
 *      `[\s\S]*?` backtracked ~O(n²) on many BEGIN markers with no END, which
 *      blocked the event loop). The optional algorithm token covers PKCS#8
 *      `-----BEGIN PRIVATE KEY-----` alongside RSA/EC/DSA/OPENSSH/ENCRYPTED.
 *   2. TRUNCATED_PRIVATE_KEY strips a lone BEGIN header plus any immediately
 *      following base64/whitespace body when the END marker is missing (output
 *      truncated by the size cap or a killed process). It runs AFTER pass 1 so
 *      complete `-----END-----` markers are already consumed. The trailing span
 *      is a single greedy character class (linear, no nested quantifiers).
 *
 * `[\s\S]` (not `.` with a dotAll flag) is what actually matches newlines here;
 * only the `g` flag is set. Kept dependency-free and backed by precompiled
 * RegExps so it is cheap to run on every persisted result.
 */

// The rule set lives in the leaf module ./redactionPatterns (shared with
// diagnostic-read redaction); re-exported here for existing importers.
import { SECRET_OUTPUT_REDACTIONS } from './redactionPatterns';
export { SECRET_OUTPUT_REDACTIONS };

/**
 * Redacts private-key blocks and other well-known secrets (AWS keys, bearer
 * tokens, JWTs, connection strings, `secret=`-style pairs) from agent output
 * before persistence, mirroring the agent's own `SanitizeOutput`.
 */
export function redactSecretsFromOutput(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_OUTPUT_REDACTIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Null/undefined-preserving variant of {@link redactSecretsFromOutput} for
 * optional free-text columns (errorMessage, errorLog, lastError, ...): the
 * stored shape must stay `null`/`undefined` when the agent sent nothing.
 */
export function redactOptionalSecretText<T extends string | null | undefined>(
  text: T
): T {
  return (text != null ? redactSecretsFromOutput(text) : text) as T;
}

/**
 * Shared chokepoint (#2434) for agent command-result ingest: returns the
 * result with its free-text `error` and `stderr` fields redacted so EVERY
 * downstream persistence surface (script_executions, backup/restore jobs,
 * vault sync state, CIS results, tunnel/remote sessions, discovery jobs, ...)
 * receives already-redacted text and new per-type handlers cannot forget to
 * redact. `stdout` is intentionally NOT touched here: several handlers parse
 * stdout as structured JSON, and artifact-bearing stdout (capture_pprof) must
 * stay byte-for-byte — stdout redaction stays at the persistence sites that
 * store it (buildStoredCommandResult / handleScriptResult), keyed by command
 * type. Redaction is idempotent, so double-redaction downstream is harmless.
 */
export function redactAgentResultErrorFields<
  T extends { error?: string | null; stderr?: string | null }
>(result: T): T {
  if (result.error == null && result.stderr == null) return result;
  return {
    ...result,
    error: redactOptionalSecretText(result.error),
    stderr: redactOptionalSecretText(result.stderr),
  } as T;
}

/**
 * Recursion bound for {@link redactSecretsDeep}. Generous: agent `details` /
 * `findings` blobs are a handful of levels deep in practice, and the payloads
 * are already size-capped upstream (1 MB command-result cap, body limits on the
 * REST ingests), so this only ever trips on pathological input.
 */
const MAX_DEEP_REDACTION_DEPTH = 32;

/**
 * Recursively redacts every string value inside an agent-supplied JSON blob
 * before it is persisted to a jsonb column (e.g. network monitor result
 * `details`, service/process check `details`, CIS findings). Non-string scalars
 * and object KEYS are left untouched — only values are rewritten, so parsers
 * that key off field names keep working.
 *
 * The depth bound FAILS CLOSED. Returning an over-deep subtree as-is would hand
 * an attacker a trivial bypass: nest the secret one level below the bound and it
 * is persisted verbatim. Instead, at the bound we serialize the remaining
 * subtree, run the flat redactor over that text, and reparse — so no raw string
 * can survive at any depth, while the structure is preserved. (JSON.stringify
 * also throws on a cycle, which the catch turns into a fully-redacted string
 * rather than a hang.)
 */
export function redactSecretsDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecretsFromOutput(value);
  if (value == null || typeof value !== 'object') return value;

  // Non-plain objects must pass through BY REFERENCE. `Object.entries(new Date())`
  // is `[]`, so walking a Date would rebuild it as `{}` — it loses toISOString(),
  // Drizzle's timestamp mapper throws on insert, the caller's try/catch swallows
  // it, and the row silently never persists. Same for the other carriers that can
  // ride a result blob. None of these can hold a secret in a string field we'd
  // otherwise reach, so passing them through costs no coverage.
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    Buffer.isBuffer(value) ||
    ArrayBuffer.isView(value) ||
    value instanceof Map ||
    value instanceof Set
  ) {
    return value;
  }

  if (depth >= MAX_DEEP_REDACTION_DEPTH) {
    try {
      return JSON.parse(redactSecretsFromOutput(JSON.stringify(value)));
    } catch {
      // Cyclic or non-serializable: drop the subtree rather than persist it raw.
      return '[REDACTED_UNSERIALIZABLE]';
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsDeep(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactSecretsDeep(entry, depth + 1);
  }
  return out;
}
