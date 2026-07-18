import { describe, expect, it } from 'vitest';
import {
  encodePartnerExportIdentityComponents,
  stablePartnerExportAddressUuid,
  stablePartnerExportInterfaceUuid,
  stablePartnerExportUuid,
  stablePartnerExportVmUuid,
} from './identity';

describe('partner export stable identities', () => {
  it('emits deterministic UUIDs with the configured RFC version and variant bits', () => {
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

  it.each([
    ['interface', stablePartnerExportInterfaceUuid('55555555-5555-4555-8555-555555555555', 'Ethernet', '00:11:22:33:44:55')],
    ['address', stablePartnerExportAddressUuid('55555555-5555-4555-8555-555555555555', 'Ethernet', '10.0.0.10', 'ipv4')],
    ['virtual machine', stablePartnerExportVmUuid('55555555-5555-4555-8555-555555555555', 'vm-guid')],
  ])('emits an RFC-valid deterministic UUID for a representative %s identity', (_kind, value) => {
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it('encodes derived identity components as a canonical JSON text array', () => {
    expect(encodePartnerExportIdentityComponents(['device:a', 'Ethernet:1', ''])).toBe(
      '["device:a","Ethernet:1",""]',
    );
  });

  it('does not collide when delimiters move between identity components', () => {
    expect(stablePartnerExportInterfaceUuid('device:a', 'Ethernet', null)).not.toBe(
      stablePartnerExportInterfaceUuid('device', 'a:Ethernet', null),
    );
  });
});
