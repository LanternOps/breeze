import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
,
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {},
  sensitiveDataScans: {},
  sensitiveDataFindings: {},
  sensitiveDataPolicies: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      orgCondition: () => undefined,
      canAccessOrg: () => true
    });
    return next();
  },
  requireScope: vi.fn(() => async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      orgCondition: () => undefined,
      canAccessOrg: () => true
    });
    return next();
  }),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    // Mirror the real middleware: populate permissions.allowedSiteIds when the
    // caller is site-restricted (signalled here via the x-restrict-site header).
    const restrict = c.req.header('x-restrict-site');
    if (restrict) {
      c.set('permissions', { allowedSiteIds: [restrict] });
    }
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next())
}));

vi.mock('../services/commandQueue', () => ({
  CommandTypes: {
    ENCRYPT_FILE: 'encrypt_file',
    QUARANTINE_FILE: 'quarantine_file',
    SECURE_DELETE_FILE: 'secure_delete_file'
  },
  queueCommand: vi.fn().mockResolvedValue({ id: 'cmd-1' })
}));

vi.mock('../jobs/sensitiveDataJobs', () => ({
  enqueueSensitiveDataScan: vi.fn().mockResolvedValue('job-1')
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn().mockResolvedValue('event-1')
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

import { db } from '../db';
import { queueCommand } from '../services/commandQueue';
import { writeRouteAudit } from '../services/auditEvents';
import { sensitiveDataRoutes } from './sensitiveData';

function mockDeviceLookup(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows)
    })
  } as any);
}

function mockInsertReturning(rows: any[]) {
  vi.mocked(db.insert).mockReturnValueOnce({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(rows)
    })
  } as any);
}

// db.select().from().where() — used by the remediate findings lookup
function mockSelectFromWhere(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows)
    })
  } as any);
}

// db.select().from().where().limit() — used by policy update/delete existing lookup
function mockSelectFromWhereLimit(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows)
      })
    })
  } as any);
}

// db.update().set().where() — status-flip / destructive metadata writes
function mockUpdateSetWhere() {
  vi.mocked(db.update).mockReturnValueOnce({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined)
    })
  } as any);
}

// db.update().set().where().returning() — policy update
function mockUpdateSetWhereReturning(rows: any[]) {
  vi.mocked(db.update).mockReturnValueOnce({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(rows)
      })
    })
  } as any);
}

// db.delete().where() — policy delete
function mockDeleteWhere() {
  vi.mocked(db.delete).mockReturnValueOnce({
    where: vi.fn().mockResolvedValue(undefined)
  } as any);
}

describe('sensitive data routes', () => {
  let app: Hono;
  const deviceId = '11111111-1111-1111-1111-111111111111';
  const scanId = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/sensitive-data', sensitiveDataRoutes);
  });

  it('queues sensitive data scans for accessible devices', async () => {
    mockDeviceLookup([
      {
        id: deviceId,
        orgId: '11111111-1111-1111-1111-111111111111',
        hostname: 'host-1',
        status: 'online'
      }
    ]);
    mockInsertReturning([{ id: scanId, deviceId, orgId: '11111111-1111-1111-1111-111111111111' }]);

    const res = await app.request('/sensitive-data/scan', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceIds: [deviceId],
        detectionClasses: ['credential']
      })
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.scans).toHaveLength(1);
    expect(body.data.queued).toBe(1);
  });

  it('reuses recent scans for matching idempotency requests', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([
            {
              id: scanId,
              orgId: '11111111-1111-1111-1111-111111111111',
              deviceId,
              status: 'queued',
              createdAt: new Date('2026-02-26T00:00:00Z')
            }
          ])
        })
      })
    } as any);

    const res = await app.request('/sensitive-data/scan', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-abc-123'
      },
      body: JSON.stringify({
        deviceIds: [deviceId],
        detectionClasses: ['credential']
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.idempotentReuse).toBe(true);
    expect(body.data.scans).toHaveLength(1);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });

  it('returns a scan status with findings summary', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: scanId,
                  orgId: '11111111-1111-1111-1111-111111111111',
                  deviceId,
                  policyId: null,
                  status: 'completed',
                  startedAt: new Date('2026-02-26T00:00:00Z'),
                  completedAt: new Date('2026-02-26T00:01:00Z'),
                  createdAt: new Date('2026-02-26T00:00:00Z'),
                  summary: { findingsCount: 1 },
                  deviceName: 'host-1'
                }
              ])
            })
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: 'f-1', risk: 'critical', status: 'open' }
          ])
        })
      } as any);

    const res = await app.request(`/sensitive-data/scans/${scanId}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(scanId);
    expect(body.data.findings.total).toBe(1);
    expect(body.data.findings.byRisk.critical).toBe(1);
  });

  it('requires explicit confirmation for destructive remediation', async () => {
    const res = await app.request('/sensitive-data/remediate', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        findingIds: ['33333333-3333-3333-3333-333333333333'],
        action: 'secure_delete'
      })
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('confirm=true');
  });

  it('supports remediation dry-run without queueing commands', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: '33333333-3333-3333-3333-333333333333',
            orgId: '11111111-1111-1111-1111-111111111111',
            deviceId,
            filePath: '/tmp/secret.txt',
            status: 'open'
          }
        ])
      })
    } as any);

    const res = await app.request('/sensitive-data/remediate', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        findingIds: ['33333333-3333-3333-3333-333333333333'],
        action: 'quarantine',
        confirm: true,
        dryRun: true
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.dryRun).toBe(true);
    expect(body.data.eligible).toBe(1);
    expect(queueCommand).not.toHaveBeenCalled();
  });

  // --- Site-axis (app-layer) enforcement ---

  describe('site-scope enforcement', () => {
    const allowedSite = 'site-a';
    const forbiddenSite = 'site-b';
    const findingId = '33333333-3333-3333-3333-333333333333';
    const orgId = '11111111-1111-1111-1111-111111111111';

    // db.select({id, siteId}).from(devices).where(...) — remediate site lookup
    function mockDeviceSiteLookup(rows: any[]) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows)
        })
      } as any);
    }

    it('blocks a site-restricted user from remediating an out-of-site finding (403)', async () => {
      // 1) findings lookup, 2) device-site lookup (device in forbidden site)
      mockSelectFromWhere([
        { id: findingId, orgId, deviceId, filePath: '/tmp/secret.txt', status: 'open' }
      ]);
      mockDeviceSiteLookup([{ id: deviceId, siteId: forbiddenSite }]);

      const res = await app.request('/sensitive-data/remediate', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
          'x-restrict-site': allowedSite
        },
        body: JSON.stringify({
          findingIds: [findingId],
          action: 'quarantine',
          confirm: true
        })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/site/i);
      // No command queued, no status flip for the out-of-site device.
      expect(queueCommand).not.toHaveBeenCalled();
    });

    it('blocks secure_delete (most destructive) for an out-of-site finding (403, no command queued)', async () => {
      // The destructive-path deny must hold for the most dangerous action too:
      // a site-restricted user cannot secure_delete a finding on a device
      // outside their allowed sites. 1) findings lookup, 2) device-site lookup.
      mockSelectFromWhere([
        { id: findingId, orgId, deviceId, filePath: '/tmp/secret.txt', status: 'open' }
      ]);
      mockDeviceSiteLookup([{ id: deviceId, siteId: forbiddenSite }]);

      const res = await app.request('/sensitive-data/remediate', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
          'x-restrict-site': allowedSite
        },
        body: JSON.stringify({
          findingIds: [findingId],
          action: 'secure_delete',
          confirm: true
        })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/site/i);
      // The most destructive command must NOT be dispatched.
      expect(queueCommand).not.toHaveBeenCalled();
    });

    it('fails closed when a finding device row does not resolve (dangling deviceId, 403)', async () => {
      // The site-axis guard loads the distinct finding device ids and rejects if
      // any device row fails to resolve (findingDevices.length !== deviceIds.length)
      // — e.g. a dangling / cross-org deviceId. Rig the device lookup to return
      // FEWER rows than the findings' distinct device ids: two findings on two
      // distinct devices, but only one device row comes back.
      const findingId2 = '55555555-5555-5555-5555-555555555555';
      const deviceId2 = '66666666-6666-6666-6666-666666666666';
      mockSelectFromWhere([
        { id: findingId, orgId, deviceId, filePath: '/tmp/secret.txt', status: 'open' },
        { id: findingId2, orgId, deviceId: deviceId2, filePath: '/tmp/secret2.txt', status: 'open' }
      ]);
      // Only ONE of the two distinct device ids resolves (the other is in the
      // allowed site to prove it's the missing-row check, not a site deny, that
      // trips the 403).
      mockDeviceSiteLookup([{ id: deviceId, siteId: allowedSite }]);

      const res = await app.request('/sensitive-data/remediate', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
          'x-restrict-site': allowedSite
        },
        body: JSON.stringify({
          findingIds: [findingId, findingId2],
          action: 'quarantine',
          confirm: true
        })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/site/i);
      // Fail-closed: no command queued when a device row can't be resolved.
      expect(queueCommand).not.toHaveBeenCalled();
    });

    it('allows remediation when the finding device is within the site allowlist', async () => {
      mockSelectFromWhere([
        { id: findingId, orgId, deviceId, filePath: '/tmp/secret.txt', status: 'open' }
      ]);
      mockDeviceSiteLookup([{ id: deviceId, siteId: allowedSite }]);
      mockUpdateSetWhere();

      const res = await app.request('/sensitive-data/remediate', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
          'x-restrict-site': allowedSite
        },
        body: JSON.stringify({
          findingIds: [findingId],
          action: 'quarantine',
          confirm: true
        })
      });

      expect(res.status).toBe(202);
      expect(queueCommand).toHaveBeenCalledTimes(1);
    });

    it('dashboard excludes out-of-site findings for a site-restricted user', async () => {
      // Site-restricted path adds an innerJoin before .where(); the join filters
      // out the forbidden-site finding, so only the allowed-site row is returned.
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { dataType: 'pci', risk: 'high', status: 'open', lastSeenAt: new Date() }
            ])
          })
        })
      } as any);

      const res = await app.request('/sensitive-data/dashboard', {
        method: 'GET',
        headers: { Authorization: 'Bearer token', 'x-restrict-site': allowedSite }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      // Only the in-site finding is counted; the forbidden-site PCI total leaks nothing.
      expect(body.data.totals.findings).toBe(1);
      expect(body.data.byDataType.pci).toBe(1);
    });
  });

  // --- SOC2 audit coverage ---

  const findingId = '33333333-3333-3333-3333-333333333333';
  const policyId = '44444444-4444-4444-4444-444444444444';
  const orgId = '11111111-1111-1111-1111-111111111111';

  it('audits status-flip remediation (accept_risk) as a risk-acceptance decision', async () => {
    mockSelectFromWhere([
      { id: findingId, orgId, deviceId, filePath: '/tmp/secret.txt', status: 'open' }
    ]);
    mockUpdateSetWhere();

    const res = await app.request('/sensitive-data/remediate', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        findingIds: [findingId],
        action: 'accept_risk'
      })
    });

    expect(res.status).toBe(200);
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'sensitive_data.finding.accept_risk',
        resourceType: 'sensitive_data_finding',
        details: expect.objectContaining({
          action: 'accept_risk',
          findingIds: [findingId],
          count: 1
        })
      })
    );
  });

  it('audits destructive remediation (quarantine) with queued/failed counts', async () => {
    mockSelectFromWhere([
      { id: findingId, orgId, deviceId, filePath: '/tmp/secret.txt', status: 'open' }
    ]);
    mockUpdateSetWhere();

    const res = await app.request('/sensitive-data/remediate', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        findingIds: [findingId],
        action: 'quarantine',
        confirm: true
      })
    });

    expect(res.status).toBe(202);
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'sensitive_data.finding.remediate',
        resourceType: 'sensitive_data_finding',
        details: expect.objectContaining({
          action: 'quarantine',
          queued: 1,
          failed: 0
        })
      })
    );
  });

  it('audits policy creation', async () => {
    mockInsertReturning([
      { id: policyId, orgId, name: 'My Policy', createdAt: new Date(), updatedAt: new Date() }
    ]);

    const res = await app.request('/sensitive-data/policies', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'My Policy',
        detectionClasses: ['credential']
      })
    });

    expect(res.status).toBe(201);
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'sensitive_data_policy.create',
        resourceType: 'sensitive_data_policy',
        resourceId: policyId,
        resourceName: 'My Policy'
      })
    );
  });

  it('audits policy update with changedFields', async () => {
    mockSelectFromWhereLimit([
      { id: policyId, orgId, name: 'Old Name', scope: {}, detectionClasses: ['credential'], schedule: null, isActive: true }
    ]);
    mockUpdateSetWhereReturning([
      { id: policyId, orgId, name: 'New Name', createdAt: new Date(), updatedAt: new Date() }
    ]);

    const res = await app.request(`/sensitive-data/policies/${policyId}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' })
    });

    expect(res.status).toBe(200);
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'sensitive_data_policy.update',
        resourceType: 'sensitive_data_policy',
        resourceId: policyId,
        resourceName: 'New Name',
        details: expect.objectContaining({
          changedFields: expect.arrayContaining(['name'])
        })
      })
    );
  });

  it('audits policy deletion', async () => {
    mockSelectFromWhereLimit([{ id: policyId, name: 'My Policy', orgId }]);
    mockDeleteWhere();

    const res = await app.request(`/sensitive-data/policies/${policyId}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'sensitive_data_policy.delete',
        resourceType: 'sensitive_data_policy',
        resourceId: policyId
      })
    );
  });
});
