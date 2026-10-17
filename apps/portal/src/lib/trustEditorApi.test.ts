// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { changedTrustDraftFields, trustEditorApi, type PortalTrustPageDraft } from './trustEditorApi';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('trustEditorApi (Trust Center W3d)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(ok({ data: { page: null } }));
    vi.stubGlobal('fetch', fetchMock);
    document.cookie = 'breeze_portal_csrf_token=csrf-123; path=/';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = 'breeze_portal_csrf_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i]!;
    return { url: String(url), method: (init?.method ?? 'GET').toUpperCase(), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
  };

  it('GET reads /portal/trust-page', async () => {
    await trustEditorApi.get();
    expect(call().url).toMatch(/\/api\/v1\/portal\/trust-page$/);
    expect(call().method).toBe('GET');
  });

  it('PUT sends the patch with the loaded revision and the CSRF header', async () => {
    await trustEditorApi.save({ expectedRevision: 3, websiteUrl: 'https://example.com' });
    const c = call();
    expect(c.url).toMatch(/\/api\/v1\/portal\/trust-page$/);
    expect(c.method).toBe('PUT');
    expect(c.body).toEqual({ expectedRevision: 3, websiteUrl: 'https://example.com' });
    expect(c.headers.get('x-breeze-csrf')).toBe('csrf-123');
  });

  it('POST /preview-token and POST /unpublish ({ confirm: true }) carry the CSRF header', async () => {
    await trustEditorApi.previewToken();
    await trustEditorApi.unpublish();
    expect(call(0)).toMatchObject({ method: 'POST', body: {} });
    expect(call(0).url).toMatch(/\/api\/v1\/portal\/trust-page\/preview-token$/);
    expect(call(0).headers.get('x-breeze-csrf')).toBe('csrf-123');
    expect(call(1)).toMatchObject({ method: 'POST', body: { confirm: true } });
    expect(call(1).url).toMatch(/\/api\/v1\/portal\/trust-page\/unpublish$/);
    expect(call(1).headers.get('x-breeze-csrf')).toBe('csrf-123');
  });
});

describe('changedTrustDraftFields', () => {
  const base: PortalTrustPageDraft = {
    securityContactEmail: 'sec@example.com', websiteUrl: null, hiddenControlIds: ['dns_filtering'],
    showPercentages: false, showDeviceCount: true, publishedAt: null, publicationRevision: 2, publicPath: '/trust/p/o',
  };

  it('returns only the fields that changed; blank text becomes null', () => {
    expect(changedTrustDraftFields(base, { ...base })).toEqual({});
    expect(changedTrustDraftFields(base, { ...base, websiteUrl: ' https://example.com ', showDeviceCount: false }))
      .toEqual({ websiteUrl: 'https://example.com', showDeviceCount: false });
    expect(changedTrustDraftFields(base, { ...base, securityContactEmail: '   ' })).toEqual({ securityContactEmail: null });
  });

  it('compares hidden controls as a set', () => {
    expect(changedTrustDraftFields({ ...base, hiddenControlIds: ['a', 'b'] }, { ...base, hiddenControlIds: ['b', 'a'] })).toEqual({});
    expect(changedTrustDraftFields(base, { ...base, hiddenControlIds: [] })).toEqual({ hiddenControlIds: [] });
  });
});
