import { beforeEach, expect, it, vi } from 'vitest';
import { topologyConfigurationApi } from './topologyConfigurationApi';
import { fetchWithAuth } from '../../stores/auth';
import { SITE } from './topologyFixtures';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

beforeEach(() => vi.mocked(fetchWithAuth).mockReset());

it('settings reads the site settings endpoint and parses the typed response', async () => {
  const settings = {
    siteId: SITE, settingsRevision: '1',
    flags: { materialization: true, ui: true, physical: false, interfaceHealth: false, diagnostics: true, ai: false },
    capabilities: { materialization: { available: true, reason: null }, ui: { available: true, reason: null }, collection: { available: true, reason: null }, physical: { available: false, reason: 'capability_unavailable' }, interfaceHealth: { available: false, reason: 'capability_unavailable' }, diagnostics: { available: true, reason: null }, ai: { available: false, reason: 'capability_unavailable' }, recurringMonitoring: { available: false, reason: 'capability_unavailable' } },
    permissions: { canEdit: true, canDiagnose: true, canConfigureMonitoring: true },
    resolved: { settings: { targets: {}, policies: {} }, digest: 'a'.repeat(64), provenance: {}, validationEffects: [] },
    binding: { partnerVersionId: null, orgVersionId: null, bindingRevision: '1', defaultsVersion: 1, schemaVersion: 1, resolverVersion: 1, overrides: { targets: {}, policies: {} } },
  };
  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify(settings)));
  const result = await topologyConfigurationApi.settings(SITE);
  expect(result.siteId).toBe(SITE);
  const [url] = vi.mocked(fetchWithAuth).mock.calls[0];
  expect(String(url)).toBe(`/topology/sites/${SITE}/settings`);
});

it('options paginates via cursor and rejects a draft version slipping into the published list', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ items: [], nextCursor: null })));
  await topologyConfigurationApi.options(SITE, 'cursor-1');
  const [url] = vi.mocked(fetchWithAuth).mock.calls[0];
  expect(String(url)).toBe(`/topology/sites/${SITE}/template-options?cursor=cursor-1`);

  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({
    items: [{ id: crypto.randomUUID(), templateId: crypto.randomUUID(), ownerScope: 'organization', key: 'draft-key', name: 'Draft', version: 1, revision: '1', state: 'draft', schemaVersion: 1, defaultsVersion: 1, resolverVersion: 1, payload: { targets: {}, policies: {} }, contentDigest: 'a'.repeat(64), publishedAt: null }],
    nextCursor: null,
  })));
  await expect(topologyConfigurationApi.options(SITE)).rejects.toThrow();
});

it('previewResponse validates the request client-side and POSTs the parsed body', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ token: 't', expiresAt: new Date().toISOString(), sites: [] })));
  const request = { partnerVersionId: null, orgVersionId: null, sites: [{ siteId: SITE, expectedBindingRevision: '1', enableRecurring: false }] };
  await topologyConfigurationApi.previewResponse(request);
  const [url, options] = vi.mocked(fetchWithAuth).mock.calls[0];
  expect(url).toBe('/topology/template-applications/preview');
  expect(options?.method).toBe('POST');
  expect(JSON.parse(options!.body as string)).toEqual(request);
});

it('previewResponse throws before any request when given a duplicate site id', async () => {
  const request = { partnerVersionId: null, orgVersionId: null, sites: [
    { siteId: SITE, expectedBindingRevision: '1', enableRecurring: false },
    { siteId: SITE, expectedBindingRevision: '1', enableRecurring: false },
  ] };
  expect(() => topologyConfigurationApi.previewResponse(request as never)).toThrow();
  expect(fetchWithAuth).not.toHaveBeenCalled();
});

it('applyResponse sends the idempotency key header and the preview token only', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ id: crypto.randomUUID(), state: 'queued', sites: [] })));
  await topologyConfigurationApi.applyResponse('token-abc', 'idem-1');
  const [url, options] = vi.mocked(fetchWithAuth).mock.calls[0];
  expect(url).toBe('/topology/template-applications');
  expect(options?.method).toBe('POST');
  expect(options?.headers).toEqual({ 'Idempotency-Key': 'idem-1' });
  expect(JSON.parse(options!.body as string)).toEqual({ token: 'token-abc' });
});

it('saveResponse PATCHes the site settings endpoint with a schema-validated overrides payload', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  const request = { expectedRevision: '1', overrides: { targets: {}, policies: {} } };
  await topologyConfigurationApi.saveResponse(SITE, request);
  const [url, options] = vi.mocked(fetchWithAuth).mock.calls[0];
  expect(url).toBe(`/topology/sites/${SITE}/settings`);
  expect(options?.method).toBe('PATCH');
  expect(JSON.parse(options!.body as string)).toEqual(request);
});

it('saveResponse rejects an unknown field before sending, rather than letting the server 400', async () => {
  const request = { expectedRevision: '1', overrides: { targets: {}, policies: {}, notAField: true } };
  expect(() => topologyConfigurationApi.saveResponse(SITE, request)).toThrow();
  expect(fetchWithAuth).not.toHaveBeenCalled();
});
