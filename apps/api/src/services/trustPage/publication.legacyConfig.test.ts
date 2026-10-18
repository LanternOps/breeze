/**
 * Review Focus 1: a page published under W1, refreshed after W02a deploys. Its legacy published_config (no W2
 * fields) must still parse and refresh, gain no mfa_enforced_m365 control (even when that evidence is met),
 * stay English and render no W2 block.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
vi.mock('../postureEvidence', () => ({ loadPostureEvidence: vi.fn(), TRUST_PAGE_EVIDENCE_POLICY: { sites: [], windowDays: 30, minPasswordLength: 8, maxLocalAdmins: 2, maxAvDefinitionsAgeDays: 7, maxSecurityStatusAgeDays: 30, includeCis: true, monitoringWindowHours: 24 } }));
vi.mock('./servingSet', () => ({ addServing: vi.fn(), removeServing: vi.fn(), cacheSnapshotPayload: vi.fn(), trustServingMember: (p: string, o?: string) => (o ? `${p}/${o}` : p) }));
vi.mock('../portal/edrVisibility', () => ({ isEdrVisibilityEnabled: vi.fn(async () => false) }));
vi.mock('./trustOnlyEvidence', () => ({ loadTrustOnlyEvidence: vi.fn() }));
const dbm = vi.hoisted(() => ({ select: vi.fn(), transaction: vi.fn(), insert: vi.fn(), update: vi.fn() }));
vi.mock('../../db', () => ({ db: dbm, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() }));

import { emptyControlEvidence, W1_TELEMETRY_CONTROL_IDS, type TrustPagePublicPayload } from '@breeze/shared';
import type { TrustPageRow } from '../../db/schema/trustPages';
import { loadPostureEvidence } from '../postureEvidence';
import { loadTrustOnlyEvidence } from './trustOnlyEvidence';
import { refreshPublishedPage } from './publication';

/** The exact shape a W1 publish froze (spec §19 item 17): no W2 field at all. */
const W1_FIXTURE_CONFIG = {
  hiddenControlIds: ['dns_filtering'], showPercentages: false, showDeviceCount: false, showManagedBy: true,
  searchIndexable: false, introHtml: '<p>Hello</p>', websiteUrl: null, securityContactEmail: null, documentIds: [],
};

function chain(result: unknown): unknown {
  const proxy: unknown = new Proxy(function () { /* target */ }, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
      return () => proxy;
    },
  });
  return proxy;
}

function publishedW1Page(): TrustPageRow {
  const now = new Date('2026-10-13T00:00:00Z');
  return {
    id: 'pg', orgId: 'o', partnerId: 'p', isPartnerHome: false, publishedAt: now, publicationRevision: 3,
    // W1 rows keep their explicit values; the W2 draft columns differ to prove the refresh ignores them.
    searchIndexable: false, showPercentages: true, showDeviceCount: true, showManagedBy: true,
    securityContactEmail: null, websiteUrl: null, introHtml: '<p>Draft edit</p>', hiddenControlIds: [],
    frameworkView: ['essential_eight'], showHistory: true, ndaText: 'Draft NDA', accessRequestCreatesTicket: false, embedAllowedOrigins: [],
    publicationAuthorizedBy: 'Jane Doe, COO', publicationAuthorizedAt: now, publicationAuthorizedByUserId: null,
    lastEvaluatedAt: now, publishedConfig: W1_FIXTURE_CONFIG as never, createdByUserId: null, updatedByUserId: null, createdAt: now, updatedAt: now,
  };
}

beforeEach(() => {
  dbm.select.mockReset(); dbm.transaction.mockReset();
  vi.mocked(loadPostureEvidence).mockResolvedValue({ asOf: new Date().toISOString(), org: { id: 'o', name: 'Acme', partnerId: 'p' }, scopeKind: 'unrestricted', deviceCount: 0, devices: [], controls: emptyControlEvidence(), report: {} } as never);
  // The new control's evidence is MET: a W1 page must still not gain it.
  vi.mocked(loadTrustOnlyEvidence).mockResolvedValue({ mfa_enforced_m365: { eligible: 1, assessed: 1, passing: 1, aggregatePct: null, newestEvidenceAt: new Date().toISOString() } });
});

describe('refreshPublishedPage from a legacy (W1) published_config', () => {
  it('rebuilds a v2, English, W1-catalog snapshot with no W2 block', async () => {
    dbm.select
      .mockReturnValueOnce(chain([publishedW1Page()]))                                 // the page
      .mockReturnValueOnce(chain([{ id: 'old-snapshot', sha: 'x'.repeat(64) }]))        // current snapshot (a v1 hash)
      .mockReturnValueOnce(chain([{ orgName: 'Acme', partnerName: 'Northwind', partnerSettings: { language: 'de-DE' }, billingWebsite: null, trustPageUnbranded: false }]))
      .mockReturnValueOnce(chain([]))                                                  // brand
      .mockReturnValueOnce(chain([]));                                                 // live documents
    let inserted: { payload: TrustPagePublicPayload } | null = null;
    dbm.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      select: () => chain([{ rev: 3, publishedAt: new Date() }]),
      update: () => chain(undefined),
      insert: () => ({ values: (v: { payload: TrustPagePublicPayload }) => { inserted = v; return chain(undefined); } }),
    }));

    const out = await refreshPublishedPage('pg');
    expect(out.rebuilt).toBe(true);
    const payload = inserted!.payload;
    expect(payload.schemaVersion).toBe(2);
    expect(payload.controls.map((c) => c.id)).not.toContain('mfa_enforced_m365');
    expect(payload.controls.map((c) => c.id).sort()).toEqual(W1_TELEMETRY_CONTROL_IDS.filter((id) => id !== 'dns_filtering').sort());
    expect(payload.summary.catalogTotal).toBe(15);
    // Frozen values, not the draft columns: English, intro from the config, no percentages.
    expect(payload.locale).toBe('en');
    expect(payload.introHtml).toBe('<p>Hello</p>');
    expect(payload.controls.every((c) => c.percent === null)).toBe(true);
    expect(payload).toMatchObject({ declaredControls: [], faq: [], subprocessors: [], history: [], frameworks: [], access: null });
  });
});
