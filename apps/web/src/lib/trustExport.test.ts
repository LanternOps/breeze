import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trustPagePublicPayloadSchema } from '@breeze/shared';
import {
  downloadTrustQuestionnaire,
  fetchPublishedTrustPayload,
  trustPayloadPath,
} from './trustExport';

const AT = '2026-10-10T12:00:00.000Z';
const payload = trustPagePublicPayloadSchema.parse({
  schemaVersion: 2, locale: 'en', snapshotId: '11111111-1111-4111-8111-111111111111', generatedAt: AT, publishedAt: AT,
  org: { name: 'Acme', logoUrl: null, primaryColor: null, websiteUrl: null, securityContactEmail: null },
  managedBy: null, introHtml: null,
  summary: { catalogTotal: 15, controlsShown: 1, controlsMet: 1, deviceCount: 3 },
  methodology: { catalogVersion: '1', evidenceMaxAgeDays: 14, definitionsMaxAgeDays: 7, coverageFloorPct: 80, thresholds: { met: 95, attention: 70 }, eligibilityNote: 'x' },
  controls: [{ id: 'endpoint_protection', category: 'endpoint_protection', source: 'telemetry', unit: 'devices', status: 'met', reason: null, percent: 99, assessed: 3, eligible: 3, evidenceAsOf: AT, frameworkRefs: [] }],
  footer: { poweredByBreeze: true, frameworkAttributions: [] },
  documents: [], declaredControls: [], frameworks: [], subprocessors: [], faq: [], history: [], access: null,
});

const ctx = { partnerSlug: 'nw', orgSlug: 'acme', isPartnerHome: false, pageUrl: 'https://breeze.test/portal/trust/nw/acme' };
const ok = () => new Response(JSON.stringify({ data: { payload, lastEvaluatedAt: AT, stale: false } }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('trustExport', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('builds /api/v1/trust/public/<p>/<o> (partner home: /<p>)', () => {
    expect(trustPayloadPath(ctx)).toBe('/api/v1/trust/public/nw/acme');
    expect(trustPayloadPath({ ...ctx, isPartnerHome: true })).toBe('/api/v1/trust/public/nw');
  });

  it('fetchPublishedTrustPayload returns { payload, lastEvaluatedAt, stale }', async () => {
    fetchMock.mockResolvedValueOnce(ok());
    const r = await fetchPublishedTrustPayload(ctx);
    expect(fetchMock.mock.calls[0]![0]).toMatch(/\/api\/v1\/trust\/public\/nw\/acme$/);
    expect(r).toEqual({ payload, lastEvaluatedAt: AT, stale: false });
  });

  it('404 → null', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    expect(await fetchPublishedTrustPayload(ctx)).toBeNull();
  });

  it('a non-404 failure throws', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await expect(fetchPublishedTrustPayload(ctx)).rejects.toThrow(/500/);
  });

  it('a stored v1 payload is normalized (no declared controls) and exports', async () => {
    const { schemaVersion: _v, locale: _l, declaredControls: _d, frameworks: _f, subprocessors: _s, faq: _q, history: _h, access: _a, ...rest } = payload;
    const v1 = { ...rest, schemaVersion: 1, documents: [] };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { payload: v1, lastEvaluatedAt: AT, stale: false } }), { status: 200 }));
    const r = await fetchPublishedTrustPayload(ctx);
    expect(r!.payload.schemaVersion).toBe(2);
    expect(r!.payload.declaredControls).toEqual([]);
    expect(r!.payload.controls).toHaveLength(1);
  });

  it('a malformed v1 payload throws', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { payload: { schemaVersion: 1, bogus: true }, lastEvaluatedAt: null, stale: false } }), { status: 200 }));
    await expect(fetchPublishedTrustPayload(ctx)).rejects.toThrow();
  });

  it('a payload that fails the published schema throws', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { payload: { schemaVersion: 9 }, lastEvaluatedAt: null, stale: false } }), { status: 200 }));
    await expect(fetchPublishedTrustPayload(ctx)).rejects.toThrow();
  });

  describe('downloadTrustQuestionnaire', () => {
    let blobs: Blob[];
    let clicked: { download: string; href: string }[];
    beforeEach(() => {
      blobs = []; clicked = [];
      (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return 'blob:x'; });
      (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push({ download: this.download, href: this.href });
      });
    });

    it('csv creates a text/csv;charset=utf-8 Blob named trust-questionnaire-<orgSlug>-<YYYY-MM-DD>.csv', async () => {
      fetchMock.mockResolvedValueOnce(ok());
      const done = await downloadTrustQuestionnaire('csv', ctx, new Date('2026-10-17T23:59:00Z'));
      expect(done).toBe(true);
      expect(blobs[0]!.type).toBe('text/csv;charset=utf-8');
      expect(clicked[0]!.download).toBe('trust-questionnaire-acme-2026-10-17.csv');
      expect(await blobs[0]!.text()).toContain('"control_id","category"');
    });

    it('does not revoke the object URL synchronously after click (async download starts)', async () => {
      vi.useFakeTimers();
      try {
        fetchMock.mockResolvedValueOnce(ok());
        await downloadTrustQuestionnaire('csv', ctx);
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        vi.runAllTimers();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x');
      } finally {
        vi.useRealTimers();
      }
    });

    it('stale and lastEvaluatedAt flow through to verification_paused and the JSON document', async () => {
      const stale = () => new Response(JSON.stringify({ data: { payload, lastEvaluatedAt: null, stale: true } }), { status: 200 });
      fetchMock.mockResolvedValueOnce(stale());
      expect(await fetchPublishedTrustPayload(ctx)).toMatchObject({ stale: true, lastEvaluatedAt: null });
      fetchMock.mockResolvedValueOnce(stale());
      await downloadTrustQuestionnaire('csv', ctx);
      expect(await blobs[0]!.text()).toContain('"true"');
      fetchMock.mockResolvedValueOnce(stale());
      await downloadTrustQuestionnaire('json', ctx);
      expect(JSON.parse(await blobs[1]!.text())).toMatchObject({ stale: true, lastEvaluatedAt: null });
    });

    it('json creates an application/json Blob with a .json name', async () => {
      fetchMock.mockResolvedValueOnce(ok());
      await downloadTrustQuestionnaire('json', ctx, new Date('2026-10-17T00:00:00Z'));
      expect(blobs[0]!.type).toBe('application/json');
      expect(clicked[0]!.download).toBe('trust-questionnaire-acme-2026-10-17.json');
      expect(JSON.parse(await blobs[0]!.text())).toMatchObject({ format: 'breeze-trust-questionnaire', pageUrl: ctx.pageUrl });
    });

    it('partner home names the file after the partner slug', async () => {
      fetchMock.mockResolvedValueOnce(ok());
      await downloadTrustQuestionnaire('csv', { ...ctx, isPartnerHome: true }, new Date('2026-10-17T00:00:00Z'));
      expect(clicked[0]!.download).toBe('trust-questionnaire-nw-2026-10-17.csv');
    });

    it('returns false and downloads nothing when the page is not served (404)', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }));
      expect(await downloadTrustQuestionnaire('csv', ctx)).toBe(false);
      expect(clicked).toHaveLength(0);
    });
  });
});
