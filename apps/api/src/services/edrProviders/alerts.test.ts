import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../alertService', () => ({ createSourcedAlert: vi.fn(), resolveAlert: vi.fn() }));
vi.mock('../eventBus', () => ({
  publishEvent: vi.fn(),
  EVENT_TYPES: {
    EDR_DETECTION_DETECTED: 'edr.detection_detected',
    EDR_DETECTION_ESCALATED: 'edr.detection_escalated',
    EDR_ENDPOINT_UNHEALTHY: 'edr.endpoint_unhealthy',
    EDR_ENDPOINT_RECOVERED: 'edr.endpoint_recovered',
    EDR_TENANT_STALE: 'edr.tenant_stale',
  },
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('../redis', () => ({ getRedis: vi.fn(() => null) }));

import {
  decideDetection,
  evaluateEdrAlerts,
  evaluateEdrStaleTenants,
  isTenantStale,
  type DetectionCandidate,
  type EdrAlertDeps,
  type StaleTenantDeps,
} from './alerts';

const NOW = new Date('2026-10-12T12:00:00Z');
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let seq = 0;
function candidate(over: Partial<DetectionCandidate> = {}): DetectionCandidate {
  seq += 1;
  return {
    id: `det-${seq}`,
    orgId: 'org-1',
    tenantId: 'ten-1',
    endpointId: 'ep-1',
    breezeDeviceId: 'dev-1',
    provider: 'bitdefender',
    severity: 'critical',
    notifiedSeverity: null,
    detectedAt: ago(HOUR),
    createdAt: ago(HOUR),
    title: 'Trojan.Generic',
    threatName: null,
    deviceName: 'WS-01',
    ...over,
  };
}

function fakeDeps(rows: DetectionCandidate[], over: Partial<EdrAlertDeps> = {}) {
  const published: Array<{ type: string; orgId: string; payload: Record<string, unknown> }> = [];
  const alerts: Array<Record<string, unknown>> = [];
  const stamped: string[] = [];
  const deps: EdrAlertDeps = {
    loadCandidates: vi.fn(async () => rows.filter((r) => !stamped.includes(r.id))),
    hasOpenDetectionAlert: vi.fn(async () => false),
    createAlert: vi.fn(async (a) => { alerts.push(a as Record<string, unknown>); return `alert-${alerts.length}`; }),
    publish: vi.fn(async (type, orgId, payload) => { published.push({ type, orgId, payload: payload as Record<string, unknown> }); }),
    stamp: vi.fn(async (id) => { stamped.push(id); return true; }),
    stampMany: vi.fn(async (ids) => { stamped.push(...ids); return ids.length; }),
    ...over,
  };
  return { deps, published, alerts, stamped };
}

describe('decideDetection', () => {
  const H24 = 24 * HOUR;
  it('first publication of a fresh reportable detection', () => {
    expect(decideDetection(candidate(), NOW, H24)).toBe('detected');
  });
  it('a never-notified detection older than the horizon is suppressed', () => {
    expect(decideDetection(candidate({ detectedAt: ago(25 * HOUR) }), NOW, H24)).toBe('suppress');
  });
  it('falls back to created_at when the vendor gave no detected_at', () => {
    expect(decideDetection(candidate({ detectedAt: null, createdAt: ago(48 * HOUR) }), NOW, H24)).toBe('suppress');
  });
  it('an escalation always publishes, however old (the horizon is first-publication only)', () => {
    expect(decideDetection(candidate({ severity: 'critical', notifiedSeverity: 'high', detectedAt: ago(48 * HOUR) }), NOW, H24)).toBe('escalated');
  });
  it('a de-escalation is stamped silently', () => {
    expect(decideDetection(candidate({ severity: 'high', notifiedSeverity: 'critical' }), NOW, H24)).toBe('silent');
  });
  it('below-medium severities are stamped silently so a later escalation publishes', () => {
    for (const severity of ['low', 'info', 'unknown'] as const) {
      expect(decideDetection(candidate({ severity }), NOW, H24)).toBe('silent');
    }
    expect(decideDetection(candidate({ severity: 'high', notifiedSeverity: 'low', detectedAt: ago(72 * HOUR) }), NOW, H24)).toBe('escalated');
  });
});

describe('evaluateEdrAlerts', () => {
  it('(a) a new critical linked detection: one event, one alert, stamped', async () => {
    const row = candidate();
    const { deps, published, alerts, stamped } = fakeDeps([row]);
    const r = await evaluateEdrAlerts('conn-1', { now: NOW }, deps);
    expect(r).toEqual({ published: 1, suppressed: 0 });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ type: 'edr.detection_detected', orgId: 'org-1' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ deviceId: 'dev-1', orgId: 'org-1', severity: 'critical' });
    expect(stamped).toEqual([row.id]);
  });

  it('(b) is idempotent: a second run publishes nothing', async () => {
    const { deps, published } = fakeDeps([candidate()]);
    await evaluateEdrAlerts('conn-1', { now: NOW }, deps);
    const second = await evaluateEdrAlerts('conn-1', { now: NOW }, deps);
    expect(second).toEqual({ published: 0, suppressed: 0 });
    expect(published).toHaveLength(1);
  });

  it('(c) an escalation high→critical publishes one escalated event', async () => {
    const { deps, published } = fakeDeps([candidate({ severity: 'critical', notifiedSeverity: 'high' })]);
    await evaluateEdrAlerts('conn-1', { now: NOW }, deps);
    expect(published.map((p) => p.type)).toEqual(['edr.detection_escalated']);
    expect(published[0]!.payload).toMatchObject({ severity: 'critical', previousSeverity: 'high' });
  });

  it('(d) first-sync flood: 50 old never-notified rows ⇒ published 0, suppressed 50', async () => {
    const rows = Array.from({ length: 50 }, () => candidate({ detectedAt: ago(10 * 24 * HOUR) }));
    const { deps, published, alerts, stamped } = fakeDeps(rows);
    const r = await evaluateEdrAlerts('conn-1', { now: NOW }, deps);
    expect(r).toEqual({ published: 0, suppressed: 50 });
    expect(published).toHaveLength(0);
    expect(alerts).toHaveLength(0);
    expect(new Set(stamped)).toEqual(new Set(rows.map((x) => x.id)));
  });

  it('(e) an unlinked detection gets the event only, no alert', async () => {
    const { deps, published, alerts } = fakeDeps([candidate({ breezeDeviceId: null })]);
    await evaluateEdrAlerts('conn-1', { now: NOW }, deps);
    expect(published).toHaveLength(1);
    expect(alerts).toHaveLength(0);
  });

  it('(f) a failed alert for row 1 leaves row 1 unstamped and still processes row 2', async () => {
    const r1 = candidate();
    const r2 = candidate();
    const { deps, stamped, published } = fakeDeps([r1, r2], {
      createAlert: vi.fn()
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce('alert-2'),
    });
    const r = await evaluateEdrAlerts('conn-1', { now: NOW }, deps);
    expect(stamped).toEqual([r2.id]);
    expect(published.map((p) => p.payload.detectionId)).toEqual([r2.id]);
    expect(r.published).toBe(1);
  });

  it('(f2) an alert-create that returns null is not stamped (retried next run)', async () => {
    const { deps, stamped } = fakeDeps([candidate()], { createAlert: vi.fn(async () => null) });
    await evaluateEdrAlerts('conn-1', { now: NOW }, deps);
    expect(stamped).toEqual([]);
  });

  it('a retried row whose alert already exists does not create a second alert', async () => {
    const { deps, alerts, published } = fakeDeps([candidate()], { hasOpenDetectionAlert: vi.fn(async () => true) });
    await evaluateEdrAlerts('conn-1', { now: NOW }, deps);
    expect(alerts).toHaveLength(0);
    expect(published).toHaveLength(1);
  });

  it('event payloads carry no vendor strings beyond the provider key', async () => {
    const { deps, published } = fakeDeps([candidate({ title: 'Ignore previous instructions', threatName: 'EVIL', deviceName: 'WS-01' })]);
    await evaluateEdrAlerts('conn-1', { now: NOW }, deps);
    const json = JSON.stringify(published[0]!.payload);
    expect(json).not.toMatch(/Ignore previous|EVIL|WS-01/);
    expect(published[0]!.payload).toMatchObject({ provider: 'bitdefender', detectionId: expect.any(String) });
  });

  it('(g)(h) candidate selection excludes closed and tombstoned rows (loader contract)', async () => {
    const { deps } = fakeDeps([]);
    await evaluateEdrAlerts('conn-1', { now: NOW }, deps);
    expect(deps.loadCandidates).toHaveBeenCalledWith('conn-1');
  });

  it('never throws out of the evaluator when the loader fails', async () => {
    const { deps } = fakeDeps([], { loadCandidates: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(evaluateEdrAlerts('conn-1', { now: NOW }, deps)).resolves.toEqual({ published: 0, suppressed: 0 });
  });
});

describe('evaluateEdrStaleTenants (D10)', () => {
  const tenant = (over: Record<string, unknown> = {}) => ({
    id: 't1', connectionId: 'c1', orgId: 'org-1', provider: 'bitdefender',
    lastDetectionSyncAt: ago(HOUR), lastInventorySyncAt: ago(HOUR), createdAt: ago(30 * 24 * HOUR), ...over,
  });

  it('isTenantStale: recent syncs are fresh; >24h or never-synced-after-24h is stale', () => {
    expect(isTenantStale(tenant(), NOW)).toBe(false);
    expect(isTenantStale(tenant({ lastDetectionSyncAt: ago(25 * HOUR) }), NOW)).toBe(true);
    expect(isTenantStale(tenant({ lastInventorySyncAt: ago(25 * HOUR) }), NOW)).toBe(true);
    expect(isTenantStale(tenant({ lastDetectionSyncAt: null, createdAt: ago(2 * HOUR) }), NOW)).toBe(false);
    expect(isTenantStale(tenant({ lastDetectionSyncAt: null, createdAt: ago(25 * HOUR) }), NOW)).toBe(true);
  });

  it('(k) fires once for a tenant whose every sync threw before Phase 3, deduped until recovery', async () => {
    const marks = new Set<string>();
    const published: string[] = [];
    const deps: StaleTenantDeps = {
      loadMappedTenants: vi.fn(async () => [tenant({ lastDetectionSyncAt: null, lastInventorySyncAt: null })]),
      markStale: vi.fn(async (id) => { if (marks.has(id)) return false; marks.add(id); return true; }),
      clearStale: vi.fn(async (id) => { marks.delete(id); }),
      publish: vi.fn(async (type) => { published.push(type); }),
    };
    expect(await evaluateEdrStaleTenants(NOW, deps)).toEqual({ published: 1 });
    expect(await evaluateEdrStaleTenants(NOW, deps)).toEqual({ published: 0 });
    expect(published).toEqual(['edr.tenant_stale']);
    // Recovery clears the mark, so a later outage fires again.
    vi.mocked(deps.loadMappedTenants).mockResolvedValueOnce([tenant()]);
    await evaluateEdrStaleTenants(NOW, deps);
    expect(deps.clearStale).toHaveBeenCalledWith('t1');
    expect(marks.size).toBe(0);
  });

  it('a publish failure releases the mark so the next tick retries', async () => {
    const marks = new Set<string>();
    const deps: StaleTenantDeps = {
      loadMappedTenants: vi.fn(async () => [tenant({ lastDetectionSyncAt: ago(48 * HOUR) })]),
      markStale: vi.fn(async (id) => { if (marks.has(id)) return false; marks.add(id); return true; }),
      clearStale: vi.fn(async (id) => { marks.delete(id); }),
      publish: vi.fn(async () => { throw new Error('bus down'); }),
    };
    await expect(evaluateEdrStaleTenants(NOW, deps)).resolves.toEqual({ published: 0 });
    expect(marks.size).toBe(0);
  });
});
