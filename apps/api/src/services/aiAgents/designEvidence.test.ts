import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FLEET_DESIGN_PRECURSOR_THRESHOLDS } from '@breeze/shared';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// db + leaf-service mocks for the `loadDesignEvidence` suite at the bottom of
// this file. Same harness shape as `narrativeContext.test.ts`'s
// `loadNarrativeContext` suite — compiled-SQL matching via a `failOn`
// fragment list, since a rejected loader is asserted by SQL substring, not by
// call order. The pure-assembler suite above this comment needs none of it
// (`assembleDesignEvidence` never touches the database).
//
// `../../db` is imported as a late-bound namespace in `designEvidence.ts`
// (`import * as dbModule from '../../db'`) specifically so a test's
// `vi.mock('../../db')` factory is observed — see that file's own comment.
// ---------------------------------------------------------------------------
/** SQL fragments whose statement must REJECT (per-loader isolation tests). */
let failOn: string[] = [];
/** Rows to serve, matched by an SQL fragment rather than by call index, so a
 *  reordered loader list does not silently re-point the fixtures. */
let rowsFor: Array<{ match: string; rows: unknown[] }> = [];

vi.mock('../../db', () => ({
  db: {
    execute: vi.fn((statement: unknown) => {
      const text = sqlText(statement).replace(/\s+/g, ' ');
      if (failOn.some((fragment) => text.includes(fragment))) {
        return Promise.reject(new Error('db unavailable'));
      }
      const hit = rowsFor.find((entry) => text.includes(entry.match));
      return Promise.resolve(hit ? hit.rows : []);
    }),
  },
}));

vi.mock('../sentry', () => ({ captureException: vi.fn() }));

// The four leaf services `loadPosture`/`loadHealth` call directly (not
// through the generic `query()` helper above) — mocked with benign,
// zero-result defaults so every loader OTHER than the one under test
// resolves cleanly without a real Postgres connection.
vi.mock('../managementPostureReport', () => ({
  getManagementPostureSummary: vi.fn(async () => ({ orgs: [] })),
}));
vi.mock('../reliabilityScoring', () => ({
  listReliabilityDevices: vi.fn(async () => ({ total: 0, rows: [] })),
}));
vi.mock('../vulnerabilityFleetQueries', () => ({
  fetchFleetFindingRows: vi.fn(async () => []),
}));
vi.mock('../vulnerabilityFleetAggregation', () => ({
  computeStats: vi.fn(() => ({
    criticalOpen: 0, highOpen: 0, mediumOpen: 0, lowOpen: 0, totalOpen: 0, devicesAffected: 0,
  })),
}));
vi.mock('../securityPosture', () => ({
  getSecurityPostureTrend: vi.fn(async () => []),
}));
// W05 (#5655): `loadApprovedDesign`/`loadDriftLiveState` reach the DB through
// `db.select(...)` (a Drizzle query builder), not the `db.execute()` helper
// the mock above serves — mocked separately so every OTHER test in this file
// (written before W05) keeps seeing `approvedDesign`/`driftLive` resolve to
// null without wiring up a `db.select` double it never needed.
vi.mock('../fleetDesign/drift', () => ({
  loadApprovedDesign: vi.fn(async () => null),
  loadDriftLiveState: vi.fn(async () => ({ policies: [], assignments: [], groupMembers: {} })),
}));

// --- compiled-SQL helper (the narrativeContext.test.ts / sweepEvidence.test.ts idiom) ---
function sqlText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.queryChunks)) return n.queryChunks.map(sqlText).join('');
  if (Array.isArray(n.value) && !('encoder' in n)) return (n.value as unknown[]).join('');
  return '';
}

import { captureException } from '../sentry';
import { loadApprovedDesign, loadDriftLiveState, type ApprovedDesignSummary, type DriftLiveState } from '../fleetDesign/drift';
import {
  DESIGN_EVIDENCE_HARD_LIMIT_BYTES, DESIGN_EVIDENCE_MAX_DEVICES,
  assembleDesignEvidence, designBaselineNumbers, loadDesignEvidence, type RawDesignEvidence,
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
    approvedDesign: null,
    driftLive: null,
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
  it('keeps legacy-import scripts ahead of the rest so neither the count cap nor the byte trim drops them first (W04)', () => {
    const script = (i: number, legacyImport: boolean) => ({
      id: uuid(i), name: `S${i}`, language: 'powershell', osTypes: ['windows'], tags: legacyImport ? ['legacy-import'] : [],
      legacyImport, description: 'd'.repeat(150),
    });
    // 1,000 ordinary scripts, then 5 legacy ones at the END of the loader order.
    const scripts = [...Array.from({ length: 1000 }, (_, i) => script(i + 1, false)), ...Array.from({ length: 5 }, (_, i) => script(2001 + i, true))];
    const capped = assembleDesignEvidence(raw({ automation: { playbooks: [], scripts } }));
    expect(capped.automation.scripts.filter((s) => s.legacyImport)).toHaveLength(5);
    const trimmed = assembleDesignEvidence(raw({ automation: { playbooks: [], scripts } }), { limitBytes: 32 * 1024 });
    expect(trimmed.truncated).toBe(true);
    expect(trimmed.automation.scripts.filter((s) => s.legacyImport)).toHaveLength(5);
  });
  it('the automation loader orders legacy-import scripts first and matches the tag case-insensitively (W04)', () => {
    const src = readFileSync(new URL('./designEvidence.ts', import.meta.url), 'utf8');
    const loader = src.slice(src.indexOf('async function loadAutomation'), src.indexOf('type LogRow'));
    expect(loader).toMatch(/ORDER BY[\s\S]*lower\(t\d?\.name\) = 'legacy-import'[\s\S]*DESC/);
    expect(loader).toContain("toLowerCase() === 'legacy-import'");
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
  it('never trims approvedDesign/driftLive — they pass through untouched even under a tiny byte ceiling', () => {
    const approvedDesign: ApprovedDesignSummary = {
      reportRunId: 'run-1',
      appliedAt: '2026-09-01T10:00:00.000Z',
      functions: [{ functionKey: 'file_server', label: 'File servers', groupId: 'g1', policyId: 'p1', deviceIds: ['d1', 'd2'], watches: [], rules: [] }],
      retired: [],
    };
    const driftLive: DriftLiveState = { policies: [], assignments: [], groupMembers: {} };
    const big = raw({
      approvedDesign,
      driftLive,
      software: Array.from({ length: 500 }, (_, i) => ({ name: `App ${i} ${'x'.repeat(200)}`, vendor: 'V', versions: 3, deviceCount: 2 })),
    });
    const e = assembleDesignEvidence(big, { limitBytes: 4 * 1024 });
    expect(e.truncated).toBe(true);
    expect(e.approvedDesign).toEqual(approvedDesign);
    expect(e.driftLive).toEqual(driftLive);
  });
  it('marks a failed loader as unavailable rather than inventing zeros', () => {
    const e = assembleDesignEvidence(raw({ unavailable: ['software'] }));
    expect(e.unavailable).toEqual(['software']);
  });
  it('baseline numbers are null, not zero, when the counts or precursors loader was unavailable', () => {
    const e = assembleDesignEvidence(raw({ unavailable: ['counts', 'precursors'] }));
    const n = designBaselineNumbers(e);
    expect(n.alertsPer100EndpointsPerMonth).toBeNull();
    expect(n.ticketsPerMonth).toBeNull();
    expect(n.precursors.every((p) => p.deviceCount === null)).toBe(true);
    const onlyCounts = designBaselineNumbers(assembleDesignEvidence(raw({ unavailable: ['counts'], precursors: { ...raw().precursors, diskOver: 2 } })));
    expect(onlyCounts.ticketsPerMonth).toBeNull();
    expect(onlyCounts.precursors.find((p) => p.condition === 'disk_used_over_threshold')?.deviceCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PR-review gap (Important): the "unavailable section is never a zero" fix
// (see this module's `assembleDesignEvidence` and the tests above) was only
// ever proven at the PURE assembler layer, fed a hand-typed
// `unavailable: [...]` array. Nothing proved `loadDesignEvidence` ITSELF
// produces that array correctly when a loader genuinely throws. This suite
// drives the real async orchestrator with a mocked `../../db` — the SAME
// module-boundary seam `designEvidence.ts`'s own header comment says exists
// for exactly this purpose ("a late-bound namespace import ... so a test's
// vi.mock('../../db') factory can be observed") — and makes ONE loader's
// statement genuinely reject, the same `failOn` idiom
// `narrativeContext.test.ts` uses for `loadNarrativeContext`.
//
// `software` is the loader under test: it is the simplest loader in this
// module (one `query()` call, no dependent leaf service), so failing it
// exercises the orchestrator's `settled()`/`missing()` pairing without also
// depending on the correctness of the four mocked leaf services above.
// ---------------------------------------------------------------------------
describe('loadDesignEvidence (loader failure isolation)', () => {
  const ORG = '00000000-0000-4000-8000-000000000e01';
  const HEADER_ROWS = [{
    org_name: 'Acme', partner_id: '00000000-0000-4000-8000-000000000e02',
    partner_name: 'MSP', timezone: 'UTC', site_name: null,
  }];

  beforeEach(() => {
    failOn = [];
    rowsFor = [{ match: 'FROM organizations', rows: HEADER_ROWS }];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a genuinely failing loader statement costs exactly its own section — never an invented zero', async () => {
    failOn = ['FROM software_inventory'];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const evidence = await loadDesignEvidence(ORG, { siteId: null });

    // The narrow section name, not a sibling and not the whole bundle.
    expect(evidence.unavailable).toEqual(['software']);
    expect(evidence.software).toEqual([]);
    // Every OTHER section resolved normally (the header succeeded, so `org`
    // is not in `unavailable` either) — proving this is per-loader
    // isolation, not a poisoned shared transaction taking everything down.
    expect(evidence.org.name).toBe('Acme');

    // Reported, not swallowed — same contract `narrativeContext.ts` and
    // `sweepEvidence.ts` carry: a broken table must be observable, not just
    // quietly rendered as "(not measured)" with nobody ever finding out.
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      expect.objectContaining({ service: 'aiAgents', operation: 'loadDesignEvidence', loader: 'software', orgId: ORG }),
    );
    const warned = warnSpy.mock.calls.find((call) => String(call[0]).includes('context loader failed'));
    expect(warned?.[1]).toMatchObject({ orgId: ORG, loader: 'software' });
    warnSpy.mockRestore();
  });

  it('feeds the real assembler, so baseline numbers for an unavailable section are null, not zero, end to end', async () => {
    // `precursors` failing is the section `designBaselineNumbers` actually
    // reads from — proving the SAME "unavailable, not zero" contract the
    // pure-assembler tests above assert, but through the real DB-backed
    // loader this time, not a hand-typed fixture.
    failOn = ['device_patches dp']; // inside loadPrecursors, per its own SQL
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const evidence = await loadDesignEvidence(ORG, { siteId: null });

    expect(evidence.unavailable).toContain('precursors');
    const baseline = designBaselineNumbers(evidence);
    expect(baseline.precursors.every((p) => p.deviceCount === null)).toBe(true);
  });

  it('an unavailable device section reports empty devices, not a fabricated device list', async () => {
    failOn = ['FROM devices d'];
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const evidence = await loadDesignEvidence(ORG, { siteId: null });

    expect(evidence.unavailable).toContain('devices');
    expect(evidence.devices).toEqual([]);
    expect(evidence.devicesTotal).toBe(0);
  });

  // W05 (#5655): `approvedDesign`/`driftLive` are loaded through the SAME
  // `settled()` isolation as every other section, but through a different
  // module (`../fleetDesign/drift`, mocked separately above since it reaches
  // the DB via `db.select(...)`, not the `db.execute()` double `rowsFor`/
  // `failOn` serve).
  it('carries approvedDesign and driftLive when loadApprovedDesign resolves a summary', async () => {
    const summary: ApprovedDesignSummary = { reportRunId: 'run-1', appliedAt: '2026-09-01T10:00:00.000Z', functions: [], retired: [] };
    const driftState: DriftLiveState = { policies: [], assignments: [], groupMembers: {} };
    vi.mocked(loadApprovedDesign).mockResolvedValueOnce(summary);
    vi.mocked(loadDriftLiveState).mockResolvedValueOnce(driftState);

    const evidence = await loadDesignEvidence(ORG, { siteId: null });

    expect(evidence.approvedDesign).toEqual(summary);
    expect(evidence.driftLive).toEqual(driftState);
    expect(evidence.unavailable).not.toContain('approvedDesign');
  });

  it('reports approvedDesign as unavailable and both fields null when loadApprovedDesign rejects', async () => {
    vi.mocked(loadApprovedDesign).mockRejectedValueOnce(new Error('drift lookup failed'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const evidence = await loadDesignEvidence(ORG, { siteId: null });

    expect(evidence.unavailable).toContain('approvedDesign');
    expect(evidence.approvedDesign).toBeNull();
    expect(evidence.driftLive).toBeNull();
  });
});
