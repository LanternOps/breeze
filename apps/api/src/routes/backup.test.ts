import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { backupRoutes } from './backup';

// Mock all services
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
  backupConfigs: {},
  backupPolicies: {},
  backupJobs: {},
  backupSnapshots: {},
  restoreJobs: {}
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
  })
}));

describe('backup routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/backup', backupRoutes);
  });

  it('should create, update, and test backup configuration', async () => {
    const createRes = await app.request('/backup/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        name: 'Archive S3',
        provider: 's3',
        enabled: true,
        details: { bucket: 'archive-bucket', region: 'us-west-2' }
      })
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.id).toBeDefined();
    expect(created.name).toBe('Archive S3');
    expect(created.details.bucket).toBe('archive-bucket');

    const updateRes = await app.request(`/backup/configs/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        enabled: false,
        details: { storageClass: 'GLACIER' }
      })
    });

    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.enabled).toBe(false);
    expect(updated.details.storageClass).toBe('GLACIER');
    expect(updated.details.bucket).toBe('archive-bucket');

    const testRes = await app.request(`/backup/configs/${created.id}/test`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(testRes.status).toBe(200);
    const tested = await testRes.json();
    expect(tested.status).toBe('success');
    expect(tested.checkedAt).toBeDefined();
  });

  it('should create a policy and report scheduling status', async () => {
    const policyRes = await app.request('/backup/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        name: 'Weekly Servers',
        configId: 'cfg-s3-primary',
        enabled: true,
        targets: {
          deviceIds: ['dev-sched-1'],
          siteIds: [],
          groupIds: []
        },
        schedule: {
          frequency: 'weekly',
          time: '04:15',
          timezone: 'UTC',
          dayOfWeek: 2
        },
        retention: {
          keepDaily: 5,
          keepWeekly: 6,
          keepMonthly: 2
        }
      })
    });

    expect(policyRes.status).toBe(201);
    const policy = await policyRes.json();
    expect(policy.id).toBeDefined();
    expect(policy.schedule.frequency).toBe('weekly');

    const statusRes = await app.request('/backup/status/dev-sched-1', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(statusRes.status).toBe(200);
    const status = await statusRes.json();
    expect(status.data.protected).toBe(true);
    expect(status.data.policyId).toBe(policy.id);
    expect(status.data.nextScheduledAt).toBeDefined();
  });

  it('should queue and fetch a restore job', async () => {
    const restoreRes = await app.request('/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        snapshotId: 'snap-001',
        deviceId: 'dev-001',
        targetPath: '/var/restore'
      })
    });

    expect(restoreRes.status).toBe(201);
    const restore = await restoreRes.json();
    expect(restore.status).toBe('queued');
    expect(restore.progress).toBe(0);

    const fetchRes = await app.request(`/backup/restore/${restore.id}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(fetchRes.status).toBe(200);
    const fetched = await fetchRes.json();
    expect(fetched.id).toBe(restore.id);
    expect(fetched.snapshotId).toBe('snap-001');
  });
});
