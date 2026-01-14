import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { reportRoutes } from './reports';

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
        where: vi.fn(() => Promise.resolve())
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve())
    }))
  }
}));

vi.mock('../db/schema', () => ({
  reports: {},
  reportRuns: {},
  devices: {},
  deviceSoftware: {},
  deviceMetrics: {},
  deviceHardware: {},
  alerts: {},
  alertRules: {},
  organizations: {},
  sites: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-123'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

import { db } from '../db';

describe('reports routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/reports', reportRoutes);
  });

  it('should generate a saved report run', async () => {
    vi.useFakeTimers();
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'report-1',
            orgId: 'org-123',
            name: 'Device Inventory',
            type: 'device_inventory',
            schedule: 'daily',
            format: 'csv'
          }])
        })
      })
    } as any);

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: 'run-1',
          reportId: 'report-1',
          status: 'pending'
        }])
      })
    } as any);

    const res = await app.request('/reports/report-1/generate', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBe('run-1');
    expect(body.status).toBe('pending');

    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('should update a report schedule', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'report-1',
            orgId: 'org-123',
            name: 'Ops Summary',
            schedule: 'monthly'
          }])
        })
      })
    } as any);

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'report-1',
            schedule: 'weekly'
          }])
        })
      })
    } as any);

    const res = await app.request('/reports/report-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({ schedule: 'weekly' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedule).toBe('weekly');
  });

  it('should return run details with export URL', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'run-1',
                reportId: 'report-1',
                status: 'completed',
                startedAt: new Date('2024-01-01T00:00:00Z'),
                completedAt: new Date('2024-01-01T00:01:00Z'),
                outputUrl: '/api/reports/runs/run-1/download',
                errorMessage: null,
                rowCount: 12,
                createdAt: new Date('2024-01-01T00:00:00Z'),
                orgId: 'org-123'
              }])
            })
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'report-1',
              name: 'Device Inventory',
              type: 'device_inventory',
              format: 'csv'
            }])
          })
        })
      } as any);

    const res = await app.request('/reports/runs/run-1', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outputUrl).toBe('/api/reports/runs/run-1/download');
    expect(body.report?.id).toBe('report-1');
  });
});
