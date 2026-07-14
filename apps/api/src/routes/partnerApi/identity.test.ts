import { describe, expect, it } from 'vitest';
import { stablePartnerExportUuid } from './identity';

describe('partner export stable identities', () => {
  it('emits deterministic RFC UUIDv5/version and variant bits', () => {
    const first = stablePartnerExportUuid('device-inventory:device', '55555555-5555-4555-8555-555555555555');
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(stablePartnerExportUuid('device-inventory:device', '55555555-5555-4555-8555-555555555555')).toBe(first);
  });

  it('separates resource and subject-type collision domains', () => {
    const source = '44444444-4444-4444-8444-444444444444';
    expect(new Set([
      stablePartnerExportUuid('device-inventory:device', source),
      stablePartnerExportUuid('device-inventory:site', source),
      stablePartnerExportUuid('device-software:device', source),
      stablePartnerExportUuid('device-relationships:device', source),
      stablePartnerExportUuid('device-relationships:site', source),
    ]).size).toBe(5);
  });
});
