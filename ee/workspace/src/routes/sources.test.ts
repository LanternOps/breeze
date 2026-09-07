import { DrizzleQueryError } from 'drizzle-orm';
import { Hono } from 'hono';
import type { ExtensionAuditEvent } from '../hostTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceAuthContext, WorkspaceRouteEnv } from './adminGate';
import { createSourcesRoutes } from './sources';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SOURCE_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

const sourceInput = {
  kind: 'smb_share' as const,
  displayName: 'Shared documents',
  rootPath: '\\\\fileserver\\documents',
  crawlDeviceId: DEVICE_ID,
  visibilityGroupIds: ['55555555-5555-4555-8555-555555555555'],
  crawlCadenceMinutes: 60,
  excludeGlobs: ['**/.git/**'],
  watch: true,
  status: 'active' as const,
};

// Service-layer rows are SafeSourceRow: credentialEnc never leaves the
// service; consumers see the computed hasCredential instead.
function source(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_ID,
    orgId: ORG_ID,
    ...sourceInput,
    hasCredential: true,
    crawlCursor: {},
    statusDetail: null,
    errorReason: null,
    lastCompleteRunAt: null,
    createdAt: new Date('2026-07-12T10:00:00.000Z'),
    updatedAt: new Date('2026-07-12T10:00:00.000Z'),
    ...overrides,
  };
}

function auth(overrides: Partial<WorkspaceAuthContext> = {}): WorkspaceAuthContext {
  return {
    user: {
      id: USER_ID,
      email: 'admin@example.com',
      name: 'Workspace Admin',
      isPlatformAdmin: false,
    },
    scope: 'partner',
    orgId: null,
    partnerId: '66666666-6666-6666-6666-666666666666',
    accessibleOrgIds: [ORG_ID],
    ...overrides,
  };
}

function makeHarness(authValue = auth()) {
  const sourcesService = {
    list: vi.fn(async () => [source()]),
    get: vi.fn(async () => source()),
    create: vi.fn(async (_orgId: string, input: typeof sourceInput) => source(input)),
    update: vi.fn(async () => source({ displayName: 'Updated documents' })),
    remove: vi.fn(async () => true),
    listRuns: vi.fn(async () => [{
      id: '77777777-7777-4777-8777-777777777777',
      orgId: ORG_ID,
      sourceId: SOURCE_ID,
      deviceId: DEVICE_ID,
      deviceKey: DEVICE_ID,
      status: 'complete' as const,
      startedAt: new Date('2026-07-12T10:00:00.000Z'),
      lastActivityAt: new Date('2026-07-12T10:01:00.000Z'),
      completedAt: new Date('2026-07-12T10:02:00.000Z'),
      cursor: null,
      stats: {},
      errorReason: null,
    }]),
  };
  const credentialService = {
    set: vi.fn(async () => true),
    clear: vi.fn(async () => true),
  };
  const audit = vi.fn(async (_event: ExtensionAuditEvent) => {});
  const log = vi.fn();
  const app = new Hono<WorkspaceRouteEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', authValue);
    await next();
  });
  app.route('/', createSourcesRoutes({ sourcesService, credentialService, audit, log }));
  return { app, sourcesService, credentialService, audit, log };
}

function jsonRequest(method: string, body?: unknown) {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sources admin routes', () => {
  it('rejects organization-scoped callers', async () => {
    const h = makeHarness(auth({ scope: 'organization', orgId: ORG_ID }));
    const res = await h.app.request(`/sources?orgId=${ORG_ID}`);
    expect(res.status).toBe(403);
    expect(h.sourcesService.list).not.toHaveBeenCalled();
  });

  it('requires orgId before listing sources', async () => {
    const h = makeHarness();
    const res = await h.app.request('/sources');
    expect(res.status).toBe(400);
    expect(h.sourcesService.list).not.toHaveBeenCalled();
  });

  it('rejects a partner without access to the requested organization', async () => {
    const h = makeHarness(auth({ accessibleOrgIds: [OTHER_ORG_ID] }));
    const res = await h.app.request(`/sources?orgId=${ORG_ID}`);
    expect(res.status).toBe(403);
    expect(h.sourcesService.list).not.toHaveBeenCalled();
  });

  it('allows system scope when accessibleOrgIds is null', async () => {
    const h = makeHarness(auth({ scope: 'system', accessibleOrgIds: null }));
    const res = await h.app.request(`/sources?orgId=${ORG_ID}`);
    expect(res.status).toBe(200);
    expect(h.sourcesService.list).toHaveBeenCalledWith(ORG_ID);
  });

  it('lists only allowlisted public source data with hasCredential', async () => {
    const h = makeHarness();
    const res = await h.app.request(`/sources?orgId=${ORG_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { sources: Array<Record<string, unknown>> };
    expect(body.sources[0]).toMatchObject({ id: SOURCE_ID, hasCredential: true });
    expect(Object.keys(body.sources[0] ?? {}).sort()).toEqual([
      'id',
      'orgId',
      'kind',
      'displayName',
      'rootPath',
      'crawlDeviceId',
      'visibilityGroupIds',
      'crawlCadenceMinutes',
      'excludeGlobs',
      'watch',
      'status',
      'errorReason',
      'lastCompleteRunAt',
      'createdAt',
      'updatedAt',
      'hasCredential',
    ].sort());
  });

  it('supports partner-scoped CRUD and audits each mutation action', async () => {
    const h = makeHarness();

    const createRes = await h.app.request(
      `/sources?orgId=${ORG_ID}`,
      jsonRequest('POST', sourceInput),
    );
    expect(createRes.status).toBe(201);
    expect(h.sourcesService.create).toHaveBeenCalledWith(ORG_ID, sourceInput);

    const detailRes = await h.app.request(`/sources/${SOURCE_ID}?orgId=${ORG_ID}`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json() as Record<string, unknown>;
    expect(detail).toMatchObject({ id: SOURCE_ID, hasCredential: true });
    expect(detail).not.toHaveProperty('credentialEnc');

    const patch = { displayName: 'Updated documents', status: 'paused' };
    const patchRes = await h.app.request(
      `/sources/${SOURCE_ID}?orgId=${ORG_ID}`,
      jsonRequest('PATCH', patch),
    );
    expect(patchRes.status).toBe(200);
    expect(h.sourcesService.update).toHaveBeenCalledWith(ORG_ID, SOURCE_ID, patch);

    const deleteRes = await h.app.request(
      `/sources/${SOURCE_ID}?orgId=${ORG_ID}`,
      { method: 'DELETE' },
    );
    expect(deleteRes.status).toBe(200);
    expect(h.sourcesService.remove).toHaveBeenCalledWith(ORG_ID, SOURCE_ID);

    expect(h.audit.mock.calls.map(([event]) => event.action)).toEqual([
      'workspace.source.create',
      'workspace.source.update',
      'workspace.source.delete',
    ]);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'user',
      actorId: USER_ID,
      orgId: ORG_ID,
      resourceType: 'workspace_source',
      resourceId: SOURCE_ID,
      result: 'success',
    }));
  });

  it('validates create and patch bodies before calling the service', async () => {
    const h = makeHarness();
    const createRes = await h.app.request(
      `/sources?orgId=${ORG_ID}`,
      jsonRequest('POST', { ...sourceInput, displayName: '' }),
    );
    expect(createRes.status).toBe(400);

    const patchRes = await h.app.request(
      `/sources/${SOURCE_ID}?orgId=${ORG_ID}`,
      jsonRequest('PATCH', { crawlCadenceMinutes: 0 }),
    );
    expect(patchRes.status).toBe(400);
    expect(h.sourcesService.create).not.toHaveBeenCalled();
    expect(h.sourcesService.update).not.toHaveBeenCalled();
  });

  it('rejects invalid SMB configurations before calling the service', async () => {
    const h = makeHarness();
    const invalidCreate = await h.app.request(
      `/sources?orgId=${ORG_ID}`,
      jsonRequest('POST', {
        ...sourceInput,
        crawlDeviceId: null,
      }),
    );
    expect(invalidCreate.status).toBe(400);

    h.sourcesService.get.mockResolvedValueOnce(source({
      kind: 'local_profile',
      rootPath: '/Users',
      crawlDeviceId: null,
    }));
    const invalidPatch = await h.app.request(
      `/sources/${SOURCE_ID}?orgId=${ORG_ID}`,
      jsonRequest('PATCH', { kind: 'smb_share' }),
    );
    expect(invalidPatch.status).toBe(400);
    expect(h.sourcesService.create).not.toHaveBeenCalled();
    expect(h.sourcesService.update).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PATCH'])('maps a wrapped foreign-key violation on %s to 400', async (method) => {
    const h = makeHarness();
    const error = new DrizzleQueryError('write source', [],
      Object.assign(new Error('private database detail'), { code: '23503' }));
    h.sourcesService.create.mockRejectedValueOnce(error);
    h.sourcesService.update.mockRejectedValueOnce(error);
    const path = method === 'POST' ? '/sources' : `/sources/${SOURCE_ID}`;
    const res = await h.app.request(`${path}?orgId=${ORG_ID}`, jsonRequest(method, sourceInput));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain('private database detail');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID, result: 'failure' }));
  });

  it('does not turn an unrelated wrapped database error into a validation error', async () => {
    const h = makeHarness();
    h.sourcesService.create.mockRejectedValueOnce(new DrizzleQueryError('write source', [],
      Object.assign(new Error('private database detail'), { code: '42501' })));
    const res = await h.app.request(`/sources?orgId=${ORG_ID}`, jsonRequest('POST', sourceInput));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('private database detail');
  });

  it('rejects an empty patch without touching the source', async () => {
    const h = makeHarness();
    const res = await h.app.request(
      `/sources/${SOURCE_ID}?orgId=${ORG_ID}`,
      jsonRequest('PATCH', {}),
    );
    expect(res.status).toBe(400);
    expect(h.sourcesService.get).not.toHaveBeenCalled();
    expect(h.sourcesService.update).not.toHaveBeenCalled();
  });

  it('sets parsed credentials without echoing secrets and audits the action', async () => {
    const h = makeHarness();
    const credential = { username: 'alice', password: 'very-secret', domain: 'ACME' };
    const res = await h.app.request(
      `/sources/${SOURCE_ID}/credential?orgId=${ORG_ID}`,
      jsonRequest('PUT', credential),
    );
    expect(res.status).toBe(200);
    expect(h.credentialService.set).toHaveBeenCalledWith(ORG_ID, SOURCE_ID, credential);
    const body = await res.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('alice');
    expect(JSON.stringify(body)).not.toContain('very-secret');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workspace.source.credential.set',
      resourceId: SOURCE_ID,
      result: 'success',
    }));
  });

  it('rejects invalid credentials before calling the service', async () => {
    const h = makeHarness();
    const res = await h.app.request(
      `/sources/${SOURCE_ID}/credential?orgId=${ORG_ID}`,
      jsonRequest('PUT', { username: '', password: '' }),
    );
    expect(res.status).toBe(400);
    expect(h.credentialService.set).not.toHaveBeenCalled();
  });

  it('does not copy credential service exception text into the audit event', async () => {
    const h = makeHarness();
    h.credentialService.set.mockRejectedValueOnce(new Error('password=very-secret'));
    const res = await h.app.request(
      `/sources/${SOURCE_ID}/credential?orgId=${ORG_ID}`,
      jsonRequest('PUT', { username: 'alice', password: 'very-secret' }),
    );
    expect(res.status).toBe(500);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workspace.source.credential.set',
      result: 'failure',
      errorMessage: 'Credential operation failed',
    }));
  });

  it('clears credentials and audits the action', async () => {
    const h = makeHarness();
    const res = await h.app.request(
      `/sources/${SOURCE_ID}/credential?orgId=${ORG_ID}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    expect(h.credentialService.clear).toHaveBeenCalledWith(ORG_ID, SOURCE_ID);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workspace.source.credential.clear',
      resourceId: SOURCE_ID,
      result: 'success',
    }));
  });

  it('returns 404 and a failure audit when a scoped mutation misses', async () => {
    const h = makeHarness();
    h.sourcesService.remove.mockResolvedValueOnce(false);
    const res = await h.app.request(
      `/sources/${SOURCE_ID}?orgId=${ORG_ID}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(404);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workspace.source.delete',
      resourceId: SOURCE_ID,
      result: 'failure',
    }));
  });

  it('audits a service exception as failure and returns a sanitized 500', async () => {
    const h = makeHarness();
    h.sourcesService.create.mockRejectedValueOnce(new Error('database exploded'));
    const res = await h.app.request(
      `/sources?orgId=${ORG_ID}`,
      jsonRequest('POST', sourceInput),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to create source' });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workspace.source.create',
      result: 'failure',
      errorMessage: 'database exploded',
    }));
  });

  it('does not misreport a committed mutation when audit delivery rejects, but logs the gap', async () => {
    const h = makeHarness();
    h.audit.mockRejectedValue(new Error('audit queue unavailable'));
    const res = await h.app.request(
      `/sources?orgId=${ORG_ID}`,
      jsonRequest('POST', sourceInput),
    );
    expect(res.status).toBe(201);
    expect(h.sourcesService.create).toHaveBeenCalledOnce();
    expect(h.audit).toHaveBeenCalledOnce();
    // The hole in the audit trail must be observable.
    expect(h.log).toHaveBeenCalledWith('error', expect.stringContaining('audit write failed'));
    expect(h.log).toHaveBeenCalledWith('error', expect.stringContaining('workspace.source.create'));
  });

  it('keeps the service failure response stable when failure audit delivery rejects', async () => {
    const h = makeHarness();
    h.sourcesService.create.mockRejectedValueOnce(new Error('database exploded'));
    h.audit.mockRejectedValue(new Error('audit queue unavailable'));
    const res = await h.app.request(
      `/sources?orgId=${ORG_ID}`,
      jsonRequest('POST', sourceInput),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to create source' });
    expect(h.audit).toHaveBeenCalledOnce();
  });

  it('returns 404 when a source is absent in the requested organization', async () => {
    const h = makeHarness();
    h.sourcesService.get.mockResolvedValueOnce(null as never);
    const res = await h.app.request(`/sources/${SOURCE_ID}?orgId=${ORG_ID}`);
    expect(res.status).toBe(404);
  });

  it('rejects credential writes for non-SMB sources without calling the service', async () => {
    const h = makeHarness();
    h.sourcesService.get.mockResolvedValueOnce(source({
      kind: 'local_profile', rootPath: '/Users', crawlDeviceId: null,
    }) as never);
    const res = await h.app.request(
      `/sources/${SOURCE_ID}/credential?orgId=${ORG_ID}`,
      jsonRequest('PUT', { username: 'alice', password: 'secret' }),
    );
    expect(res.status).toBe(400);
    expect(h.credentialService.set).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'workspace.source.credential.set',
      result: 'failure',
    }));
  });

  it('maps a service validation error to 400 with its message', async () => {
    const h = makeHarness();
    const { SourceValidationError } = await import('../services/sourcesService');
    h.sourcesService.create.mockRejectedValueOnce(
      new SourceValidationError('smb_share requires crawlDeviceId'),
    );
    const res = await h.app.request(
      `/sources?orgId=${ORG_ID}`,
      jsonRequest('POST', sourceInput),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'smb_share requires crawlDeviceId' });
  });

  // #3472: crawl_device_id is only meaningful for smb_share. A local_profile
  // row carrying one is the shape deviceSummaryService's owned-sources branch
  // absorbs with `device_id IS NULL`; enforce it on write instead.
  it('rejects a local_profile POST that carries a crawl device', async () => {
    const h = makeHarness();
    const res = await h.app.request(
      `/sources?orgId=${ORG_ID}`,
      jsonRequest('POST', {
        ...sourceInput, kind: 'local_profile', rootPath: '/Users', crawlDeviceId: DEVICE_ID,
      }),
    );
    expect(res.status).toBe(400);
    expect(h.sourcesService.create).not.toHaveBeenCalled();
  });

  it('rejects a PATCH that sets local_profile together with an explicit crawl device', async () => {
    const h = makeHarness();
    h.sourcesService.get.mockResolvedValueOnce(source({}) as never);
    const res = await h.app.request(
      `/sources/${SOURCE_ID}?orgId=${ORG_ID}`,
      jsonRequest('PATCH', { kind: 'local_profile', crawlDeviceId: DEVICE_ID }),
    );
    expect(res.status).toBe(400);
    expect(h.sourcesService.update).not.toHaveBeenCalled();
  });

  // A flip that would strand the crawl device is rejected rather than silently
  // nulling operator configuration. The web form always submits crawlDeviceId
  // explicitly, so a deliberate flip is unaffected — asserted below.
  it('rejects a flip to local_profile that would strand an existing crawl device', async () => {
    const h = makeHarness();
    h.sourcesService.get.mockResolvedValueOnce(
      source({ kind: 'smb_share', crawlDeviceId: DEVICE_ID }) as never,
    );
    const res = await h.app.request(
      `/sources/${SOURCE_ID}?orgId=${ORG_ID}`,
      jsonRequest('PATCH', { kind: 'local_profile', rootPath: '/Users' }),
    );
    expect(res.status).toBe(400);
    expect(h.sourcesService.update).not.toHaveBeenCalled();
  });

  it('allows a deliberate flip that clears the crawl device explicitly', async () => {
    const h = makeHarness();
    h.sourcesService.get.mockResolvedValueOnce(
      source({ kind: 'smb_share', crawlDeviceId: DEVICE_ID }) as never,
    );
    h.sourcesService.update.mockResolvedValueOnce(
      source({ kind: 'local_profile', rootPath: '/Users', crawlDeviceId: null }) as never,
    );
    const res = await h.app.request(
      `/sources/${SOURCE_ID}?orgId=${ORG_ID}`,
      jsonRequest('PATCH', { kind: 'local_profile', rootPath: '/Users', crawlDeviceId: null }),
    );
    expect(res.status).toBe(200);
    expect(h.sourcesService.update).toHaveBeenCalled();
  });

  it('rejects a crawl cadence that would overflow the integer column', async () => {
    const h = makeHarness();
    const res = await h.app.request(
      `/sources?orgId=${ORG_ID}`,
      jsonRequest('POST', { ...sourceInput, crawlCadenceMinutes: 9_000_000_000 }),
    );
    expect(res.status).toBe(400);
    expect(h.sourcesService.create).not.toHaveBeenCalled();
  });

  it('fails closed when a partner arrives without an accessible-orgs list', async () => {
    const h = makeHarness(auth({ accessibleOrgIds: null }));
    const res = await h.app.request(`/sources?orgId=${ORG_ID}`);
    expect(res.status).toBe(403);
    expect(h.sourcesService.list).not.toHaveBeenCalled();
  });

  it('lists runs through the public projection without cursor or deviceKey', async () => {
    const h = makeHarness();
    const res = await h.app.request(`/sources/${SOURCE_ID}/runs?orgId=${ORG_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { runs: Array<Record<string, unknown>> };
    expect(body.runs[0]).toMatchObject({ sourceId: SOURCE_ID, status: 'complete' });
    expect(body.runs[0]).not.toHaveProperty('cursor');
    expect(body.runs[0]).not.toHaveProperty('deviceKey');
  });

  it('lists runs with a default of 20 and enforces the maximum of 100', async () => {
    const h = makeHarness();
    const defaultRes = await h.app.request(`/sources/${SOURCE_ID}/runs?orgId=${ORG_ID}`);
    expect(defaultRes.status).toBe(200);
    expect(h.sourcesService.listRuns).toHaveBeenCalledWith(ORG_ID, SOURCE_ID, 20);

    const maxRes = await h.app.request(`/sources/${SOURCE_ID}/runs?orgId=${ORG_ID}&limit=100`);
    expect(maxRes.status).toBe(200);
    expect(h.sourcesService.listRuns).toHaveBeenLastCalledWith(ORG_ID, SOURCE_ID, 100);

    const invalidRes = await h.app.request(`/sources/${SOURCE_ID}/runs?orgId=${ORG_ID}&limit=101`);
    expect(invalidRes.status).toBe(400);
  });
});
