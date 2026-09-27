import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { customFieldRoutes } from './customFields';
import { customFieldImportRoutes } from './customFieldImport';
import { SITE_CEILING_WRITE_DENIED_MESSAGE } from '../services/siteCeilingAccess';

/**
 * Site-ceiling gate on custom-field definition writes: a caller with a
 * defined site ceiling has no per-site ownership model to be narrowed into on
 * this table, so create/update/delete of a definition — including via the
 * bulk definitions importer — must refuse the same way the other org-wide
 * governance objects do.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const FIELD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../services/customFields/import/definitionImport', () => ({
  previewCustomFieldDefinitionImport: vi.fn(async () => []),
  commitCustomFieldDefinitionImport: vi.fn(async () => ({ created: [], errors: [] })),
}));

vi.mock('../services/customFields/import/audit', () => ({
  writeCustomFieldDefinitionImportAudits: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  customFieldDefinitions: {
    id: 'id',
    orgId: 'orgId',
    partnerId: 'partnerId',
    name: 'name',
    fieldKey: 'fieldKey',
    type: 'type',
    options: 'options',
    required: 'required',
    defaultValue: 'defaultValue',
    deviceTypes: 'deviceTypes',
    scriptWrite: 'scriptWrite',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
}));

let authOverrides: Record<string, unknown> = {};

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      ...authOverrides,
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { db } from '../db';

function fieldRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FIELD_ID,
    orgId: ORG_ID,
    partnerId: null,
    name: 'Serial Number',
    fieldKey: 'serial_number',
    type: 'text',
    options: null,
    required: false,
    defaultValue: null,
    deviceTypes: null,
    scriptWrite: false,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function mockSelectField() {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([fieldRow()]),
      }),
    }),
  } as any);
}

describe('custom field definition writes — site ceiling', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authOverrides = {};
    app = new Hono();
    app.route('/custom-fields', customFieldRoutes);
    app.route('/custom-fields', customFieldImportRoutes);
  });

  it('denies POST / for a site-restricted caller with no insert issued', async () => {
    authOverrides = { allowedSiteIds: [SITE_ID] };
    const res = await app.request('/custom-fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ name: 'Serial', fieldKey: 'serial', type: 'text' }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SITE_CEILING_WRITE_DENIED_MESSAGE });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('denies PATCH /:id for a site-restricted caller with no update issued', async () => {
    authOverrides = { allowedSiteIds: [] };
    const res = await app.request(`/custom-fields/${FIELD_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ name: 'Renamed' }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SITE_CEILING_WRITE_DENIED_MESSAGE });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('denies DELETE /:id for a site-restricted caller with no delete issued', async () => {
    authOverrides = { allowedSiteIds: [SITE_ID] };
    const res = await app.request(`/custom-fields/${FIELD_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SITE_CEILING_WRITE_DENIED_MESSAGE });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('denies POST /custom-fields/import for a site-restricted caller', async () => {
    authOverrides = { allowedSiteIds: [SITE_ID] };
    const res = await app.request('/custom-fields/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        rows: [
          {
            fieldKey: 'serial',
            name: 'Serial',
            type: 'text',
            ownerScope: 'organization',
            organizationId: ORG_ID,
          },
        ],
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SITE_CEILING_WRITE_DENIED_MESSAGE });
  });

  it('allows an unrestricted org caller through to the write layer', async () => {
    mockSelectField();
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([fieldRow({ name: 'Renamed' })]),
        }),
      }),
    } as any);

    const res = await app.request(`/custom-fields/${FIELD_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ name: 'Renamed' }),
    });

    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalled();
  });
});
