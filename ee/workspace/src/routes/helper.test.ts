import { Hono } from 'hono';
import type { ExtensionAuditEvent, ExtensionHelperDevice } from '../hostTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHelperRoutes, type WorkspaceHelperRouteEnv } from './helper';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ORG_B = '88888888-8888-4888-8888-888888888888';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_B_ID = '55555555-5555-4555-8555-555555555555';
const FILE_ID = '77777777-7777-4777-8777-777777777777';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const helperDevice: ExtensionHelperDevice = {
  id: DEVICE_ID,
  agentId: 'agent-1',
  orgId: ORG_ID,
  siteId: '66666666-6666-4666-8666-666666666666',
  hostname: 'FRONT-DESK-01',
  osType: 'windows',
  osVersion: '11',
  agentVersion: '1.0.0',
};

const deviceOrgB: ExtensionHelperDevice = { ...helperDevice, id: DEVICE_B_ID, orgId: ORG_B };

function visibleSource(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_ID,
    displayName: 'Alder Creek (dev)',
    kind: 'smb_share' as const,
    rootPath: '\\\\srv\\alder',
    ...overrides,
  };
}

function file(overrides: Record<string, unknown> = {}) {
  return {
    id: FILE_ID,
    sourceId: SOURCE_ID,
    deviceKey: ZERO_UUID,
    relPath: 'clients/henderson/report.pdf',
    parentPath: 'clients/henderson',
    name: 'report.pdf',
    isDir: false,
    ext: 'pdf',
    size: 1024,
    mtime: '2026-07-12T10:00:00.000Z',
    openPath: '\\\\srv\\alder\\clients\\henderson\\report.pdf',
    ...overrides,
  };
}

function contentServices() {
  return {
    search: vi.fn(async () => [{
      ...file(),
      snippet: '…<b>Henderson</b> easement…',
      inferredDocType: 'easement deed',
      inferredProjectKey: '2023-041',
      inferredProjectLabel: 'Henderson Water Main Replacement',
      declaredProjectKey: '2024-007',
      declaredProjectLabel: 'Vine Hill Winery Site Plan',
      metadataDisagreement: true,
      group: 'document' as const,
      matchedEntities: [],
    }]),
    passages: vi.fn(async () => [{
      fileIndexId: FILE_ID,
      relPath: 'clients/henderson/report.pdf',
      sourceId: SOURCE_ID,
      openPath: '\\\\srv\\alder\\clients\\henderson\\report.pdf',
      snippet: 'GRANT OF EASEMENT for the Henderson Road project.',
      score: 0.042,
    }]),
  };
}

/**
 * `contentEnabled` seeds the injected per-org content flag (Task 3, replacing
 * the WORKSPACE_CONTENT_PREVIEW env var). Default off — the finder base surface
 * must work while content is disabled.
 */
function makeHarness(options: { contentSearch?: boolean; contentEnabled?: boolean } = {}) {
  const fileQueryService = {
    visibleSources: vi.fn(async () => [visibleSource()]),
    search: vi.fn(async () => [file()]),
    browse: vi.fn(async () => [file()]),
  };
  const contentSearchService = options.contentSearch === false ? undefined : contentServices();
  const activityService = {
    record: vi.fn(async (): Promise<{ recorded: true } | { notFound: true }> => (
      { recorded: true }
    )),
    recents: vi.fn(async () => [file()]),
    departmentRecent: vi.fn(async () => [
      { ...file(), lastActivityAt: '2026-07-13T09:00:00.000Z' },
    ]),
  };
  const getSettings = vi.fn(async (_orgId: string) => ({ contentEnabled: options.contentEnabled ?? false }));
  const audit = vi.fn(async (_event: ExtensionAuditEvent) => {});
  const log = vi.fn();
  const app = new Hono<WorkspaceHelperRouteEnv>();
  // Fake of the injected core helper auth middleware: 401 without a bearer
  // token, otherwise sets the helperDevice context like the real one.
  app.use('*', async (c, next) => {
    if (!c.req.header('authorization')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }
    c.set('helperDevice', helperDevice);
    await next();
  });
  app.route('/', createHelperRoutes({
    fileQueryService, activityService, contentSearchService, getSettings, audit, log,
  }));
  return { app, fileQueryService, activityService, contentSearchService, getSettings, audit, log };
}

const authed = { headers: { authorization: 'Bearer brz_helper-token' } };

function postActivity(body: unknown) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer brz_helper-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('workspace helper routes', () => {
  describe('authentication', () => {
    it('rejects every helper path without the auth context, capabilities included', async () => {
      const { app, fileQueryService, activityService } = makeHarness();
      const paths: Array<[string, RequestInit | undefined]> = [
        ['/capabilities', undefined],
        ['/sources', undefined],
        ['/search?q=henderson', undefined],
        [`/browse?sourceId=${SOURCE_ID}`, undefined],
        ['/recents', undefined],
        ['/activity', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileIndexId: FILE_ID, action: 'open' }),
        }],
      ];
      for (const [path, init] of paths) {
        const res = await app.request(path, init);
        expect(res.status, path).toBe(401);
      }
      expect(fileQueryService.search).not.toHaveBeenCalled();
      expect(fileQueryService.browse).not.toHaveBeenCalled();
      expect(activityService.record).not.toHaveBeenCalled();
    });
  });

  describe('GET /capabilities', () => {
    it('reports the finder feature set', async () => {
      const { app } = makeHarness();
      const res = await app.request('/capabilities', authed);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        features: ['search', 'browse', 'recents', 'open'],
      });
    });
  });

  describe('GET /sources', () => {
    it('lists visible sources without leaking rootPath', async () => {
      const { app, fileQueryService } = makeHarness();
      const res = await app.request('/sources', authed);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        sources: [{ id: SOURCE_ID, displayName: 'Alder Creek (dev)', kind: 'smb_share' }],
      });
      expect(fileQueryService.visibleSources).toHaveBeenCalledWith(ORG_ID, []);
    });
  });

  describe('GET /search', () => {
    it('passes the caller identity and all filters to the query service', async () => {
      const { app, fileQueryService } = makeHarness();
      const res = await app.request(
        `/search?q=henderson&sourceId=${SOURCE_ID}&ext=pdf` +
        '&modifiedAfter=2026-01-01T00:00:00.000Z&modifiedBefore=2026-07-01T00:00:00.000Z&limit=5',
        authed,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [file()] });
      expect(fileQueryService.search).toHaveBeenCalledWith(ORG_ID, DEVICE_ID, {
        q: 'henderson',
        sourceId: SOURCE_ID,
        ext: 'pdf',
        modifiedAfter: '2026-01-01T00:00:00.000Z',
        modifiedBefore: '2026-07-01T00:00:00.000Z',
        limit: 5,
      }, []);
    });

    it('searches with only q', async () => {
      const { app, fileQueryService } = makeHarness();
      const res = await app.request('/search?q=x', authed);
      expect(res.status).toBe(200);
      expect(fileQueryService.search).toHaveBeenCalledWith(ORG_ID, DEVICE_ID, { q: 'x' }, []);
    });

    it('rejects a missing q with 400', async () => {
      const { app, fileQueryService } = makeHarness();
      const res = await app.request('/search', authed);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid request' });
      expect(fileQueryService.search).not.toHaveBeenCalled();
    });

    it('rejects an oversized q with 400', async () => {
      const { app, fileQueryService } = makeHarness();
      const res = await app.request(`/search?q=${'a'.repeat(201)}`, authed);
      expect(res.status).toBe(400);
      expect(fileQueryService.search).not.toHaveBeenCalled();
    });

    it('rejects a non-numeric limit with 400', async () => {
      const { app, fileQueryService } = makeHarness();
      const res = await app.request('/search?q=x&limit=abc', authed);
      expect(res.status).toBe(400);
      expect(fileQueryService.search).not.toHaveBeenCalled();
    });

    it('uses the legacy path when content is disabled, even with the service wired', async () => {
      const { app, fileQueryService, contentSearchService } = makeHarness();
      const res = await app.request('/search?q=x', authed);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [file()] });
      expect(fileQueryService.search).toHaveBeenCalled();
      expect(contentSearchService?.search).not.toHaveBeenCalled();
    });

    it('uses the hybrid path when content is enabled for the org', async () => {
      const { app, fileQueryService, contentSearchService } = makeHarness({ contentEnabled: true });
      const res = await app.request('/search?q=Henderson easement', authed);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results[0]).toMatchObject({
        inferredDocType: 'easement deed',
        metadataDisagreement: true,
        group: 'document',
      });
      expect(contentSearchService?.search).toHaveBeenCalledWith(
        ORG_ID, DEVICE_ID, expect.objectContaining({ q: 'Henderson easement' }), [],
      );
      expect(fileQueryService.search).not.toHaveBeenCalled();
    });

    it('falls back to legacy when no content service is wired, content flag regardless', async () => {
      const { app, fileQueryService } = makeHarness({ contentSearch: false, contentEnabled: true });
      const res = await app.request('/search?q=x', authed);
      expect(res.status).toBe(200);
      expect(fileQueryService.search).toHaveBeenCalled();
    });

    it('accepts project/docType filters and forwards them to the hybrid search service', async () => {
      const { app, contentSearchService } = makeHarness({ contentEnabled: true });
      const res = await app.request(
        '/search?q=henderson&project=Henderson%20Water%20Main%20Replacement&docType=easement',
        authed,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results.every((r: { inferredDocType: string }) => r.inferredDocType === 'easement deed'))
        .toBe(true);
      expect(contentSearchService?.search).toHaveBeenCalledWith(ORG_ID, DEVICE_ID, {
        q: 'henderson',
        project: 'Henderson Water Main Replacement',
        docType: 'easement',
      }, []);
    });

    it('accepts project/docType filters on the legacy path too', async () => {
      const { app, fileQueryService } = makeHarness();
      const res = await app.request('/search?q=x&docType=easement', authed);
      expect(res.status).toBe(200);
      expect(fileQueryService.search).toHaveBeenCalledWith(ORG_ID, DEVICE_ID, {
        q: 'x', docType: 'easement',
      }, []);
    });
  });

  describe('filing routes (dev-preview gating)', () => {
    const FILING = {
      fileIndexId: FILE_ID, relPath: 'Emails/Unfiled/x.eml', name: 'x.eml', emailMeta: null,
      status: 'suggested', suggestedProjectKey: '2023-041',
      suggestedProjectLabel: 'Henderson Water Main Replacement',
      matchedEntityType: 'po', matchedEntityValue: 'PO 4021', confidence: 'high',
      rationale: 'matched City of Fairoaks PO #4021', decidedProjectKey: null,
    };
    const filingService = {
      list: vi.fn(async () => [FILING]),
      classify: vi.fn(async () => FILING),
      assign: vi.fn(async () => ({ ...FILING, status: 'reassigned', decidedProjectKey: '2025-012' })),
      projects: vi.fn(async () => [{ key: '2023-041', label: 'Henderson Water Main Replacement' }]),
    };

    function makeFilingApp(contentEnabled = false) {
      const base = makeHarness();
      const app = new Hono<WorkspaceHelperRouteEnv>();
      app.use('*', async (c, next) => {
        if (!c.req.header('authorization')) return c.json({ error: 'unauthorized' }, 401);
        c.set('helperDevice', helperDevice);
        await next();
      });
      app.route('/', createHelperRoutes({
        fileQueryService: base.fileQueryService,
        activityService: base.activityService,
        contentSearchService: base.contentSearchService,
        filingService: filingService as never,
        getSettings: vi.fn(async (_orgId: string) => ({ contentEnabled })),
        audit: base.audit,
        log: base.log,
      }));
      return app;
    }

    it('404s every filing route when content is disabled', async () => {
      const app = makeFilingApp();
      for (const [method, path, body] of [
        ['GET', '/filing', undefined],
        ['GET', '/content/projects', undefined],
        ['POST', '/filing/classify', { fileIndexId: FILE_ID }],
        ['POST', `/filing/${FILE_ID}/assign`, { projectKey: '2023-041' }],
      ] as const) {
        const res = await app.request(path, {
          method,
          headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      expect(filingService.classify).not.toHaveBeenCalled();
    });

    it('serves list/classify/assign/projects when content is enabled', async () => {
      const app = makeFilingApp(true);
      const list = await app.request('/filing', authed);
      expect(list.status).toBe(200);
      expect((await list.json()).filings[0].rationale).toBe('matched City of Fairoaks PO #4021');

      const classify = await app.request('/filing/classify', {
        method: 'POST',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: JSON.stringify({ fileIndexId: FILE_ID }),
      });
      expect(classify.status).toBe(200);
      expect(filingService.classify).toHaveBeenCalledWith(ORG_ID, FILE_ID, []);

      const assign = await app.request(`/filing/${FILE_ID}/assign`, {
        method: 'POST',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: JSON.stringify({ projectKey: '2025-012', helperUser: 'Front desk' }),
      });
      expect(assign.status).toBe(200);
      expect(filingService.assign).toHaveBeenCalledWith(ORG_ID, FILE_ID, '2025-012', 'Front desk', []);

      const projects = await app.request('/content/projects', authed);
      expect((await projects.json()).projects).toHaveLength(1);
    });

    it('rejects malformed classify/assign requests', async () => {
      const app = makeFilingApp(true);
      const nonUuid = await app.request('/filing/classify', {
        method: 'POST',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: JSON.stringify({ fileIndexId: 'not-a-uuid' }),
      });
      expect(nonUuid.status).toBe(404);
      const extraField = await app.request(`/filing/${FILE_ID}/assign`, {
        method: 'POST',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: JSON.stringify({ projectKey: 'x', nope: 1 }),
      });
      expect(extraField.status).toBe(400);
    });

    it('capabilities reports filing features when the service is wired', async () => {
      const app = makeFilingApp(true);
      const res = await app.request('/content/capabilities', authed);
      expect(await res.json()).toEqual({
        enabled: true, features: ['contentSearch', 'filing', 'projects'],
      });
    });
  });

  describe('GET /content/passages', () => {
    it('404s when content is disabled for the org', async () => {
      const { app, contentSearchService } = makeHarness();
      const res = await app.request('/content/passages?q=easement', authed);
      expect(res.status).toBe(404);
      expect(contentSearchService?.passages).not.toHaveBeenCalled();
    });

    it('404s when content is enabled but no content service is wired', async () => {
      const { app } = makeHarness({ contentSearch: false, contentEnabled: true });
      const res = await app.request('/content/passages?q=easement', authed);
      expect(res.status).toBe(404);
    });

    it('requires helper auth', async () => {
      const { app } = makeHarness({ contentEnabled: true });
      const res = await app.request('/content/passages?q=easement');
      expect(res.status).toBe(401);
    });

    it('rejects a missing q with 400', async () => {
      const { app, contentSearchService } = makeHarness({ contentEnabled: true });
      const res = await app.request('/content/passages', authed);
      expect(res.status).toBe(400);
      expect(contentSearchService?.passages).not.toHaveBeenCalled();
    });

    it('returns visibility-scoped passages and forwards the caller identity', async () => {
      const { app, contentSearchService } = makeHarness({ contentEnabled: true });
      const res = await app.request('/content/passages?q=Henderson easement', authed);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.passages[0]).toEqual({
        fileIndexId: FILE_ID,
        relPath: 'clients/henderson/report.pdf',
        sourceId: SOURCE_ID,
        openPath: '\\\\srv\\alder\\clients\\henderson\\report.pdf',
        snippet: 'GRANT OF EASEMENT for the Henderson Road project.',
        score: 0.042,
      });
      expect(contentSearchService?.passages).toHaveBeenCalledWith(
        ORG_ID, 'Henderson easement', { helperDeviceId: DEVICE_ID }, [],
      );
    });

    it('forwards fileIndexId and limit when provided', async () => {
      const { app, contentSearchService } = makeHarness({ contentEnabled: true });
      const res = await app.request(
        `/content/passages?q=easement&fileIndexId=${FILE_ID}&limit=3`, authed,
      );
      expect(res.status).toBe(200);
      expect(contentSearchService?.passages).toHaveBeenCalledWith(
        ORG_ID, 'easement', { helperDeviceId: DEVICE_ID, fileIndexId: FILE_ID, limit: 3 }, [],
      );
    });

    it('404s a malformed fileIndexId before the service runs', async () => {
      const { app, contentSearchService } = makeHarness({ contentEnabled: true });
      const res = await app.request('/content/passages?q=easement&fileIndexId=not-a-uuid', authed);
      expect(res.status).toBe(404);
      expect(contentSearchService?.passages).not.toHaveBeenCalled();
    });
  });

  describe('GET /content/capabilities', () => {
    it('404s when content is disabled for the org', async () => {
      const { app } = makeHarness();
      const res = await app.request('/content/capabilities', authed);
      expect(res.status).toBe(404);
    });

    it('404s when content is enabled but no service is wired', async () => {
      const { app } = makeHarness({ contentSearch: false, contentEnabled: true });
      const res = await app.request('/content/capabilities', authed);
      expect(res.status).toBe(404);
    });

    it('reports content features when enabled', async () => {
      const { app } = makeHarness({ contentEnabled: true });
      const res = await app.request('/content/capabilities', authed);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: true, features: ['contentSearch'] });
    });

    it('requires helper auth', async () => {
      const { app } = makeHarness({ contentEnabled: true });
      const res = await app.request('/content/capabilities');
      expect(res.status).toBe(401);
    });
  });

  // The per-org property the WORKSPACE_CONTENT_PREVIEW env var could never
  // express: org A enabled, org B disabled, one process, one route tree —
  // driven entirely by the injected getSettings(orgId).
  describe('per-org content flag (A enabled, B disabled, same process)', () => {
    const filingService = {
      list: vi.fn(async () => []),
      classify: vi.fn(async () => null),
      assign: vi.fn(async () => null),
      projects: vi.fn(async () => []),
    };

    function makePerOrgApp() {
      const base = makeHarness();
      const getSettings = vi.fn(async (orgId: string) => ({ contentEnabled: orgId === ORG_ID }));
      const app = new Hono<WorkspaceHelperRouteEnv>();
      app.use('*', async (c, next) => {
        if (!c.req.header('authorization')) return c.json({ error: 'unauthorized' }, 401);
        c.set('helperDevice', c.req.header('x-org') === 'B' ? deviceOrgB : helperDevice);
        await next();
      });
      app.route('/', createHelperRoutes({
        fileQueryService: base.fileQueryService,
        activityService: base.activityService,
        contentSearchService: base.contentSearchService,
        filingService: filingService as never,
        getSettings,
        audit: base.audit,
        log: base.log,
      }));
      return { app, base };
    }

    const asA = authed;
    const asB = { headers: { authorization: 'Bearer brz_helper-token', 'x-org': 'B' } };

    it('/search: A takes the hybrid path, B takes the legacy path', async () => {
      const { app, base } = makePerOrgApp();
      const a = await app.request('/search?q=easement', asA);
      expect(a.status).toBe(200);
      expect(base.contentSearchService?.search).toHaveBeenCalledWith(
        ORG_ID, DEVICE_ID, expect.objectContaining({ q: 'easement' }), [],
      );

      const b = await app.request('/search?q=easement', asB);
      expect(b.status).toBe(200);
      expect(base.fileQueryService.search).toHaveBeenCalledWith(
        ORG_B, DEVICE_B_ID, expect.objectContaining({ q: 'easement' }), [],
      );
      // B never reached the content service.
      expect(base.contentSearchService?.search).toHaveBeenCalledTimes(1);
    });

    it('/content/capabilities: 200 for A, 404 for B', async () => {
      const { app } = makePerOrgApp();
      expect((await app.request('/content/capabilities', asA)).status).toBe(200);
      expect((await app.request('/content/capabilities', asB)).status).toBe(404);
    });

    it('/content/passages: served for A, 404 for B', async () => {
      const { app, base } = makePerOrgApp();
      expect((await app.request('/content/passages?q=easement', asA)).status).toBe(200);
      const b = await app.request('/content/passages?q=easement', asB);
      expect(b.status).toBe(404);
      expect(base.contentSearchService?.passages).toHaveBeenCalledTimes(1);
    });

    it('filing: served for A, 404 for B', async () => {
      const { app } = makePerOrgApp();
      expect((await app.request('/filing', asA)).status).toBe(200);
      const b = await app.request('/filing', asB);
      expect(b.status).toBe(404);
      expect(filingService.list).toHaveBeenCalledTimes(1);
      expect(filingService.list).toHaveBeenCalledWith(ORG_ID, []);
    });
  });

  describe('GET /browse', () => {
    it('lists entries at the source root by default', async () => {
      const { app, fileQueryService } = makeHarness();
      const res = await app.request(`/browse?sourceId=${SOURCE_ID}`, authed);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ entries: [file()] });
      expect(fileQueryService.browse).toHaveBeenCalledWith(ORG_ID, DEVICE_ID, SOURCE_ID, '', {}, []);
    });

    it('passes parentPath through', async () => {
      const { app, fileQueryService } = makeHarness();
      const res = await app.request(
        `/browse?sourceId=${SOURCE_ID}&parentPath=${encodeURIComponent('clients/henderson')}`,
        authed,
      );
      expect(res.status).toBe(200);
      expect(fileQueryService.browse).toHaveBeenCalledWith(
        ORG_ID, DEVICE_ID, SOURCE_ID, 'clients/henderson', {}, [],
      );
    });

    it('accepts project/docType filters and forwards them to fileQueryService.browse', async () => {
      const { app, fileQueryService } = makeHarness();
      const res = await app.request(
        `/browse?sourceId=${SOURCE_ID}` +
        `&project=${encodeURIComponent('Henderson Water Main Replacement')}&docType=easement`,
        authed,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ entries: [file()] });
      expect(fileQueryService.browse).toHaveBeenCalledWith(
        ORG_ID, DEVICE_ID, SOURCE_ID, '',
        { project: 'Henderson Water Main Replacement', docType: 'easement' }, [],
      );
    });

    it('answers 404 for an unknown-or-hidden source without touching the index', async () => {
      const { app, fileQueryService } = makeHarness();
      fileQueryService.visibleSources.mockResolvedValueOnce([]);
      const res = await app.request(`/browse?sourceId=${SOURCE_ID}`, authed);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
      expect(fileQueryService.browse).not.toHaveBeenCalled();
    });

    it('answers 404 for a malformed sourceId before any query runs', async () => {
      const { app, fileQueryService } = makeHarness();
      const res = await app.request('/browse?sourceId=not-a-uuid', authed);
      expect(res.status).toBe(404);
      expect(fileQueryService.visibleSources).not.toHaveBeenCalled();
      expect(fileQueryService.browse).not.toHaveBeenCalled();
    });

    it('rejects a missing sourceId with 400', async () => {
      const { app } = makeHarness();
      const res = await app.request('/browse', authed);
      expect(res.status).toBe(400);
    });

    it('rejects an oversized parentPath with 400', async () => {
      const { app, fileQueryService } = makeHarness();
      const res = await app.request(
        `/browse?sourceId=${SOURCE_ID}&parentPath=${'a'.repeat(4097)}`,
        authed,
      );
      expect(res.status).toBe(400);
      expect(fileQueryService.browse).not.toHaveBeenCalled();
    });
  });

  describe('GET /recents', () => {
    it('returns the device recents and the department feed', async () => {
      const { app, activityService } = makeHarness();
      const res = await app.request('/recents', authed);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        recent: [file()],
        department: [{ ...file(), lastActivityAt: '2026-07-13T09:00:00.000Z' }],
      });
      expect(activityService.recents).toHaveBeenCalledWith(ORG_ID, DEVICE_ID, null, undefined, []);
      expect(activityService.departmentRecent).toHaveBeenCalledWith(ORG_ID, DEVICE_ID, undefined, []);
    });

    it('filters recents by the helperUser label when provided', async () => {
      const { app, activityService } = makeHarness();
      const res = await app.request(`/recents?helperUser=${encodeURIComponent('Dana K')}`, authed);
      expect(res.status).toBe(200);
      expect(activityService.recents).toHaveBeenCalledWith(ORG_ID, DEVICE_ID, 'Dana K', undefined, []);
    });

    it('rejects an oversized helperUser with 400', async () => {
      const { app, activityService } = makeHarness();
      const res = await app.request(`/recents?helperUser=${'a'.repeat(101)}`, authed);
      expect(res.status).toBe(400);
      expect(activityService.recents).not.toHaveBeenCalled();
    });
  });

  describe('POST /activity', () => {
    it('records the activity and writes the audit event', async () => {
      const { app, activityService, audit } = makeHarness();
      const res = await app.request('/activity', postActivity({
        fileIndexId: FILE_ID,
        action: 'open',
        helperUser: 'Dana',
      }));
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ recorded: true });
      expect(activityService.record).toHaveBeenCalledWith(ORG_ID, {
        fileIndexId: FILE_ID,
        deviceId: DEVICE_ID,
        helperUser: 'Dana',
        action: 'open',
      }, []);
      expect(audit).toHaveBeenCalledWith({
        orgId: ORG_ID,
        actorType: 'agent',
        actorId: DEVICE_ID,
        action: 'workspace.file.open',
        resourceType: 'workspace_file',
        resourceId: FILE_ID,
        details: { helperUser: 'Dana', fileIndexId: FILE_ID },
        result: 'success',
      });
    });

    it('records a null helperUser when the label is absent', async () => {
      const { app, activityService } = makeHarness();
      const res = await app.request('/activity', postActivity({
        fileIndexId: FILE_ID,
        action: 'copy_path',
      }));
      expect(res.status).toBe(201);
      expect(activityService.record).toHaveBeenCalledWith(ORG_ID, {
        fileIndexId: FILE_ID,
        deviceId: DEVICE_ID,
        helperUser: null,
        action: 'copy_path',
      }, []);
    });

    it('answers 404 (and does not audit) when the file is unknown, hidden, or tombstoned', async () => {
      const { app, activityService, audit } = makeHarness();
      activityService.record.mockResolvedValueOnce({ notFound: true });
      const res = await app.request('/activity', postActivity({
        fileIndexId: FILE_ID,
        action: 'open',
      }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
      expect(audit).not.toHaveBeenCalled();
    });

    it('answers 404 for a malformed fileIndexId before the service runs', async () => {
      const { app, activityService } = makeHarness();
      const res = await app.request('/activity', postActivity({
        fileIndexId: 'not-a-uuid',
        action: 'open',
      }));
      expect(res.status).toBe(404);
      expect(activityService.record).not.toHaveBeenCalled();
    });

    it('rejects an unknown action with 400', async () => {
      const { app } = makeHarness();
      const res = await app.request('/activity', postActivity({
        fileIndexId: FILE_ID,
        action: 'delete',
      }));
      expect(res.status).toBe(400);
    });

    it('rejects unexpected fields with 400 (strict body)', async () => {
      const { app } = makeHarness();
      const res = await app.request('/activity', postActivity({
        fileIndexId: FILE_ID,
        action: 'open',
        extra: true,
      }));
      expect(res.status).toBe(400);
    });

    it('rejects an oversized helperUser with 400', async () => {
      const { app } = makeHarness();
      const res = await app.request('/activity', postActivity({
        fileIndexId: FILE_ID,
        action: 'open',
        helperUser: 'a'.repeat(101),
      }));
      expect(res.status).toBe(400);
    });

    it('rejects a malformed JSON body with 400', async () => {
      const { app } = makeHarness();
      const res = await app.request('/activity', {
        method: 'POST',
        headers: { authorization: 'Bearer brz_helper-token', 'content-type': 'application/json' },
        body: '{nope',
      });
      expect(res.status).toBe(400);
    });

    it('keeps the response successful when the audit write fails, but logs it', async () => {
      const { app, audit, log } = makeHarness();
      audit.mockRejectedValueOnce(new Error('audit pipe closed'));
      const res = await app.request('/activity', postActivity({
        fileIndexId: FILE_ID,
        action: 'open',
      }));
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ recorded: true });
      expect(log).toHaveBeenCalledWith('error', expect.stringContaining('audit write failed'));
    });
  });
});
