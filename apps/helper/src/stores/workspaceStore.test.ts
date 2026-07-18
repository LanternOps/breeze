import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/helperFetch', () => ({
  helperRequest: vi.fn(),
  getTauriInvoke: vi.fn(async () => null),
  requireDevBearerToken: vi.fn(),
}));

import { helperRequest } from '../lib/helperFetch';
import { useChatStore } from './chatStore';
import { useWorkspaceStore, type FinderFile } from './workspaceStore';

const helperRequestMock = vi.mocked(helperRequest);

const AGENT_CONFIG = { api_url: 'http://localhost:3001', agent_id: 'agent-1' };

function ok(body: unknown, status = 200) {
  return { ok: true, status, body: JSON.stringify(body) };
}

function file(overrides: Partial<FinderFile> = {}): FinderFile {
  return {
    id: 'f1',
    sourceId: 's1',
    deviceKey: '__shared__',
    relPath: 'clients/alder/b.pdf',
    parentPath: 'clients/alder',
    name: 'b.pdf',
    isDir: false,
    ext: 'pdf',
    size: 1024,
    mtime: '2026-07-01T00:00:00.000Z',
    openPath: '\\\\srv\\share\\clients\\alder\\b.pdf',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ agentConfig: AGENT_CONFIG });
  useWorkspaceStore.setState({
    available: null,
    features: [],
    sources: [],
    results: [],
    entries: [],
    recent: [],
    department: [],
    loading: false,
    error: null,
    browsePath: null,
  });
});

describe('probe', () => {
  it('marks the workspace available and loads features + sources on 200', async () => {
    helperRequestMock
      .mockResolvedValueOnce(ok({ ok: true, features: ['search', 'browse', 'recents', 'open'] }))
      .mockResolvedValueOnce(ok({ sources: [{ id: 's1', displayName: 'Alder Creek', kind: 'smb_share' }] }));

    await useWorkspaceStore.getState().probe();

    const s = useWorkspaceStore.getState();
    expect(s.available).toBe(true);
    expect(s.features).toEqual(['search', 'browse', 'recents', 'open']);
    expect(s.sources).toEqual([{ id: 's1', displayName: 'Alder Creek', kind: 'smb_share' }]);
    expect(s.error).toBeNull();
    expect(helperRequestMock.mock.calls[0][1]).toBe(
      'http://localhost:3001/api/v1/workspace/helper/capabilities',
    );
    expect(helperRequestMock.mock.calls[1][1]).toBe(
      'http://localhost:3001/api/v1/workspace/helper/sources',
    );
  });

  it('hides the workspace on 404 without surfacing an error', async () => {
    helperRequestMock.mockResolvedValueOnce({ ok: false, status: 404, body: 'Not found' });

    await useWorkspaceStore.getState().probe();

    const s = useWorkspaceStore.getState();
    expect(s.available).toBe(false);
    expect(s.error).toBeNull();
    expect(helperRequestMock).toHaveBeenCalledTimes(1);
  });

  it('hides the workspace on 401 without surfacing an error', async () => {
    helperRequestMock.mockResolvedValueOnce({ ok: false, status: 401, body: '{"error":"unauthorized"}' });

    await useWorkspaceStore.getState().probe();

    const s = useWorkspaceStore.getState();
    expect(s.available).toBe(false);
    expect(s.error).toBeNull();
  });

  it('hides the workspace when the probe request throws', async () => {
    helperRequestMock.mockRejectedValueOnce(new Error('network down'));

    await useWorkspaceStore.getState().probe();

    const s = useWorkspaceStore.getState();
    expect(s.available).toBe(false);
    expect(s.error).toBeNull();
  });
});

describe('search', () => {
  it('populates results and encodes query params', async () => {
    const row = file();
    helperRequestMock.mockResolvedValueOnce(ok({ results: [row] }));

    await useWorkspaceStore.getState().search('quarterly report', { sourceId: 's1', ext: 'pdf' });

    const s = useWorkspaceStore.getState();
    expect(s.results).toEqual([row]);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();

    const url = new URL(helperRequestMock.mock.calls[0][1]);
    expect(url.pathname).toBe('/api/v1/workspace/helper/search');
    expect(url.searchParams.get('q')).toBe('quarterly report');
    expect(url.searchParams.get('sourceId')).toBe('s1');
    expect(url.searchParams.get('ext')).toBe('pdf');
  });

  it('omits absent filters from the query string', async () => {
    helperRequestMock.mockResolvedValueOnce(ok({ results: [] }));

    await useWorkspaceStore.getState().search('henderson');

    const url = new URL(helperRequestMock.mock.calls[0][1]);
    expect(url.searchParams.get('q')).toBe('henderson');
    expect(url.searchParams.has('sourceId')).toBe(false);
    expect(url.searchParams.has('ext')).toBe(false);
  });

  it('surfaces an API failure as error and clears loading', async () => {
    helperRequestMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      body: JSON.stringify({ error: 'Search unavailable' }),
    });

    await useWorkspaceStore.getState().search('x');

    const s = useWorkspaceStore.getState();
    expect(s.error).toBe('Search unavailable');
    expect(s.loading).toBe(false);
    expect(s.results).toEqual([]);
  });

  it('does nothing without an agent config', async () => {
    useChatStore.setState({ agentConfig: null });

    await useWorkspaceStore.getState().search('x');

    expect(helperRequestMock).not.toHaveBeenCalled();
  });
});

describe('browse', () => {
  it('sets entries and browsePath from a folder listing', async () => {
    const dir = file({ id: 'd1', isDir: true, name: 'contracts', ext: null, openPath: null });
    helperRequestMock.mockResolvedValueOnce(ok({ entries: [dir] }));

    await useWorkspaceStore.getState().browse('s1', 'clients/alder');

    const s = useWorkspaceStore.getState();
    expect(s.entries).toEqual([dir]);
    expect(s.browsePath).toEqual({ sourceId: 's1', parentPath: 'clients/alder' });
    expect(s.loading).toBe(false);

    const url = new URL(helperRequestMock.mock.calls[0][1]);
    expect(url.pathname).toBe('/api/v1/workspace/helper/browse');
    expect(url.searchParams.get('sourceId')).toBe('s1');
    expect(url.searchParams.get('parentPath')).toBe('clients/alder');
  });

  it('surfaces a browse failure and keeps the previous browsePath', async () => {
    useWorkspaceStore.setState({ browsePath: { sourceId: 's1', parentPath: '' } });
    helperRequestMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      body: JSON.stringify({ error: 'Not found' }),
    });

    await useWorkspaceStore.getState().browse('s2', 'x');

    const s = useWorkspaceStore.getState();
    expect(s.error).toBe('Not found');
    expect(s.loading).toBe(false);
    expect(s.browsePath).toEqual({ sourceId: 's1', parentPath: '' });
  });
});

describe('loadRecents', () => {
  it('fills recent and department feeds', async () => {
    const mine = file();
    const dept = { ...file({ id: 'f2', name: 'notes.docx' }), lastActivityAt: '2026-07-17T10:00:00.000Z' };
    helperRequestMock.mockResolvedValueOnce(ok({ recent: [mine], department: [dept] }));

    await useWorkspaceStore.getState().loadRecents('todd');

    const s = useWorkspaceStore.getState();
    expect(s.recent).toEqual([mine]);
    expect(s.department).toEqual([dept]);

    const url = new URL(helperRequestMock.mock.calls[0][1]);
    expect(url.pathname).toBe('/api/v1/workspace/helper/recents');
    expect(url.searchParams.get('helperUser')).toBe('todd');
  });

  it('omits helperUser param when null', async () => {
    helperRequestMock.mockResolvedValueOnce(ok({ recent: [], department: [] }));

    await useWorkspaceStore.getState().loadRecents(null);

    const url = new URL(helperRequestMock.mock.calls[0][1]);
    expect(url.searchParams.has('helperUser')).toBe(false);
  });
});

describe('recordActivity', () => {
  it('POSTs the strict activity body', async () => {
    helperRequestMock.mockResolvedValueOnce(ok({ recorded: true }, 201));

    await useWorkspaceStore.getState().recordActivity('f1', 'open', 'todd');

    expect(helperRequestMock).toHaveBeenCalledTimes(1);
    const [, url, options] = helperRequestMock.mock.calls[0];
    expect(url).toBe('http://localhost:3001/api/v1/workspace/helper/activity');
    expect(options.method).toBe('POST');
    expect(options.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(options.body as string)).toEqual({
      fileIndexId: 'f1',
      action: 'open',
      helperUser: 'todd',
    });
  });

  it('omits helperUser from the body when null', async () => {
    helperRequestMock.mockResolvedValueOnce(ok({ recorded: true }, 201));

    await useWorkspaceStore.getState().recordActivity('f1', 'copy_path', null);

    const [, , options] = helperRequestMock.mock.calls[0];
    expect(JSON.parse(options.body as string)).toEqual({
      fileIndexId: 'f1',
      action: 'copy_path',
    });
  });

  it('is best-effort: a failure does not surface an error', async () => {
    helperRequestMock.mockRejectedValueOnce(new Error('network down'));

    await useWorkspaceStore.getState().recordActivity('f1', 'open', null);

    expect(useWorkspaceStore.getState().error).toBeNull();
  });
});
