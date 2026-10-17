import { describe, expect, it, vi, beforeEach } from 'vitest';
vi.mock('../postureEvidence', () => ({ loadPostureEvidence: vi.fn(), TRUST_PAGE_EVIDENCE_POLICY: { sites: [], windowDays: 30, minPasswordLength: 8, maxLocalAdmins: 2, maxAvDefinitionsAgeDays: 7, maxSecurityStatusAgeDays: 30, includeCis: true, monitoringWindowHours: 24 } }));
vi.mock('./trustOnlyEvidence', () => ({ loadTrustOnlyEvidence: vi.fn(async () => ({})) }));
vi.mock('./servingSet', () => ({ addServing: vi.fn(), removeServing: vi.fn(), cacheSnapshotPayload: vi.fn(), trustServingMember: (p: string, o?: string) => (o ? `${p}/${o}` : p) }));
vi.mock('../portal/edrVisibility', () => ({ isEdrVisibilityEnabled: vi.fn(async () => false) }));
vi.mock('./template', () => ({ loadPartnerTemplate: vi.fn(async () => null) }));
const trustMode = vi.hoisted(() => ({ value: 'enforce' as 'off' | 'shadow' | 'enforce' }));
vi.mock('../../config/partnerTrustMode', () => ({ partnerTrustMode: () => trustMode.value }));
const dbm = vi.hoisted(() => ({ select: vi.fn(), transaction: vi.fn(), insert: vi.fn(), update: vi.fn() }));
vi.mock('../../db', () => ({ db: dbm, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() }));
import { emptyControlEvidence, TELEMETRY_CONTROL_IDS } from '@breeze/shared';
import type { TrustPageRow } from '../../db/schema/trustPages';
import { loadPostureEvidence } from '../postureEvidence';
import { addServing, cacheSnapshotPayload, removeServing } from './servingSet';
import { loadPartnerTemplate } from './template';
import { publishTrustPage, trustPublishDecision, unpublishTrustPage, validatePublishSlugs, TrustPageError } from './publication';

/** Thenable query-builder stand-in: every builder method returns itself; awaiting it yields `result`. */
function chain(result: unknown): unknown {
  const target = function () { /* callable proxy target */ };
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
      return () => proxy;
    },
  });
  return proxy;
}

function pageRow(overrides: Partial<TrustPageRow> = {}): TrustPageRow {
  const now = new Date('2026-10-13T00:00:00Z');
  return {
    id: 'pg', orgId: 'o', partnerId: 'p', isPartnerHome: false, publishedAt: null, publicationRevision: 0,
    searchIndexable: false, showPercentages: false, showDeviceCount: false, showManagedBy: true,
    securityContactEmail: null, websiteUrl: null, introHtml: null, hiddenControlIds: [],
    frameworkView: null, showHistory: null, ndaText: null, accessRequestCreatesTicket: false,
    publicationAuthorizedBy: null, publicationAuthorizedAt: null, publicationAuthorizedByUserId: null,
    lastEvaluatedAt: null, publishedConfig: null, createdByUserId: null, updatedByUserId: null, createdAt: now, updatedAt: now,
    ...overrides,
  };
}

/** Queue the selects publishTrustPage issues outside the transaction: page, [org type for a partner-home page], org/partner ctx, brand, documents. */
function queueBuildSelects(page: TrustPageRow, orgType = 'internal') {
  dbm.select.mockReturnValueOnce(chain([page]));
  if (page.isPartnerHome) dbm.select.mockReturnValueOnce(chain([{ type: orgType }]));
  dbm.select
    .mockReturnValueOnce(chain([{ orgName: 'Acme', partnerName: 'Northwind', partnerSettings: {}, billingWebsite: null, trustPageUnbranded: false }]))
    .mockReturnValueOnce(chain([]))
    .mockReturnValueOnce(chain([]));
}

/** A transaction whose locked revision is `lockedRev`; records when it settles. */
function txWithLockedRevision(lockedRev: number, updated: TrustPageRow, settled: { at: number }) {
  dbm.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      select: () => chain([{ rev: lockedRev }]),
      update: () => chain([updated]),
      insert: () => chain(undefined),
    };
    const out = await fn(tx);
    settled.at = performance.now();
    return out;
  });
}

beforeEach(() => {
  vi.mocked(loadPostureEvidence).mockResolvedValue({ asOf: new Date().toISOString(), org: { id: 'o', name: 'Acme', partnerId: 'p' }, scopeKind: 'unrestricted', deviceCount: 0, devices: [], controls: emptyControlEvidence(), report: { reporting: 0, unprotected: 0, cisIncluded: true, cisAssessedCount: 0, edrUnknown: 0, anyAvUnknown: 0, orgWide: null, backupProviders: { evidence: [], coveredDeviceCount: 0 }, vulnByDevice: new Map() } } as never);
});

describe('validatePublishSlugs', () => {
  it('throws 422 SLUG_INVALID with the offending slug named', () => {
    expect(() => validatePublishSlugs('Northwind', 'acme')).toThrowError(TrustPageError);
    expect.assertions(4);
    try { validatePublishSlugs('nw', 'Acme Dental'); } catch (e) { expect(e).toMatchObject({ status: 422, code: 'SLUG_INVALID' }); expect((e as Error).message).toMatch(/organization slug/); }
    expect(() => validatePublishSlugs('nw', 'acme-dental')).not.toThrow();
  });
  it('rejects the reserved partner slug "preview" (collides with the public preview-token route)', () => {
    let caught: unknown;
    try { validatePublishSlugs('preview', 'acme'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(TrustPageError);
    expect(caught).toMatchObject({ status: 422, code: 'SLUG_INVALID' });
    expect((caught as Error).message).toMatch(/reserved/);
  });
});

describe('trustPublishDecision (Ruling 24: the GET canPublish rule IS the publish rule)', () => {
  beforeEach(() => { trustMode.value = 'enforce'; });
  it.each(['enforce', 'shadow'] as const)('%s: trusted allows; probation and restricted deny with web-known reasons', (mode) => {
    trustMode.value = mode;
    expect(trustPublishDecision('trusted')).toEqual({ allowed: true, reason: null });
    expect(trustPublishDecision('probation')).toEqual({ allowed: false, reason: 'probation_default_deny' });
    expect(trustPublishDecision('restricted')).toEqual({ allowed: false, reason: 'restricted' });
  });
  it('off (self-hosted) allows every state', () => {
    trustMode.value = 'off';
    for (const st of ['trusted', 'probation', 'restricted'] as const) expect(trustPublishDecision(st)).toEqual({ allowed: true, reason: null });
  });
  it('shadow probation: publish refuses exactly when the decision says not allowed', async () => {
    trustMode.value = 'shadow';
    await expect(publishTrustPage({ orgId: 'o', expectedRevision: 0, actorUserId: 'u', partnerTrustState: 'probation', partnerSlug: 'nw', orgSlug: 'acme' })).rejects.toMatchObject({ status: 403, code: 'TRUST_PROBATION' });
    trustMode.value = 'enforce';
  });
});

describe('publishTrustPage guards', () => {
  beforeEach(() => { dbm.select.mockReset(); dbm.transaction.mockReset(); dbm.update.mockReset(); vi.mocked(addServing).mockReset(); vi.mocked(cacheSnapshotPayload).mockReset(); });

  it('refuses probation/restricted partners with 403 TRUST_PROBATION / TRUST_RESTRICTED', async () => {
    await expect(publishTrustPage({ orgId: 'o', expectedRevision: 0, actorUserId: 'u', partnerTrustState: 'probation', partnerSlug: 'nw', orgSlug: 'acme' })).rejects.toMatchObject({ status: 403, code: 'TRUST_PROBATION' });
    await expect(publishTrustPage({ orgId: 'o', expectedRevision: 0, actorUserId: 'u', partnerTrustState: 'restricted', partnerSlug: 'nw', orgSlug: 'acme' })).rejects.toMatchObject({ status: 403, code: 'TRUST_RESTRICTED' });
    expect(dbm.select).not.toHaveBeenCalled();
  });

  it('refuses an invalid slug with 422 before reading the page', async () => {
    await expect(publishTrustPage({ orgId: 'o', expectedRevision: 0, actorUserId: 'u', partnerTrustState: 'trusted', partnerSlug: 'nw', orgSlug: 'Acme Dental' })).rejects.toMatchObject({ status: 422, code: 'SLUG_INVALID' });
    expect(dbm.select).not.toHaveBeenCalled();
  });

  it('a customer page without authorization (stored or supplied) fails 422 AUTHORIZATION_REQUIRED before touching the transaction', async () => {
    dbm.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ id: 'pg', orgId: 'o', partnerId: 'p', isPartnerHome: false, publicationRevision: 0, publicationAuthorizedBy: null, hiddenControlIds: [] }] }) }) });
    await expect(publishTrustPage({ orgId: 'o', expectedRevision: 0, actorUserId: 'u', partnerTrustState: 'trusted', partnerSlug: 'nw', orgSlug: 'acme' })).rejects.toMatchObject({ status: 422, code: 'AUTHORIZATION_REQUIRED' });
    expect(dbm.transaction).not.toHaveBeenCalled();
  });

  it('a whitespace-only supplied authorization does not satisfy the attestation', async () => {
    dbm.select.mockReturnValueOnce(chain([pageRow()]));
    await expect(publishTrustPage({ orgId: 'o', expectedRevision: 0, actorUserId: 'u', authorization: { authorizedBy: '   ' }, partnerTrustState: 'trusted', partnerSlug: 'nw', orgSlug: 'acme' })).rejects.toMatchObject({ status: 422, code: 'AUTHORIZATION_REQUIRED' });
    expect(dbm.transaction).not.toHaveBeenCalled();
  });

  it('a stale revision is a 409 and never touches the serving set or cache', async () => {
    const page = pageRow({ publicationAuthorizedBy: 'Jane Doe, COO' });
    queueBuildSelects(page);
    txWithLockedRevision(1, page, { at: 0 });
    await expect(publishTrustPage({ orgId: 'o', expectedRevision: 0, actorUserId: 'u', partnerTrustState: 'trusted', partnerSlug: 'nw', orgSlug: 'acme' })).rejects.toMatchObject({ status: 409, code: 'REVISION_MISMATCH' });
    expect(addServing).not.toHaveBeenCalled();
    expect(cacheSnapshotPayload).not.toHaveBeenCalled();
  });

  it('Ruling 25: a partner-home page on a non-internal org is refused 422 PARTNER_HOME_INTERNAL_ONLY before building', async () => {
    vi.mocked(loadPostureEvidence).mockClear();
    dbm.select.mockReturnValueOnce(chain([pageRow({ isPartnerHome: true })])).mockReturnValueOnce(chain([{ type: 'customer' }]));
    await expect(publishTrustPage({ orgId: 'o', expectedRevision: 0, actorUserId: 'u', partnerTrustState: 'trusted', partnerSlug: 'nw', orgSlug: 'acme' })).rejects.toMatchObject({ status: 422, code: 'PARTNER_HOME_INTERNAL_ONLY' });
    expect(loadPostureEvidence).not.toHaveBeenCalled();
    expect(dbm.transaction).not.toHaveBeenCalled();
  });

  it('the publish transaction freezes the draft into published_config', async () => {
    const page = pageRow({ publicationAuthorizedBy: 'Jane Doe, COO', showPercentages: true, hiddenControlIds: ['dns_filtering'], introHtml: '<p>Hi</p>' });
    queueBuildSelects(page);
    const sets: unknown[] = [];
    dbm.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      select: () => chain([{ rev: 0 }]),
      update: () => ({ set: (v: unknown) => { sets.push(v); return chain([{ ...page, publicationRevision: 1 }]); } }),
      insert: () => chain(undefined),
    }));
    await publishTrustPage({ orgId: 'o', expectedRevision: 0, actorUserId: 'u', partnerTrustState: 'trusted', partnerSlug: 'nw', orgSlug: 'acme' });
    const pageSet = sets.find((v) => (v as Record<string, unknown>).publishedConfig) as Record<string, unknown>;
    expect(pageSet.publishedConfig).toEqual({
      hiddenControlIds: ['dns_filtering'], showPercentages: true, showDeviceCount: false, showManagedBy: true,
      searchIndexable: false, introHtml: '<p>Hi</p>', websiteUrl: null, securityContactEmail: null, documentIds: [],
      // W2 (amendment 28): every field frozen explicitly, inherited values resolved.
      documents: [], catalogControlIds: [...TELEMETRY_CONTROL_IDS], declarationIds: [], frameworkView: ['nist_csf_2'],
      showHistory: false, subprocessors: [], faq: [], ndaText: null, locale: 'en',
    });
  });

  it('inherited (NULL) settings freeze as their resolved defaults, and the partner language is the frozen locale', async () => {
    const page = pageRow({ publicationAuthorizedBy: 'Jane Doe, COO', showPercentages: null, showManagedBy: null, hiddenControlIds: null, ndaText: 'Keep it confidential.' });
    dbm.select.mockReturnValueOnce(chain([page]));
    dbm.select
      .mockReturnValueOnce(chain([{ orgName: 'Acme', partnerName: 'Northwind', partnerSettings: { language: 'fr-CA' }, billingWebsite: null, trustPageUnbranded: false }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]));
    const sets: unknown[] = [];
    dbm.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      select: () => chain([{ rev: 0 }]),
      update: () => ({ set: (v: unknown) => { sets.push(v); return chain([{ ...page, publicationRevision: 1 }]); } }),
      insert: () => chain(undefined),
    }));
    await publishTrustPage({ orgId: 'o', expectedRevision: 0, actorUserId: 'u', partnerTrustState: 'trusted', partnerSlug: 'nw', orgSlug: 'acme' });
    const cfg = (sets.find((v) => (v as Record<string, unknown>).publishedConfig) as Record<string, Record<string, unknown>>).publishedConfig!;
    expect(cfg).toMatchObject({ showPercentages: false, showManagedBy: true, hiddenControlIds: [], ndaText: 'Keep it confidential.', locale: 'fr-CA' });
  });

  it('publish with an expectedTemplateRevision that no longer matches is 409 TEMPLATE_CHANGED before building', async () => {
    vi.mocked(loadPostureEvidence).mockClear();
    vi.mocked(loadPartnerTemplate).mockResolvedValueOnce(null);
    dbm.select.mockReturnValueOnce(chain([pageRow({ publicationAuthorizedBy: 'Jane Doe, COO' })]));
    await expect(publishTrustPage({ orgId: 'o', expectedRevision: 0, expectedTemplateRevision: 3, actorUserId: 'u', partnerTrustState: 'trusted', partnerSlug: 'nw', orgSlug: 'acme' }))
      .rejects.toMatchObject({ status: 409, code: 'TEMPLATE_CHANGED' });
    expect(loadPostureEvidence).not.toHaveBeenCalled();
    expect(dbm.transaction).not.toHaveBeenCalled();
  });

  it('the partner home page is exempt from the attestation and serves both members, after the transaction settles', async () => {
    const page = pageRow({ isPartnerHome: true });
    queueBuildSelects(page);
    const settled = { at: 0 };
    txWithLockedRevision(0, { ...page, publicationRevision: 1, publishedAt: new Date() }, settled);
    let addedAt = 0;
    vi.mocked(addServing).mockImplementationOnce(async () => { addedAt = performance.now(); });
    const out = await publishTrustPage({ orgId: 'o', expectedRevision: 0, actorUserId: 'u', partnerTrustState: 'trusted', partnerSlug: 'nw', orgSlug: 'acme' });
    expect(out.page.publicationRevision).toBe(1);
    expect(addServing).toHaveBeenCalledWith(['nw/acme', 'nw']);
    expect(cacheSnapshotPayload).toHaveBeenCalledWith(out.snapshotId, expect.objectContaining({ snapshotId: out.snapshotId }));
    expect(settled.at).toBeGreaterThan(0);
    expect(addedAt).toBeGreaterThanOrEqual(settled.at);
  });
});

describe('unpublishTrustPage', () => {
  beforeEach(() => { dbm.update.mockReset(); vi.mocked(removeServing).mockReset(); });

  it('removes the org member (and the partner-home member) after the write', async () => {
    dbm.update.mockReturnValueOnce(chain([pageRow({ isPartnerHome: true, publicationRevision: 3 })]));
    const row = await unpublishTrustPage({ orgId: 'o', actorUserId: 'u', partnerSlug: 'nw', orgSlug: 'acme', isPartnerHome: true });
    expect(row.publicationRevision).toBe(3);
    expect(removeServing).toHaveBeenCalledWith(['nw/acme', 'nw']);
  });

  it('404s for an org without a page and leaves the serving set alone', async () => {
    dbm.update.mockReturnValueOnce(chain([]));
    await expect(unpublishTrustPage({ orgId: 'o', actorUserId: 'u', partnerSlug: 'nw', orgSlug: 'acme', isPartnerHome: false })).rejects.toMatchObject({ status: 404 });
    expect(removeServing).not.toHaveBeenCalled();
  });
});
