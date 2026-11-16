import { describe, expect, it } from 'vitest';
import { updateHardwareSchema } from './schemas';

describe('tpmAvailable on the hardware report (#8318 T1, §12.1)', () => {
  it('takes a boolean and drops anything else without failing the report', () => {
    expect(updateHardwareSchema.parse({ tpmAvailable: false }).tpmAvailable).toBe(false);
    expect(updateHardwareSchema.parse({ tpmAvailable: true }).tpmAvailable).toBe(true);
    for (const value of ['yes', 1, null, {}]) {
      const parsed = updateHardwareSchema.safeParse({ serialNumber: 'SN1', tpmAvailable: value });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.tpmAvailable).toBeUndefined();
    }
  });

  it('never carries the EK baseline: only the attestation route writes it (§5.1)', () => {
    const parsed = updateHardwareSchema.parse({
      serialNumber: 'SN1',
      tpmEkPubSha256: 'a'.repeat(64),
      tpmAttestedAt: '2026-01-01T00:00:00Z',
      tpmEkMismatchSha256: 'b'.repeat(64),
      tpmEkMismatchAt: '2026-01-01T00:00:00Z',
    }) as Record<string, unknown>;
    for (const key of ['tpmEkPubSha256', 'tpmAttestedAt', 'tpmEkMismatchSha256', 'tpmEkMismatchAt']) {
      expect(parsed).not.toHaveProperty(key);
    }
  });
});
