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
    app.use('*', (c, next) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        userId: 'user-123',
        scope: 'organization',
        orgId: 'org-123',
        partnerId: null,
      });
      return next();
    });
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

    it('maps unique-violation to 409', async () => {
      vi.mocked(db.select).mockReturnValueOnce(chainMock([ownedCatalogItem()]) as any);
      vi.mocked(db.insert).mockImplementationOnce(() => {
        throw Object.assign(new Error('duplicate'), { code: '23505' });
      });

      const res = await app.request(`/software/catalog/${CATALOG_ID}/install-methods`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ platform: 'windows', kind: 'winget', packageId: 'Vendor.App' }),
      });

      expect(res.status).toBe(409);
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
