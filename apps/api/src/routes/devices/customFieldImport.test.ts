import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Route contract for the VALUES importer (#3257 W08 Task 5).
 *
 * The gates are the point of this file, so every negative test is
 * mutation-checked: deleting the middleware it guards turns it red (recorded in
 * the PR body). The service is mocked — its behaviour has its own suite — so
 * these tests assert exactly what the ROUTE is responsible for: the caps, the
 * auth band, the partner bounding, and the always-200 contract.
 */

const PARTNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_PARTNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';

const {
  authRef,
  permissionsRef,
  permissionDenied,
  grantsRequested,
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
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      user: { id: 'u-1', email: 'admin@example.com' },
      token: { mfa: true } as { mfa: boolean },
    },
  },
  permissionsRef: { current: { allowedSiteIds: undefined } as { allowedSiteIds?: string[] } | undefined },
  permissionDenied: { current: false },
  /** Recorded at MODULE LOAD (that is when `requirePermission` is called), so it
   *  is deliberately never cleared in `beforeEach`. */
  grantsRequested: [] as Array<[string, string]>,
  requirePermissionSpy: vi.fn(),
  requireMfaSpy: vi.fn(),
  previewMock: vi.fn(),
  commitMock: vi.fn(),
  auditMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  // Bearer-only, exactly like production: `middleware/auth.ts` has no
  // X-API-Key branch at all, which is what makes the API-key test meaningful.
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!c.req.header('authorization')?.startsWith('Bearer ')) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: (resource: string, action: string) => {
    grantsRequested.push([resource, action]);
    requirePermissionSpy(resource, action);
    return async (c: any, next: any) => {
      if (permissionDenied.current) return c.json({ error: 'Insufficient permissions' }, 403);
      c.set('permissions', permissionsRef.current);
      await next();
    };
  },
  requireMfa: () => async (c: any, next: any) => {
    requireMfaSpy();
    if (authRef.current.token?.mfa !== true) {
      return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
    }
    await next();
  },
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
  },
}));

vi.mock('../../services/customFields/import/valueImport', () => ({
  previewDeviceCustomFieldImport: previewMock,
  commitDeviceCustomFieldImport: commitMock,
}));

vi.mock('../../services/customFields/import/audit', () => ({
  writeCustomFieldValueImportAudits: auditMock,
}));

import { customFieldImportRoutes } from './customFieldImport';
import { MAX_IMPORT_ROWS, MAX_IMPORT_VALUES } from '../../services/customFields/import/types';

const PREVIEW = '/devices/custom-fields/import/preview';
const COMMIT = '/devices/custom-fields/import';
const BOTH = [PREVIEW, COMMIT];

function app() {
  const a = new Hono();
  a.route('/devices', customFieldImportRoutes);
  return a;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app().request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t', ...headers },
    body: JSON.stringify(body),
  });
}

const value = (fieldKey: string, v: unknown) => ({ target: { kind: 'customField', fieldKey }, value: v });

function row(overrides: Record<string, unknown> = {}) {
  return { hostname: 'wkstn-1', values: [value('asset_tag', 'AB-1')], ...overrides };
}

const emptySummary = {
  appliedValues: 0, skippedValues: 0, failedValues: 0, rows: [], linksCreated: 0, errors: [],
};

function setPartnerAuth() {
  authRef.current = {
    scope: 'partner', partnerId: PARTNER, orgId: null, accessibleOrgIds: [ORG],
    user: { id: 'u-1', email: 'admin@example.com' }, token: { mfa: true },
  };
}

function setOrgAuth() {
  authRef.current = {
    scope: 'organization', partnerId: PARTNER, orgId: ORG, accessibleOrgIds: [ORG],
    user: { id: 'u-2', email: 'org-admin@example.com' }, token: { mfa: true },
  };
}

beforeEach(() => {
  setPartnerAuth();
  permissionsRef.current = { allowedSiteIds: undefined };
  permissionDenied.current = false;
  previewMock.mockReset().mockResolvedValue([]);
  commitMock.mockReset().mockResolvedValue(emptySummary);
  auditMock.mockReset();
  requireMfaSpy.mockClear();
  requirePermissionSpy.mockClear();
});

describe('POST /devices/custom-fields/import{,/preview} — caps', () => {
  it('rejects more rows than the row cap, with copy telling the browser to split', async () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => row());
    for (const path of BOTH) {
      const res = await post(path, { rows });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/split/i);
    }
    expect(previewMock).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('rejects 1000 rows x 30 values at the zod layer even though the ROW cap passes', async () => {
    // The row cap alone does not bound the work — this is the case it misses.
    const values = Array.from({ length: 30 }, (_, i) => value(`f_${i}`, 'x'));
    const rows = Array.from({ length: MAX_IMPORT_ROWS }, () => row({ values }));
    expect(rows.length).toBeLessThanOrEqual(MAX_IMPORT_ROWS);
    expect(rows.length * 30).toBeGreaterThan(MAX_IMPORT_VALUES);

    const res = await post(PREVIEW, { rows });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/split/i);
    expect(previewMock).not.toHaveBeenCalled();
  });

  it('accepts a batch at exactly the value cap', async () => {
    const values = Array.from({ length: 10 }, (_, i) => value(`f_${i}`, 'x'));
    const rows = Array.from({ length: MAX_IMPORT_VALUES / 10 }, () => row({ values }));
    const res = await post(PREVIEW, { rows });
    expect(res.status).toBe(200);
  });

  it('rejects an empty batch', async () => {
    const res = await post(PREVIEW, { rows: [] });
    expect(res.status).toBe(400);
  });
});

describe('POST /devices/custom-fields/import{,/preview} — auth band', () => {
  it('rejects an X-API-Key caller on both routes', async () => {
    for (const path of BOTH) {
      const res = await app().request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'brz_test' },
        body: JSON.stringify({ rows: [row()] }),
      });
      expect(res.status).toBe(401);
    }
    expect(previewMock).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('403s a caller whose token has not satisfied MFA, on both routes', async () => {
    authRef.current.token = { mfa: false };
    for (const path of BOTH) {
      const res = await post(path, { rows: [row()] });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    }
    expect(requireMfaSpy).toHaveBeenCalledTimes(2);
    expect(previewMock).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('requires the DEVICE write grant, not the organization one', async () => {
    // Wrong grant here would make the importer a cheaper path to a device write
    // than the endpoint it bulk-loads.
    // One shared middleware instance, used by both routes — so this is the ONLY
    // grant the router asks for, on either path.
    expect(grantsRequested).toEqual([['devices', 'write']]);
  });

  it('403s a caller without the device write permission, on both routes', async () => {
    permissionDenied.current = true;
    for (const path of BOTH) {
      const res = await post(path, { rows: [row()] });
      expect(res.status).toBe(403);
    }
    expect(previewMock).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('403s an org token naming another partner in the body', async () => {
    setOrgAuth();
    for (const path of BOTH) {
      const res = await post(path, { partnerId: OTHER_PARTNER, rows: [row()] });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'Access denied to this partner' });
    }
    expect(previewMock).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('403s when the permissions context is missing rather than importing with no site bound', async () => {
    // RLS never covered the site axis, so an absent allowlist must deny, never
    // degrade into "unrestricted".
    permissionsRef.current = undefined;
    const res = await post(PREVIEW, { rows: [row()] });
    expect(res.status).toBe(403);
    expect(previewMock).not.toHaveBeenCalled();
  });
});

describe('POST /devices/custom-fields/import{,/preview} — context handed to the service', () => {
  it('carries the caller partner, org allowlist and SITE allowlist', async () => {
    permissionsRef.current = { allowedSiteIds: ['site-1'] };

    await post(PREVIEW, { rows: [row()] });

    expect(previewMock.mock.calls[0]![1]).toMatchObject({
      partnerId: PARTNER,
      accessibleOrgIds: [ORG],
      allowedSiteIds: ['site-1'],
      mode: 'skip',
      overrideProviderWarranty: false,
    });
  });

  it('passes null (not undefined) for an unrestricted site axis', async () => {
    await post(PREVIEW, { rows: [row()] });
    // `loadDeviceResolutionSnapshot` THROWS on undefined rather than widening.
    expect(previewMock.mock.calls[0]![1].allowedSiteIds).toBeNull();
  });

  it('defaults the mode to skip and the warranty override to off', async () => {
    await post(COMMIT, { rows: [row()] });
    expect(commitMock.mock.calls[0]![1]).toMatchObject({ mode: 'skip', overrideProviderWarranty: false });
  });

  it('honours an explicit update mode and warranty override', async () => {
    await post(COMMIT, { rows: [row()], mode: 'update', overrideProviderWarranty: true });
    expect(commitMock.mock.calls[0]![1]).toMatchObject({ mode: 'update', overrideProviderWarranty: true });
  });
});

describe('POST /devices/custom-fields/import — wire schema', () => {
  it('accepts a warranty mapping target', async () => {
    const res = await post(PREVIEW, {
      rows: [row({ values: [{ target: { kind: 'warranty', field: 'warrantyEndDate' }, value: '2027-03-04' }] })],
    });
    expect(res.status).toBe(200);
  });

  it('rejects an unknown warranty field', async () => {
    const res = await post(PREVIEW, {
      rows: [row({ values: [{ target: { kind: 'warranty', field: 'isSubscription' }, value: true }] })],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a row that maps two columns onto the same target', async () => {
    // A duplicate is not one bad cell — the column-to-target mapping is chosen
    // once for the whole file, so it would repeat on every row and the last
    // column would silently win.
    for (const path of BOTH) {
      const res = await post(path, { rows: [row({ values: [value('asset_tag', 'A'), value('asset_tag', 'B')] })] });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/same custom field or warranty field/i);
    }
    expect(previewMock).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('rejects a row that maps the same WARRANTY field twice', async () => {
    const warranty = (v: string) => ({ target: { kind: 'warranty', field: 'warrantyEndDate' }, value: v });
    const res = await post(PREVIEW, { rows: [row({ values: [warranty('2027-01-01'), warranty('2028-01-01')] })] });
    expect(res.status).toBe(400);
  });

  it('accepts two DIFFERENT warranty fields on one row', async () => {
    const res = await post(PREVIEW, {
      rows: [row({ values: [
        { target: { kind: 'warranty', field: 'warrantyEndDate' }, value: '2027-01-01' },
        { target: { kind: 'warranty', field: 'manufacturer' }, value: 'Dell' },
      ] })],
    });
    expect(res.status).toBe(200);
  });

  it('rejects an unknown mapping kind', async () => {
    const res = await post(PREVIEW, {
      rows: [row({ values: [{ target: { kind: 'tags', fieldKey: 'x' }, value: 'y' }] })],
    });
    expect(res.status).toBe(400);
  });

  it('rejects an ambiguous acknowledgement with no expectedDeviceId at the wire', async () => {
    const res = await post(COMMIT, { rows: [row({ expectedOutcome: 'ambiguous' })] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expectedDeviceId/i);
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('accepts an ambiguous acknowledgement that carries the pin', async () => {
    const res = await post(COMMIT, { rows: [row({ expectedOutcome: 'ambiguous', expectedDeviceId: DEVICE })] });
    expect(res.status).toBe(200);
  });

  it('STRIPS an acknowledgement field on the PREVIEW route rather than honouring it', async () => {
    // Preview is advisory and writes nothing. The preview row schema has no
    // acknowledgement fields, so zod removes them — the service can never see a
    // pin from this route and therefore cannot silently apply one.
    const res = await post(PREVIEW, { rows: [row({ expectedDeviceId: DEVICE, expectedOutcome: 'ambiguous' })] });

    expect(res.status).toBe(200);
    expect(previewMock.mock.calls[0]![0][0]).not.toHaveProperty('expectedDeviceId');
    expect(previewMock.mock.calls[0]![0][0]).not.toHaveProperty('expectedOutcome');
  });
});

describe('POST /devices/custom-fields/import — response contract', () => {
  it('returns 200 with a partial summary, never a failure body', async () => {
    commitMock.mockResolvedValue({
      appliedValues: 28,
      skippedValues: 0,
      failedValues: 2,
      linksCreated: 1,
      rows: [{
        index: 0, deviceId: DEVICE, organizationId: ORG, method: 'hostname', externalSystem: 'datto_rmm',
        applied: 28, skipped: 0, failed: 2, appliedFieldKeys: ['asset_tag'], warranty: 'applied', linkCreated: true,
      }],
      errors: [{ index: 1, error: 'No device in reach matches the identifiers on this row', code: 'not-found' }],
    });

    const res = await post(COMMIT, { rows: [row(), row({ hostname: 'ghost' })] });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ appliedValues: 28, linksCreated: 1 });
    expect(body.errors[0]).toMatchObject({ code: 'not-found' });
    expect(body).not.toHaveProperty('success');
  });

  it('writes the audits from the summary, carrying the batch row count', async () => {
    await post(COMMIT, { rows: [row(), row()], externalSystem: 'datto_rmm' });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1]).toMatchObject({ rowCount: 2, externalSystem: 'datto_rmm' });
  });

  it('still returns the summary when the audit fan-out throws', async () => {
    // The rows are already committed by then. A 500 here would describe a
    // request that in fact succeeded.
    auditMock.mockImplementation(() => { throw new Error('audit down'); });
    const res = await post(COMMIT, { rows: [row()] });
    expect(res.status).toBe(200);
  });

  it('preview writes nothing and never audits', async () => {
    await post(PREVIEW, { rows: [row()] });
    expect(commitMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});
