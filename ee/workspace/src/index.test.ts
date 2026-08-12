import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { stageExtensionForTest } from '@breeze/extension-testkit';
import type {
  BreezeExtensionV1,
  ExtensionRegistrar,
  ExtensionRuntimeContext,
} from './hostTypes';
import manifest from '../manifest.json';
import workspaceExtension from './index';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '55555555-5555-4555-8555-555555555555';
const RUN_ID = '66666666-6666-4666-8666-666666666666';

/**
 * Chainable Drizzle stand-in: every terminal call resolves to `rows`. Used only
 * to prove the registration wiring reaches the right handler — the services'
 * own suites cover query behavior against recorded SQL.
 */
function fakeDb(rows: unknown[] = [], onQuery?: () => void) {
  const settle = () => {
    onQuery?.();
    const result = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
    for (const method of ['limit', 'orderBy', 'returning']) {
      (result as Record<string, unknown>)[method] = () => {
        onQuery?.();
        return Promise.resolve(rows);
      };
    }
    return result;
  };
  const db: Record<string, unknown> = {
    execute: async () => { onQuery?.(); return rows; },
    select: () => ({ from: () => ({ where: settle }) }),
    insert: () => ({ values: () => ({ returning: async () => { onQuery?.(); return rows; } }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => { onQuery?.(); return rows; } }) }) }),
    delete: () => ({ where: () => ({ returning: async () => { onQuery?.(); return rows; } }) }),
  };
  return db as unknown as ExtensionRuntimeContext['db'];
}

class CapturingRegistrar implements ExtensionRegistrar {
  readonly apps: Hono[] = [];
  readonly jobs: string[] = [];
  readonly aiTools: string[] = [];
  mountRoute(app: Hono): void { this.apps.push(app); }
  registerJob(job: { name: string }): void { this.jobs.push(job.name); }
  registerAiTool(name: string): void { this.aiTools.push(name); }
}

function runtimeContext(overrides: Partial<ExtensionRuntimeContext> = {}): ExtensionRuntimeContext {
  return {
    db: fakeDb(),
    secrets: {
      encryptForColumn: (_table, _column, plaintext) => plaintext,
      decryptForColumn: (_table, _column, ciphertext) => ciphertext,
    },
    audit: async () => {},
    log: () => {},
    config: Object.freeze({}),
    // NOTE (ee/workspace import): `tenancy` is required on ExtensionRuntimeContext
    // in the monorepo's @breeze/extension-sdk (added since the vendored 1.0.0
    // tarball this suite was written against). No test here exercises it, so a
    // benign stub satisfies the type without asserting real per-org semantics.
    tenancy: { installedOrgs: async () => [] },
    ...overrides,
  };
}

const HELPER_DEVICE = {
  id: DEVICE_ID,
  agentId: 'agent-1',
  orgId: ORG_ID,
  siteId: null,
  hostname: 'FRONT-DESK-01',
  osType: 'windows',
  osVersion: '11',
  agentVersion: '1.0.0',
};

/**
 * Mount the extension the way the host does: a single app behind the gateway,
 * which has already applied the manifest-declared auth boundary and attached
 * the caller identity. The extension itself owns neither.
 */
async function stagedApp(options: {
  context?: Partial<ExtensionRuntimeContext>;
  auth?: Record<string, unknown> | null;
  agent?: Record<string, unknown> | null;
  helper?: Record<string, unknown> | null;
} = {}) {
  const registrar = new CapturingRegistrar();
  await workspaceExtension.register(registrar, runtimeContext(options.context));
  const outer = new Hono();
  outer.use('*', async (c, next) => {
    const auth = options.auth === undefined
      ? { user: { id: USER_ID }, scope: 'system', accessibleOrgIds: null }
      : options.auth;
    if (auth) c.set('auth' as never, auth as never);
    const agent = options.agent === undefined
      ? { deviceId: DEVICE_ID, agentId: 'agent-1', orgId: ORG_ID, siteId: null, role: 'agent' }
      : options.agent;
    if (agent) c.set('agent' as never, agent as never);
    const helper = options.helper === undefined ? HELPER_DEVICE : options.helper;
    if (helper) c.set('helperDevice' as never, helper as never);
    await next();
  });
  const app = registrar.apps[0];
  if (!app) throw new Error('extension mounted no app');
  outer.route('/api/v1/ext/workspace', app);
  return outer;
}

describe('workspace extension registration (v1 contract)', () => {
  it('stages cleanly against the v1 recorder without touching the database', async () => {
    // No `opts.db`: the testkit context THROWS on any db access, so this
    // passing is the proof that register() does no database work — services
    // only hold the handle.
    const result = await stageExtensionForTest(workspaceExtension, manifest);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.recorded).toEqual({ routes: 1, jobs: [], aiTools: [] });
  });

  it('reports a throwing register as a single register_threw issue with an empty recorder', async () => {
    const broken: BreezeExtensionV1 = {
      register() { throw new Error('register exploded'); },
    };
    const result = await stageExtensionForTest(broken, manifest);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe('register_threw');
    expect(result.recorded).toEqual({ routes: 0, jobs: [], aiTools: [] });
  });

  it('mounts health, sources, device-summary and agent paths on one app', async () => {
    const outer = await stagedApp();

    const health = await outer.request('/api/v1/ext/workspace/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, extension: 'workspace' });

    const sources = await outer.request(`/api/v1/ext/workspace/sources?orgId=${ORG_ID}`);
    expect(sources.status).toBe(200);
    expect(await sources.json()).toEqual({ sources: [] });

    // Reaches the device-summary handler (its own 404 body), not Hono's
    // unmounted-route default.
    const summary = await outer.request(
      `/api/v1/ext/workspace/devices/${DEVICE_ID}/summary?orgId=${ORG_ID}`,
    );
    expect(summary.status).toBe(404);
    expect(await summary.json()).toEqual({ error: 'Device not found' });

    const agent = await outer.request('/api/v1/ext/workspace/agent/crawl-config');
    expect(agent.status).toBe(200);
  });

  // Gateway path shape: the host gateway authenticates extension agent traffic
  // as /agent/:agentId/* (device id in the path), while the phase-2 wire spec
  // uses flat /agent/*. Both shapes must resolve the same routes, and the
  // :agentId segment must never become identity (identity is c.get('agent')).
  it('serves the agent routes under both /agent and /agent/:agentId mounts', async () => {
    const outer = await stagedApp();
    expect((await outer.request('/api/v1/ext/workspace/agent/crawl-config')).status).toBe(200);
    expect((await outer.request('/api/v1/ext/workspace/agent/abc123/crawl-config')).status).toBe(200);
    const nested = await outer.request('/api/v1/ext/workspace/agent/abc123/nope');
    expect(nested.status).toBe(404);
    expect(await nested.json()).toEqual({ error: 'not found' });
  });

  // Still extension-owned under a single-app mount: without the catch-all an
  // unmatched /agent/* request falls through to the user routes below it.
  it('answers unmatched /agent/* with 404 instead of falling through to user routes', async () => {
    const outer = await stagedApp();
    const res = await outer.request('/api/v1/ext/workspace/agent/sources');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });

    const nested = await outer.request('/api/v1/ext/workspace/agent/devices/x/summary');
    expect(nested.status).toBe(404);
    expect(await nested.json()).toEqual({ error: 'not found' });
  });

  // Identity presence is a host invariant: the gateway applies the
  // manifest-declared agent boundary before dispatch. But 68bf21d removed
  // ctx.agentAuthMiddleware, which is what used to GUARANTEE c.get('agent'),
  // and every agent handler dereferences it unconditionally. Without an
  // explicit guard the tree fails closed only incidentally — a TypeError
  // surfacing through onError as a 500 — while adminGate on the user side fails
  // closed deliberately with a 403. This asserts the agent side is explicit
  // too: a missing identity is 401, not a 500 from a dereference.
  it.each([
    ['GET', '/agent/crawl-config'],
    ['POST', '/agent/runs'],
    ['POST', `/agent/sources/${SOURCE_ID}/credential`],
    ['POST', `/agent/sources/${SOURCE_ID}/events`],
    ['POST', `/agent/runs/${RUN_ID}/batch`],
    ['POST', `/agent/runs/${RUN_ID}/complete`],
  ])('rejects %s %s with 401 when no agent identity is present', async (method, path) => {
    const outer = await stagedApp({ agent: null });
    const res = await outer.request(`/api/v1/ext/workspace${path}`, {
      method,
      ...(method === 'POST'
        ? { headers: { 'content-type': 'application/json' }, body: '{}' }
        : {}),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'agent identity required' });
  });

  // The guard must fail closed WITHOUT swallowing the catch-all: an
  // authenticated agent hitting an unmatched /agent/* path still gets the
  // extension's own 404, not a 401 and not a fall-through to the user routes.
  it('keeps the /agent catch-all reachable for an authenticated agent', async () => {
    const outer = await stagedApp();
    const res = await outer.request('/api/v1/ext/workspace/agent/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  // The helper tree mirrors the agent tree: the host applies core helper auth
  // on /helper/* (legacy-manifest helperRoutes flag), so the extension's own
  // guard is what turns a missing identity into an explicit 401 instead of a
  // TypeError-shaped 500.
  it('serves /helper routes for an identified helper and 404s unmatched helper paths', async () => {
    const outer = await stagedApp();
    const capabilities = await outer.request('/api/v1/ext/workspace/helper/capabilities');
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toEqual({
      ok: true,
      features: ['search', 'browse', 'recents', 'open'],
    });
    // The catch-all keeps unmatched helper paths out of the user app.
    const nope = await outer.request('/api/v1/ext/workspace/helper/nope');
    expect(nope.status).toBe(404);
    expect(await nope.json()).toEqual({ error: 'not found' });
  });

  it.each([
    ['GET', '/helper/capabilities'],
    ['GET', '/helper/sources'],
  ])('rejects %s %s with 401 when no helper identity is present', async (method, path) => {
    const outer = await stagedApp({ helper: null });
    const res = await outer.request(`/api/v1/ext/workspace${path}`, { method });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'helper identity required' });
  });

  // The client tree (W4) is the Outlook add-in's surface: core's generic
  // client proxy authenticates the pane user and dispatches under /client/*
  // with an organization-scoped auth context. Mounted before the admin-gated
  // user routes, with its own catch-all, exactly like /helper.
  const CLIENT_AUTH = {
    user: { id: USER_ID, email: 'jenny@example.test', name: 'Jenny Tran' },
    scope: 'organization',
    orgId: ORG_ID,
    partnerId: undefined,
    accessibleOrgIds: [ORG_ID],
  };

  it('serves /client routes for an organization-scoped session once content is enabled', async () => {
    const outer = await stagedApp({
      auth: CLIENT_AUTH,
      context: { db: fakeDb([{ orgId: ORG_ID, contentEnabled: true, dlpConfig: {} }]) },
    });
    const projects = await outer.request('/api/v1/ext/workspace/client/content/projects');
    expect(projects.status).toBe(200);

    // The catch-all keeps unmatched client paths out of the admin-gated user app.
    const nope = await outer.request('/api/v1/ext/workspace/client/nope');
    expect(nope.status).toBe(404);
    expect(await nope.json()).toEqual({ error: 'not found' });
  });

  it('404s the client tree while content is disabled for the org (default-deny)', async () => {
    const outer = await stagedApp({ auth: CLIENT_AUTH });
    const res = await outer.request('/api/v1/ext/workspace/client/content/projects');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'content_disabled' });
  });

  // /client is the end-user surface: an operator principal must not reach it
  // even though the same principal is welcome on the admin routes.
  it.each([
    ['system', { user: { id: USER_ID }, scope: 'system', accessibleOrgIds: null }],
    ['no auth at all', null],
  ])('rejects a %s principal on /client with 403', async (_label, auth) => {
    const outer = await stagedApp({
      auth,
      context: { db: fakeDb([{ orgId: ORG_ID, contentEnabled: true, dlpConfig: {} }]) },
    });
    const res = await outer.request('/api/v1/ext/workspace/client/content/projects');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'organization access required' });
  });

  // Content routes stay behind the per-org content flag (W2 Task 3): disabled
  // (no settings row) → 404 even for an authed admin; enabled via the org's
  // settings row → the route exists.
  it('gates content routes on the per-org content flag', async () => {
    const disabled = await stagedApp();
    expect((await disabled.request(`/api/v1/ext/workspace/content/status?orgId=${ORG_ID}`))
      .status).toBe(404);

    const enabled = await stagedApp({
      context: {
        db: fakeDb([{ orgId: ORG_ID, contentEnabled: true, dlpConfig: {} }]),
      },
    });
    const res = await enabled.request(`/api/v1/ext/workspace/content/status?orgId=${ORG_ID}`);
    expect(res.status).toBe(200);
  });

  // A silent text/plain 500 was invisible in production; the JSON error shape
  // and the log line are both load-bearing, and the handler must survive the
  // host mounting the extension via route().
  it('answers unhandled route errors with the JSON error shape and a level-first log line', async () => {
    const logs: Array<[string, string]> = [];
    const outer = await stagedApp({
      context: {
        db: fakeDb([], () => { throw new Error('connection reset'); }),
        log: (level, message) => { logs.push([level, message]); },
      },
    });

    const agentRes = await outer.request('/api/v1/ext/workspace/agent/crawl-config');
    expect(agentRes.status).toBe(500);
    expect(agentRes.headers.get('content-type')).toContain('application/json');
    expect(await agentRes.json()).toEqual({ error: 'internal error' });

    const userRes = await outer.request(`/api/v1/ext/workspace/sources?orgId=${ORG_ID}`);
    expect(userRes.status).toBe(500);
    expect(await userRes.json()).toEqual({ error: 'internal error' });

    const helperRes = await outer.request('/api/v1/ext/workspace/helper/sources');
    expect(helperRes.status).toBe(500);
    expect(await helperRes.json()).toEqual({ error: 'internal error' });

    const unhandled = logs.filter(([, message]) => message.includes('workspace unhandled error'));
    expect(unhandled).toHaveLength(3);
    expect(unhandled.every(([level]) => level === 'error')).toBe(true);
    expect(unhandled.some(([, message]) => message.includes('connection reset'))).toBe(true);
  });

  // The host logger must reach the sources routes: an audit-transport failure
  // is fail-open by design, so the log line is the only signal that a hole was
  // punched in the audit trail. Dropping `log` from the deps object hides it.
  it('threads the host logger into the sources routes so audit-write failures stay visible', async () => {
    const logs: Array<[string, string]> = [];
    const outer = await stagedApp({
      context: {
        audit: async () => { throw new Error('audit queue unavailable'); },
        log: (level, message) => { logs.push([level, message]); },
      },
    });
    const res = await outer.request(
      `/api/v1/ext/workspace/sources/55555555-5555-4555-8555-555555555555?orgId=${ORG_ID}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(404);
    expect(logs).toContainEqual([
      'error',
      expect.stringContaining('workspace audit write failed') as unknown as string,
    ]);
  });

  it('logs registration at info level through the level-first host logger', async () => {
    const log = vi.fn();
    const registrar = new CapturingRegistrar();
    await workspaceExtension.register(registrar, runtimeContext({ log }));
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('workspace'));
    expect(log.mock.calls.every(([level]) => (
      ['debug', 'info', 'warn', 'error'].includes(level as string)
    ))).toBe(true);
  });

  /**
   * AUTH-BOUNDARY RELOCATION.
   *
   * Under the legacy contract the extension attached ctx.authMiddleware,
   * ctx.agentAuthMiddleware and ctx.helperAuthMiddleware itself, and this
   * suite asserted an agent token was rejected on user routes and required on
   * agent routes. v1 removed all three fields: the host gateway applies the
   * declared boundary (`agentRoutes: true`, `publicRoutes: []`, and the
   * legacy-manifest `helperRoutes` flag for /helper/*) BEFORE dispatch. Those
   * specific assertions therefore cannot survive here — the boundary is not
   * the extension's to enforce any more.
   *
   * What remains extension-owned and is still covered: the /agent and /helper
   * catch-all 404s, the identity guards, the onError JSON shape, and the admin
   * gate on every user route. The declared boundary itself is asserted against
   * the manifests below and in manifest.test.ts.
   */
  it('no longer attaches host auth middleware and declares the boundary in the manifests', async () => {
    const source = workspaceExtension.register.toString();
    expect(source).not.toContain('authMiddleware');
    expect(source).not.toContain('agentAuthMiddleware');
    expect(source).not.toContain('helperAuthMiddleware');
    expect(manifest.publicRoutes).toEqual([]);
    expect(manifest.agentRoutes).toBe(true);
    // NOTE (ee/workspace import): the legacy breeze-extension.json manifest
    // this used to pin `helperRoutes === true` from was dropped here. The
    // built-in path carries the flag as an explicit field on the `BUILTINS`
    // entry in apps/api/src/extensions/builtinRegistry.ts, which is where the
    // equivalent assertion now lives.
  });

  // The admin gate is what still stands between a user route and another org's
  // data, so register() must not reorder it away from the user mounts.
  it.each([
    ['organization', [ORG_ID]],
    ['partner', ['33333333-3333-4333-8333-333333333333']],
    ['partner', null],
  ] as const)('rejects %s scope with accessibleOrgIds=%j on user routes through register()', async (scope, accessibleOrgIds) => {
    const outer = await stagedApp({
      auth: { user: { id: USER_ID }, scope, accessibleOrgIds },
    });
    for (const path of ['sources', `devices/${DEVICE_ID}/summary`]) {
      const res = await outer.request(`/api/v1/ext/workspace/${path}?orgId=${ORG_ID}`);
      expect(res.status).toBe(403);
    }
  });
});
