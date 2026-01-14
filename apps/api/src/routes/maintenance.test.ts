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
  }
}));

vi.mock('../db/schema/maintenance', () => ({
  maintenanceWindows: {},
  maintenanceOccurrences: {}
}));

vi.mock('../db/schema/orgs', () => ({
  organizations: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-123',
      token: { sub: 'user-123' }
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

import { db } from '../db';

describe('maintenance routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
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
    const occurrencesPayload = occurrencesValues.mock.calls[0][0];
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
});
