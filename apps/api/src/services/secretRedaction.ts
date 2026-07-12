/**
 * Server-side secret redaction for agent-reported command output.
 *
 * This mirrors the agent-side `SanitizeOutput` private-key rule
 * (`agent/internal/executor/security.go`) and exists as a defense-in-depth
 * layer: agent-side redaction only protects output produced by agents that
 * have already updated, so we ALSO strip private keys here at ingest time so
 * that pre-update agents (which persist stdout/stderr verbatim) can never
 * store a reconstructable private key that `scripts:read` users could view.
 *
 * The regex removes the ENTIRE PEM block (header + base64 body + footer),
 * not just the header line. The algorithm token is optional so PKCS#8
 * `-----BEGIN PRIVATE KEY-----` is covered alongside the
 * RSA/EC/DSA/OPENSSH/ENCRYPTED forms. The `s` (dotAll) flag lets `.` match
 * newlines; the non-greedy `*?` stops at the first END marker so two separate
 * keys in one string are each redacted individually rather than as one span.
 *
 * Kept dependency-free and backed by a single precompiled RegExp so it is
 * cheap to run on every persisted result.
 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;

const PRIVATE_KEY_REPLACEMENT = '[PRIVATE_KEY_REDACTED]';

/**
 * Redacts full PEM private-key blocks from agent output before persistence.
 *
 * Returns '' for null/undefined so callers can safely persist the result
 * without extra null handling.
 */
export function redactSecretsFromOutput(text: string | null | undefined): string {
  if (text === null || text === undefined) {
    return '';
  }
  return text.replace(PRIVATE_KEY_BLOCK, PRIVATE_KEY_REPLACEMENT);
}
