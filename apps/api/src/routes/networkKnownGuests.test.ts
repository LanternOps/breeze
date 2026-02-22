import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  networkKnownGuests: {
    id: 'id',
    partnerId: 'partner_id',
    macAddress: 'mac_address',
    label: 'label',
    notes: 'notes',
    addedBy: 'added_by',
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'partner',
      partnerId: 'partner-123',
      orgId: null,
      user: { id: 'user-123', email: 'partner@example.com', name: 'Partner User' },
      accessibleOrgIds: [],
      canAccessOrg: () => false
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { networkKnownGuestsRoutes } from './networkKnownGuests';

describe('networkKnownGuests routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'partner',
        partnerId: 'partner-123',
        orgId: null,
        user: { id: 'user-123', email: 'partner@example.com', name: 'Partner User' },
        accessibleOrgIds: [],
        canAccessOrg: () => false
      });
      return next();
    });
    app = new Hono();
    app.route('/partner/known-guests', networkKnownGuestsRoutes);
  });

  describe('GET /partner/known-guests', () => {
    it('returns 403 when no partnerId on auth context', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'system',
          partnerId: null,
          orgId: null,
          user: { id: 'user-123', email: 'sys@example.com', name: 'System User' },
          accessibleOrgIds: null,
          canAccessOrg: () => true
        });
        return next();
      });

      const res = await app.request('/partner/known-guests', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Partner context required');
    });

    it('returns list of guests for authenticated partner', async () => {
      const now = new Date();
      const guests = [
        {
          id: 'guest-1',
          partnerId: 'partner-123',
          macAddress: 'aa:bb:cc:dd:ee:ff',
          label: 'Office Printer',
          notes: null,
          addedBy: 'user-123',
          createdAt: now,
          updatedAt: now
        },
        {
          id: 'guest-2',
          partnerId: 'partner-123',
          macAddress: '11:22:33:44:55:66',
          label: 'Conference Room TV',
          notes: 'Room 2B',
          addedBy: 'user-123',
          createdAt: now,
          updatedAt: now
        }
      ];

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(guests)
          })
        })
      } as any);

      const res = await app.request('/partner/known-guests', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data[0].macAddress).toBe('aa:bb:cc:dd:ee:ff');
      expect(body.data[1].label).toBe('Conference Room TV');
    });
  });

  describe('POST /partner/known-guests', () => {
    it('returns 400 for invalid MAC address format', async () => {
      const res = await app.request('/partner/known-guests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          macAddress: 'not-a-mac',
          label: 'Test Device'
        })
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for MAC with wrong separator', async () => {
      const res = await app.request('/partner/known-guests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          macAddress: 'AA-BB-CC-DD-EE-FF',
          label: 'Test Device'
        })
      });

      expect(res.status).toBe(400);
    });

    it('normalizes MAC address to lowercase before insert', async () => {
      const now = new Date();
      const insertedGuest = {
        id: 'guest-1',
        partnerId: 'partner-123',
        macAddress: 'aa:bb:cc:dd:ee:ff',
        label: 'Test Device',
        notes: null,
        addedBy: 'user-123',
        createdAt: now,
        updatedAt: now
      };

      const mockReturning = vi.fn().mockResolvedValue([insertedGuest]);
      const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
      vi.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

      const res = await app.request('/partner/known-guests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          macAddress: 'AA:BB:CC:DD:EE:FF',
          label: 'Test Device'
        })
      });

      expect(res.status).toBe(201);
      // Verify the values call received a lowercase MAC
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({ macAddress: 'aa:bb:cc:dd:ee:ff' })
      );
      const body = await res.json();
      expect(body.data.macAddress).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('creates a guest with notes', async () => {
      const now = new Date();
      const insertedGuest = {
        id: 'guest-1',
        partnerId: 'partner-123',
        macAddress: 'aa:bb:cc:dd:ee:ff',
        label: 'Office Printer',
        notes: 'Floor 3',
        addedBy: 'user-123',
        createdAt: now,
        updatedAt: now
      };

      const mockReturning = vi.fn().mockResolvedValue([insertedGuest]);
      const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
      vi.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

      const res = await app.request('/partner/known-guests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          macAddress: 'aa:bb:cc:dd:ee:ff',
          label: 'Office Printer',
          notes: 'Floor 3'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.notes).toBe('Floor 3');
    });

    it('returns 409 on duplicate MAC for same partner', async () => {
      const mockReturning = vi.fn().mockRejectedValue(
        Object.assign(new Error('unique constraint'), { code: '23505' })
      );
      const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
      vi.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

      const res = await app.request('/partner/known-guests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          macAddress: 'aa:bb:cc:dd:ee:ff',
          label: 'Duplicate Device'
        })
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('This MAC address is already in your known guests list');
    });

    it('returns 403 when no partnerId on auth context', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'system',
          partnerId: null,
          orgId: null,
          user: { id: 'user-123', email: 'sys@example.com', name: 'System User' },
          accessibleOrgIds: null,
          canAccessOrg: () => true
        });
        return next();
      });

      const res = await app.request('/partner/known-guests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          macAddress: 'aa:bb:cc:dd:ee:ff',
          label: 'Test Device'
        })
      });

      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /partner/known-guests/:id', () => {
    it('returns 404 when guest does not belong to partner', async () => {
      const mockReturning = vi.fn().mockResolvedValue([]);
      const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
      vi.mocked(db.delete).mockReturnValue({ where: mockWhere } as any);

      const res = await app.request('/partner/known-guests/guest-999', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Not found');
    });

    it('removes a guest successfully', async () => {
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'guest-1' }]);
      const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
      vi.mocked(db.delete).mockReturnValue({ where: mockWhere } as any);

      const res = await app.request('/partner/known-guests/guest-1', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('returns 403 when no partnerId on auth context', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'system',
          partnerId: null,
          orgId: null,
          user: { id: 'user-123', email: 'sys@example.com', name: 'System User' },
          accessibleOrgIds: null,
          canAccessOrg: () => true
        });
        return next();
      });

      const res = await app.request('/partner/known-guests/guest-1', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
    });
  });
});
