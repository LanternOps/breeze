/**
 * Identity at scan ingest (#5988 W03, spec §9 / F5).
 *
 * `resolveScanIdentity` is the single point `processResults` reads identity
 * from, for both the INSERT and the UPDATE branch. The manual-precedence half
 * is asserted here too, by inspecting the BOUND SQL of buildScanUpdateSet
 * rather than deep-searching the Drizzle tree (a deep search matches a pg
 * enum's `enumValues` array and passes on unfixed code —
 * memory: drizzle_condition_deep_search_matches_enum_values_vacuous).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: async <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));

import { buildScanUpdateSet, resolveScanIdentity } from './discoveryWorker';

const sqlText = (frag: unknown): string => {
  const chunks = (frag as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) => (typeof c === 'string' ? c : (c as { value?: unknown[] }).value?.join?.('') ?? ''))
    .join(' ');
};

describe('resolveScanIdentity', () => {
  it('turns the Xerox C325 scan payload into Xerox / Xerox(R) C325 Color MFP', () => {
    const identity = resolveScanIdentity(
      {
        ip: '10.0.0.5',
        mac: '00:20:00:aa:bb:cc',
        assetType: 'printer',
        methods: ['snmp'],
        model: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1',
        snmpData: {
          sysObjectId: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1',
          sysDescr: 'Xerox(R) C325 Color MFP; SS CXTGV.230.096, kernel 5.4.254-yocto-standard, All-N-1',
        },
      } as never,
      'LEXMARK INTERNATIONAL, INC.',
    );
    expect(identity.manufacturer).toBe('Xerox');
    expect(identity.model).toBe('Xerox(R) C325 Color MFP');
  });

  it('still uses the NIC OUI when the scan has no SNMP data at all', () => {
    const identity = resolveScanIdentity(
      { ip: '10.0.0.6', assetType: 'unknown', methods: ['arp'] } as never,
      'Ubiquiti Inc',
    );
    expect(identity).toMatchObject({ manufacturer: 'Ubiquiti Inc', model: null });
  });

  it('never surfaces a bare sysObjectID as the model', () => {
    const identity = resolveScanIdentity(
      {
        ip: '10.0.0.7', assetType: 'unknown', methods: ['snmp'],
        model: '1.3.6.1.4.1.99999.1.2',
        snmpData: { sysObjectId: '1.3.6.1.4.1.99999.1.2', sysDescr: 'Unbranded box' },
      } as never,
      null,
    );
    expect(identity.model).toBeNull();
  });
});

describe('manual precedence survives identity resolution', () => {
  it('still guards manufacturer and model against a manual row', () => {
    const identity = resolveScanIdentity(
      {
        ip: '10.0.0.5', assetType: 'printer', methods: ['snmp'],
        snmpData: { sysObjectId: '1.3.6.1.4.1.253.1', sysDescr: 'Xerox(R) C325 Color MFP; x' },
      } as never,
      null,
    );
    const updateSet = buildScanUpdateSet(
      { manufacturer: identity.manufacturer, model: identity.model, hostname: 'scan-name' },
      null,
    ) as Record<string, unknown>;

    for (const column of ['manufacturer', 'model', 'hostname']) {
      expect(sqlText(updateSet[column]), column).toContain("= 'manual'");
    }
  });
});
