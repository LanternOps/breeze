import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  authRef,
  permissionDenied,
  requirePermissionSpy,
  requireMfaSpy,
  previewMock,
  commitMock,
  auditMock,
} = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as 'partner' | 'organization' | 'system',
      partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as string | null,
      partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null | undefined,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      user: { id: 'u-1', email: 'admin@example.com' },
    },
  },
  permissionDenied: { current: false },
  requirePermissionSpy: vi.fn(),
  requireMfaSpy: vi.fn(),
  previewMock: vi.fn(),
  commitMock: vi.fn(),
  auditMock: vi.fn(),
}));

/**
 * `authMiddleware` is modelled on production's actual contract rather than
 * stubbed to always succeed: it authenticates a Bearer JWT and has NO
 * X-API-Key branch at all. That is what makes the "rejects an X-API-Key
 * caller" test below meaningful — swapping the route to `dualAuth` would
 * change which middleware the route mounts, and this mock would stop covering
 * it.
 */
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!c.req.header('authorization')?.startsWith('Bearer ')) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: (resource: string, action: string) => {
    requirePermissionSpy(resource, action);
    return async (c: any, next: any) => {
      if (permissionDenied.current) return c.json({ error: 'Insufficient permissions' }, 403);
      await next();
    };
  },
  requireMfa: () => async (_c: any, next: any) => {
    requireMfaSpy();
    await next();
  },
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
  },
}));

vi.mock('../services/customFields/import/definitionImport', () => ({
  previewCustomFieldDefinitionImport: previewMock,
  commitCustomFieldDefinitionImport: commitMock,
}));

vi.mock('../services/customFields/import/audit', () => ({
  writeCustomFieldDefinitionImportAudits: auditMock,
}));

import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { customFieldImportRoutes } from './customFieldImport';

const PARTNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_PARTNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG = '11111111-1111-4111-8111-111111111111';
const DEF = '33333333-3333-4333-8333-333333333333';

const PREVIEW = '/custom-fields/import/preview';
const COMMIT = '/custom-fields/import';
const BOTH = [PREVIEW, COMMIT];

function app() {
  const a = new Hono();
  a.route('/custom-fields', customFieldImportRoutes);
  return a;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app().request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t', ...headers },
    body: JSON.stringify(body),
  });
}

function partnerRow(overrides: Record<string, unknown> = {}) {
  return { fieldKey: 'udf7', name: 'Warranty Expiry', type: 'date', ownerScope: 'partner', ...overrides };
}

function setPartnerAuth(partnerOrgAccess: 'all' | 'selected') {
  authRef.current = {
    scope: 'partner',
    partnerId: PARTNER,
    partnerOrgAccess,
    orgId: null,
    accessibleOrgIds: [ORG],
    user: { id: 'u-1', email: 'admin@example.com' },
  };
}

function setOrgAuth() {
  authRef.current = {
    scope: 'organization',
    partnerId: PARTNER,
    partnerOrgAccess: undefined,
    orgId: ORG,
    accessibleOrgIds: [ORG],
    user: { id: 'u-2', email: 'org-admin@example.com' },
  };
}

beforeEach(() => {
  setPartnerAuth('all');
  permissionDenied.current = false;
  previewMock.mockReset().mockResolvedValue([]);
  commitMock.mockReset().mockResolvedValue({ created: [], skipped: [], errors: [] });
  auditMock.mockReset();
  requireMfaSpy.mockClear();
});

describe('custom-field definition import routes', () => {
  it('rejects an X-API-Key caller on both routes', async () => {
    for (const path of BOTH) {
      const res = await app().request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' },
        body: JSON.stringify({ rows: [partnerRow()] }),
      });
      expect(res.status).toBe(401);
    }
  });

  it('gates on the same permission the single-create route uses (devices:write)', () => {
    expect(requirePermissionSpy).toHaveBeenCalledWith('devices', 'write');
  });

  it('403s a caller without that permission on both routes', async () => {
    permissionDenied.current = true;
    for (const path of BOTH) {
      const res = await post(path, { rows: [partnerRow()] });
      expect(res.status).toBe(403);
    }
    expect(previewMock).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('requires MFA on both routes', async () => {
    for (const path of BOTH) {
      await post(path, { rows: [partnerRow()] });
    }
    expect(requireMfaSpy).toHaveBeenCalledTimes(2);
  });

  it('403s an org token naming another partner in the body', async () => {
    setOrgAuth();
    const res = await post(PREVIEW, {
      partnerId: OTHER_PARTNER,
      rows: [{ ...partnerRow(), ownerScope: 'organization', organizationId: ORG }],
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Access denied to this partner' });
    expect(previewMock).not.toHaveBeenCalled();
  });

  it('rejects more than MAX_IMPORT_ROWS rows at the zod layer', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => partnerRow({ fieldKey: `udf${i}` }));
    const res = await post(PREVIEW, { rows });
    expect(res.status).toBe(400);
    expect(previewMock).not.toHaveBeenCalled();
  });

  it('rejects an empty rows array', async () => {
    const res = await post(PREVIEW, { rows: [] });
    expect(res.status).toBe(400);
  });

  it('rejects an organization row with no organizationId at the zod layer', async () => {
    const res = await post(PREVIEW, { rows: [partnerRow({ ownerScope: 'organization' })] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/organizationId is required/i);
  });

  it('rejects a field key the single-create route would reject', async () => {
    const res = await post(PREVIEW, { rows: [partnerRow({ fieldKey: 'UDF 7' })] });
    expect(res.status).toBe(400);
  });

  it('requires expectedDefinitionId when the commit acknowledges already-exists', async () => {
    const res = await post(COMMIT, {
      rows: [partnerRow({ expectedAnnotation: 'already-exists' })],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expectedDefinitionId is required/i);
    expect(commitMock).not.toHaveBeenCalled();
  });

  describe('partner-wide capability gate', () => {
    it('403s a partner user without full org access on both routes', async () => {
      setPartnerAuth('selected');
      for (const path of BOTH) {
        const res = await post(path, { rows: [partnerRow()] });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
      }
      expect(previewMock).not.toHaveBeenCalled();
      expect(commitMock).not.toHaveBeenCalled();
    });

    it('403s an ORG-scoped token submitting a partner-wide row', async () => {
      setOrgAuth();
      const res = await post(PREVIEW, { rows: [partnerRow()] });
      expect(res.status).toBe(403);
      expect(previewMock).not.toHaveBeenCalled();
    });

    it('admits an org-scoped token submitting only organization rows', async () => {
      setOrgAuth();
      const res = await post(PREVIEW, {
        rows: [partnerRow({ ownerScope: 'organization', organizationId: ORG })],
      });
      expect(res.status).toBe(200);
      expect(previewMock.mock.calls[0]![1]).toMatchObject({
        partnerId: PARTNER,
        accessibleOrgIds: [ORG],
        canManagePartnerWide: false,
      });
    });

    it('passes the capability and the caller reach into the service context', async () => {
      setPartnerAuth('all');
      await post(PREVIEW, { rows: [partnerRow()] });
      expect(previewMock.mock.calls[0]![1]).toEqual({
        partnerId: PARTNER,
        accessibleOrgIds: [ORG],
        canManagePartnerWide: true,
      });
    });
  });

  it('returns 200 with a non-empty errors[] on a partial commit', async () => {
    commitMock.mockResolvedValue({
      created: [{ index: 0, definitionId: DEF, fieldKey: 'udf7', ownerScope: 'partner', organizationId: null }],
      skipped: [],
      errors: [{ index: 1, fieldKey: 'udf8', error: 'nope', code: 'type-conflict' }],
    });
    const res = await post(COMMIT, {
      rows: [partnerRow(), partnerRow({ fieldKey: 'udf8', type: 'text' })],
    });
    // runAction reads a failure body as a hard failure and would hide the row
    // that DID import.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toHaveLength(1);
    expect(body.created).toHaveLength(1);
  });

  it('writes the import audits with the source system and the submitted rows', async () => {
    commitMock.mockResolvedValue({
      created: [{ index: 0, definitionId: DEF, fieldKey: 'udf7', ownerScope: 'partner', organizationId: null }],
      skipped: [],
      errors: [],
    });
    await post(COMMIT, { externalSystem: 'datto_rmm', rows: [partnerRow({ sourceLabel: 'udf7' })] });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1]).toMatchObject({
      externalSystem: 'datto_rmm',
      rows: [expect.objectContaining({ sourceLabel: 'udf7' })],
    });
  });

  it('defaults externalSystem to the csv fallback', async () => {
    await post(COMMIT, { rows: [partnerRow()] });
    expect(auditMock.mock.calls[0]![1]).toMatchObject({ externalSystem: 'csv' });
  });
});
