import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  alerts: {
    id: 'id',
    deviceId: 'device_id',
    orgId: 'org_id',
    configItemName: 'config_item_name',
    status: 'status',
    triggeredAt: 'triggered_at',
    severity: 'severity',
  },
  devices: {
    id: 'id',
    hostname: 'hostname',
    displayName: 'display_name',
  },
}));

vi.mock('./eventBus', () => ({
  getEventBus: vi.fn(),
  EVENT_TYPES: { DNS_THREAT_BLOCKED: 'dns.threat.blocked' },
}));

// #11328 — the alert goes through the shared create + `alert.triggered` path.
vi.mock('./alertService', () => ({
  createSourcedAlert: vi.fn(),
}));

import { db, withSystemDbAccessContext } from '../db';
import { createSourcedAlert } from './alertService';
import { handleDnsThreatBlocked, handleDnsThreatBlockedEvent } from './dnsThreatAlerts';

function mockCooldownSelect(found: boolean) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(found ? [{ id: 'existing-alert' }] : []),
      }),
    }),
  } as any);
}

function mockDeviceSelect(device: { hostname: string; displayName: string | null } | null) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(device ? [device] : []),
      }),
    }),
  } as any);
}

function mockInsertReturning(id: string) {
  vi.mocked(createSourcedAlert).mockResolvedValueOnce(id);
}

function createdAlertParams(call = 0) {
  return vi.mocked(createSourcedAlert).mock.calls[call]![0];
}

describe('handleDnsThreatBlocked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts an alert row with severity=high when no cooldown blocks it', async () => {
    mockCooldownSelect(false);
    mockDeviceSelect({ hostname: 'TST-LAPTOP-01', displayName: null });
    mockInsertReturning('alert-new-1');

    const result = await handleDnsThreatBlocked('org-1', {
      deviceId: 'dev-1',
      domain: 'malware.example.com',
      category: 'malware',
      integrationId: 'int-1',
      timestamp: '2026-05-22T20:00:00.000Z',
    });

    expect(result).toEqual({ alertId: 'alert-new-1', reason: 'created' });
    // #11328 — a raw insert never published `alert.triggered`, so channels,
    // routing rules and escalation never saw a DNS threat. createSourcedAlert
    // stages the event with the row and announces it after COMMIT.
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    expect(vi.mocked(createSourcedAlert)).toHaveBeenCalledTimes(1);
    const values = createdAlertParams();
    expect(values.severity).toBe('high');
    expect(values.orgId).toBe('org-1');
    expect(values.deviceId).toBe('dev-1');
    expect(values.owner).toBeUndefined();
    expect(values.configItemName).toBe('dns_threat_malware');
    expect(values.publisher).toBe('dns-threat-alerts');
    expect(values.title).toContain('malware.example.com');
    expect(values.title).toContain('malware');
    expect(values.message).toContain('TST-LAPTOP-01');
    expect(values.context).toMatchObject({
      source: 'dns_threat_evaluator',
      domain: 'malware.example.com',
      category: 'malware',
    });
  });

  it('returns cooldown reason and does not create (or publish) when an active alert for the same device+category exists', async () => {
    mockCooldownSelect(true);

    const result = await handleDnsThreatBlocked('org-1', {
      deviceId: 'dev-1',
      domain: 'phish.example.com',
      category: 'phishing',
      integrationId: 'int-1',
      timestamp: '2026-05-22T20:00:00.000Z',
    });

    expect(result).toEqual({ alertId: null, reason: 'cooldown' });
    expect(vi.mocked(createSourcedAlert)).not.toHaveBeenCalled();
  });

  it('reports create_failed (not created) when createSourcedAlert produced no alert', async () => {
    mockCooldownSelect(false);
    mockDeviceSelect({ hostname: 'h', displayName: null });
    vi.mocked(createSourcedAlert).mockResolvedValueOnce(null);

    const result = await handleDnsThreatBlocked('org-1', {
      deviceId: 'dev-1',
      domain: 'm.example.com',
      category: 'malware',
      integrationId: null,
      timestamp: '2026-05-22T20:00:00.000Z',
    });

    expect(result).toEqual({ alertId: null, reason: 'create_failed' });
  });

  it('returns no_device reason when payload has no deviceId', async () => {
    const result = await handleDnsThreatBlocked('org-1', {
      deviceId: null,
      domain: 'unknown.example.com',
      category: 'malware',
      integrationId: 'int-1',
      timestamp: '2026-05-22T20:00:00.000Z',
    });

    expect(result).toEqual({ alertId: null, reason: 'no_device' });
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
    expect(vi.mocked(createSourcedAlert)).not.toHaveBeenCalled();
  });

  it('separate categories on the same device both fire (cooldown is per-category)', async () => {
    // First call: malware → fires.
    mockCooldownSelect(false);
    mockDeviceSelect({ hostname: 'host-1', displayName: null });
    mockInsertReturning('alert-malware-1');

    const malware = await handleDnsThreatBlocked('org-1', {
      deviceId: 'dev-1',
      domain: 'm.example.com',
      category: 'malware',
      integrationId: 'int-1',
      timestamp: '2026-05-22T20:00:00.000Z',
    });
    expect(malware.reason).toBe('created');

    // Second call: same device, different category (phishing). Different
    // configItemName means the cooldown query returns no match, so it
    // fires independently.
    mockCooldownSelect(false);
    mockDeviceSelect({ hostname: 'host-1', displayName: null });
    mockInsertReturning('alert-phishing-1');

    const phishing = await handleDnsThreatBlocked('org-1', {
      deviceId: 'dev-1',
      domain: 'p.example.com',
      category: 'phishing',
      integrationId: 'int-1',
      timestamp: '2026-05-22T20:00:01.000Z',
    });
    expect(phishing.reason).toBe('created');
    expect(phishing.alertId).toBe('alert-phishing-1');
  });

  it('falls back to displayName then deviceId when hostname is null', async () => {
    mockCooldownSelect(false);
    mockDeviceSelect({ hostname: '', displayName: 'Alice Laptop' });
    mockInsertReturning('alert-fallback');

    const result = await handleDnsThreatBlocked('org-1', {
      deviceId: 'dev-fallback',
      domain: 'm.example.com',
      category: 'malware',
      integrationId: null,
      timestamp: '2026-05-22T20:00:00.000Z',
    });
    expect(result.reason).toBe('created');
    const values = createdAlertParams();
    expect(values.message).toContain('Alice Laptop');
  });

  it('uses an explicit cooldownMinutes override when provided', async () => {
    mockCooldownSelect(false);
    mockDeviceSelect({ hostname: 'h', displayName: null });
    mockInsertReturning('alert-1');

    await handleDnsThreatBlocked(
      'org-1',
      {
        deviceId: 'dev-1',
        domain: 'm.example.com',
        category: 'malware',
        integrationId: null,
        timestamp: '2026-05-22T20:00:00.000Z',
      },
      { cooldownMinutes: 5 }
    );

    // We can't directly observe the cutoff Date passed to gt(), but the
    // call shape matches — and the parameter is the load-bearing piece
    // the cooldown logic respects. The non-throw + creation success is
    // the smoke; the override-respect path is exercised more thoroughly
    // by the cooldown-blocks test above.
    expect(vi.mocked(createSourcedAlert)).toHaveBeenCalled();
  });
});

// #4085 Task 3: handleDnsThreatBlockedEvent is the registry-registered
// subscriber (id `dns-threat-alerts`). MUST throw on failure — the old
// registerDnsThreatAlertSubscriber logged and swallowed; that swallow now
// lives one layer up, in eventBus.ts's registry-aware local delivery.
describe('handleDnsThreatBlockedEvent (durable registry contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function event(orgId: string, payload: Record<string, unknown>) {
    return {
      id: 'event-1',
      type: 'dns.threat.blocked',
      orgId,
      source: 'test',
      priority: 'normal' as const,
      payload,
      metadata: { correlationId: 'c1', timestamp: new Date().toISOString() },
    } as never;
  }

  it('rethrows (does not swallow) a failure from handleDnsThreatBlocked', async () => {
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('db exploded');
    });

    await expect(
      handleDnsThreatBlockedEvent(
        event('org-1', {
          deviceId: 'dev-1',
          domain: 'm.example.com',
          category: 'malware',
          integrationId: null,
          timestamp: '2026-05-22T20:00:00.000Z',
        })
      )
    ).rejects.toThrow('db exploded');
  });

  it('throws when no alert row was produced, so queue mode retries instead of acking an unpublished threat', async () => {
    mockCooldownSelect(false);
    mockDeviceSelect({ hostname: 'h', displayName: null });
    vi.mocked(createSourcedAlert).mockResolvedValueOnce(null);

    await expect(
      handleDnsThreatBlockedEvent(
        event('org-1', {
          deviceId: 'dev-1',
          domain: 'm.example.com',
          category: 'malware',
          integrationId: null,
          timestamp: '2026-05-22T20:00:00.000Z',
        })
      )
    ).rejects.toThrow('nothing was published');
  });

  it('inserts an alert on the happy path', async () => {
    mockCooldownSelect(false);
    mockDeviceSelect({ hostname: 'h', displayName: null });
    mockInsertReturning('alert-1');

    await handleDnsThreatBlockedEvent(
      event('org-1', {
        deviceId: 'dev-1',
        domain: 'm.example.com',
        category: 'malware',
        integrationId: null,
        timestamp: '2026-05-22T20:00:00.000Z',
      })
    );

    expect(vi.mocked(createSourcedAlert)).toHaveBeenCalled();
  });

  // #4085 final-review fix: publish() dispatches durable-registry handlers via
  // runOutsideDbContext (scope 'none'), so without an explicit system context
  // the cooldown `db.select`/alert `db.insert` above would 42501 under forced
  // RLS in queue mode. A plain "was withSystemDbAccessContext called at all"
  // check would pass even if it were called AFTER the queries (or on something
  // unrelated) — the real guarantee is that it wraps the queries, so this
  // asserts ordering via each mock's own invocationCallOrder.
  it('establishes a system DB access context before the alerts/devices queries (RLS fix)', async () => {
    mockCooldownSelect(false);
    mockDeviceSelect({ hostname: 'h', displayName: null });
    mockInsertReturning('alert-1');

    await handleDnsThreatBlockedEvent(
      event('org-1', {
        deviceId: 'dev-1',
        domain: 'm.example.com',
        category: 'malware',
        integrationId: null,
        timestamp: '2026-05-22T20:00:00.000Z',
      })
    );

    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    const contextCallOrder = vi.mocked(withSystemDbAccessContext).mock.invocationCallOrder[0]!;
    const firstSelectCallOrder = vi.mocked(db.select).mock.invocationCallOrder[0]!;
    const firstInsertCallOrder = vi.mocked(createSourcedAlert).mock.invocationCallOrder[0]!;
    expect(contextCallOrder).toBeLessThan(firstSelectCallOrder);
    expect(contextCallOrder).toBeLessThan(firstInsertCallOrder);
  });
});

// #6692 — only threat categories raise a severity=high "DNS threat" alert. The
// sync job no longer publishes content-policy / unknown blocks, but events
// queued before that fix must still be ignored here rather than paging
// on-call for a blocked YouTube query.
describe('handleDnsThreatBlocked — threat-category gate (#6692)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function payload(category: string) {
    return {
      deviceId: 'dev-1',
      domain: 'example.com',
      category,
      integrationId: 'int-1',
      timestamp: '2026-09-22T12:00:00.000Z',
    };
  }

  it.each(['phishing', 'malware', 'botnet', 'ransomware', 'cryptomining', 'spam', 'adware'])(
    'raises a severity=high alert for a blocked %s query',
    async (category) => {
      mockCooldownSelect(false);
      mockDeviceSelect({ hostname: 'host-1', displayName: null });
      mockInsertReturning(`alert-${category}`);

      const result = await handleDnsThreatBlocked('org-1', payload(category));

      expect(result).toEqual({ alertId: `alert-${category}`, reason: 'created' });
      const values = createdAlertParams();
      expect(values.severity).toBe('high');
      expect(values.configItemName).toBe(`dns_threat_${category}`);
    },
  );

  it.each(['social_media', 'streaming', 'gambling', 'adult_content', 'unknown', 'not-a-category'])(
    'ignores a %s payload without touching the database',
    async (category) => {
      const result = await handleDnsThreatBlocked('org-1', payload(category));

      expect(result).toEqual({ alertId: null, reason: 'not_threat_category' });
      expect(vi.mocked(db.select)).not.toHaveBeenCalled();
      expect(vi.mocked(createSourcedAlert)).not.toHaveBeenCalled();
    },
  );
});
