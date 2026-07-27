import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isSecretBearingTool,
  sealToolSecrets,
  assertNoPlaintextSecret,
  SECRET_UNAVAILABLE_TEXT,
  type SecretToolResult,
} from './secretBearingTools';
import { TEMP_PASSWORD_ENC_KEY, TEMP_PASSWORD_SEAL_FAILED_KEY } from './resultSecrets';

const PW = 'Bz9!oVnL920blvsjqqMy';

describe('isSecretBearingTool', () => {
  it('matches both reset tools bare and mcp-prefixed', () => {
    expect(isSecretBearingTool('m365_reset_password')).toBe(true);
    expect(isSecretBearingTool('google_reset_password')).toBe(true);
    expect(isSecretBearingTool('mcp__breeze__m365_reset_password')).toBe(true);
    expect(isSecretBearingTool('mcp__breeze__google_reset_password')).toBe(true);
  });

  it('does not match non-secret tools', () => {
    expect(isSecretBearingTool('m365_disable_user')).toBe(false);
    expect(isSecretBearingTool('google_suspend_user')).toBe(false);
  });

  it('normalizes any mcp__<server>__ prefix, not just mcp__breeze__', () => {
    // Regression: a narrower local normalization here fails OPEN — it gates
    // both the pre-execution refusal and assertNoPlaintextSecret, so a tool
    // name this predicate fails to recognize as secret-bearing silently
    // turns both guards into no-ops.
    expect(isSecretBearingTool('mcp__anything__google_reset_password')).toBe(true);
    expect(isSecretBearingTool('mcp__anything__m365_reset_password')).toBe(true);
  });
});

describe('sealToolSecrets', () => {
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.APP_ENCRYPTION_KEY_ID = 'test-key-1';
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('seals the credential and keeps it out of llmText', () => {
    const carrier: SecretToolResult = {
      kind: 'success',
      llmText: 'Reset the password for a@b.com. The temporary credential is available for one-time reveal.',
      secrets: { temporaryPassword: PW },
    };
    const { llmText, sealedResult } = sealToolSecrets(carrier);

    expect(llmText).not.toContain(PW);
    expect(sealedResult[TEMP_PASSWORD_ENC_KEY]).toMatch(/^enc:v3:/);
    expect(JSON.stringify(sealedResult)).not.toContain(PW);
  });

  it('preserves carrier meta in the sealed result', () => {
    const { sealedResult } = sealToolSecrets({
      kind: 'success',
      llmText: 'done',
      secrets: { temporaryPassword: PW },
      meta: { delegantToolCallId: 'dtc-123' },
    });
    expect(sealedResult.delegantToolCallId).toBe('dtc-123');
  });

  it('substitutes llmText when it would leak the secret', () => {
    const { llmText, sealedResult } = sealToolSecrets({
      kind: 'success',
      llmText: `Temporary password: ${PW}`,
      secrets: { temporaryPassword: PW },
    });
    expect(llmText).toBe(SECRET_UNAVAILABLE_TEXT);
    expect(llmText).not.toContain(PW);
    expect(sealedResult[TEMP_PASSWORD_ENC_KEY]).toMatch(/^enc:v3:/);
  });

  it('drops the plaintext and substitutes llmText when sealing is not v3', () => {
    delete process.env.APP_ENCRYPTION_KEY_ID;
    const { llmText, sealedResult } = sealToolSecrets({
      kind: 'success',
      llmText: 'Reset done, credential available for one-time reveal.',
      secrets: { temporaryPassword: PW },
    });
    expect(sealedResult[TEMP_PASSWORD_SEAL_FAILED_KEY]).toBe(true);
    expect(sealedResult[TEMP_PASSWORD_ENC_KEY]).toBeUndefined();
    expect(JSON.stringify(sealedResult)).not.toContain(PW);
    expect(llmText).toBe(SECRET_UNAVAILABLE_TEXT);
  });

  it('passes an error carrier through with no secret keys', () => {
    const { llmText, sealedResult } = sealToolSecrets({
      kind: 'error',
      llmText: JSON.stringify({ error: 'not_found', message: 'no such user' }),
    });
    expect(llmText).toContain('not_found');
    expect(sealedResult[TEMP_PASSWORD_ENC_KEY]).toBeUndefined();
    expect(sealedResult[TEMP_PASSWORD_SEAL_FAILED_KEY]).toBeUndefined();
  });
});

describe('assertNoPlaintextSecret', () => {
  it('accepts a sealed result for a secret-bearing tool', () => {
    expect(() => assertNoPlaintextSecret('google_reset_password', {
      [TEMP_PASSWORD_ENC_KEY]: 'enc:v3:abc',
    })).not.toThrow();
  });

  it('accepts a seal-failed marker', () => {
    expect(() => assertNoPlaintextSecret('google_reset_password', {
      [TEMP_PASSWORD_SEAL_FAILED_KEY]: true,
    })).not.toThrow();
  });

  it('throws on a legacy plaintext key', () => {
    expect(() => assertNoPlaintextSecret('google_reset_password', {
      temporaryPassword: PW,
    })).toThrow(/plaintext credential/i);
  });

  it('throws on the prose shape that caused the original leak', () => {
    expect(() => assertNoPlaintextSecret('google_reset_password', {
      raw: `Reset the password for a@b.com. Temporary password: ${PW} (the user must change it at next sign-in).`,
    })).toThrow(/plaintext credential/i);
  });

  it('ignores results for tools that never mint credentials', () => {
    expect(() => assertNoPlaintextSecret('google_suspend_user', {
      raw: 'Temporary password: whatever',
    })).not.toThrow();
  });

  it('accepts an error result that carries no credential and no marker', () => {
    // A secret-bearing tool that fails legitimately persists an error result
    // with no marker. Requiring one here would throw on every error release.
    expect(() => assertNoPlaintextSecret('google_reset_password', {
      raw: JSON.stringify({ error: 'not_found', message: 'no such user' }),
    })).not.toThrow();
  });

  it('accepts an already-redacted historical row', () => {
    expect(() => assertNoPlaintextSecret('google_reset_password', {
      raw: 'Reset the password for a@b.com. Temporary password: [REDACTED] (the user must change it at next sign-in).',
    })).not.toThrow();
  });
});

describe('seal invariant', () => {
  it('a success carrier always yields exactly one of enc or seal-failed', () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.APP_ENCRYPTION_KEY_ID = 'test-key-1';
    const withKey = sealToolSecrets({
      kind: 'success', llmText: 'ok', secrets: { temporaryPassword: PW },
    }).sealedResult;

    delete process.env.APP_ENCRYPTION_KEY_ID;
    const withoutKey = sealToolSecrets({
      kind: 'success', llmText: 'ok', secrets: { temporaryPassword: PW },
    }).sealedResult;

    for (const r of [withKey, withoutKey]) {
      const markers = [TEMP_PASSWORD_ENC_KEY, TEMP_PASSWORD_SEAL_FAILED_KEY]
        .filter((k) => k in r);
      expect(markers).toHaveLength(1);
    }
  });
});
