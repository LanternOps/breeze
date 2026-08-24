import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  softwareInstallMethodRoutes,
  installMethodBodySchema,
  WINGET_PACKAGE_ID_RE,
  BREW_PACKAGE_NAME_RE,
  validatePackageIdForKind,
} from './softwareInstallMethods';
import { db } from '../db';
import { writeRouteAudit } from '../services/auditEvents';

// Chain-friendly mock builder for Drizzle query builder patterns (mirrors the
// `selectResult` helper in software.test.ts). A single self-referential proxy
// resolves regardless of chain depth — `.from().where()`, `.values().returning()`,
// etc. all terminate at the same `p`, so `.then` is the only special case.
function chainMock(terminalValue: any): any {
  const p: any = new Proxy(() => p, {
    get: (_t, prop) => (prop === 'then' ? (resolve: any) => resolve(terminalValue) : () => p),
  });
  return p;
}

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(() => chainMock([])),
    insert: vi.fn(() => chainMock([])),
    update: vi.fn(() => chainMock([])),
    delete: vi.fn(() => chainMock(undefined)),
    transaction: vi.fn(async (fn: any) => fn({ insert: vi.fn(() => chainMock([])) })),
  }
}));

vi.mock('../db/schema', () => ({
  softwareCatalog: { id: 'id', orgId: 'org_id', name: 'name', integrationProvider: 'integration_provider' },
  softwareInstallMethods: {
    id: 'im_id',
    catalogId: 'im_catalog_id',
    platform: 'im_platform',
    kind: 'im_kind',
    packageId: 'im_package_id',
    enabled: 'im_enabled',
    createdAt: 'im_created_at',
  },
}));

const { permissionGate, mfaGate } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      userId: 'user-123',
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) return c.json({ error: 'Permission denied' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (mfaGate.deny) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

const CATALOG_ID = '11111111-1111-4111-8111-111111111111';
const METHOD_ID = '22222222-2222-4222-8222-222222222222';

function ownedCatalogItem(overrides: Record<string, unknown> = {}) {
  return {
    id: CATALOG_ID,
    orgId: 'org-123',
    name: 'Some App',
    integrationProvider: null,
    ...overrides,
  };
}

/**
 * The shape drizzle-orm/postgres-js actually throws: a DrizzleQueryError whose
 * OWN `.code` is undefined, wrapping the postgres-js PostgresError on `.cause`.
 * A flat `{ code }` fixture passes against a broken top-level `err.code` check
 * and proves nothing (issue #3881), so every SQLSTATE mapping is exercised
 * through this builder as well as the flat one below.
 */
function drizzleWrapped(code: string, message: string, extra: Record<string, unknown> = {}) {
  const pgError = Object.assign(new Error(message), { code, severity: 'ERROR', ...extra });
  // NB: no `name` override — the real DrizzleQueryError never sets `this.name`,
  // so a genuine instance reports `name === 'Error'`. Keeping the fixture
  // faithful here matters: it is the whole point of this builder.
  const wrapper = Object.assign(new Error('Failed query: insert into "software_install_methods" ...'), {
    cause: pgError,
  });
  return wrapper;
}

/** Raw postgres-js shape (no Drizzle wrapper) — still must map. */
function flatPgError(code: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { code, severity: 'ERROR', ...extra });
}

const SQLSTATE_SHAPES = [
  ['DrizzleQueryError-wrapped (real driver shape)', drizzleWrapped] as const,
  ['flat postgres-js error', flatPgError] as const,
];

function installedMethod(overrides: Record<string, unknown> = {}) {
  return {
    id: METHOD_ID,
    catalogId: CATALOG_ID,
    platform: 'windows',
    kind: 'winget',
    packageId: 'Vendor.App',
    enabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('softwareInstallMethodRoutes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;
    app = new Hono();
    // No extra auth-setting middleware needed here: softwareInstallMethodRoutes
    // applies its own `use('*', authMiddleware)` (mocked above), which already
    // sets `auth` on every request.
    app.route('/software', softwareInstallMethodRoutes);
  });

  describe('validatePackageIdForKind', () => {
    it('accepts a normal winget package id', () => {
      expect(validatePackageIdForKind('winget', 'Vendor.App')).toBeNull();
    });
    it('rejects a malformed winget package id', () => {
      expect(validatePackageIdForKind('winget', 'bad id;rm')).not.toBeNull();
    });
    it('rejects a malformed brew name', () => {
      expect(validatePackageIdForKind('homebrew_cask', '../evil')).not.toBeNull();
    });
    it('rejects overly long package ids', () => {
      expect(validatePackageIdForKind('winget', 'a'.repeat(300))).not.toBeNull();
    });
  });

  describe('installMethodBodySchema', () => {
    it('rejects kind/platform mismatch (winget + macos)', () => {
      const result = installMethodBodySchema.safeParse({ platform: 'macos', kind: 'winget', packageId: 'Vendor.App' });
      expect(result.success).toBe(false);
    });
  });

  describe('POST /software/catalog/:id/install-methods', () => {
    it('creates a winget method on an owned catalog item', async () => {
      vi.mocked(db.select).mockReturnValueOnce(chainMock([ownedCatalogItem()]) as any);
      vi.mocked(db.insert).mockReturnValueOnce(chainMock([installedMethod()]) as any);

      const res = await app.request(`/software/catalog/${CATALOG_ID}/install-methods`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ platform: 'windows', kind: 'winget', packageId: 'Vendor.App' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data).toMatchObject({ id: METHOD_ID });
      expect(db.insert).toHaveBeenCalled();
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'software.install_method.create', resourceId: METHOD_ID }),
      );
    });

    it('rejects kind/platform mismatch (winget + macos)', async () => {
      // No db.select mock needed: zValidator's superRefine rejects before the
      // handler (and thus loadOwnedCatalogItem) ever runs.

      const res = await app.request(`/software/catalog/${CATALOG_ID}/install-methods`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ platform: 'macos', kind: 'winget', packageId: 'Vendor.App' }),
      });

      expect(res.status).toBe(400);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects malformed winget packageId ("bad id;rm")', async () => {
      const res = await app.request(`/software/catalog/${CATALOG_ID}/install-methods`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ platform: 'windows', kind: 'winget', packageId: 'bad id;rm' }),
      });

      expect(res.status).toBe(400);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects malformed brew name ("../evil")', async () => {
      const res = await app.request(`/software/catalog/${CATALOG_ID}/install-methods`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ platform: 'macos', kind: 'homebrew_cask', packageId: '../evil' }),
      });

      expect(res.status).toBe(400);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('404s when the catalog item is not visible/owned', async () => {
      vi.mocked(db.select).mockReturnValueOnce(chainMock([]) as any);

      const res = await app.request(`/software/catalog/${CATALOG_ID}/install-methods`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ platform: 'windows', kind: 'winget', packageId: 'Vendor.App' }),
      });

      expect(res.status).toBe(404);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects methods on built-in items (integrationProvider set)', async () => {
      vi.mocked(db.select).mockReturnValueOnce(chainMock([ownedCatalogItem({ integrationProvider: 'ninite' })]) as any);

      const res = await app.request(`/software/catalog/${CATALOG_ID}/install-methods`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ platform: 'windows', kind: 'winget', packageId: 'Vendor.App' }),
      });

      expect(res.status).toBe(400);
      expect(db.insert).not.toHaveBeenCalled();
    });

    async function postDuplicate() {
      return app.request(`/software/catalog/${CATALOG_ID}/install-methods`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ platform: 'windows', kind: 'winget', packageId: 'Vendor.App' }),
      });
    }

    it.each(SQLSTATE_SHAPES)('maps unique-violation (23505) to 409 — %s', async (_label, build) => {
      vi.mocked(db.select).mockReturnValueOnce(chainMock([ownedCatalogItem()]) as any);
      vi.mocked(db.insert).mockImplementationOnce(() => {
        throw build('23505', 'duplicate key value violates unique constraint', {
          constraint_name: 'software_install_methods_catalog_platform_kind_uniq',
        });
      });

      const res = await postDuplicate();

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/already exists/i);
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('does not swallow a non-unique-violation error as a 409', async () => {
      vi.mocked(db.select).mockReturnValueOnce(chainMock([ownedCatalogItem()]) as any);
      vi.mocked(db.insert).mockImplementationOnce(() => {
        throw drizzleWrapped('23502', 'null value in column "package_id" violates not-null constraint');
      });

      const res = await postDuplicate();

      expect(res.status).toBe(500);
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /software/catalog/:id/install-methods/:methodId', () => {
    it('updates enabled/packageId', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(chainMock([ownedCatalogItem()]) as any)
        .mockReturnValueOnce(chainMock([installedMethod()]) as any);
      vi.mocked(db.update).mockReturnValueOnce(chainMock([installedMethod({ enabled: false })]) as any);

      const res = await app.request(`/software/catalog/${CATALOG_ID}/install-methods/${METHOD_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ enabled: false }),
      });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'software.install_method.update' }),
      );
    });

    it('validates packageId against the method kind on update', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(chainMock([ownedCatalogItem()]) as any)
        .mockReturnValueOnce(chainMock([installedMethod({ kind: 'winget' })]) as any);

      const res = await app.request(`/software/catalog/${CATALOG_ID}/install-methods/${METHOD_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ packageId: 'bad id;rm' }),
      });

      expect(res.status).toBe(400);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('rejects an empty PATCH body as a no-op', async () => {
      // No db.select mock needed: zValidator's refine rejects the empty body
      // before the handler (and thus loadOwnedCatalogItem) ever runs.
      const res = await app.request(`/software/catalog/${CATALOG_ID}/install-methods/${METHOD_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      expect(db.update).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /software/catalog/:id/install-methods/:methodId', () => {
    it('deletes and audits', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(chainMock([ownedCatalogItem()]) as any)
        .mockReturnValueOnce(chainMock([installedMethod()]) as any);
      vi.mocked(db.delete).mockReturnValueOnce(chainMock(undefined) as any);

      const res = await app.request(`/software/catalog/${CATALOG_ID}/install-methods/${METHOD_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(db.delete).toHaveBeenCalled();
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'software.install_method.delete', resourceId: METHOD_ID }),
      );
    });

    function mockOwnedMethodLookup() {
      vi.mocked(db.select)
        .mockReturnValueOnce(chainMock([ownedCatalogItem()]) as any)
        .mockReturnValueOnce(chainMock([installedMethod()]) as any);
    }

    async function deleteMethod() {
      return app.request(`/software/catalog/${CATALOG_ID}/install-methods/${METHOD_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });
    }

    it.each(SQLSTATE_SHAPES)(
      'maps a referencing-deployment FK violation (23503) to 409 without auditing — %s',
      async (_label, build) => {
        mockOwnedMethodLookup();
        vi.mocked(db.delete).mockImplementationOnce(() => {
          throw build('23503', 'update or delete on table violates foreign key constraint', {
            table_name: 'software_deployments',
            detail: 'Key (id)=(...) is still referenced from table "software_deployments".',
          });
        });

        const res = await deleteMethod();

        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error).toMatch(/referenced by past deployments/i);
        expect(writeRouteAudit).not.toHaveBeenCalled();
      },
    );

    it('does not swallow a non-FK-violation error as a 409', async () => {
      mockOwnedMethodLookup();
      vi.mocked(db.delete).mockImplementationOnce(() => {
        throw drizzleWrapped('40P01', 'deadlock detected');
      });

      const res = await deleteMethod();

      expect(res.status).toBe(500);
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
  });

  describe('GET /software/catalog/:id/install-methods', () => {
    it('lists methods for the item', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(chainMock([ownedCatalogItem()]) as any)
        .mockReturnValueOnce(chainMock([installedMethod()]) as any);

      const res = await app.request(`/software/catalog/${CATALOG_ID}/install-methods`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });
  });

  describe('POST /software/catalog/import-package', () => {
    const importedCatalogRow = () => ({
      id: CATALOG_ID,
      orgId: 'org-123',
      name: 'New App',
      vendor: null,
      description: null,
      category: 'application',
      iconUrl: null,
      websiteUrl: null,
      integrationProvider: null,
    });

    const validMethodsPayload = [
      { platform: 'windows', kind: 'winget', packageId: 'Vendor.App' },
      { platform: 'macos', kind: 'homebrew_cask', packageId: 'vendor-app' },
    ];

    it('creates a catalog row + N method rows in one db.transaction', async () => {
      const catalogRow = importedCatalogRow();
      const methodRows = [
        installedMethod({ id: 'm-1', platform: 'windows', kind: 'winget', packageId: 'Vendor.App' }),
        installedMethod({ id: 'm-2', platform: 'macos', kind: 'homebrew_cask', packageId: 'vendor-app' }),
      ];
      const txInsert = vi.fn()
        .mockReturnValueOnce(chainMock([catalogRow]))
        .mockReturnValueOnce(chainMock(methodRows));
      vi.mocked(db.transaction).mockImplementationOnce(async (fn: any) => fn({ insert: txInsert }));

      const res = await app.request('/software/catalog/import-package', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'New App', methods: validMethodsPayload }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.catalogItem).toMatchObject({ id: CATALOG_ID, name: 'New App' });
      expect(body.data.methods).toHaveLength(2);
      expect(db.transaction).toHaveBeenCalled();
      expect(txInsert).toHaveBeenCalledTimes(2);
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'software.catalog.import', resourceId: CATALOG_ID }),
      );
    });

    it('rejects duplicate platform+kind pairs in the body', async () => {
      const res = await app.request('/software/catalog/import-package', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'New App',
          methods: [
            { platform: 'windows', kind: 'winget', packageId: 'Vendor.App' },
            { platform: 'windows', kind: 'winget', packageId: 'Vendor.App2' },
          ],
        }),
      });

      expect(res.status).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('rejects an empty methods array', async () => {
      const res = await app.request('/software/catalog/import-package', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'New App', methods: [] }),
      });

      expect(res.status).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('reuses validatePackageIdForKind for method validation', async () => {
      const res = await app.request('/software/catalog/import-package', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'New App',
          methods: [{ platform: 'windows', kind: 'winget', packageId: 'bad id;rm' }],
        }),
      });

      expect(res.status).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('rejects kind/platform mismatch within a method entry', async () => {
      const res = await app.request('/software/catalog/import-package', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'New App',
          methods: [{ platform: 'macos', kind: 'winget', packageId: 'Vendor.App' }],
        }),
      });

      expect(res.status).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });
});

// Sanity-check the exported regexes directly, since Tasks 3/4 import them.
describe('exported regexes', () => {
  it('WINGET_PACKAGE_ID_RE matches typical winget ids', () => {
    expect(WINGET_PACKAGE_ID_RE.test('Microsoft.VisualStudioCode')).toBe(true);
    expect(WINGET_PACKAGE_ID_RE.test('bad id;rm')).toBe(false);
  });
  it('BREW_PACKAGE_NAME_RE matches typical brew names', () => {
    expect(BREW_PACKAGE_NAME_RE.test('google-chrome')).toBe(true);
    expect(BREW_PACKAGE_NAME_RE.test('../evil')).toBe(false);
  });
});
