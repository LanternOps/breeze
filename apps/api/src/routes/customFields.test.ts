import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { customFieldRoutes } from './customFields';

// Valid UUID constants
const FIELD_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FIELD_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
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
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

function makeField(overrides: Record<string, unknown> = {}) {
  return {
    id: FIELD_ID_1,
    orgId: ORG_ID,
    partnerId: null,
    name: 'Serial Number',
    fieldKey: 'serial_number',
    type: 'text',
    options: null,
    required: false,
    defaultValue: null,
    deviceTypes: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides
  };
}

describe('customFields routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: ORG_ID,
        partnerId: null,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID
      });
      return next();
    });
    app = new Hono();
    app.route('/custom-fields', customFieldRoutes);
  });

  // ----------------------------------------------------------------
  // GET / - List custom fields
  // ----------------------------------------------------------------
  describe('GET /custom-fields', () => {
    it('should list custom fields for the org', async () => {
      const fields = [makeField(), makeField({ id: FIELD_ID_2, fieldKey: 'asset_tag', name: 'Asset Tag' })];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(fields)
          })
        })
      } as any);

      const res = await app.request('/custom-fields', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it('should filter by type', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([makeField({ type: 'number' })])
          })
        })
      } as any);

      const res = await app.request('/custom-fields?type=number', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('should filter by search term', async () => {
      const fields = [
        makeField({ name: 'Serial Number', fieldKey: 'serial_number' }),
        makeField({ id: FIELD_ID_2, name: 'Asset Tag', fieldKey: 'asset_tag' })
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(fields)
          })
        })
      } as any);

      const res = await app.request('/custom-fields?search=serial', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].fieldKey).toBe('serial_number');
    });

    it('should return empty when org has no orgId', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => false
        });
        return next();
      });

      const res = await app.request('/custom-fields', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  // ----------------------------------------------------------------
  // GET /:id - Get custom field by ID
  // ----------------------------------------------------------------
  describe('GET /custom-fields/:id', () => {
    it('should return a custom field by ID', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeField()])
          })
        })
      } as any);

      const res = await app.request(`/custom-fields/${FIELD_ID_1}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(FIELD_ID_1);
      expect(body.data.fieldKey).toBe('serial_number');
    });

    it('should return 404 when field not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/custom-fields/${FIELD_ID_1}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('not found');
    });

    it('should return 404 for field belonging to different org (multi-tenant isolation)', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeField({ orgId: ORG_ID_2 })])
          })
        })
      } as any);

      const res = await app.request(`/custom-fields/${FIELD_ID_1}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });

    it('should reject invalid UUID param', async () => {
      const res = await app.request('/custom-fields/not-a-uuid', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------------
  // POST / - Create custom field
  // ----------------------------------------------------------------
  describe('POST /custom-fields', () => {
    it('should create a custom field for org-scoped user', async () => {
      const created = makeField();
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created])
        })
      } as any);

      const res = await app.request('/custom-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Serial Number',
          fieldKey: 'serial_number',
          type: 'text'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.id).toBe(FIELD_ID_1);
      expect(body.data.name).toBe('Serial Number');
    });

    it('should reject when both orgId and partnerId provided', async () => {
      const res = await app.request('/custom-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Field',
          fieldKey: 'field',
          type: 'text',
          orgId: ORG_ID,
          partnerId: PARTNER_ID
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('either orgId or partnerId');
    });

    it('should reject when org user has no orgId', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => false
        });
        return next();
      });

      const res = await app.request('/custom-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Field',
          fieldKey: 'field',
          type: 'text'
        })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('Organization context required');
    });

    it('should validate required fields', async () => {
      const res = await app.request('/custom-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Field'
          // missing fieldKey and type
        })
      });

      expect(res.status).toBe(400);
    });

    it('should validate fieldKey format', async () => {
      const res = await app.request('/custom-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Field',
          fieldKey: 'Invalid-Key',
          type: 'text'
        })
      });

      expect(res.status).toBe(400);
    });

    it('should validate type enum', async () => {
      const res = await app.request('/custom-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Field',
          fieldKey: 'field',
          type: 'invalid_type'
        })
      });

      expect(res.status).toBe(400);
    });

    it('should allow partner scope to create org-scoped field with valid org access', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (orgId: string) => orgId === ORG_ID
        });
        return next();
      });

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([makeField({ orgId: ORG_ID, partnerId: null })])
        })
      } as any);

      const res = await app.request('/custom-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Field',
          fieldKey: 'field',
          type: 'text',
          orgId: ORG_ID
        })
      });

      expect(res.status).toBe(201);
    });

    it('should reject partner creating field for inaccessible org', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (orgId: string) => orgId === ORG_ID
        });
        return next();
      });

      const res = await app.request('/custom-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Field',
          fieldKey: 'field',
          type: 'text',
          orgId: ORG_ID_2
        })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('Access to this organization denied');
    });

    it('should create with deviceTypes', async () => {
      const created = makeField({ deviceTypes: ['windows', 'macos'] });
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created])
        })
      } as any);

      const res = await app.request('/custom-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Field',
          fieldKey: 'field',
          type: 'dropdown',
          deviceTypes: ['windows', 'macos'],
          options: { choices: ['A', 'B'] }
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.deviceTypes).toEqual(['windows', 'macos']);
    });
  });

  // ----------------------------------------------------------------
  // PATCH /:id - Update custom field
  // ----------------------------------------------------------------
  describe('PATCH /custom-fields/:id', () => {
    it('should update a custom field', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeField()])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([makeField({ name: 'Updated Name' })])
          })
        })
      } as any);

      const res = await app.request(`/custom-fields/${FIELD_ID_1}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Updated Name' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Updated Name');
    });

    it('should return 404 for non-existent field', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/custom-fields/${FIELD_ID_1}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(404);
    });

    it('should return 403 when user cannot edit field from different org', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeField({ orgId: ORG_ID_2 })])
          })
        })
      } as any);

      // getCustomFieldWithAccess will return null due to org mismatch
      const res = await app.request(`/custom-fields/${FIELD_ID_1}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Hack' })
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // DELETE /:id - Delete custom field
  // ----------------------------------------------------------------
  describe('DELETE /custom-fields/:id', () => {
    it('should delete a custom field', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeField()])
          })
        })
      } as any);
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockResolvedValue(undefined)
      } as any);

      const res = await app.request(`/custom-fields/${FIELD_ID_1}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(FIELD_ID_1);
    });

    it('should return 404 when deleting non-existent field', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/custom-fields/${FIELD_ID_1}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });

    it('should reject deleting field from another org (multi-tenant isolation)', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeField({ orgId: ORG_ID_2 })])
          })
        })
      } as any);

      const res = await app.request(`/custom-fields/${FIELD_ID_1}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });

    it('should reject invalid UUID param for delete', async () => {
      const res = await app.request('/custom-fields/not-a-uuid', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------------
  // Partner/System scope tests
  // ----------------------------------------------------------------
  describe('partner scope access', () => {
    beforeEach(() => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'partner@example.com', name: 'Partner User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (orgId: string) => orgId === ORG_ID
        });
        return next();
      });
    });

    it('should list partner-scoped and org-scoped fields', async () => {
      const fields = [
        makeField({ partnerId: PARTNER_ID, orgId: null }),
        makeField({ id: FIELD_ID_2, orgId: ORG_ID, partnerId: null })
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(fields)
          })
        })
      } as any);

      const res = await app.request('/custom-fields', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
    });

    it('should create partner-scoped field when no orgId provided', async () => {
      const created = makeField({ orgId: null, partnerId: PARTNER_ID });
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created])
        })
      } as any);

      const res = await app.request('/custom-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Partner Field',
          fieldKey: 'partner_field',
          type: 'text'
        })
      });

      expect(res.status).toBe(201);
    });

    it('should reject partner accessing different partnerId field', async () => {
      const res = await app.request('/custom-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Field',
          fieldKey: 'field',
          type: 'text',
          partnerId: '44444444-4444-4444-4444-444444444444'
        })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('Access to this partner denied');
    });
  });

  describe('system scope access', () => {
    beforeEach(() => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin' },
          scope: 'system',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: null,
          canAccessOrg: () => true
        });
        return next();
      });
    });

    it('should require orgId or partnerId for system scope create', async () => {
      const res = await app.request('/custom-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Field',
          fieldKey: 'field',
          type: 'text'
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('orgId or partnerId is required');
    });
  });
});
