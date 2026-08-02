// Stub authMiddleware/requireScope so the suite can inject its own partner-
// scope auth context, the same pattern extensionsAdmin.test.ts uses for
// platformAdminMiddleware. requireScope is a pass-through here — its own
// scope-gating logic is covered by middleware/auth.test.ts; this suite
// exercises the route's own canAccessOrg / provisioning / non-disclosure
// logic against an already-authenticated partner-scope caller.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const ORG_OK = '11111111-1111-4111-8111-111111111111';
const ORG_OK_2 = '22222222-2222-4222-8222-222222222222';
const ORG_FORBIDDEN = '33333333-3333-4333-8333-333333333333'; // valid UUID, not in accessibleOrgIds
const ORG_BAD = 'not-a-uuid';

const ACCESSIBLE_ORG_IDS = [ORG_OK, ORG_OK_2];

// Preserve every other real export via importOriginal rather than a bare
// replacement object: the composition-level describe block below imports the
// REAL `mountExtensionGateway` (extensions/gateway.ts), whose transitive
// dependency graph (agentAuth -> ... -> routes/monitors.ts) calls
// `requirePermission(...)` at module scope. A hand-written replacement would
// need to keep re-guessing every export that graph touches; importOriginal
// keeps everything else (requirePermission, requireMfa, etc.) genuinely real
// and only swaps the two exports this suite actually needs to control.
vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: vi.fn(async (c: { set(key: string, value: unknown): void }, next: () => Promise<void>) => {
      c.set('auth', {
        user: { id: 'user-1', email: 'admin@partner.example', name: 'Admin', isPlatformAdmin: false },
        scope: 'partner',
        orgId: null,
        partnerId: 'partner-1',
        accessibleOrgIds: ACCESSIBLE_ORG_IDS,
        canAccessOrg: (orgId: string) => ACCESSIBLE_ORG_IDS.includes(orgId),
      });
      await next();
    }),
    requireScope: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
  };
});

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(),
  createAuditLog: vi.fn(),
}));

import { Hono } from 'hono';
import {
  createExtensionOrgInstallRoutes,
  type ExtensionOrgInstallListEntry,
  type ExtensionOrgInstallManagementPort,
  type ExtensionOrgInstallRoutesDeps,
} from './extensionOrgInstalls';
import type { ExtensionStateRecord } from '../extensions/stateStore';
import { mountExtensionGateway } from '../extensions/gateway';
import { ExtensionContributionRegistry } from '../extensions/contributionRegistry';

interface InstallRow extends ExtensionOrgInstallListEntry {
  extensionName: string;
}

function makeInMemoryInstalls(seed: InstallRow[] = []): ExtensionOrgInstallManagementPort & { rows: InstallRow[] } {
  const rows: InstallRow[] = [...seed];
  return {
    rows,
    async upsert(extension, orgId, installedBy) {
      const now = new Date();
      const existing = rows.find((r) => r.extensionName === extension && r.orgId === orgId);
      if (existing) {
        existing.enabled = true;
        existing.installedBy = installedBy;
        existing.updatedAt = now;
      } else {
        rows.push({
          extensionName: extension,
          orgId,
          enabled: true,
          installedBy,
          installedAt: now,
          updatedAt: now,
        });
      }
    },
    async disable(extension, orgId) {
      const existing = rows.find((r) => r.extensionName === extension && r.orgId === orgId);
      if (!existing) return false;
      existing.enabled = false;
      existing.updatedAt = new Date();
      return true;
    },
    async list(extension) {
      return rows
        .filter((r) => r.extensionName === extension)
        .map(({ orgId, enabled, installedBy, installedAt, updatedAt }) => ({
          orgId,
          enabled,
          installedBy,
          installedAt,
          updatedAt,
        }));
    },
  };
}

/** `stateStore.get` stub: returns a row for 'demo', null (unprovisioned) otherwise. */
function makeStateStore(): ExtensionOrgInstallRoutesDeps['stateStore'] {
  return {
    get: vi.fn(async (name: string) => (name === 'demo' ? ({ name } as ExtensionStateRecord) : null)),
  };
}

describe('extensionOrgInstalls routes', () => {
  let installs: ReturnType<typeof makeInMemoryInstalls>;
  let stateStore: ExtensionOrgInstallRoutesDeps['stateStore'];
  let app: ReturnType<typeof createExtensionOrgInstallRoutes>;

  beforeEach(() => {
    installs = makeInMemoryInstalls();
    stateStore = makeStateStore();
    app = createExtensionOrgInstallRoutes({ stateStore, installs });
  });

  it('PUT activates: upserts enabled=true with the actor recorded', async () => {
    const res = await app.request(`/demo/orgs/${ORG_OK}`, { method: 'PUT' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ extension: 'demo', orgId: ORG_OK, enabled: true });
    expect(installs.rows).toContainEqual(
      expect.objectContaining({ extensionName: 'demo', orgId: ORG_OK, enabled: true, installedBy: 'user-1' }),
    );
  });

  it('PUT re-activates a deactivated row', async () => {
    installs.rows.push({
      extensionName: 'demo',
      orgId: ORG_OK,
      enabled: false,
      installedBy: 'user-0',
      installedAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const res = await app.request(`/demo/orgs/${ORG_OK}`, { method: 'PUT' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ extension: 'demo', orgId: ORG_OK, enabled: true });
    expect(installs.rows).toContainEqual(
      expect.objectContaining({ extensionName: 'demo', orgId: ORG_OK, enabled: true, installedBy: 'user-1' }),
    );
  });

  it('DELETE deactivates: flips enabled=false, keeps the row', async () => {
    installs.rows.push({
      extensionName: 'demo',
      orgId: ORG_OK,
      enabled: true,
      installedBy: 'user-1',
      installedAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const res = await app.request(`/demo/orgs/${ORG_OK}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ extension: 'demo', orgId: ORG_OK, enabled: false });
    expect(installs.rows).toContainEqual(
      expect.objectContaining({ extensionName: 'demo', orgId: ORG_OK, enabled: false }),
    );
    expect(installs.rows).toHaveLength(1);
  });

  it('DELETE with no install row: 404', async () => {
    const res = await app.request(`/demo/orgs/${ORG_OK}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('GET lists installs', async () => {
    installs.rows.push(
      {
        extensionName: 'demo',
        orgId: ORG_OK,
        enabled: true,
        installedBy: 'user-1',
        installedAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
      {
        extensionName: 'demo',
        orgId: ORG_OK_2,
        enabled: false,
        installedBy: 'user-2',
        installedAt: new Date('2026-01-03T00:00:00.000Z'),
        updatedAt: new Date('2026-01-04T00:00:00.000Z'),
      },
    );

    const res = await app.request('/demo/orgs');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      installs: [
        {
          orgId: ORG_OK,
          enabled: true,
          installedBy: 'user-1',
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
        {
          orgId: ORG_OK_2,
          enabled: false,
          installedBy: 'user-2',
          installedAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-04T00:00:00.000Z',
        },
      ],
    });
  });

  it('unknown (unprovisioned) extension: 404 on PUT, DELETE and GET — never 400', async () => {
    for (const [method, path] of [
      ['PUT', `/ghost/orgs/${ORG_OK}`],
      ['DELETE', `/ghost/orgs/${ORG_OK}`],
      ['GET', '/ghost/orgs'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
    }
  });

  it('org outside accessibleOrgIds: 404, and the port is never touched', async () => {
    const res = await app.request(`/demo/orgs/${ORG_FORBIDDEN}`, { method: 'PUT' });
    expect(res.status).toBe(404);
    expect(installs.rows).toHaveLength(0);
  });

  it('malformed orgId: 404 (non-disclosure, and it cannot exist)', async () => {
    const res = await app.request(`/demo/orgs/${ORG_BAD}`, { method: 'PUT' });
    expect(res.status).toBe(404);
  });
});

/**
 * Composition-level pin: this router is reachable through the exact app
 * shape index.ts builds — mountExtensionGateway on the ROOT app first
 * (registering the `/api/v1/:routeNamespace/*` catch-all directly on it, per
 * gateway.ts), THEN `app.route('/api/v1', api)` merging in this router
 * mounted at '/extensions'. Registration order alone would suggest the
 * gateway's catch-all "wins" for `/api/v1/extensions/*` — the real reason it
 * doesn't is (a) an empty/normal registry can never resolve an active
 * extension for the reserved 'extensions' namespace, so (b) the gateway's
 * dispatchAlias middleware calls `next()` (pass-through) instead of
 * responding, letting the composed Hono handler chain reach this router's
 * own routes regardless of which app registered them first. See the
 * docstring at the top of extensionOrgInstalls.ts and the mount comment in
 * index.ts.
 */
describe('extensionOrgInstalls composition with mountExtensionGateway (index.ts app shape)', () => {
  it('a request to /api/v1/extensions/:name/orgs/:orgId reaches this router, not the gateway catch-all', async () => {
    const rootApp = new Hono();
    // No extension is activated in this registry, so it can never resolve a
    // routeNamespace of 'extensions' (that namespace is also unreachable in
    // production — see RESERVED_ROUTE_NAMESPACES). This mirrors index.ts:
    // mountExtensionGateway runs on the root app BEFORE the '/api/v1' merge.
    mountExtensionGateway(
      rootApp,
      new ExtensionContributionRegistry(),
      async () => true,
      async () => false,
    );

    const stateStore = makeStateStore();
    const installs = makeInMemoryInstalls();
    const orgInstallRoutes = createExtensionOrgInstallRoutes({ stateStore, installs });

    const api = new Hono();
    api.route('/extensions', orgInstallRoutes);
    // Merged in AFTER mountExtensionGateway already registered its catch-all
    // on rootApp — the ordering index.ts actually uses (index.ts:~1013 vs.
    // ~1020 mountExtensionGateway vs. ~1027 `app.route('/api/v1', api)`).
    rootApp.route('/api/v1', api);

    // A malformed orgId deterministically produces this router's own
    // `notFound` body (`{ error: 'not found' }`), distinct from both Hono's
    // default 404 (`{ error: 'Not Found', path }`) and the gateway's 503
    // (`{ error: 'extension unavailable' }`) — so a 200/503/generic-404
    // response here would mean the request never reached this handler.
    const res = await rootApp.request(`/api/v1/extensions/demo/orgs/${ORG_BAD}`, { method: 'PUT' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});
