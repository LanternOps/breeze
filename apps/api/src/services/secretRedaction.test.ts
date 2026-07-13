import { describe, it, expect } from 'vitest';
import {
  redactSecretsFromOutput,
  redactOptionalSecretText,
  redactAgentResultErrorFields,
  redactSecretsDeep,
} from './secretRedaction';

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

describe('redactOptionalSecretText (#2434)', () => {
  it('preserves null and undefined', () => {
    expect(redactOptionalSecretText(null)).toBeNull();
    expect(redactOptionalSecretText(undefined)).toBeUndefined();
  });

  it('redacts a non-null value', () => {
    const out = redactOptionalSecretText('password=SuperSecret123');
    expect(out).not.toContain('SuperSecret123');
  });
});

describe('redactAgentResultErrorFields (#2434 chokepoint)', () => {
  const pem =
    '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKe0m0h\n-----END RSA PRIVATE KEY-----';

  it('redacts error and stderr but leaves stdout and structured result untouched', () => {
    const result = {
      status: 'failed',
      stdout: `stdout keeps raw: ${pem}`,
      stderr: `stderr: ${pem}`,
      error: `error: ${pem}`,
      result: { key: pem },
    };
    const out = redactAgentResultErrorFields(result);
    expect(out.error).toContain('[PRIVATE_KEY_REDACTED]');
    expect(out.stderr).toContain('[PRIVATE_KEY_REDACTED]');
    // stdout is deliberately untouched here (structured-JSON consumers +
    // capture_pprof artifacts) — its persisted forms are redacted per-site.
    expect(out.stdout).toContain('BEGIN RSA PRIVATE KEY');
    expect(out.result).toBe(result.result);
    expect(out.status).toBe('failed');
  });

  it('returns the same object when there is nothing to redact', () => {
    const result: { status: 'completed'; error?: string; stderr?: string } = {
      status: 'completed',
    };
    expect(redactAgentResultErrorFields(result)).toBe(result);
  });
});

describe('redactSecretsDeep (#2434)', () => {
  const pem =
    '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKe0m0h\n-----END RSA PRIVATE KEY-----';

  it('redacts strings nested in objects and arrays', () => {
    const out = redactSecretsDeep({
      error: `top: ${pem}`,
      list: [`item: ${pem}`, 42, null],
      nested: { deeper: { hint: `deep: ${pem}` } },
      count: 3,
      flag: true,
    }) as Record<string, unknown>;

    expect(JSON.stringify(out)).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(out.error).toContain('[PRIVATE_KEY_REDACTED]');
    expect((out.list as unknown[])[0]).toContain('[PRIVATE_KEY_REDACTED]');
    expect((out.list as unknown[])[1]).toBe(42);
    expect(((out.nested as any).deeper.hint)).toContain('[PRIVATE_KEY_REDACTED]');
    expect(out.count).toBe(3);
    expect(out.flag).toBe(true);
  });

  it('passes through scalars and nullish values', () => {
    expect(redactSecretsDeep(null)).toBeNull();
    expect(redactSecretsDeep(7)).toBe(7);
    expect(redactSecretsDeep(undefined)).toBeUndefined();
  });

  it('FAILS CLOSED past the recursion bound — an over-nested secret cannot escape', () => {
    // A hostile agent nests the key deeper than the recursion bound to dodge
    // redaction. If the bound returned the subtree as-is, this would persist
    // the PEM verbatim. 64 levels is double MAX_DEEP_REDACTION_DEPTH.
    let nested: Record<string, unknown> = { key: pem };
    for (let i = 0; i < 64; i++) nested = { deeper: nested };

    const out = redactSecretsDeep(nested);
    const serialized = JSON.stringify(out);
    expect(serialized).toContain('[PRIVATE_KEY_REDACTED]');
    expect(serialized).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(serialized).not.toContain('MIIBOgIBAAJBAKe0m0h');
  });

  it('passes a Date through BY REFERENCE — a generic walk would flatten it to {}', () => {
    // Object.entries(new Date()) === [], so an unguarded walk rebuilds a Date as
    // {} and it loses toISOString(). Drizzle's timestamp mapper then throws on
    // insert, the caller's try/catch swallows it, and the row silently never
    // persists (this shipped as a real bug in the first cut of this PR: it took
    // out the CIS *success* path while failed scans kept writing).
    const checkedAt = new Date('2026-07-13T00:00:00Z');
    const out = redactSecretsDeep({
      checkedAt,
      findings: [{ message: `key: ${pem}` }],
    }) as { checkedAt: unknown; findings: unknown };

    expect(out.checkedAt).toBeInstanceOf(Date);
    expect((out.checkedAt as Date).toISOString()).toBe('2026-07-13T00:00:00.000Z');
    // ...while still redacting the strings alongside it.
    expect(JSON.stringify(out.findings)).toContain('[PRIVATE_KEY_REDACTED]');
  });

  it('does not hang or leak on a cyclic structure', () => {
    const cyclic: Record<string, unknown> = { note: `key: ${pem}` };
    cyclic.self = cyclic;

    const serialized = JSON.stringify(redactSecretsDeep(cyclic));
    expect(serialized).not.toContain('BEGIN RSA PRIVATE KEY');
  });
});
