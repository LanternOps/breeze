import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
const serving = vi.hoisted(() => ({ readCachedSnapshotPayload: vi.fn(), cacheSnapshotPayload: vi.fn() }));
vi.mock('./servingSet', () => serving);
import { trustPagePublicPayloadSchema, type TrustPagePublicPayload } from '@breeze/shared';
import { gateCisFrameworkView, loadServedPayload } from './servedPayload';

const hardening = {
  id: 'hardening_baseline', category: 'patching_hardening', source: 'telemetry', unit: 'devices',
  status: 'met', reason: null, percent: null, assessed: null, eligible: null, evidenceAsOf: '2026-10-13T11:00:00.000Z',
  frameworkRefs: [{ framework: 'nist_csf_2', ref: 'PR.PS-01' }],
  safeguards: [{ framework: 'cis_v8', ref: '4.1', status: 'met', reason: null, percent: null, assessed: null, eligible: null }],
};
const encryption = {
  id: 'disk_encryption', category: 'data_protection', source: 'telemetry', unit: 'devices',
  status: 'met', reason: null, percent: null, assessed: null, eligible: null, evidenceAsOf: '2026-10-13T11:00:00.000Z',
  frameworkRefs: [{ framework: 'cis_v8', ref: '3.6' }],
};
/** A snapshot built while BREEZE_TRUST_CIS_FRAMEWORK_VIEW was ON: CIS in the view, safeguards, and a CIS card ref. */
const built = (controls: unknown[] = [hardening, encryption]): TrustPagePublicPayload => trustPagePublicPayloadSchema.parse({
  schemaVersion: 2, locale: 'en', declaredControls: [], frameworks: ['cis_v8', 'nist_csf_2'], subprocessors: [], faq: [], history: [], access: null,
  snapshotId: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6b',
  generatedAt: '2026-10-13T12:00:00.000Z', publishedAt: '2026-10-01T09:00:00.000Z',
  org: { name: 'Acme Dental', logoUrl: null, primaryColor: null, websiteUrl: null, securityContactEmail: null },
  managedBy: null, introHtml: null,
  summary: { catalogTotal: 15, controlsShown: controls.length, controlsMet: controls.length, deviceCount: null },
  methodology: { catalogVersion: '2026-10-13.1', evidenceMaxAgeDays: 30, definitionsMaxAgeDays: 7, coverageFloorPct: 80, thresholds: { met: 95, attention: 80 }, eligibilityNote: 'Managed devices.' },
  controls, documents: [],
  footer: { poweredByBreeze: true, frameworkAttributions: ['cis_v8', 'nist_csf_2'] },
});

describe('gateCisFrameworkView (#9087, amendment 25)', () => {
  it('flag off: drops cis_v8 from frameworks, strips safeguards, keeps control CIS refs and their attribution', () => {
    const p = built();
    const g = gateCisFrameworkView(p, false);
    expect(g.frameworks).toEqual(['nist_csf_2']);
    expect(g.controls.every((c) => !('safeguards' in c))).toBe(true);
    expect(g.controls.find((c) => c.id === 'disk_encryption')!.frameworkRefs).toEqual([{ framework: 'cis_v8', ref: '3.6' }]);
    expect(g.footer.frameworkAttributions).toEqual(['cis_v8', 'nist_csf_2']); // a card still cites CIS
    expect(p.frameworks).toEqual(['cis_v8', 'nist_csf_2']); // the stored payload is not mutated
    expect(p.controls[0]).toHaveProperty('safeguards');
  });

  it('flag off: attribution loses cis_v8 when only the view or safeguards referenced it', () => {
    const g = gateCisFrameworkView(built([hardening]), false);
    expect(g.frameworks).toEqual(['nist_csf_2']);
    expect(g.footer.frameworkAttributions).toEqual(['nist_csf_2']);
  });

  it('flag on: identity', () => {
    const p = built();
    expect(gateCisFrameworkView(p, true)).toBe(p);
  });

  it('flag off with nothing to gate returns the payload untouched', () => {
    const p = { ...built([encryption]), frameworks: ['nist_csf_2'] } as TrustPagePublicPayload;
    expect(gateCisFrameworkView(p, false)).toBe(p);
  });

  it('gated output still parses with trustPagePublicPayloadSchema', () => {
    expect(trustPagePublicPayloadSchema.safeParse(gateCisFrameworkView(built(), false)).success).toBe(true);
    expect(trustPagePublicPayloadSchema.safeParse(gateCisFrameworkView(built([hardening]), false)).success).toBe(true);
  });
});

describe('loadServedPayload', () => {
  const prev = process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW;
  beforeEach(() => { serving.readCachedSnapshotPayload.mockReset(); serving.cacheSnapshotPayload.mockReset(); });
  afterEach(() => { if (prev === undefined) delete process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW; else process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW = prev; });

  it('a cached snapshot built while the flag was on is gated once the flag is off', async () => {
    process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW = 'false';
    serving.readCachedSnapshotPayload.mockResolvedValueOnce(built());
    const out = await loadServedPayload({ snapshotId: 's1', payload: null });
    expect(out!.frameworks).toEqual(['nist_csf_2']);
    expect(serving.cacheSnapshotPayload).not.toHaveBeenCalled();
  });

  it('a cache miss caches the STORED payload (ungated) and serves it gated', async () => {
    process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW = 'false';
    serving.readCachedSnapshotPayload.mockResolvedValueOnce(null);
    const stored = built();
    const out = await loadServedPayload({ snapshotId: 's1', payload: stored });
    expect(serving.cacheSnapshotPayload).toHaveBeenCalledWith('s1', stored);
    expect(out!.frameworks).toEqual(['nist_csf_2']);
  });

  it('flag on: serves CIS as stored', async () => {
    process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW = 'true';
    serving.readCachedSnapshotPayload.mockResolvedValueOnce(built());
    expect((await loadServedPayload({ snapshotId: 's1', payload: null }))!.frameworks).toEqual(['cis_v8', 'nist_csf_2']);
  });

  it('no snapshot, or no payload anywhere, is null', async () => {
    expect(await loadServedPayload({ snapshotId: null, payload: built() })).toBeNull();
    serving.readCachedSnapshotPayload.mockResolvedValueOnce(null);
    expect(await loadServedPayload({ snapshotId: 's1', payload: null })).toBeNull();
  });
});
