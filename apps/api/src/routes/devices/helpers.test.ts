import { describe, it, expect } from 'vitest';
import { stripSensitiveDeviceFields } from './helpers';

// SR-008 (systemic twin): GET /devices/:id spreads the full device row to the
// client. Credential verifiers + mTLS material must never reach any client,
// even an authenticated same-tenant dashboard user.

describe('stripSensitiveDeviceFields (SR-008)', () => {
  const sensitive = {
    agentTokenHash: 'a'.repeat(64),
    previousTokenHash: 'b'.repeat(64),
    watchdogTokenHash: 'c'.repeat(64),
    previousWatchdogTokenHash: 'd'.repeat(64),
    helperTokenHash: 'e'.repeat(64),
    previousHelperTokenHash: 'f'.repeat(64),
    tokenIssuedAt: new Date(),
    watchdogTokenIssuedAt: new Date(),
    helperTokenIssuedAt: new Date(),
    previousTokenExpiresAt: new Date(),
    previousWatchdogTokenExpiresAt: new Date(),
    previousHelperTokenExpiresAt: new Date(),
    mtlsCertSerialNumber: 'SERIAL123',
    mtlsCertCfId: 'cf-cert-id',
    mtlsCertExpiresAt: new Date(),
    mtlsCertIssuedAt: new Date(),
  };
  const safe = {
    id: 'dev-1',
    orgId: 'org-1',
    hostname: 'host-1',
    status: 'online',
    osType: 'linux',
    customFields: { k: 'v' },
  };

  it('removes every credential verifier and mTLS field', () => {
    const out = stripSensitiveDeviceFields({ ...safe, ...sensitive }) as Record<string, unknown>;
    for (const key of Object.keys(sensitive)) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it('preserves all non-sensitive operational fields', () => {
    const out = stripSensitiveDeviceFields({ ...safe, ...sensitive }) as Record<string, unknown>;
    expect(out).toEqual(safe);
  });

  it('does not mutate the input object (internal logic still needs the full row)', () => {
    const input = { ...safe, ...sensitive };
    stripSensitiveDeviceFields(input);
    expect(input.agentTokenHash).toBe('a'.repeat(64));
  });
});
