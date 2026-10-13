import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));
vi.mock('../../components/shared/Toast', () => ({
  showToast: vi.fn(),
}));

import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../../components/shared/Toast';
import { ActionError } from '../runAction';
import { HttpError } from '../httpError';
import {
  createEdrConnection,
  deleteEdrConnection,
  edrProviderLabel,
  fetchEdrConnections,
  fetchEdrDetections,
  fetchEdrEndpoints,
  fetchEdrProviders,
  fetchEdrStatus,
  fetchEdrTenants,
  linkEdrEndpoint,
  mapEdrTenant,
  patchEdrConnection,
  syncEdrConnection,
  testEdrConnection,
} from '../edrProviders';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

function res(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body } as unknown as Response;
}

function lastCall() {
  const [path, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit | undefined];
  return { path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
}

const ID = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
});

describe('edrProviders client — mutations', () => {
  it('createEdrConnection POSTs the body to /edr/connections', async () => {
    fetchMock.mockResolvedValue(res({ data: { id: ID } }, 201));
    const body = { provider: 'bitdefender', name: 'GZ', baseUrl: 'https://x/api', credentials: { apiKey: 'k' } };
    await createEdrConnection(body, { errorFallback: 'e' });
    expect(lastCall()).toEqual({ path: '/edr/connections', method: 'POST', body });
  });

  it('patchEdrConnection PATCHes /edr/connections/:id', async () => {
    fetchMock.mockResolvedValue(res({ data: { id: ID } }));
    await patchEdrConnection(ID, { isActive: false }, { errorFallback: 'e' });
    expect(lastCall()).toEqual({ path: `/edr/connections/${ID}`, method: 'PATCH', body: { isActive: false } });
  });

  it('testEdrConnection POSTs /edr/connections/:id/test', async () => {
    fetchMock.mockResolvedValue(res({ success: true, rootName: 'Root' }));
    const out = await testEdrConnection(ID, { errorFallback: 'e' });
    expect(lastCall()).toEqual({ path: `/edr/connections/${ID}/test`, method: 'POST', body: undefined });
    expect(out.rootName).toBe('Root');
  });

  it('syncEdrConnection POSTs /edr/connections/:id/sync', async () => {
    fetchMock.mockResolvedValue(res({ success: true, syncJobIds: ['a'] }, 202));
    await syncEdrConnection(ID, { errorFallback: 'e' });
    expect(lastCall()).toEqual({ path: `/edr/connections/${ID}/sync`, method: 'POST', body: undefined });
  });

  it('deleteEdrConnection DELETEs with the confirm counts when given', async () => {
    fetchMock.mockResolvedValue(res({ success: true }));
    await deleteEdrConnection(ID, { detections: 3, endpoints: 7 }, { errorFallback: 'e' });
    expect(lastCall()).toEqual({ path: `/edr/connections/${ID}?confirm=3%3A7`, method: 'DELETE', body: undefined });
  });

  it('deleteEdrConnection without counts DELETEs bare (server answers 409 CONFIRM_COUNTS)', async () => {
    fetchMock.mockResolvedValue(res({ code: 'CONFIRM_COUNTS', detections: 1, endpoints: 2, tenants: 1, error: 'confirm' }, 409));
    const err = await deleteEdrConnection(ID, null, { errorFallback: 'e', suppressErrorToast: (s) => s === 409 }).catch((e) => e);
    expect(lastCall()).toEqual({ path: `/edr/connections/${ID}`, method: 'DELETE', body: undefined });
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).code).toBe('CONFIRM_COUNTS');
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('mapEdrTenant(id, null) sends {orgId:null}, never {}', async () => {
    fetchMock.mockResolvedValue(res({ data: { tenantId: ID } }));
    await mapEdrTenant(ID, null, { errorFallback: 'e' });
    expect(lastCall()).toEqual({ path: `/edr/tenants/${ID}/mapping`, method: 'PUT', body: { orgId: null } });
  });

  it('mapEdrTenant(id, org) sends {orgId}', async () => {
    fetchMock.mockResolvedValue(res({ data: { tenantId: ID } }));
    await mapEdrTenant(ID, ORG, { errorFallback: 'e' });
    expect(lastCall().body).toEqual({ orgId: ORG });
  });

  it('linkEdrEndpoint(id, null) sends {deviceId:null}, never {}', async () => {
    fetchMock.mockResolvedValue(res({ data: { id: ID } }));
    await linkEdrEndpoint(ID, null, { errorFallback: 'e' });
    expect(lastCall()).toEqual({ path: `/edr/endpoints/${ID}/link`, method: 'PUT', body: { deviceId: null } });
  });

  it('a 200 {success:false} throws ActionError and toasts', async () => {
    fetchMock.mockResolvedValue(res({ success: false, error: 'bad key' }));
    const err = await testEdrConnection(ID, { errorFallback: 'fallback' }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });
});

describe('edrProviderLabel', () => {
  it('maps a known key; unknown, prototype and empty keys are null', () => {
    expect(edrProviderLabel('bitdefender')).toBe('Bitdefender GravityZone');
    expect(edrProviderLabel('acme')).toBeNull();
    expect(edrProviderLabel('toString')).toBeNull();
    expect(edrProviderLabel(null)).toBeNull();
  });
});

describe('edrProviders client — queries', () => {
  it('fetchEdrProviders returns data[]', async () => {
    fetchMock.mockResolvedValue(res({ data: [{ key: 'bitdefender', label: 'GZ', credentialFields: [], baseUrlPolicy: null, capabilities: {} }] }));
    const rows = await fetchEdrProviders();
    expect(lastCall().path).toBe('/edr/providers');
    expect(rows).toHaveLength(1);
  });

  it('fetchEdrConnections throws HttpError on non-ok (never an empty list)', async () => {
    fetchMock.mockResolvedValue(res({ error: 'no' }, 403));
    await expect(fetchEdrConnections()).rejects.toBeInstanceOf(HttpError);
  });

  it('fetchEdrTenants returns rows, suggestions and summary', async () => {
    fetchMock.mockResolvedValue(res({ data: [{ id: ID }], suggestions: [{ tenantId: ID, orgId: ORG }], summary: { tenants: 1, unmappedTenants: 1, unmappedEndpointCount: 4 } }));
    const out = await fetchEdrTenants(ID);
    expect(lastCall().path).toBe(`/edr/connections/${ID}/tenants`);
    expect(out.suggestions).toEqual([{ tenantId: ID, orgId: ORG }]);
    expect(out.summary.unmappedEndpointCount).toBe(4);
  });

  it('fetchEdrEndpoints builds the query string from set filters only', async () => {
    fetchMock.mockResolvedValue(res({ data: [] }));
    await fetchEdrEndpoints({ deviceId: ID, state: 'linked' });
    expect(lastCall().path).toBe(`/edr/endpoints?deviceId=${ID}&state=linked`);
  });

  it('fetchEdrDetections passes filters (severity joined) and returns data/pagination/coverage', async () => {
    const coverage = { orgsWithEdr: 1, partial: true, notes: ['n'] };
    fetchMock.mockResolvedValue(res({ data: [], pagination: { limit: 50, offset: 0, total: 0 }, coverage }));
    const out = await fetchEdrDetections({ severity: ['critical', 'high'], status: 'open', limit: 50, offset: 0 });
    expect(lastCall().path).toBe('/edr/detections?severity=critical%2Chigh&status=open&limit=50&offset=0');
    expect(out.coverage).toEqual(coverage);
    expect(out.total).toBe(0);
  });

  it('fetchEdrStatus passes orgId when given and returns providers + coverage', async () => {
    fetchMock.mockResolvedValue(res({ data: { providers: [], coverage: { orgsWithEdr: 0, partial: false, notes: [] } } }));
    const out = await fetchEdrStatus({ orgId: ORG });
    expect(lastCall().path).toBe(`/edr/status?orgId=${ORG}`);
    expect(out.providers).toEqual([]);
  });

  it('fetchEdrDetections throws HttpError on non-ok', async () => {
    fetchMock.mockResolvedValue(res({}, 500));
    await expect(fetchEdrDetections({})).rejects.toBeInstanceOf(HttpError);
  });
});
