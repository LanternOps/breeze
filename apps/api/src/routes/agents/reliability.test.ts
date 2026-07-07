import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// #1105 depth-tracking: withDbAccessContext increments/decrements a shared
// counter around its callback so tests can assert which calls (insert vs.
// enqueue/audit) run inside vs. outside the org-scoped context. `activeScope`
// additionally records WHICH context is active when a callback runs, so the
// inline fallback test can prove it runs under a *system* context (not merely
// present) — an org context would silently no-op the compute (#1105 critical fix).
let contextDepth = 0;
let activeScope: string | null = null;
vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (ctx: { scope?: string } | undefined, fn: () => Promise<unknown>) => {
    contextDepth += 1;
    const prevScope = activeScope;
    activeScope = ctx?.scope ?? 'unknown';
    try {
      return await fn();
    } finally {
      contextDepth -= 1;
      activeScope = prevScope;
    }
  }),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const prevScope = activeScope;
    activeScope = 'system';
    try {
      return await fn();
    } finally {
      activeScope = prevScope;
    }
  }),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  }
}));

vi.mock('../../db/schema', () => ({
  deviceReliabilityHistory: {},
  devices: {
    id: 'id',
    orgId: 'orgId',
    agentId: 'agentId',
  },
  patchPolicies: {},
  alertRules: {},
  backupConfigs: {},
  securityPolicies: {},
  automationPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {},
  discoveredAssetTypeEnum: { enumValues: ['workstation', 'server', 'printer', 'unknown'] },
}));

vi.mock('../../jobs/reliabilityWorker', () => ({
  enqueueDeviceReliabilityComputation: vi.fn(),
}));

vi.mock('../../services/reliabilityScoring', () => ({
  computeAndPersistDeviceReliability: vi.fn(),
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));

import { db, withDbAccessContext, withSystemDbAccessContext, runOutsideDbContext } from '../../db';
import { reliabilityRoutes } from './reliability';
import { enqueueDeviceReliabilityComputation } from '../../jobs/reliabilityWorker';
import { computeAndPersistDeviceReliability } from '../../services/reliabilityScoring';
import { writeAuditEvent } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';

const payload = {
  uptimeSeconds: 3600,
  bootTime: '2026-02-20T10:00:00.000Z',
  crashEvents: [] as Array<unknown>,
  appHangs: [] as Array<unknown>,
  serviceFailures: [] as Array<unknown>,
  hardwareErrors: [] as Array<unknown>,
};

function buildApp(): Hono {
  const app = new Hono();
  app.use('/agents/*', async (c, next) => {
    c.set('agent', {
      deviceId: 'device-1',
      orgId: 'org-1',
      agentId: 'agent-123',
      siteId: 'site-1',
      role: 'agent',
    });
    await next();
  });
  app.route('/agents', reliabilityRoutes);
  return app;
}

describe('agent reliability ingestion route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ id: 'device-1', orgId: 'org-1' }]),
        })),
      })),
    } as any);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  it('falls back to inline compute under a SYSTEM context when queue enqueue fails', async () => {
    vi.mocked(enqueueDeviceReliabilityComputation).mockRejectedValue(new Error('queue unavailable'));
    let fallbackScope: string | null = null;
    vi.mocked(computeAndPersistDeviceReliability).mockImplementation(async () => {
      fallbackScope = activeScope;
      return true;
    });

    const app = buildApp();
    const response = await app.request('/agents/agent-123/reliability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(vi.mocked(enqueueDeviceReliabilityComputation)).toHaveBeenCalledWith('device-1');
    expect(vi.mocked(captureException)).toHaveBeenCalledWith(expect.any(Error));
    expect(vi.mocked(computeAndPersistDeviceReliability)).toHaveBeenCalledWith('device-1');
    // #1105 Critical fix: the inline fallback reads the ml-feature-flag gate
    // (an `organizations INNER JOIN partners` — needs partner-axis visibility) and
    // writes deviceReliability. It MUST run under a *system* context: an org context
    // can't see the partner row, so the flag gate would resolve `org_not_found` and
    // the compute would silently no-op. Mirrors the worker (runOutsideDbContext +
    // withSystemDbAccessContext), not an org-scoped wrap.
    expect(fallbackScope).toBe('system');
    expect(vi.mocked(runOutsideDbContext)).toHaveBeenCalled();
    expect(vi.mocked(withSystemDbAccessContext)).toHaveBeenCalled();
  });

  it('stays 200 when the inline fallback itself throws (metrics already persisted, best-effort recompute)', async () => {
    // Redis down (enqueue rejects) AND the inline recompute also throws. The
    // history row was already committed, so the request must NOT flip to 500 —
    // a 500 would drive agent retries and duplicate inserts during the outage.
    vi.mocked(enqueueDeviceReliabilityComputation).mockRejectedValue(new Error('queue unavailable'));
    vi.mocked(computeAndPersistDeviceReliability).mockRejectedValue(new Error('compute exploded'));

    const app = buildApp();
    const response = await app.request('/agents/agent-123/reliability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, status: 'received' });
    // Both the enqueue failure and the fallback failure are surfaced to Sentry.
    expect(vi.mocked(captureException)).toHaveBeenCalledTimes(2);
    // Audit still runs after a swallowed fallback failure.
    expect(vi.mocked(writeAuditEvent)).toHaveBeenCalled();
  });

  it('does not use inline fallback when queue enqueue succeeds', async () => {
    vi.mocked(enqueueDeviceReliabilityComputation).mockResolvedValue('job-1');
    vi.mocked(computeAndPersistDeviceReliability).mockResolvedValue(true);

    const app = buildApp();
    const response = await app.request('/agents/agent-123/reliability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(vi.mocked(enqueueDeviceReliabilityComputation)).toHaveBeenCalledWith('device-1');
    expect(vi.mocked(computeAndPersistDeviceReliability)).not.toHaveBeenCalled();
  });

  it('returns 404 when device is not found by agentId', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    } as any);

    const app = buildApp();
    const response = await app.request('/agents/agent-unknown/reliability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(404);
  });

  it('returns 500 and skips enqueue/audit when the history insert fails', async () => {
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockRejectedValue(new Error('insert boom')),
    } as any);

    const app = buildApp();
    const response = await app.request('/agents/agent-123/reliability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to record reliability metrics' });
    // A persistent insert failure must reach Sentry (parity with the enqueue catch).
    expect(vi.mocked(captureException)).toHaveBeenCalledWith(expect.any(Error));
    // The metrics never landed, so the downstream compute + audit must not run.
    expect(vi.mocked(enqueueDeviceReliabilityComputation)).not.toHaveBeenCalled();
    expect(vi.mocked(computeAndPersistDeviceReliability)).not.toHaveBeenCalled();
    expect(vi.mocked(writeAuditEvent)).not.toHaveBeenCalled();
  });

  it('returns 401 (not a masked 404) when the agent token carries no org', async () => {
    const app = new Hono();
    app.use('/agents/*', async (c, next) => {
      // Authenticated agent, but no orgId on the context.
      c.set('agent', { deviceId: 'device-1', agentId: 'agent-123', siteId: 'site-1', role: 'agent' } as never);
      await next();
    });
    app.route('/agents', reliabilityRoutes);

    const response = await app.request('/agents/agent-123/reliability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Agent context missing organization' });
    // Fail fast: no DB work, no vacuous org-context lookup.
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
    expect(vi.mocked(captureException)).toHaveBeenCalledWith(expect.any(Error));
  });

  it('inserts reliability history with the correct device and org ids', async () => {
    vi.mocked(enqueueDeviceReliabilityComputation).mockResolvedValue('job-1');
    const insertValues = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const app = buildApp();
    await app.request('/agents/agent-123/reliability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        orgId: 'org-1',
        uptimeSeconds: payload.uptimeSeconds,
      })
    );
  });

  it('returns success response body with expected shape', async () => {
    vi.mocked(enqueueDeviceReliabilityComputation).mockResolvedValue('job-1');

    const app = buildApp();
    const response = await app.request('/agents/agent-123/reliability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true, status: 'received' });
  });

  // #1105 — the route self-manages a SHORT withDbAccessContext around only the
  // lookup + insert; the BullMQ enqueue and audit write must run OUTSIDE it so
  // no pooled connection is pinned idle-in-transaction across Redis/non-DB work.
  it('runs BullMQ enqueue and audit write at DB-context depth 0 (#1105)', async () => {
    let enqueueDepth = -1;
    let auditDepth = -1;
    vi.mocked(enqueueDeviceReliabilityComputation).mockImplementation(async () => {
      enqueueDepth = contextDepth;
      return 'job-1';
    });
    vi.mocked(writeAuditEvent).mockImplementation(() => {
      auditDepth = contextDepth;
    });

    const app = buildApp();
    const res = await app.request('/agents/agent-123/reliability', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(enqueueDepth).toBe(0); // enqueue is OUTSIDE the org transaction
    expect(auditDepth).toBe(0); // audit is OUTSIDE the org transaction
    expect(vi.mocked(withDbAccessContext)).toHaveBeenCalled(); // insert WAS wrapped
  });
});

describe('reliability ingest — requireAgentRole gate (F8)', () => {
  it('rejects a watchdog-role token with 403', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('agent', { deviceId: 'dev-1', agentId: 'agent-1', orgId: 'org-1', siteId: 'site-1', role: 'watchdog' } as never);
      return next();
    });
    app.route('/agents', reliabilityRoutes);
    const res = await app.request('/agents/dev-1/reliability', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });
});
