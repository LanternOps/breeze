import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { backupRoutes } from './backup';

// Valid UUID constants for tests
const CONFIG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const POLICY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SNAPSHOT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const RESTORE_ID = '11111111-1111-4111-8111-111111111111';

// Mock all services
vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../jobs/backupWorker', () => ({
  enqueueRestoreDispatch: vi.fn().mockResolvedValue(undefined),
}));

// Build a fully chainable db mock
function chainMock(resolvedValue: unknown = []) {
  const terminal = vi.fn(() => Promise.resolve(resolvedValue));
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'leftJoin', 'orderBy', 'groupBy', 'limit', 'returning', 'values', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  // Make the chain itself thenable
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
const deleteMock = vi.fn(() => chainMock([]));

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn())
}));

vi.mock('../db/schema', () => ({
  backupConfigs: {
    id: 'backup_configs.id',
    orgId: 'backup_configs.org_id',
    provider: 'backup_configs.provider',
  },
  backupPolicies: {
    id: 'backup_policies.id',
    orgId: 'backup_policies.org_id',
  },
  backupJobs: {
    id: 'backup_jobs.id',
    orgId: 'backup_jobs.org_id',
    deviceId: 'backup_jobs.device_id',
    status: 'backup_jobs.status',
    createdAt: 'backup_jobs.created_at',
  },
  backupSnapshots: {
    id: 'backup_snapshots.id',
    orgId: 'backup_snapshots.org_id',
    configId: 'backup_snapshots.config_id',
    timestamp: 'backup_snapshots.timestamp',
    size: 'backup_snapshots.size',
  },
  restoreJobs: {
    id: 'restore_jobs.id',
    orgId: 'restore_jobs.org_id',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' }
    });
    return next();
  }),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
}));

describe('backup routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/backup', backupRoutes);
  });

  it('should create, update, and test backup configuration', async () => {
    const now = new Date();
    const configRecord = {
      id: CONFIG_ID,
      orgId: ORG_ID,
      name: 'Archive S3',
      type: 'file',
      provider: 's3',
      providerConfig: { bucket: 'archive-bucket', region: 'us-west-2' },
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    // Mock insert for create
    insertMock.mockReturnValueOnce(chainMock([configRecord]));

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

    // Mock update for patch
    const updatedRecord = {
      ...configRecord,
      isActive: false,
      providerConfig: { storageClass: 'GLACIER' },
    };
    updateMock.mockReturnValueOnce(chainMock([updatedRecord]));

    const updateRes = await app.request(`/backup/configs/${CONFIG_ID}`, {
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

    // Mock select for test endpoint
    selectMock.mockReturnValueOnce(chainMock([configRecord]));

    const testRes = await app.request(`/backup/configs/${CONFIG_ID}/test`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(testRes.status).toBe(200);
    const tested = await testRes.json();
    expect(tested.status).toBe('success');
    expect(tested.checkedAt).toBeDefined();
  });

  it('should create a policy and report scheduling status', async () => {
    const now = new Date();

    // First select: verify config exists (for policy create)
    selectMock.mockReturnValueOnce(chainMock([{ id: CONFIG_ID }]));

    const policyRecord = {
      id: POLICY_ID,
      orgId: ORG_ID,
      configId: CONFIG_ID,
      name: 'Weekly Servers',
      enabled: true,
      targets: { deviceIds: [DEVICE_ID], siteIds: [], groupIds: [] },
      schedule: { frequency: 'weekly', time: '04:15', timezone: 'UTC', dayOfWeek: 2 },
      retention: { keepDaily: 5, keepWeekly: 6, keepMonthly: 2 },
      createdAt: now,
      updatedAt: now,
    };

    insertMock.mockReturnValueOnce(chainMock([policyRecord]));

    const policyRes = await app.request('/backup/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        name: 'Weekly Servers',
        configId: CONFIG_ID,
        enabled: true,
        targets: {
          deviceIds: [DEVICE_ID],
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

    // Mock for status endpoint: select policies, then select jobs
    selectMock
      .mockReturnValueOnce(chainMock([policyRecord])) // policies query
      .mockReturnValueOnce(chainMock([])); // jobs query

    const statusRes = await app.request(`/backup/status/${DEVICE_ID}`, {
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
    const now = new Date();
    const snapshot = {
      id: SNAPSHOT_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      snapshotId: 'snap-ext-001',
    };

    // Select snapshot for verification
    selectMock.mockReturnValueOnce(chainMock([snapshot]));

    const restoreRecord = {
      id: RESTORE_ID,
      orgId: ORG_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      restoreType: 'selective',
      targetPath: '/var/restore',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      restoredSize: null,
      restoredFiles: null,
    };

    insertMock.mockReturnValueOnce(chainMock([restoreRecord]));

    const restoreRes = await app.request('/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        snapshotId: SNAPSHOT_ID,
        deviceId: DEVICE_ID,
        targetPath: '/var/restore'
      })
    });

    expect(restoreRes.status).toBe(201);
    const restore = await restoreRes.json();
    expect(restore.status).toBe('pending');

    // Mock fetch of restore job
    selectMock.mockReturnValueOnce(chainMock([restoreRecord]));

    const fetchRes = await app.request(`/backup/restore/${RESTORE_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(fetchRes.status).toBe(200);
    const fetched = await fetchRes.json();
    expect(fetched.id).toBe(restore.id);
    expect(fetched.snapshotId).toBe(SNAPSHOT_ID);
  });

  it('should return provider usage history timeline', async () => {
    // Mock for usage-history: select snapshots with leftJoin
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/usage-history?days=7', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data.days).toBe(7);
    expect(Array.isArray(payload.data.points)).toBe(true);
    expect(payload.data.points.length).toBe(7);
    expect(Array.isArray(payload.data.providers)).toBe(true);
  });
});
