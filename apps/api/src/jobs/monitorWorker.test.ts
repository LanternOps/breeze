import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb, ctxState, queueMock } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn()
  },
  // Tracks DB-access-context depth + an ordered event log so a test can prove
  // the monitor scheduler READS inside a context but ENQUEUES outside one (#1105).
  ctxState: { depth: 0, events: [] as string[] },
  queueMock: {
    getJob: vi.fn(async () => null),
    add: vi.fn(async () => ({ id: 'job-1' })),
    getRepeatableJobs: vi.fn(async () => []),
    removeRepeatableByKey: vi.fn(async () => undefined),
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = queueMock.getJob;
    add = queueMock.add;
    getRepeatableJobs = queueMock.getRepeatableJobs;
    removeRepeatableByKey = queueMock.removeRepeatableByKey;
  },
  Worker: class {},
  Job: class {},
  UnrecoverableError: class extends Error {},
}));

vi.mock('../db', () => ({
  db: mockDb,
  // Real-ish context wrapper: tracks depth around fn so the scheduler test can
  // assert which work runs inside the context vs after it closes.
  withSystemDbAccessContext: async (fn: () => unknown) => {
    ctxState.depth++;
    ctxState.events.push('ctx:enter');
    try {
      return await fn();
    } finally {
      ctxState.depth--;
      ctxState.events.push('ctx:exit');
    }
  },
  // #1105 tripwire wired into createInstrumentedQueue's add(). Mirror prod
  // semantics: record a violation if an enqueue runs while a context is held.
  assertOutsideHeldDbContext: (op: string) => {
    if (ctxState.depth > 0) ctxState.events.push(`tripwire-violation:${op}`);
  }
}));

vi.mock('../db/schema', () => ({
  networkMonitors: {
    id: 'networkMonitors.id',
    orgId: 'networkMonitors.orgId',
    partnerId: 'networkMonitors.partnerId',
    isActive: 'networkMonitors.isActive',
    lastChecked: 'networkMonitors.lastChecked',
    pollingInterval: 'networkMonitors.pollingInterval',
    assetId: 'networkMonitors.assetId',
    consecutiveFailures: 'networkMonitors.consecutiveFailures'
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId'
  },
  networkMonitorResults: {
    monitorId: 'networkMonitorResults.monitorId'
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    lastSeenAt: 'devices.lastSeenAt',
    enrolledAt: 'devices.enrolledAt'
  },
  networkMonitorAlertRules: {
    monitorId: 'networkMonitorAlertRules.monitorId',
    isActive: 'networkMonitorAlertRules.isActive',
    $inferSelect: {}
  },
  alerts: {
    id: 'alerts.id',
    orgId: 'alerts.orgId',
    deviceId: 'alerts.deviceId',
    status: 'alerts.status',
    context: 'alerts.context'
  },
  discoveredAssets: {
    id: 'discoveredAssets.id',
    orgId: 'discoveredAssets.orgId',
    linkedDeviceId: 'discoveredAssets.linkedDeviceId',
    siteId: 'discoveredAssets.siteId'
  }
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/agentCommandRelay', () => ({
  dispatchCommandToAgent: vi.fn(),
  isAgentConnectedAnywhere: vi.fn()
}));

vi.mock('../routes/monitors', () => ({
  buildMonitorCommand: vi.fn()
}));

vi.mock('../services/alertCooldown', () => ({
  isCooldownActive: vi.fn(async () => false),
  setCooldown: vi.fn(async () => undefined)
}));

vi.mock('../services/alertService', () => ({
  resolveAlert: vi.fn(async () => undefined),
  createSourcedAlert: vi.fn(async () => 'alert-1')
}));

import { db } from '../db';
import { isCooldownActive, setCooldown } from '../services/alertCooldown';
import { resolveAlert, createSourcedAlert } from '../services/alertService';
import { dispatchCommandToAgent, isAgentConnectedAnywhere } from '../services/agentCommandRelay';
import { buildMonitorCommand } from '../routes/monitors';

function selectLimitResolved(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows)
      })
    })
  };
}

function selectWhereResolved(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows)
    })
  };
}

function selectWhereOrderLimitResolved(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows)
        })
      })
    })
  };
}

const {
  recordMonitorCheckResult,
  processScheduler,
  selectExecutionAgentForMonitor,
  processCheckMonitor,
} = await import('./monitorWorker');

describe('selectExecutionAgentForMonitor (SR5-08 site-bound fallback)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('picks an online agent in the monitor site when one exists', async () => {
    vi.mocked(db.select)
      // asset → siteId
      .mockReturnValueOnce(selectLimitResolved([{ siteId: 'site-1' }]) as any)
      // site agent lookup → online agent in site-1
      .mockReturnValueOnce(selectLimitResolved([{ agentId: 'agent-site-1' }]) as any);

    const agentId = await selectExecutionAgentForMonitor({ orgId: 'org-1', assetId: 'asset-1' });
    expect(agentId).toBe('agent-site-1');
  });

  it('does NOT fall back to an arbitrary org agent when a site-bound monitor has no online site agent', async () => {
    vi.mocked(db.select)
      // asset → siteId (site-1)
      .mockReturnValueOnce(selectLimitResolved([{ siteId: 'site-1' }]) as any)
      // no online agent in site-1
      .mockReturnValueOnce(selectLimitResolved([]) as any);

    const agentId = await selectExecutionAgentForMonitor({ orgId: 'org-1', assetId: 'asset-1' });
    // Fail closed rather than cross the site boundary.
    expect(agentId).toBeNull();
    // Only the asset + site-agent lookups ran — no org-wide fallback query.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
  });

  it('allows an org-wide agent for an unbound (assetless) monitor — behavior preserved', async () => {
    vi.mocked(db.select)
      // org-wide online agent lookup
      .mockReturnValueOnce(selectLimitResolved([{ agentId: 'agent-any' }]) as any);

    const agentId = await selectExecutionAgentForMonitor({ orgId: 'org-1', assetId: null });
    expect(agentId).toBe('agent-any');
    // No asset lookup for an assetless monitor; only the org-wide query runs.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it('fails closed for a bound asset with a null site', async () => {
    vi.mocked(db.select)
      // asset → siteId null
      .mockReturnValueOnce(selectLimitResolved([{ siteId: null }]) as any);

    const agentId = await selectExecutionAgentForMonitor({ orgId: 'org-1', assetId: 'asset-1' });
    expect(agentId).toBeNull();
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});

describe('processScheduler (#1105 connection-hold)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctxState.depth = 0;
    ctxState.events = [];
    queueMock.getJob.mockResolvedValue(null);
    queueMock.add.mockImplementation(async () => {
      ctxState.events.push(`enqueue@depth${ctxState.depth}`);
      return { id: 'job-1' };
    });
  });

  function mockDueMonitors(rows: unknown[]) {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(async () => {
          ctxState.events.push(`select@depth${ctxState.depth}`);
          return rows;
        })
      })
    } as any);
  }

  it('reads due monitors inside a DB context but enqueues OUTSIDE it', async () => {
    mockDueMonitors([
      { id: 'm1', orgId: 'o1', pollingInterval: 60, lastChecked: null },
      { id: 'm2', orgId: 'o2', pollingInterval: 60, lastChecked: null },
    ]);

    const result = await processScheduler();

    expect(result).toEqual({ enqueued: 2 });
    // SELECT runs in-context (depth 1); the context CLOSES; then both enqueues
    // run with no transaction held (depth 0). This is the #1105 fix.
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'select@depth1',
      'ctx:exit',
      'enqueue@depth0',
      'enqueue@depth0',
    ]);
    // The prod held-context tripwire never fires for the enqueue path.
    expect(ctxState.events.some((e) => e.startsWith('tripwire-violation'))).toBe(false);
  });

  it('returns early without enqueuing when no monitors are due', async () => {
    mockDueMonitors([]);

    const result = await processScheduler();

    expect(result).toEqual({ enqueued: 0 });
    expect(queueMock.add).not.toHaveBeenCalled();
    expect(ctxState.events).toEqual(['ctx:enter', 'select@depth1', 'ctx:exit']);
  });
});

describe('recordMonitorCheckResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.transaction).mockImplementation(async (callback: any) => callback({
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined)
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      })
    }));
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined)
    } as any);
  });

  it('creates a monitor alert when an active rule matches', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectLimitResolved([{
        id: 'monitor-1',
        orgId: 'org-1',
        assetId: null,
        name: 'Edge Ping',
        target: '8.8.8.8',
        monitorType: 'icmp_ping',
        consecutiveFailures: 3
      }]) as any)
      .mockReturnValueOnce(selectWhereResolved([{
        id: 'rule-1',
        monitorId: 'monitor-1',
        condition: 'offline',
        threshold: null,
        severity: 'high',
        message: null,
        isActive: true
      }]) as any)
      .mockReturnValueOnce(selectWhereOrderLimitResolved([{ id: 'device-1' }]) as any)
      .mockReturnValueOnce(selectWhereResolved([]) as any);

    await recordMonitorCheckResult('monitor-1', {
      monitorId: 'monitor-1',
      status: 'offline',
      responseMs: 250,
      error: 'timeout'
    }, {
      // The reporting device and its org; supplying it here keeps these
      // pre-existing cases on the normal path, where no org fallback read runs.
      orgId: 'org-1',
      deviceId: 'device-1',
    });

    // #5241: the alert must go through the shared create+publish path so
    // `alert.triggered` actually fires — never a raw insert into `alerts`.
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    expect(vi.mocked(createSourcedAlert)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createSourcedAlert)).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'device-1',
      orgId: 'org-1',
      severity: 'high',
      publisher: 'monitor-worker',
      context: expect.objectContaining({
        source: 'network_monitor',
        monitorId: 'monitor-1',
        alertRuleId: 'rule-1',
      }),
      title: expect.stringContaining('Edge Ping'),
      message: expect.stringContaining('Edge Ping'),
      eventPayload: expect.objectContaining({
        monitorId: 'monitor-1',
        alertRuleId: 'rule-1',
        monitorType: 'icmp_ping',
        target: '8.8.8.8',
      }),
    }));
    expect(vi.mocked(isCooldownActive)).toHaveBeenCalledWith('rule-1', 'device-1');
    expect(vi.mocked(setCooldown)).toHaveBeenCalledWith('rule-1', 'device-1', 5);
    expect(vi.mocked(resolveAlert)).not.toHaveBeenCalled();
  });

  it('does not burn the cooldown when alert creation fails (#5241)', async () => {
    vi.mocked(createSourcedAlert).mockResolvedValueOnce(null);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectLimitResolved([{
        id: 'monitor-1',
        orgId: 'org-1',
        assetId: null,
        name: 'Edge Ping',
        target: '8.8.8.8',
        monitorType: 'icmp_ping',
        consecutiveFailures: 3
      }]) as any)
      .mockReturnValueOnce(selectWhereResolved([{
        id: 'rule-1',
        monitorId: 'monitor-1',
        condition: 'offline',
        threshold: null,
        severity: 'high',
        message: null,
        isActive: true
      }]) as any)
      .mockReturnValueOnce(selectWhereOrderLimitResolved([{ id: 'device-1' }]) as any)
      .mockReturnValueOnce(selectWhereResolved([]) as any);

    await recordMonitorCheckResult('monitor-1', {
      monitorId: 'monitor-1',
      status: 'offline',
      responseMs: 250,
      error: 'timeout'
    }, {
      // The reporting device and its org; supplying it here keeps these
      // pre-existing cases on the normal path, where no org fallback read runs.
      orgId: 'org-1',
      deviceId: 'device-1',
    });

    expect(vi.mocked(createSourcedAlert)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setCooldown)).not.toHaveBeenCalled();
  });

  it('keeps evaluating later rules after one rule fails to create its alert (#5241)', async () => {
    // rule-1's create fails, rule-2's succeeds: the `continue` must skip only
    // rule-1's cooldown, not abort the rest of the monitor's rule set.
    vi.mocked(createSourcedAlert)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('alert-2');
    vi.mocked(db.select)
      .mockReturnValueOnce(selectLimitResolved([{
        id: 'monitor-1',
        orgId: 'org-1',
        assetId: null,
        name: 'Edge Ping',
        target: '8.8.8.8',
        monitorType: 'icmp_ping',
        consecutiveFailures: 3
      }]) as any)
      .mockReturnValueOnce(selectWhereResolved([
        {
          id: 'rule-1',
          monitorId: 'monitor-1',
          condition: 'offline',
          threshold: null,
          severity: 'high',
          message: null,
          isActive: true
        },
        {
          id: 'rule-2',
          monitorId: 'monitor-1',
          condition: 'consecutive_failures_gt',
          threshold: '2',
          severity: 'critical',
          message: null,
          isActive: true
        }
      ]) as any)
      .mockReturnValueOnce(selectWhereOrderLimitResolved([{ id: 'device-1' }]) as any)
      .mockReturnValueOnce(selectWhereResolved([]) as any)
      .mockReturnValueOnce(selectWhereResolved([]) as any);

    await recordMonitorCheckResult('monitor-1', {
      monitorId: 'monitor-1',
      status: 'offline',
      responseMs: 250,
      error: 'timeout'
    }, {
      // The reporting device and its org; supplying it here keeps these
      // pre-existing cases on the normal path, where no org fallback read runs.
      orgId: 'org-1',
      deviceId: 'device-1',
    });

    expect(vi.mocked(createSourcedAlert)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(setCooldown)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setCooldown)).toHaveBeenCalledWith('rule-2', 'device-1', 5);
  });

  it('auto-resolves matching alerts when the monitor recovers', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectLimitResolved([{
        id: 'monitor-1',
        orgId: 'org-1',
        assetId: null,
        name: 'Edge Ping',
        target: '8.8.8.8',
        monitorType: 'icmp_ping',
        consecutiveFailures: 0
      }]) as any)
      .mockReturnValueOnce(selectWhereResolved([{
        id: 'rule-1',
        monitorId: 'monitor-1',
        condition: 'offline',
        threshold: null,
        severity: 'high',
        message: null,
        isActive: true
      }]) as any)
      .mockReturnValueOnce(selectWhereOrderLimitResolved([{ id: 'device-1' }]) as any)
      .mockReturnValueOnce(selectWhereResolved([{ id: 'alert-1' }]) as any);

    await recordMonitorCheckResult('monitor-1', {
      monitorId: 'monitor-1',
      status: 'online',
      responseMs: 22
    }, {
      // The reporting device and its org; supplying it here keeps these
      // pre-existing cases on the normal path, where no org fallback read runs.
      orgId: 'org-1',
      deviceId: 'device-1',
    });

    expect(vi.mocked(resolveAlert)).toHaveBeenCalledWith(
      'alert-1',
      expect.stringContaining('recovered from offline')
    );
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    expect(vi.mocked(createSourcedAlert)).not.toHaveBeenCalled();
    expect(vi.mocked(setCooldown)).not.toHaveBeenCalled();
  });

  it('redacts secrets from agent-supplied error and details before persistence (#2434)', async () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKe0m0h\n-----END RSA PRIVATE KEY-----';

    const txInsertValues = vi.fn().mockResolvedValue(undefined);
    const txUpdateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.transaction).mockImplementation(async (callback: any) => callback({
      insert: vi.fn().mockReturnValue({ values: txInsertValues }),
      update: vi.fn().mockReturnValue({ set: txUpdateSet }),
    }));

    vi.mocked(db.select)
      // monitor lookup after the transaction
      .mockReturnValueOnce(selectLimitResolved([{
        id: 'monitor-1',
        orgId: 'org-1',
        assetId: null,
        name: 'Edge Ping',
        target: '8.8.8.8',
        monitorType: 'icmp_ping',
        consecutiveFailures: 1
      }]) as any)
      // no active alert rules — nothing further to evaluate
      .mockReturnValueOnce(selectWhereResolved([]) as any);

    await recordMonitorCheckResult('monitor-1', {
      monitorId: 'monitor-1',
      status: 'offline',
      responseMs: 0,
      error: `probe failed, key follows:\n${pem}`,
      details: {
        monitorId: 'monitor-1',
        status: 'offline',
        error: `probe failed, key follows:\n${pem}`,
        nested: { hint: `still leaking:\n${pem}` },
      },
    }, { orgId: 'org-1', deviceId: 'device-1' });

    // network_monitor_results row: error + every string inside details redacted.
    const inserted = txInsertValues.mock.calls[0]![0] as {
      error: string;
      details: { error: string; nested: { hint: string } };
    };
    expect(inserted.error).toContain('[PRIVATE_KEY_REDACTED]');
    expect(inserted.details.error).toContain('[PRIVATE_KEY_REDACTED]');
    expect(inserted.details.nested.hint).toContain('[PRIVATE_KEY_REDACTED]');
    expect(JSON.stringify(inserted)).not.toContain('BEGIN RSA PRIVATE KEY');

    // network_monitors state: lastError redacted too.
    const stateSet = txUpdateSet.mock.calls[0]![0] as { lastError: string };
    expect(stateSet.lastError).toContain('[PRIVATE_KEY_REDACTED]');
    expect(stateSet.lastError).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  // #5751 W03 (#5754): the TLS observation joins the SAME updateSet as
  // lastStatus/lastResponseMs, inside the transaction that inserts the result
  // row — never a second statement that could land without it.
  describe('TLS observation writeback', () => {
    /** Runs one result and returns the network_monitors updateSet it produced. */
    async function recordAndCaptureUpdate(
      details: Record<string, unknown> | undefined,
      /** What the monitor's target/config resolve to RIGHT NOW. */
      current: { target: string; config: unknown } = { target: 'https://a.example', config: {} },
    ): Promise<Record<string, unknown>> {
      const txUpdateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      vi.mocked(db.transaction).mockImplementation(async (callback: any) => callback({
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
        update: vi.fn().mockReturnValue({ set: txUpdateSet }),
        // The provenance read is locked (FOR UPDATE) so a concurrent PATCH
        // either commits first (and we see its new target) or blocks until we
        // commit (and its own tls reset then clears what we wrote).
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([current]),
              }),
            }),
          }),
        }),
      }));
      vi.mocked(db.select)
        .mockReturnValueOnce(selectLimitResolved([{
          id: 'monitor-1', orgId: 'org-1', assetId: null, name: 'Web',
          target: 'https://a.example', monitorType: 'http_check', consecutiveFailures: 0,
        }]) as any)
        .mockReturnValueOnce(selectWhereResolved([]) as any);

      await recordMonitorCheckResult('monitor-1', {
        monitorId: 'monitor-1', status: 'online', responseMs: 12, details,
      }, { orgId: 'org-1', deviceId: 'device-1' });

      return txUpdateSet.mock.calls[0]![0] as Record<string, unknown>;
    }

    it('writes every tls_* column from an observed result', async () => {
      const set = await recordAndCaptureUpdate({
        monitorId: 'monitor-1',
        sslState: 'observed',
        sslExpiry: '2027-01-02T03:04:05Z',
        sslIssuer: 'CN=Example CA',
        sslObservedHost: 'final.example.com',
        sslRequestedUrl: 'https://a.example',
      });

      expect(set.tlsState).toBe('observed');
      expect(set.tlsNotAfter).toEqual(new Date('2027-01-02T03:04:05Z'));
      expect(set.tlsIssuer).toBe('CN=Example CA');
      // The OBSERVED host, not the monitor's target — redirects are followed.
      expect(set.tlsObservedHost).toBe('final.example.com');
      expect(set.tlsObservedAt).toBeInstanceOf(Date);
    });

    it('records handshake_failed with a NULL expiry, so a stale one never reads as fine', async () => {
      const set = await recordAndCaptureUpdate({
        monitorId: 'monitor-1',
        sslState: 'handshake_failed',
        sslObservedHost: 'broken.example.com',
        sslRequestedUrl: 'https://a.example',
      });

      expect(set.tlsState).toBe('handshake_failed');
      expect(set.tlsNotAfter).toBeNull();
      expect(set.tlsIssuer).toBeNull();
    });

    it('leaves the stored observation untouched for a result with no ssl* keys (icmp/dns)', async () => {
      const set = await recordAndCaptureUpdate({ monitorId: 'monitor-1', status: 'online' });

      for (const key of ['tlsState', 'tlsNotAfter', 'tlsIssuer', 'tlsObservedHost', 'tlsObservedAt']) {
        expect(set, `${key} must be absent, not null — null would clear a good reading`)
          .not.toHaveProperty(key);
      }
    });

    it('writes nothing for a result with no details at all', async () => {
      const set = await recordAndCaptureUpdate(undefined);
      expect(set).not.toHaveProperty('tlsState');
    });

    it('does not write an invalid date when sslExpiry is unparseable', async () => {
      const set = await recordAndCaptureUpdate({
        sslState: 'observed', sslExpiry: 'not-a-date', sslObservedHost: 'h.example',
        sslRequestedUrl: 'https://a.example',
      });

      expect(set.tlsNotAfter).toBeNull();
      // Degraded rather than 'observed', which the shape CHECK would reject.
      expect(set.tlsState).not.toBe('observed');
    });

    // Review finding: clearing the columns at PATCH time does nothing about a
    // result that was ALREADY in flight when the edit landed. The agent echoes
    // the URL it actually requested, so a result produced under the old
    // target/config is recognised and dropped instead of being attributed to
    // the new one.
    it('drops the observation when the monitor target changed after dispatch', async () => {
      const set = await recordAndCaptureUpdate(
        {
          sslState: 'observed',
          sslExpiry: '2027-01-02T03:04:05Z',
          sslIssuer: 'CN=Example CA',
          sslObservedHost: 'a.example',
          sslRequestedUrl: 'https://a.example',
        },
        { target: 'https://b.example', config: {} },
      );

      for (const key of ['tlsState', 'tlsNotAfter', 'tlsIssuer', 'tlsObservedHost', 'tlsObservedAt']) {
        expect(set, `${key} must be absent — the result predates the edit`).not.toHaveProperty(key);
      }
      // The rest of the writeback still lands; only the TLS part is dropped.
      expect(set.lastStatus).toBe('online');
    });

    it('drops the observation when only the config url changed after dispatch', async () => {
      const set = await recordAndCaptureUpdate(
        {
          sslState: 'observed',
          sslExpiry: '2027-01-02T03:04:05Z',
          sslIssuer: 'CN=Example CA',
          sslObservedHost: 'a.example',
          sslRequestedUrl: 'https://a.example/old',
        },
        { target: 'ignored', config: { url: 'https://a.example/new' } },
      );
      expect(set).not.toHaveProperty('tlsState');
    });

    it('accepts a result whose requested url still matches the config url', async () => {
      const set = await recordAndCaptureUpdate(
        {
          sslState: 'observed',
          sslExpiry: '2027-01-02T03:04:05Z',
          sslIssuer: 'CN=Example CA',
          sslObservedHost: 'a.example',
          sslRequestedUrl: 'https://a.example/path',
        },
        { target: 'ignored', config: { url: 'https://a.example/path' } },
      );
      expect(set.tlsState).toBe('observed');
    });

    it('drops an observation carrying no requested url — its provenance is unverifiable', async () => {
      const set = await recordAndCaptureUpdate({
        sslState: 'observed',
        sslExpiry: '2027-01-02T03:04:05Z',
        sslIssuer: 'CN=Example CA',
        sslObservedHost: 'a.example',
      });
      expect(set).not.toHaveProperty('tlsState');
    });

    it('survives redactSecretsDeep — a real issuer DN reaches the column intact', async () => {
      // redactSecretsDeep runs on `details` BEFORE this writeback, so the
      // assertion is on the value that actually lands, not on the input.
      const issuer = 'CN=R10,O=Let’s Encrypt,C=US';
      const set = await recordAndCaptureUpdate({
        sslState: 'observed',
        sslExpiry: '2027-01-02T03:04:05Z',
        sslIssuer: issuer,
        sslObservedHost: 'final.example.com',
        sslRequestedUrl: 'https://a.example',
      });

      expect(set.tlsIssuer).toBe(issuer);
      expect(set.tlsObservedHost).toBe('final.example.com');
    });
  });
});

describe('processCheckMonitor (wave 3.5b #4084 — dispatch via facade)', () => {
  const MONITOR_ROW = {
    id: 'monitor-1',
    orgId: 'org-1',
    assetId: null,
    isActive: true,
    name: 'Edge Ping',
    target: '8.8.8.8',
    monitorType: 'icmp_ping',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildMonitorCommand).mockReturnValue({
      id: 'cmd-1',
      type: 'network_check',
      payload: {},
    } as never);
  });

  function wireMonitorAndAgentSelects(agentId: string | null) {
    vi.mocked(db.select)
      // monitor row lookup
      .mockReturnValueOnce(selectLimitResolved([MONITOR_ROW]) as any)
      // org-wide online agent lookup (assetless monitor)
      .mockReturnValueOnce(selectLimitResolved(agentId ? [{ agentId }] : []) as any);
    if (agentId) vi.mocked(db.select)
      .mockReturnValueOnce(selectLimitResolved([MONITOR_ROW]) as any)
      .mockReturnValueOnce(selectLimitResolved([{ agentId }]) as any);
  }

  it('warns and returns not-dispatched when no agent is connected anywhere, without calling dispatch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    wireMonitorAndAgentSelects(null);

    const result = await processCheckMonitor({ type: 'check-monitor', monitorId: 'monitor-1', orgId: 'org-1' });

    expect(result).toEqual({ dispatched: false, agentId: null });
    expect(vi.mocked(dispatchCommandToAgent)).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('No online agent'));
    warn.mockRestore();
  });

  it('returns dispatched:true on outcome sent, and dispatches with priority "probe"', async () => {
    wireMonitorAndAgentSelects('agent-1');
    vi.mocked(isAgentConnectedAnywhere).mockResolvedValue(true);
    vi.mocked(dispatchCommandToAgent).mockResolvedValue({ status: 'sent', via: 'local' });

    const result = await processCheckMonitor({ type: 'check-monitor', monitorId: 'monitor-1', orgId: 'org-1' });

    expect(result).toEqual({ dispatched: true, agentId: 'agent-1' });
    expect(vi.mocked(dispatchCommandToAgent)).toHaveBeenCalledWith(
      'agent-1',
      expect.anything(),
      { priority: 'probe' }
    );
  });

  it('returns dispatched:false and logs the outcome status when offline', async () => {
    wireMonitorAndAgentSelects('agent-1');
    vi.mocked(isAgentConnectedAnywhere).mockResolvedValue(true);
    vi.mocked(dispatchCommandToAgent).mockResolvedValue({ status: 'offline' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await processCheckMonitor({ type: 'check-monitor', monitorId: 'monitor-1', orgId: 'org-1' });

    expect(result).toEqual({ dispatched: false, agentId: 'agent-1' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('offline'));
    error.mockRestore();
  });

  it('returns dispatched:false and WARNS naming "indeterminate" so ops can tell "maybe sent" from "definitely not"', async () => {
    wireMonitorAndAgentSelects('agent-1');
    vi.mocked(isAgentConnectedAnywhere).mockResolvedValue(true);
    vi.mocked(dispatchCommandToAgent).mockResolvedValue({ status: 'indeterminate' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await processCheckMonitor({ type: 'check-monitor', monitorId: 'monitor-1', orgId: 'org-1' });

    expect(result).toEqual({ dispatched: false, agentId: 'agent-1' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('indeterminate'));
    error.mockRestore();
  });
});

/**
 * #5291 W04 - partner-wide network checks.
 *
 * `network_monitors.org_id` is nullable now (org XOR partner). Before this
 * wave every read in this worker went through `monitor.orgId`, so a
 * partner-wide row enqueued `orgId: null` and every probe-device, dedupe and
 * alert query silently matched nothing - the check just stopped running, with
 * no error at all. These tests pin the two halves of the fix: the scheduler
 * fans a partner-wide row out one job per org, and the checker reads the
 * RUNNING org off the job, never off the monitor.
 */
describe('partner-wide network monitors (#5291 W04)', () => {
  let agentSelectWhereArgs: unknown;

  beforeEach(() => {
    agentSelectWhereArgs = undefined;
    vi.clearAllMocks();
    ctxState.depth = 0;
    ctxState.events = [];
    queueMock.getJob.mockResolvedValue(null);
    queueMock.add.mockResolvedValue({ id: 'job-1' } as never);
  });

  it('fans a partner-wide monitor out to ONE JOB PER ORG under its partner', async () => {
    // A REALISTIC BullMQ getJob: it returns a job that has already been added
    // under the same stable id. With a monitor-only dedupe key, orgs 2..N would
    // find org 1's still-waiting job, `isReusableState` would short-circuit,
    // and they would silently never be enqueued. Mocking getJob as a flat
    // `null` hides that entirely, so this fixture is what makes the assertion
    // below a real control rather than a tautology.
    const addedByJobId = new Map<string, { id: string }>();
    queueMock.getJob.mockImplementation((async (jobId: string) => addedByJobId.get(jobId) ?? null) as never);
    queueMock.add.mockImplementation((async (_name: string, _data: unknown, opts: { jobId?: string }) => {
      const job = { id: opts?.jobId ?? 'job-1', getState: async () => 'waiting', remove: async () => undefined };
      if (opts?.jobId) addedByJobId.set(opts.jobId, job);
      return job;
    }) as never);

    vi.mocked(db.select)
      .mockReturnValueOnce(selectWhereResolved([
        { id: 'm-partner', orgId: null, partnerId: 'p1', pollingInterval: 60, lastChecked: null },
      ]) as any)
      .mockReturnValueOnce(selectWhereResolved([
        { id: 'org-a', partnerId: 'p1' },
        { id: 'org-b', partnerId: 'p1' },
        { id: 'org-c', partnerId: 'p1' },
      ]) as any);

    const result = await processScheduler();

    expect(result).toEqual({ enqueued: 3 });
    const enqueuedOrgIds = queueMock.add.mock.calls.map((call: any) => call[1].orgId);
    expect([...enqueuedOrgIds].sort()).toEqual(['org-a', 'org-b', 'org-c']);
    for (const call of queueMock.add.mock.calls as any[]) {
      expect(call[1].monitorId).toBe('m-partner');
    }
  });

  it('still enqueues exactly one job for an org-owned monitor', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectWhereResolved([
      { id: 'm-org', orgId: 'org-a', partnerId: null, pollingInterval: 60, lastChecked: null },
    ]) as any);

    const result = await processScheduler();

    expect(result).toEqual({ enqueued: 1 });
    expect(queueMock.add).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it('drops a job whose org is neither the monitor org nor an org under its partner', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(db.select)
      .mockReturnValueOnce(selectLimitResolved([
        { id: 'm-partner', orgId: null, partnerId: 'p1', assetId: null, isActive: true, name: 'GW', target: '10.0.0.1', monitorType: 'icmp_ping' },
      ]) as any)
      .mockReturnValueOnce(selectLimitResolved([]) as any);

    const result = await processCheckMonitor({ type: 'check-monitor', monitorId: 'm-partner', orgId: 'org-foreign' });

    expect(result).toEqual({ dispatched: false, agentId: null });
    expect(vi.mocked(dispatchCommandToAgent)).not.toHaveBeenCalled();
    // Assert the DROP REASON, not merely that the org id appears: a bypassed
    // guard falls through to selectExecutionAgentForMonitor and warns "No
    // online agent for org org-foreign", which also contains the org id. Only
    // the mismatch branch says why the job was refused.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('neither its own org nor an org under its partner'),
    );
    // A bypassed guard would skip the membership probe and spend the second
    // queued read on agent selection instead; the count pins which one ran.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('selects the probe device from the JOB org, not the monitor org, for a partner-wide check', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectLimitResolved([
        { id: 'm-partner', orgId: null, partnerId: 'p1', assetId: null, isActive: true, name: 'GW', target: '10.0.0.1', monitorType: 'icmp_ping' },
      ]) as any)
      .mockReturnValueOnce(selectLimitResolved([{ id: 'org-a' }]) as any)
      // Agent lookup. The PREDICATE is captured, not discarded: selectLimitResolved
      // throws its `where` arguments away, so without this the test would pass
      // identically if device selection were reverted to the monitor's (NULL) org.
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation((...args: unknown[]) => {
            agentSelectWhereArgs = args;
            return { limit: vi.fn().mockResolvedValue([{ agentId: 'agent-a' }]) };
          }),
        }),
      } as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectLimitResolved([{ id: 'm-partner', orgId: null, partnerId: 'p1', assetId: null, isActive: true, monitorType: 'icmp_ping', target: 'example.com' }]) as any)
      .mockReturnValueOnce(selectLimitResolved([{ id: 'org-a' }]) as any)
      .mockReturnValueOnce(selectLimitResolved([{ agentId: 'agent-a' }]) as any);
    vi.mocked(isAgentConnectedAnywhere).mockResolvedValue(true);
    vi.mocked(dispatchCommandToAgent).mockResolvedValue({ status: 'sent', via: 'local' } as never);

    const result = await processCheckMonitor({ type: 'check-monitor', monitorId: 'm-partner', orgId: 'org-a' });

    expect(result).toEqual({ dispatched: true, agentId: 'agent-a' });
    expect(agentSelectWhereArgs, 'the agent lookup never ran').toBeDefined();
    expect(JSON.stringify(agentSelectWhereArgs)).toContain('org-a');
  });

  it('stamps every result row with the running org and the probe device', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.transaction).mockImplementation((async (callback: any) => callback({
      insert: vi.fn().mockReturnValue({ values }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    })) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectLimitResolved([
        { id: 'm-partner', orgId: null, partnerId: 'p1', assetId: null, name: 'GW', target: '10.0.0.1', monitorType: 'icmp_ping', consecutiveFailures: 0 },
      ]) as any)
      .mockReturnValueOnce(selectWhereResolved([]) as any);

    await recordMonitorCheckResult(
      'm-partner',
      { monitorId: 'm-partner', status: 'online', responseMs: 12 },
      { orgId: 'org-a', deviceId: 'device-a' },
    );

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      monitorId: 'm-partner',
      orgId: 'org-a',
      deviceId: 'device-a',
    }));
  });

  it('falls back to the MONITOR\'s org when the reporter carried none (Redis-down direct path)', async () => {
    // agentWs resolves the reporting device live; if that row is gone
    // mid-session the reporter carries no org. Writing org_id NULL for an
    // ORG-OWNED monitor would make the result invisible to every org-scoped
    // reader — it would just disappear from that customer's history with
    // nothing to explain it.
    const values = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.transaction).mockImplementation((async (callback: any) => callback({
      insert: vi.fn().mockReturnValue({ values }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    })) as any);
    vi.mocked(db.select)
      // the new pre-insert org resolution
      .mockReturnValueOnce(selectLimitResolved([{ orgId: 'org-owner' }]) as any)
      // post-tx monitor read
      .mockReturnValueOnce(selectLimitResolved([
        { id: 'monitor-1', orgId: 'org-owner', assetId: null, name: 'Edge Ping', target: '8.8.8.8', monitorType: 'icmp_ping', consecutiveFailures: 0 },
      ]) as any)
      // no alert rules
      .mockReturnValueOnce(selectWhereResolved([]) as any);

    await recordMonitorCheckResult('monitor-1', { monitorId: 'monitor-1', status: 'online', responseMs: 5 });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-owner' }));
  });

  it('leaves org_id NULL only when the monitor is partner-wide AND the reporter carried no org', async () => {
    // The one genuinely unattributable case: there is no tenant to guess.
    const values = vi.fn().mockResolvedValue(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(db.transaction).mockImplementation((async (callback: any) => callback({
      insert: vi.fn().mockReturnValue({ values }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    })) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectLimitResolved([{ orgId: null }]) as any)
      .mockReturnValueOnce(selectLimitResolved([
        { id: 'monitor-1', orgId: null, partnerId: 'p1', assetId: null, name: 'GW', target: '10.0.0.1', monitorType: 'icmp_ping', consecutiveFailures: 0 },
      ]) as any);

    await recordMonitorCheckResult('monitor-1', { monitorId: 'monitor-1', status: 'online', responseMs: 5 });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ orgId: null }));
    // …and it says so, rather than skipping alert evaluation silently.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('partner-wide'));
    warn.mockRestore();
  });

  it('attributes a partner-wide monitor\'s ALERT to the running org, not the (null) definition owner', async () => {
    // Every other alert case in this file uses an org-owned monitor, where
    // runningOrgId trivially equals monitor.orgId — so none of them would catch
    // evaluateMonitorAlertRules being reverted to read monitor.orgId. Here the
    // definition owns no org at all: reverting would dedupe and create the
    // alert against a null tenant.
    vi.mocked(db.transaction).mockImplementation((async (callback: any) => callback({
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    })) as any);

    let alertDedupeWhereArgs: unknown;
    vi.mocked(db.select)
      // post-tx monitor read: partner-wide, so orgId is NULL
      .mockReturnValueOnce(selectLimitResolved([{
        id: 'm-partner',
        orgId: null,
        partnerId: 'p1',
        assetId: null,
        name: 'GW',
        target: '10.0.0.1',
        monitorType: 'icmp_ping',
        consecutiveFailures: 3,
      }]) as any)
      // one active offline rule
      .mockReturnValueOnce(selectWhereResolved([{
        id: 'rule-1',
        monitorId: 'm-partner',
        condition: 'offline',
        threshold: null,
        severity: 'high',
        message: null,
        isActive: true,
      }]) as any)
      // probe-device pick for the RUNNING org
      .mockReturnValueOnce(selectWhereOrderLimitResolved([{ id: 'device-a' }]) as any)
      // existing-alert dedupe read — capture its predicate
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation((...args: unknown[]) => {
            alertDedupeWhereArgs = args;
            return Promise.resolve([]);
          }),
        }),
      } as any);

    await recordMonitorCheckResult(
      'm-partner',
      { monitorId: 'm-partner', status: 'offline', responseMs: 0 },
      { orgId: 'org-a', deviceId: 'device-a' },
    );

    expect(vi.mocked(createSourcedAlert)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-a', deviceId: 'device-a' }),
    );
    // The dedupe read must be scoped the same way, or a recovered sibling org
    // would suppress this org's alert.
    expect(JSON.stringify(alertDedupeWhereArgs)).toContain('org-a');
  });
});
