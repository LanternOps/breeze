import { describe, it, expect } from 'vitest';
import { redactSecretsFromOutput } from './secretRedaction';

// A representative base64 body line that must never survive redaction.
const KEY_BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDb1234567890abcd';

const REDACTED = '[PRIVATE_KEY_REDACTED]';

function pemBlock(label: string): string {
  const header = `-----BEGIN ${label}-----`;
  const footer = `-----END ${label}-----`;
  return `${header}\n${KEY_BODY}\nAnOtHeRlInE0987654321\n${footer}`;
}

describe('redactSecretsFromOutput', () => {
  it('redacts a PKCS#8 private key block (optional algorithm token)', () => {
    const input = `before\n${pemBlock('PRIVATE KEY')}\nafter`;
    const out = redactSecretsFromOutput(input);
    expect(out).not.toContain(KEY_BODY);
    expect(out).not.toContain('-----BEGIN PRIVATE KEY-----');
    expect(out).not.toContain('-----END PRIVATE KEY-----');
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).toContain(REDACTED);
  });

  it('redacts an RSA private key block including body and END marker', () => {
    const out = redactSecretsFromOutput(pemBlock('RSA PRIVATE KEY'));
    expect(out).not.toContain(KEY_BODY);
    expect(out).not.toContain('RSA PRIVATE KEY');
    expect(out).toBe(REDACTED);
  });

  it('redacts an OPENSSH private key block', () => {
    const out = redactSecretsFromOutput(pemBlock('OPENSSH PRIVATE KEY'));
    expect(out).not.toContain(KEY_BODY);
    expect(out).not.toContain('OPENSSH PRIVATE KEY');
    expect(out).toBe(REDACTED);
  });

  it('redacts an ENCRYPTED private key block', () => {
    const out = redactSecretsFromOutput(pemBlock('ENCRYPTED PRIVATE KEY'));
    expect(out).not.toContain(KEY_BODY);
    expect(out).not.toContain('ENCRYPTED PRIVATE KEY');
    expect(out).toBe(REDACTED);
  });

  it('redacts two keys in one string individually', () => {
    const input = `${pemBlock('RSA PRIVATE KEY')}\nmiddle text\n${pemBlock('OPENSSH PRIVATE KEY')}`;
    const out = redactSecretsFromOutput(input);
    expect(out).not.toContain(KEY_BODY);
    expect(out).not.toContain('-----END RSA PRIVATE KEY-----');
    expect(out).not.toContain('-----END OPENSSH PRIVATE KEY-----');
    expect(out).toContain('middle text');
    // Non-greedy match: each key is its own redaction marker.
    expect(out.match(/\[PRIVATE_KEY_REDACTED\]/g)).toHaveLength(2);
  });

  it('passes through non-key text unchanged', () => {
    const input = 'just a normal script output with no secrets';
    expect(redactSecretsFromOutput(input)).toBe(input);
  });

  // --- ReDoS: pathological input must complete quickly, not hang the loop. ---
  it('handles pathological BEGIN-only input in bounded time', () => {
    // 30k BEGIN markers (~0.8 MB) with NO END marker. Under the old unbounded
    // `[\s\S]*?` PEM regex each BEGIN scanned to end-of-string, so this
    // backtracked ~O(n²) and would run for many minutes, blocking the event
    // loop. With the 16 KiB-bounded gap each match attempt is bounded → linear
    // (~1 s idle vs. effectively non-terminating before).
    const input = '-----BEGIN PRIVATE KEY-----'.repeat(30_000);
    const start = Date.now();
    const out = redactSecretsFromOutput(input);
    const elapsed = Date.now() - start;
    expect(typeof out).toBe('string');
    // Deliberately loose ceiling: this only needs to separate linear behavior
    // (seconds, even on a loaded shared CI runner or under parallel local
    // forks) from the old ReDoS behavior (minutes / never returns, which the
    // 30 s test timeout catches). A tight bound flaked on CI (6.7 s at 100k
    // markers) and under local parallel runs.
    expect(elapsed).toBeLessThan(20_000);
    // The lone headers are stripped by the truncated-key fallback.
    expect(out).not.toContain('-----BEGIN PRIVATE KEY-----');
    expect(out).toContain(REDACTED);
  }, 30_000);

  // --- Truncated key: header + body but no END must still be fully redacted. ---
  it('redacts a truncated private key (BEGIN + body, no END marker)', () => {
    const input = `logs before\n-----BEGIN RSA PRIVATE KEY-----\n${KEY_BODY}\nAnOtHeRlInE0987654321`;
    const out = redactSecretsFromOutput(input);
    expect(out).not.toContain(KEY_BODY);
    expect(out).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(out).toContain('logs before');
    expect(out).toContain(REDACTED);
  });

  // --- Ported patterns from the agent's SanitizeOutput. ---
  it('redacts AWS access key IDs', () => {
    const out = redactSecretsFromOutput('key is AKIAIOSFODNN7EXAMPLE here');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[AWS_KEY_REDACTED]');
  });

  it('redacts bearer tokens', () => {
    const out = redactSecretsFromOutput('Authorization: Bearer abc123.def-456_XYZ');
    expect(out).not.toContain('abc123.def-456_XYZ');
    expect(out).toContain('Bearer [TOKEN_REDACTED]');
  });

  it('redacts password= / token= / secret= style pairs', () => {
    const out = redactSecretsFromOutput('DB_PASSWORD=SuperSecret123 and token: abcd1234efgh');
    expect(out).not.toContain('SuperSecret123');
    expect(out).not.toContain('abcd1234efgh');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts connection strings', () => {
    const out = redactSecretsFromOutput('conn postgresql://user:pass@host:5432/db extra');
    expect(out).not.toContain('user:pass@host');
    expect(out).toContain('postgresql://[CONNECTION_STRING_REDACTED]');
  });

  it('redacts JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = redactSecretsFromOutput(`JWT ${jwt} done`);
    expect(out).not.toContain(jwt);
    expect(out).toContain('[JWT_REDACTED]');
  });
});
