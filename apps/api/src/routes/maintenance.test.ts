import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { maintenanceRoutes } from './maintenance';

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve())
    }))
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn())
}));

vi.mock('../db/schema/maintenance', () => ({
  maintenanceWindows: { id: 'id', orgId: 'orgId', partnerId: 'partnerId' },
  maintenanceOccurrences: {}
}));

vi.mock('../db/schema/orgs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/schema/orgs')>()),
  organizations: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-123',
      token: { sub: 'user-123' },
      canAccessOrg: (orgId: string) => orgId === 'org-123'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';

const PARTNER_ID = 'partner-1';

describe('maintenance routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        partnerId: null,
        orgId: 'org-123',
        token: { sub: 'user-123' },
        canAccessOrg: (orgId: string) => orgId === 'org-123'
      });
      return next();
    });
    app = new Hono();
    app.route('/maintenance', maintenanceRoutes);
  });

  it('should list maintenance windows', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([
            { id: 'win-1', orgId: 'org-123', name: 'Monthly Patch', status: 'scheduled' }
          ])
        })
      })
    } as any);

    const res = await app.request('/maintenance/windows', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('win-1');
  });

  it('should create a maintenance window and schedule occurrences', async () => {
    const createdWindow = {
      id: 'win-1',
      orgId: 'org-123',
      name: 'Weekly Maintenance',
      status: 'scheduled'
    };
    const occurrencesValues = vi.fn().mockResolvedValue(undefined);

    vi.mocked(db.insert)
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([createdWindow])
        })
      } as any)
      .mockReturnValueOnce({
        values: occurrencesValues
      } as any);

    const res = await app.request('/maintenance/windows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({
        name: 'Weekly Maintenance',
        description: 'Server updates',
        startTime: '2024-01-01T10:00:00.000Z',
        endTime: '2024-01-01T12:00:00.000Z',
        timezone: 'UTC',
        recurrence: 'once',
        targetType: 'all',
        suppressAlerts: true,
        suppressPatches: true,
        suppressAutomations: false,
        notifyOnStart: false,
        notifyOnEnd: false
      })
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('win-1');
    const firstCall = occurrencesValues.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error('Expected occurrence insert call');
    }
    const occurrencesPayload = firstCall[0];
    expect(occurrencesPayload).toHaveLength(1);
    expect(occurrencesPayload[0].windowId).toBe('win-1');
  });

  it('should get a maintenance window with upcoming occurrences', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'win-1',
              orgId: 'org-123',
              name: 'Maintenance Window'
            }])
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                { id: 'occ-1', status: 'scheduled' }
              ])
            })
          })
        })
      } as any);

    const res = await app.request('/maintenance/windows/win-1', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('win-1');
    expect(body.upcomingOccurrences).toHaveLength(1);
  });

  it('should update a maintenance window', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'win-1',
            orgId: 'org-123',
            name: 'Old Name'
          }])
        })
      })
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'win-1',
            name: 'New Name'
          }])
        })
      })
    } as any);

    const res = await app.request('/maintenance/windows/win-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({ name: 'New Name' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('New Name');
  });

  // Regression guard for #3256: `notifyBefore` / `notifyOnStart` / `notifyOnEnd`
  // were accepted and persisted but never read by anything, so a window promised
  // notifications it never sent. They are off the write surface now. These tests
  // fail if the fields are wired back into the request schemas without a real
  // consumer landing first.
  describe('retired notification fields (#3256)', () => {
    it('should not persist notifyBefore/notifyOnStart/notifyOnEnd on create', async () => {
      const occurrencesValues = vi.fn().mockResolvedValue(undefined);
      const windowValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'win-1', orgId: 'org-123', name: 'W', status: 'scheduled' }])
      });
      vi.mocked(db.insert)
        .mockReturnValueOnce({ values: windowValues } as any)
        .mockReturnValueOnce({ values: occurrencesValues } as any);

      const res = await app.request('/maintenance/windows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          name: 'W',
          startTime: '2024-01-01T10:00:00.000Z',
          endTime: '2024-01-01T12:00:00.000Z',
          timezone: 'UTC',
          recurrence: 'once',
          targetType: 'all',
          notifyBefore: 30,
          notifyOnStart: true,
          notifyOnEnd: true
        })
      });

      // Still a 201: the keys are stripped, not rejected, so existing clients
      // that send them keep working.
      expect(res.status).toBe(201);

      const insertCall = windowValues.mock.calls[0];
      if (!insertCall) throw new Error('Expected window insert call');
      const inserted = insertCall[0] as Record<string, unknown>;
      expect(inserted).not.toHaveProperty('notifyBefore');
      expect(inserted).not.toHaveProperty('notifyOnStart');
      expect(inserted).not.toHaveProperty('notifyOnEnd');
      // The rest of the payload is untouched.
      expect(inserted).toMatchObject({ orgId: 'org-123', name: 'W' });
    });

    it('should not write notifyBefore/notifyOnStart/notifyOnEnd on update', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'win-1', orgId: 'org-123', name: 'Old Name' }])
          })
        })
      } as any);
      const setSpy = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'win-1', name: 'New Name' }])
        })
      });
      vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

      const res = await app.request('/maintenance/windows/win-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ name: 'New Name', notifyBefore: 30, notifyOnStart: true, notifyOnEnd: true })
      });

      expect(res.status).toBe(200);
      const setCall = setSpy.mock.calls[0];
      if (!setCall) throw new Error('Expected update set call');
      const updated = setCall[0] as Record<string, unknown>;
      expect(updated).not.toHaveProperty('notifyBefore');
      expect(updated).not.toHaveProperty('notifyOnStart');
      expect(updated).not.toHaveProperty('notifyOnEnd');
      expect(updated).toMatchObject({ name: 'New Name' });
    });

    it('should reject an update that carries only retired notification fields', async () => {
      const res = await app.request('/maintenance/windows/win-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ notifyBefore: 30, notifyOnStart: true })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('No updates provided');
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  it('should delete a maintenance window and future occurrences', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'win-1',
            orgId: 'org-123'
          }])
        })
      })
    } as any);
    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined)
    } as any);

    const res = await app.request('/maintenance/windows/win-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('should cancel a maintenance window and occurrences', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'win-1',
            orgId: 'org-123',
            status: 'scheduled'
          }])
        })
      })
    } as any);
    vi.mocked(db.update)
      .mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'win-1',
              status: 'cancelled'
            }])
          })
        })
      } as any)
      .mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

    const res = await app.request('/maintenance/windows/win-1/cancel', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('cancelled');
  });

  it('should list occurrences for a window', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'win-1',
              orgId: 'org-123'
            }])
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              { id: 'occ-1', windowId: 'win-1' }
            ])
          })
        })
      } as any);

    const res = await app.request('/maintenance/windows/win-1/occurrences', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  it('should list occurrences for calendar view', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: 'win-1' }
          ])
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([
                {
                  occurrence: { id: 'occ-1', windowId: 'win-1' },
                  window: { id: 'win-1', name: 'Window', targetType: 'all' }
                }
              ])
            })
          })
        })
      } as any);

    const res = await app.request('/maintenance/occurrences', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].window.id).toBe('win-1');
  });

  it('should update an occurrence with overrides', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              occurrence: { id: 'occ-1', overrides: {} },
              window: { id: 'win-1', orgId: 'org-123' }
            }])
          })
        })
      })
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'occ-1',
            notes: 'Adjusted'
          }])
        })
      })
    } as any);

    const res = await app.request('/maintenance/occurrences/occ-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({ notes: 'Adjusted' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notes).toBe('Adjusted');
  });

  it('should start and end an occurrence', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                occurrence: { id: 'occ-1', status: 'scheduled' },
                window: { id: 'win-1', orgId: 'org-123' }
              }])
            })
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                occurrence: { id: 'occ-1', status: 'active' },
                window: { id: 'win-1', orgId: 'org-123' }
              }])
            })
          })
        })
      } as any);
    vi.mocked(db.update)
      .mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'occ-1',
              status: 'active'
            }])
          })
        })
      } as any)
      .mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'occ-1',
              status: 'completed'
            }])
          })
        })
      } as any);

    const startRes = await app.request('/maintenance/occurrences/occ-1/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' }
    });
    expect(startRes.status).toBe(200);
    const startBody = await startRes.json();
    expect(startBody.status).toBe('active');

    const endRes = await app.request('/maintenance/occurrences/occ-1/end', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' }
    });
    expect(endRes.status).toBe(200);
    const endBody = await endRes.json();
    expect(endBody.status).toBe('completed');
  });

  it.skip('should return active windows for a device', async () => {
    // Skipped: Complex date/time mock required
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{
            id: 'win-1',
            orgId: 'org-123',
            name: 'Device Window',
            targetType: 'device',
            deviceIds: ['device-1'],
            suppressAlerts: true,
            suppressPatching: true,
            suppressAutomations: false
          }])
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{
              occurrence: { id: 'occ-1', status: 'active' },
              window: {
                id: 'win-1',
                name: 'Device Window',
                targetType: 'device',
                deviceIds: ['device-1'],
                suppressAlerts: true,
                suppressPatching: true,
                suppressAutomations: false
              }
            }])
          })
        })
      } as any);

    const res = await app.request('/maintenance/active?deviceId=device-1', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].window.id).toBe('win-1');
  });

  // ----------------------------------------------------------------
  // Partner-wide dual-ownership gate (#2131): a maintenance window with
  // orgId null + partnerId set is only mutable by a caller with
  // canManagePartnerWidePolicies(auth) === true (system scope, or partner
  // scope with partnerOrgAccess === 'all'). PR review flagged these 403s as
  // unit-untested — only real-DB integration suites (not run in the
  // required CI job) covered them.
  // ----------------------------------------------------------------
  describe('partner-wide dual-ownership gate', () => {
    it('should return 403 patching a partner-wide window when the partner caller lacks partnerOrgAccess=all', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-partner', email: 'partner@example.com', name: 'Partner User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          partnerOrgAccess: 'selected',
          token: { sub: 'user-partner' },
          canAccessOrg: () => true
        });
        return next();
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'win-1',
              orgId: null,
              partnerId: PARTNER_ID,
              name: 'Partner-wide Window'
            }])
          })
        })
      } as any);

      const res = await app.request('/maintenance/windows/win-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ name: 'New Name' })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('should return 403 creating a partner-wide window without the partner-wide capability', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-partner', email: 'partner@example.com', name: 'Partner User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          partnerOrgAccess: 'selected',
          token: { sub: 'user-partner' },
          canAccessOrg: () => true
        });
        return next();
      });

      const res = await app.request('/maintenance/windows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          ownerScope: 'partner',
          name: 'Partner-wide Maintenance',
          startTime: '2024-01-01T10:00:00.000Z',
          endTime: '2024-01-01T12:00:00.000Z',
          timezone: 'UTC',
          recurrence: 'once',
          targetType: 'all',
          suppressAlerts: true,
          suppressPatches: true,
          suppressAutomations: false,
          notifyOnStart: false,
          notifyOnEnd: false
        })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('should create a partner-wide window with orgId null and partnerId set when the caller has partnerOrgAccess=all', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-partner', email: 'partner@example.com', name: 'Partner User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          partnerOrgAccess: 'all',
          token: { sub: 'user-partner' },
          canAccessOrg: () => true
        });
        return next();
      });

      const createdWindow = {
        id: 'win-1',
        orgId: null,
        partnerId: PARTNER_ID,
        name: 'Partner-wide Maintenance',
        status: 'scheduled'
      };
      const occurrencesValues = vi.fn().mockResolvedValue(undefined);
      const windowValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([createdWindow])
      });

      vi.mocked(db.insert)
        .mockReturnValueOnce({ values: windowValues } as any)
        .mockReturnValueOnce({ values: occurrencesValues } as any);

      const res = await app.request('/maintenance/windows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          ownerScope: 'partner',
          name: 'Partner-wide Maintenance',
          startTime: '2024-01-01T10:00:00.000Z',
          endTime: '2024-01-01T12:00:00.000Z',
          timezone: 'UTC',
          recurrence: 'once',
          targetType: 'all',
          suppressAlerts: true,
          suppressPatches: true,
          suppressAutomations: false,
          notifyOnStart: false,
          notifyOnEnd: false
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('win-1');

      const insertCall = windowValues.mock.calls[0];
      expect(insertCall).toBeDefined();
      if (!insertCall) {
        throw new Error('Expected window insert call');
      }
      expect(insertCall[0]).toMatchObject({
        orgId: null,
        partnerId: PARTNER_ID
      });
    });
  });

  // ==========================================================================
  // Site-scope enforcement (#3654)
  //
  // `allowedSiteIds` is an app-layer authz axis that Postgres RLS does NOT
  // defend. Before this suite, every maintenance-window write gated on org +
  // partner-wide capability only, so a technician restricted to Site A could
  // re-time or delete a window that another site's software deployment was
  // bound to (`softwareDeploymentScheduler.isMaintenanceWindowOpen`).
  // ==========================================================================
  describe('site-scope enforcement (#3654)', () => {
    const SITE_A = '11111111-1111-4111-8111-111111111111';
    const SITE_B = '22222222-2222-4222-8222-222222222222';
    const DEV_A = '33333333-3333-4333-8333-333333333333';
    const DEV_B = '44444444-4444-4444-8444-444444444444';
    const GRP_1 = '55555555-5555-4555-8555-555555555555';
    const UNBOUNDED_DENIED =
      'Site-restricted users cannot manage a maintenance window that targets all devices in the organization';
    const TARGET_DENIED = 'Access to one or more target sites denied';
    const UNRESOLVED_DENIED =
      'A site-restricted user must target at least one site they can access';
    const PARTNER_WIDE_DENIED =
      'Site-restricted users cannot manage partner-wide maintenance windows';

    /**
     * Chainable thenable that answers any Drizzle select shape used by these
     * routes (`.from().where()`, `.innerJoin()`, `.limit()`, `.orderBy()`) with
     * the same row batch.
     */
    function selectChain(rows: unknown[]): any {
      const chain: any = Promise.resolve(rows);
      chain.from = () => selectChain(rows);
      chain.innerJoin = () => selectChain(rows);
      chain.leftJoin = () => selectChain(rows);
      chain.where = () => selectChain(rows);
      chain.orderBy = () => selectChain(rows);
      chain.limit = () => Promise.resolve(rows);
      return chain;
    }

    /** Answer successive `db.select()` calls with successive row batches. */
    function queueSelects(...batches: unknown[][]) {
      let i = 0;
      vi.mocked(db.select).mockImplementation(((..._a: unknown[]) =>
        selectChain(batches[i++] ?? [])) as any);
    }

    /** Auth as an org user restricted to `siteIds` (undefined = unrestricted). */
    function authAsSiteRestricted(siteIds: string[] | undefined) {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          partnerId: null,
          orgId: 'org-123',
          token: { sub: 'user-123' },
          canAccessOrg: (orgId: string) => orgId === 'org-123'
        });
        // requirePermission is mocked to a pass-through in this file, so stand
        // in for the `c.set('permissions', ...)` it normally performs.
        c.set('permissions', {
          permissions: [],
          partnerId: null,
          orgId: 'org-123',
          roleId: 'role-1',
          scope: 'organization',
          allowedSiteIds: siteIds
        });
        return next();
      });
    }

    const baseWindowBody = {
      name: 'Weekly Maintenance',
      startTime: '2024-01-01T10:00:00.000Z',
      endTime: '2024-01-01T12:00:00.000Z',
      timezone: 'UTC',
      recurrence: 'once',
      suppressAlerts: true,
      suppressPatches: true,
      suppressAutomations: false
    };

    function post(body: Record<string, unknown>) {
      return app.request('/maintenance/windows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ ...baseWindowBody, ...body })
      });
    }

    function mockCreateSucceeds() {
      const created = { id: 'win-new', orgId: 'org-123', name: 'Weekly Maintenance', status: 'scheduled' };
      vi.mocked(db.insert)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([created]) })
        } as any)
        .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) } as any);
      return created;
    }

    // ---- POST /windows ----------------------------------------------------

    it('rejects a site-restricted create that targets ALL devices', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects();

      const res = await post({ targetType: 'all' });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(UNBOUNDED_DENIED);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects a site-restricted create that names an out-of-scope site', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects();

      const res = await post({ targetType: 'site', siteIds: [SITE_A, SITE_B] });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(TARGET_DENIED);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects a site-restricted create whose devices live in an out-of-scope site', async () => {
      authAsSiteRestricted([SITE_A]);
      // device lookup for the gate
      queueSelects([{ id: DEV_B, siteId: SITE_B }]);

      const res = await post({ targetType: 'device', deviceIds: [DEV_B] });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(TARGET_DENIED);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects a site-restricted create whose group spans the whole org (null siteId)', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects([{ id: GRP_1, siteId: null }]);

      const res = await post({ targetType: 'group', groupIds: [GRP_1] });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(TARGET_DENIED);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects a site-restricted create that resolves to no site at all', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects();

      const res = await post({ targetType: 'site', siteIds: [] });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(UNRESOLVED_DENIED);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('allows a site-restricted create confined to an in-scope site', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects();
      mockCreateSucceeds();

      const res = await post({ targetType: 'site', siteIds: [SITE_A] });

      expect(res.status).toBe(201);
      expect((await res.json()).id).toBe('win-new');
    });

    it('allows a site-restricted create whose devices are all in scope', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects([{ id: DEV_A, siteId: SITE_A }]);
      mockCreateSucceeds();

      const res = await post({ targetType: 'device', deviceIds: [DEV_A] });

      expect(res.status).toBe(201);
    });

    it('leaves an unrestricted caller free to create an all-devices window', async () => {
      authAsSiteRestricted(undefined);
      queueSelects();
      mockCreateSucceeds();

      const res = await post({ targetType: 'all' });

      expect(res.status).toBe(201);
    });

    it('denies a site-restricted caller with an empty site allowlist', async () => {
      // `organization_users.site_ids = '{}'` means "no sites", not "all sites".
      authAsSiteRestricted([]);
      queueSelects();

      const res = await post({ targetType: 'site', siteIds: [SITE_A] });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(TARGET_DENIED);
      expect(db.insert).not.toHaveBeenCalled();
    });

    // ---- PATCH /windows/:id (the headline exploit) ------------------------

    const siteBWindow = {
      id: 'win-b',
      orgId: 'org-123',
      partnerId: null,
      name: 'Site B patch night',
      status: 'scheduled',
      targetType: 'site',
      siteIds: [SITE_B],
      groupIds: null,
      deviceIds: null
    };
    const siteAWindow = { ...siteBWindow, id: 'win-a', name: 'Site A patch night', siteIds: [SITE_A] };
    const allWindow = { ...siteBWindow, id: 'win-all', name: 'Org-wide', targetType: 'all', siteIds: null };

    it('rejects re-timing another site’s window', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects([siteBWindow]);

      const res = await app.request('/maintenance/windows/win-b', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ startTime: '2024-06-01T09:00:00.000Z' })
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(TARGET_DENIED);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('rejects widening an in-scope window onto an out-of-scope site', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects([siteAWindow]);

      const res = await app.request('/maintenance/windows/win-a', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ siteIds: [SITE_A, SITE_B] })
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(TARGET_DENIED);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('rejects escalating an in-scope window to targetType all', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects([siteAWindow]);

      const res = await app.request('/maintenance/windows/win-a', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ targetType: 'all' })
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(UNBOUNDED_DENIED);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('allows editing a window confined to the caller’s own site', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects([siteAWindow]);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...siteAWindow, name: 'Renamed' }])
          })
        })
      } as any);

      const res = await app.request('/maintenance/windows/win-a', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ name: 'Renamed' })
      });

      expect(res.status).toBe(200);
      expect((await res.json()).name).toBe('Renamed');
    });

    // ---- DELETE / cancel --------------------------------------------------

    it('rejects deleting another site’s window', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects([siteBWindow]);

      const res = await app.request('/maintenance/windows/win-b', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(TARGET_DENIED);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('rejects deleting an org-wide window', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects([allWindow]);

      const res = await app.request('/maintenance/windows/win-all', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(UNBOUNDED_DENIED);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('rejects cancelling another site’s window', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects([siteBWindow]);

      const res = await app.request('/maintenance/windows/win-b/cancel', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(TARGET_DENIED);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('rejects mutating a partner-wide window', async () => {
      authAsSiteRestricted([SITE_A]);
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-p', email: 'p@example.com', name: 'P' },
          scope: 'partner',
          partnerId: PARTNER_ID,
          orgId: 'org-123',
          partnerOrgAccess: 'all',
          token: { sub: 'user-p' },
          canAccessOrg: () => true
        });
        c.set('permissions', {
          permissions: [], partnerId: PARTNER_ID, orgId: 'org-123',
          roleId: 'role-1', scope: 'organization', allowedSiteIds: [SITE_A]
        });
        return next();
      });
      queueSelects([{ ...siteAWindow, id: 'win-pw', orgId: null, partnerId: PARTNER_ID }]);

      const res = await app.request('/maintenance/windows/win-pw', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(PARTNER_WIDE_DENIED);
      expect(db.delete).not.toHaveBeenCalled();
    });

    // ---- occurrence mutations --------------------------------------------

    const siteBOccurrence = {
      occurrence: { id: 'occ-b', windowId: 'win-b', status: 'scheduled', overrides: {} },
      window: siteBWindow
    };

    it('rejects re-timing an occurrence of another site’s window', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects([siteBOccurrence]);

      const res = await app.request('/maintenance/occurrences/occ-b', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ startTime: '2024-06-01T09:00:00.000Z' })
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(TARGET_DENIED);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('rejects starting an occurrence of another site’s window early', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects([siteBOccurrence]);

      const res = await app.request('/maintenance/occurrences/occ-b/start', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(TARGET_DENIED);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('rejects ending an occurrence of another site’s window early', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects([{ ...siteBOccurrence, occurrence: { ...siteBOccurrence.occurrence, status: 'active' } }]);

      const res = await app.request('/maintenance/occurrences/occ-b/end', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(TARGET_DENIED);
      expect(db.update).not.toHaveBeenCalled();
    });

    // ---- reads ------------------------------------------------------------

    it('hides out-of-scope windows from GET /windows but keeps org-wide ones', async () => {
      authAsSiteRestricted([SITE_A]);
      // 1: the window list. No group/device ids present, so no follow-up query.
      queueSelects([siteAWindow, siteBWindow, allWindow]);

      const res = await app.request('/maintenance/windows', {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(200);
      const ids = (await res.json()).data.map((w: { id: string }) => w.id);
      // `all` windows genuinely suppress the caller's own devices, so they stay
      // visible (read = intersection) even though they are not mutable.
      expect(ids).toEqual(['win-a', 'win-all']);
    });

    it('404s a single out-of-scope window on GET /windows/:id', async () => {
      authAsSiteRestricted([SITE_A]);
      queueSelects([siteBWindow]);

      const res = await app.request('/maintenance/windows/win-b', {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(404);
    });

    it('leaves the window list untouched for an unrestricted caller', async () => {
      authAsSiteRestricted(undefined);
      queueSelects([siteAWindow, siteBWindow, allWindow]);

      const res = await app.request('/maintenance/windows', {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(200);
      expect((await res.json()).data).toHaveLength(3);
    });
  });
});
