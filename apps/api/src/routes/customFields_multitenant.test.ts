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
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111'
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
