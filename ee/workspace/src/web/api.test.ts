import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RESPONSE_LENGTH,
  WORKSPACE_API_BASE,
  WorkspaceApiError,
  buildWorkspaceUrl,
  createWorkspaceApi,
  type SourceInput,
} from './api';

const ORG_ID = 'org-1';
const SOURCE_ID = 'src-1';
const DEVICE_ID = 'dev-1';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sourceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SOURCE_ID,
    orgId: ORG_ID,
    kind: 'smb_share',
    displayName: 'Finance Share',
    rootPath: '\\\\fs01\\finance',
    crawlDeviceId: 'dev-9',
    visibilityGroupIds: [],
    crawlCadenceMinutes: 1440,
    excludeGlobs: [],
    watch: true,
    status: 'active',
    errorReason: null,
    lastCompleteRunAt: '2026-07-12T10:00:00.000Z',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    hasCredential: true,
    ...overrides,
  };
}

function sourceInput(): SourceInput {
  return {
    kind: 'smb_share',
    displayName: 'Finance Share',
    rootPath: '\\\\fs01\\finance',
    crawlDeviceId: 'dev-9',
    visibilityGroupIds: [],
    crawlCadenceMinutes: 1440,
    excludeGlobs: [],
    watch: true,
    status: 'active',
  };
}

describe('buildWorkspaceUrl', () => {
  it('builds relative URLs under the workspace API base', () => {
    expect(buildWorkspaceUrl('sources', { orgId: ORG_ID }))
      .toBe(`${WORKSPACE_API_BASE}sources?orgId=org-1`);
  });

  it.each([
    ['absolute URL', 'https://evil.test/x'],
    ['absolute URL, uppercase scheme', 'HTTPS://evil.test/x'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['protocol-relative URL', '//evil.test/x'],
    ['rooted path (caller-supplied origin/path)', '/api/v1/ext/workspace/sources'],
    ['parent traversal', '../secrets'],
    ['embedded parent traversal', 'sources/../../admin'],
    ['percent-encoded traversal', 'sources/%2e%2e/admin'],
    ['backslash path', 'sources\\admin'],
    ['query smuggling', 'sources/x?orgId=other'],
    ['fragment smuggling', 'sources/x#frag'],
  ])('refuses %s', (_label, path) => {
    expect(() => buildWorkspaceUrl(path)).toThrowError(WorkspaceApiError);
    try {
      buildWorkspaceUrl(path);
    } catch (error) {
      expect((error as WorkspaceApiError).kind).toBe('protocol');
    }
  });
});

describe('createWorkspaceApi', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse({ sources: [] }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists sources with the orgId query param and same-origin credentials', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sources: [sourceRow()] }));
    const sources = await createWorkspaceApi().listSources(ORG_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${WORKSPACE_API_BASE}sources?orgId=org-1`);
    expect(init.credentials).toBe('same-origin');
    expect(init.method ?? 'GET').toBe('GET');
    expect(sources).toHaveLength(1);
    expect(sources[0]?.displayName).toBe('Finance Share');
  });

  it('creates a source with a JSON POST', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sourceRow(), 201));
    const created = await createWorkspaceApi().createSource(ORG_ID, sourceInput());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${WORKSPACE_API_BASE}sources?orgId=org-1`);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(sourceInput());
    expect(created.id).toBe(SOURCE_ID);
  });

  it('fetches, patches, and deletes a single source', async () => {
    const api = createWorkspaceApi();
    fetchMock.mockResolvedValueOnce(jsonResponse(sourceRow()));
    await api.getSource(ORG_ID, SOURCE_ID);
    fetchMock.mockResolvedValueOnce(jsonResponse(sourceRow({ displayName: 'Renamed' })));
    await api.updateSource(ORG_ID, SOURCE_ID, { displayName: 'Renamed' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    await api.deleteSource(ORG_ID, SOURCE_ID);

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0]?.[0]).toBe(`${WORKSPACE_API_BASE}sources/src-1?orgId=org-1`);
    expect(calls[1]?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(calls[1]?.[1]?.body as string)).toEqual({ displayName: 'Renamed' });
    expect(calls[2]?.[1]?.method).toBe('DELETE');
    for (const [, init] of calls) {
      expect(init.credentials).toBe('same-origin');
    }
  });

  it('sets and clears credentials against the credential subresource', async () => {
    const api = createWorkspaceApi();
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    await api.setCredential(ORG_ID, SOURCE_ID, { username: 'svc', password: 'p', domain: 'CORP' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    await api.clearCredential(ORG_ID, SOURCE_ID);

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0]?.[0]).toBe(`${WORKSPACE_API_BASE}sources/src-1/credential?orgId=org-1`);
    expect(calls[0]?.[1]?.method).toBe('PUT');
    expect(JSON.parse(calls[0]?.[1]?.body as string))
      .toEqual({ username: 'svc', password: 'p', domain: 'CORP' });
    expect(calls[1]?.[0]).toBe(`${WORKSPACE_API_BASE}sources/src-1/credential?orgId=org-1`);
    expect(calls[1]?.[1]?.method).toBe('DELETE');
  });

  it('lists crawl runs with a limit', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ runs: [] }));
    await createWorkspaceApi().listRuns(ORG_ID, SOURCE_ID);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${WORKSPACE_API_BASE}sources/src-1/runs?orgId=org-1&limit=20`);
  });

  it('returns only the five aggregate device summary fields, stripping extras', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      deviceId: DEVICE_ID,
      indexedFiles: 12,
      visibleSources: 3,
      lastSuccessfulCrawlAt: '2026-07-12T10:00:00.000Z',
      lastActivityAt: '2026-07-13T11:30:00.000Z',
      sampleFileNames: ['secret.docx'],
      indexedPaths: ['\\\\fs01\\finance\\secret.docx'],
    }));
    const summary = await createWorkspaceApi().getDeviceSummary(ORG_ID, DEVICE_ID);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${WORKSPACE_API_BASE}devices/dev-1/summary?orgId=org-1`);
    expect(Object.keys(summary).sort()).toEqual([
      'deviceId',
      'indexedFiles',
      'lastActivityAt',
      'lastSuccessfulCrawlAt',
      'visibleSources',
    ]);
    expect(JSON.stringify(summary)).not.toContain('secret.docx');
  });

  it('refuses hostile path segments without calling fetch', async () => {
    const api = createWorkspaceApi();
    await expect(api.getSource(ORG_ID, '../../admin')).rejects.toMatchObject({ kind: 'protocol' });
    await expect(api.getDeviceSummary(ORG_ID, 'dev/../../x')).rejects.toMatchObject({ kind: 'protocol' });
    // Query/fragment smuggling through an id must die in the segment check.
    await expect(api.getSource(ORG_ID, 'x?orgId=other')).rejects.toMatchObject({ kind: 'protocol' });
    await expect(api.getSource(ORG_ID, 'x#frag')).rejects.toMatchObject({ kind: 'protocol' });
    await expect(api.getSource(ORG_ID, 'x y')).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes the caller AbortSignal through to fetch', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(jsonResponse({ sources: [] }));
    await createWorkspaceApi().listSources(ORG_ID, { signal: controller.signal });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it('normalizes 400 responses and never adopts the server string as its own message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: '<b>nope</b>' }, 400));
    const error = await createWorkspaceApi().listSources(ORG_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceApiError);
    const apiError = error as WorkspaceApiError;
    expect(apiError.kind).toBe('invalid-request');
    expect(apiError.status).toBe(400);
    expect(apiError.message).not.toContain('<');
    expect(apiError.detail).toBe('<b>nope</b>');
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not-found'],
    [500, 'server'],
  ])('maps HTTP %d to kind %s', async (status, kind) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'x' }, status));
    await expect(createWorkspaceApi().listSources(ORG_ID)).rejects.toMatchObject({ kind, status });
  });

  it('caps oversized response bodies', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(MAX_RESPONSE_LENGTH + 1), { status: 200 }));
    await expect(createWorkspaceApi().listSources(ORG_ID)).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('rejects non-JSON and wrong-shape success bodies as protocol errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>hi</html>', { status: 200 }));
    await expect(createWorkspaceApi().listSources(ORG_ID)).rejects.toMatchObject({ kind: 'protocol' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ unexpected: true }));
    await expect(createWorkspaceApi().listSources(ORG_ID)).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('normalizes network failures without echoing the underlying message', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('ECONNREFUSED secret-host'));
    const error = await createWorkspaceApi().listSources(ORG_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceApiError);
    expect((error as WorkspaceApiError).kind).toBe('network');
    expect((error as WorkspaceApiError).message).not.toContain('secret-host');
  });

  it('maps aborts to the aborted kind', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'));
    await expect(createWorkspaceApi().listSources(ORG_ID)).rejects.toMatchObject({ kind: 'aborted' });
  });
});
