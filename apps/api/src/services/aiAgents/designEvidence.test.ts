import { describe, expect, it } from 'vitest';

import { FLEET_DESIGN_PRECURSOR_THRESHOLDS } from '@breeze/shared';

import {
  DESIGN_EVIDENCE_HARD_LIMIT_BYTES, DESIGN_EVIDENCE_MAX_DEVICES,
  assembleDesignEvidence, designBaselineNumbers, type RawDesignEvidence,
} from './designEvidence';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
function raw(overrides: Partial<RawDesignEvidence> = {}): RawDesignEvidence {
  return {
    org: { name: 'Acme', partnerName: 'MSP', timezone: 'UTC', siteName: null },
    devices: [{ id: uuid(1), hostname: 'FS01', displayName: null, osType: 'windows', osVersion: '2022', role: 'server', roleSource: 'auto', lastSeenAt: '2026-09-11T00:00:00Z', status: 'online', siteName: 'HQ', groupNames: ['Servers'], tags: ['file'], customFields: { rack: 'A1' }, pendingReboot: false, reliabilityScore: 92 }],
    devicesTotal: 1,
    software: [], services: [], network: { assets: [], topology: [], baselines: 0, openChanges: [] },
    posture: [], health: { reliabilityWorst: [], fleetFindings: [], vulnerability: null, patching: null, backups: null, cis: null },
    configuration: { policies: [], assignments: [], alertTemplates: [] },
    automation: { playbooks: [], scripts: [] },
    logs: [], window: { start: '2026-06-13', end: '2026-09-11' },
    counts: { alerts90d: 0, tickets90d: 0, endpoints: 1 },
    precursors: { diskOver: 0, rebootPending: 0, rebootPendingOver: 0, patchAgeOver: 0, certificateExpiring: null, backupMissed: 0, serviceRestartsOver: 0 },
    unavailable: [],
    ...overrides,
  };
}

describe('assembleDesignEvidence', () => {
  it('projects display fields only and never a jsonb blob', () => {
    const e = assembleDesignEvidence(raw());
    expect(e.devices[0]).not.toHaveProperty('managementPosture');
    expect(JSON.stringify(e)).not.toContain('customFields":{');
    expect(e.devices[0]!.customFields).toBe('rack=A1');
  });
  it('caps devices at the bound and reports the rest as not assessed', () => {
    const many = Array.from({ length: DESIGN_EVIDENCE_MAX_DEVICES + 5 }, (_, i) => ({ ...raw().devices[0]!, id: uuid(i + 1), hostname: `D${i}` }));
    const e = assembleDesignEvidence(raw({ devices: many, devicesTotal: many.length }));
    expect(e.devices).toHaveLength(DESIGN_EVIDENCE_MAX_DEVICES);
    expect(e.devicesNotAssessed).toBe(5);
    expect(e.deviceIds.size).toBe(DESIGN_EVIDENCE_MAX_DEVICES);
  });
  it('trims software, then services, then network, then logs before devices to meet the byte ceiling', () => {
    const big = raw({
      software: Array.from({ length: 500 }, (_, i) => ({ name: `App ${i} ${'x'.repeat(200)}`, vendor: 'V', versions: 3, deviceCount: 2 })),
      logs: Array.from({ length: 500 }, (_, i) => ({ eventId: String(i), source: 'S'.repeat(200), level: 'error', count: 9, deviceCount: 3 })),
    });
    const e = assembleDesignEvidence(big, { limitBytes: 32 * 1024 });
    expect(Buffer.byteLength(JSON.stringify(e), 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(e.truncated).toBe(true);
    expect(e.devices).toHaveLength(1);
  });
  it('computes baseline numbers with the frozen thresholds', () => {
    const e = assembleDesignEvidence(raw({ counts: { alerts90d: 126, tickets90d: 21, endpoints: 100 }, precursors: { ...raw().precursors, diskOver: 4, certificateExpiring: null } }));
    const n = designBaselineNumbers(e);
    expect(n.alertsPer100EndpointsPerMonth).toBe(42);
    expect(n.ticketsPerMonth).toBe(7);
    expect(n.precursors.find((p) => p.condition === 'disk_used_over_threshold')?.deviceCount).toBe(4);
    expect(n.precursors.find((p) => p.condition === 'certificate_expiring')?.deviceCount).toBeNull();
    expect(e.thresholds).toEqual(FLEET_DESIGN_PRECURSOR_THRESHOLDS);
  });
  it('marks a failed loader as unavailable rather than inventing zeros', () => {
    const e = assembleDesignEvidence(raw({ unavailable: ['software'] }));
    expect(e.unavailable).toEqual(['software']);
  });
});
