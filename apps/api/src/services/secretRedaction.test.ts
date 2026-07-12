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
  it('returns empty string for null/undefined', () => {
    expect(redactSecretsFromOutput(null)).toBe('');
    expect(redactSecretsFromOutput(undefined)).toBe('');
  });

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
});
