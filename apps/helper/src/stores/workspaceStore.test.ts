import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/helperFetch', () => ({
  helperRequest: vi.fn(),
  getTauriInvoke: vi.fn(async () => null),
  requireDevBearerToken: vi.fn(),
}));

import { helperRequest } from '../lib/helperFetch';
import { useChatStore } from './chatStore';
import { useWorkspaceStore, sortRows, type FinderFile } from './workspaceStore';

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
    contentEnabled: null,
    contentFeatures: [],
    sources: [],
    results: [],
    entries: [],
    recent: [],
    department: [],
    filings: [],
    projects: [],
    loading: false,
    error: null,
    filingBusy: null,
    browsePath: null,
    // Neutral baseline for sort tests — the store's real production defaults
    // (browse: name/asc, recents: mtime/desc) are asserted separately.
    sort: { search: null, browse: null, recents: null },
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

describe('content preview probe', () => {
  it('sets contentEnabled + features when the capabilities endpoint answers 200', async () => {
    helperRequestMock
      .mockResolvedValueOnce(ok({ ok: true, features: ['search'] }))
      .mockResolvedValueOnce(ok({ sources: [] }))
      .mockResolvedValueOnce(ok({ enabled: true, features: ['contentSearch', 'filing', 'projects'] }));
    await useWorkspaceStore.getState().probe();
    expect(useWorkspaceStore.getState().contentEnabled).toBe(true);
    expect(useWorkspaceStore.getState().contentFeatures).toEqual(['contentSearch', 'filing', 'projects']);
  });

  it('quietly disables content on 404 (flag off) without touching availability', async () => {
    helperRequestMock
      .mockResolvedValueOnce(ok({ ok: true, features: ['search'] }))
      .mockResolvedValueOnce(ok({ sources: [] }))
      .mockResolvedValueOnce({ ok: false, status: 404, body: '{"error":"not found"}' });
    await useWorkspaceStore.getState().probe();
    expect(useWorkspaceStore.getState().available).toBe(true);
    expect(useWorkspaceStore.getState().contentEnabled).toBe(false);
    expect(useWorkspaceStore.getState().error).toBeNull();
  });
});

describe('filing', () => {
  const FILING = {
    fileIndexId: 'e1', relPath: 'Emails/Unfiled/x.eml', name: 'x.eml',
    emailMeta: { subject: 'RE: PO 4021' }, status: null,
    suggestedProjectKey: null, suggestedProjectLabel: null,
    matchedEntityType: null, matchedEntityValue: null,
    confidence: null, rationale: null, decidedProjectKey: null,
  };

  it('loadFilings fills filings and projects', async () => {
    helperRequestMock
      .mockResolvedValueOnce(ok({ filings: [FILING] }))
      .mockResolvedValueOnce(ok({ projects: [{ key: '2023-041', label: 'Henderson Water Main Replacement' }] }));
    await useWorkspaceStore.getState().loadFilings();
    expect(useWorkspaceStore.getState().filings).toHaveLength(1);
    expect(useWorkspaceStore.getState().projects[0].key).toBe('2023-041');
  });

  it('classifyEmail POSTs the id and swaps the row in place', async () => {
    useWorkspaceStore.setState({ filings: [FILING] });
    const suggested = {
      ...FILING, status: 'suggested', suggestedProjectKey: '2023-041',
      suggestedProjectLabel: 'Henderson Water Main Replacement', confidence: 'high',
      rationale: 'matched City of Fairoaks PO #4021',
    };
    helperRequestMock.mockResolvedValueOnce(ok({ filing: suggested }));
    await useWorkspaceStore.getState().classifyEmail('e1');
    const [, url, init] = helperRequestMock.mock.calls[0];
    expect(url).toContain('/filing/classify');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ fileIndexId: 'e1' });
    expect(useWorkspaceStore.getState().filings[0].confidence).toBe('high');
    expect(useWorkspaceStore.getState().filingBusy).toBeNull();
  });

  it('assignFiling posts projectKey + helperUser and surfaces failures', async () => {
    useWorkspaceStore.setState({ filings: [FILING] });
    helperRequestMock.mockResolvedValueOnce(ok({ filing: { ...FILING, status: 'reassigned', decidedProjectKey: '2025-012' } }));
    await useWorkspaceStore.getState().assignFiling('e1', '2025-012', 'Front desk');
    const [, url, init] = helperRequestMock.mock.calls[0];
    expect(url).toContain('/filing/e1/assign');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ projectKey: '2025-012', helperUser: 'Front desk' });
    expect(useWorkspaceStore.getState().filings[0].status).toBe('reassigned');

    helperRequestMock.mockResolvedValueOnce({ ok: false, status: 404, body: '{"error":"not found"}' });
    await useWorkspaceStore.getState().assignFiling('e1', '9999-999', null);
    expect(useWorkspaceStore.getState().error).toBe('not found');
    expect(useWorkspaceStore.getState().filingBusy).toBeNull();
  });
});

describe('sort', () => {
  it('setSort toggles direction on repeated column', () => {
    const s = useWorkspaceStore.getState();
    s.setSort('browse', 'name');
    expect(useWorkspaceStore.getState().sort.browse).toEqual({ col: 'name', dir: 'asc' });
    s.setSort('browse', 'name');
    expect(useWorkspaceStore.getState().sort.browse).toEqual({ col: 'name', dir: 'desc' });
  });

  it('setSort resets to asc when the column changes', () => {
    const s = useWorkspaceStore.getState();
    s.setSort('recents', 'mtime');
    s.setSort('recents', 'mtime');
    expect(useWorkspaceStore.getState().sort.recents).toEqual({ col: 'mtime', dir: 'desc' });
    s.setSort('recents', 'name');
    expect(useWorkspaceStore.getState().sort.recents).toEqual({ col: 'name', dir: 'asc' });
  });

  it('sortRows: null sort preserves input order (relevance)', () => {
    const rows = [file({ name: 'b' }), file({ name: 'a' })];
    expect(sortRows(rows, null).map((r) => r.name)).toEqual(['b', 'a']);
  });

  it('sortRows orders by mtime desc and size asc; dirs before files on name in browse mode', () => {
    const byMtime = [
      file({ id: 'm1', name: 'old', mtime: '2026-01-01T00:00:00.000Z' }),
      file({ id: 'm2', name: 'new', mtime: '2026-07-01T00:00:00.000Z' }),
    ];
    expect(sortRows(byMtime, { col: 'mtime', dir: 'desc' }).map((r) => r.name)).toEqual([
      'new', 'old',
    ]);

    const bySize = [
      file({ id: 's1', name: 'big', size: 2048 }),
      file({ id: 's2', name: 'small', size: 512 }),
    ];
    expect(sortRows(bySize, { col: 'size', dir: 'asc' }).map((r) => r.name)).toEqual([
      'small', 'big',
    ]);

    const rows = [file({ name: 'z', isDir: true }), file({ name: 'a', isDir: false })];
    expect(sortRows(rows, { col: 'name', dir: 'asc' }, { dirsFirst: true }).map((r) => r.name)).toEqual([
      'z', 'a',
    ]);
  });
});
