import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const USER = '99999999-9999-4999-8999-999999999999';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PARTNER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const MSG = '33333333-3333-4333-8333-333333333333';
const SITE = '10000000-0000-4000-8000-000000000001';
const dev = (n: number) => `0d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const h = vi.hoisted(() => ({
  groups: [] as Array<{ orgId: string; deviceIds: string[]; devices: Array<{ id: string; siteId: string; agentVersion: string | null }> }>,
  denied: [] as Array<{ deviceId: string; orgId: string | null }>,
  resolveTargetsDetailed: vi.fn(),
  queue: vi.fn(),
  flag: vi.fn(),
  branding: vi.fn(),
  audit: vi.fn(async () => {}),
  supports: vi.fn(),
  actorLimit: vi.fn(),
  partnerLimit: vi.fn(),
  claimCritical: vi.fn(),
  releaseCritical: vi.fn(async () => {}),
  claimIdem: vi.fn(),
  completeIdem: vi.fn(async () => {}),
  releaseIdem: vi.fn(async () => {}),
  requirePermission: vi.fn(),
  persist: vi.fn(),
  attach: vi.fn(async () => {}),
  markFailed: vi.fn(async () => {}),
  order: [] as string[],
  auth: {} as Record<string, unknown>,
  outsideDepth: 0,
}));

// Counts how deep inside runOutsideDbContext a call runs, so a test can prove
// every Redis round-trip left the request's held DB transaction.
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  runOutsideDbContext: <T,>(fn: () => T): T => {
    h.outsideDepth += 1;
    const done = () => { h.outsideDepth -= 1; };
    try {
      const r = fn();
      if (r instanceof Promise) return r.finally(done) as T;
      done();
      return r;
    } catch (e) { done(); throw e; }
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: (resource: string, action: string) => {
    h.requirePermission(resource, action);
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('permissions', { allowedSiteIds: undefined });
      await next();
    };
  },
}));
vi.mock('./resolveTargets', () => ({
  resolveTargetsDetailed: h.resolveTargetsDetailed,
}));
vi.mock('../../services/commandQueue', () => ({ queueCommandForExecution: h.queue }));
vi.mock('../../services/helperSettings', () => ({ buildHelperConfigUpdate: h.flag }));
vi.mock('../../services/endpointMessaging/brandingSnapshot', () => ({ resolveMessageBranding: h.branding }));
vi.mock('../../services/commandMinVersion', () => ({ agentSupportsMessaging: h.supports }));
vi.mock('../../services/auditEvents', () => ({ writeAuditEventAsync: h.audit }));
vi.mock('../../services/endpointMessaging/rateLimits', () => ({
  checkActorSendLimit: h.actorLimit,
  checkPartnerDeliveryLimit: h.partnerLimit,
  claimCriticalSlot: h.claimCritical,
  releaseCriticalSlot: h.releaseCritical,
}));
vi.mock('../../services/endpointMessaging/idempotency', () => ({
  claimMessageIdempotency: h.claimIdem,
  completeMessageIdempotency: h.completeIdem,
  releaseMessageIdempotency: h.releaseIdem,
}));
vi.mock('../../services/endpointMessaging/persistence', () => ({
  persistSend: h.persist,
  attachDeliveryCommand: h.attach,
  markDeliveryQueueFailed: h.markFailed,
}));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIpOrUndefined: () => '203.0.113.7' }));

import { sendRoutes } from './send';

// Captured at import: the route chain is built once, before beforeEach clears mocks.
const permissionGateCalls = h.requirePermission.mock.calls.map((c) => [...c]);

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, h.auth as never);
    await next();
  });
  app.route('/endpoint-messages', sendRoutes);
  return app;
}

const group = (orgId: string, ids: number[], agentVersion: string | null = '999.0.0') => ({
  orgId,
  deviceIds: ids.map(dev),
  devices: ids.map((n) => ({ id: dev(n), siteId: SITE, agentVersion })),
});

const baseBody = (over: Record<string, unknown> = {}) => ({
  messageId: MSG,
  targets: { deviceIds: [dev(1)] },
  title: 'Reboot tonight',
  body: 'Please save your work. See [policy](https://example.com/policy).',
  severity: 'warning',
  requiresAck: true,
  expiresInMinutes: 60,
  ...over,
});

async function post(body: unknown) {
  const res = await buildApp().request('/endpoint-messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* non-JSON body (500) */ }
  return { res, json };
}

describe('POST /endpoint-messages (#8741)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.auth = { user: { id: USER, email: 'tech@example.com' }, scope: 'partner', partnerId: PARTNER, orgId: null, accessibleOrgIds: [ORG_A, ORG_B] };
    h.groups = [group(ORG_A, [1])];
    h.denied = [];
    h.resolveTargetsDetailed.mockImplementation(async () => ({ groups: h.groups, denied: h.denied }));
    h.queue.mockImplementation(async (deviceId: string) => ({ command: { id: `cmd-${deviceId}`, status: 'sent' }, delivery: 'delivered' }));
    h.flag.mockResolvedValue({ endpointMessaging: { enabled: true } });
    h.branding.mockResolvedValue({ partnerId: PARTNER, branding: { companyName: 'Acme IT', displayName: 'Acme IT', accent: '#112233' } });
    h.supports.mockReturnValue(true);
    h.actorLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    h.partnerLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    h.claimCritical.mockResolvedValue(true);
    h.claimIdem.mockResolvedValue({ state: 'claimed' });
    h.outsideDepth = 0;
    h.order = [];
    h.persist.mockImplementation(async (args: { devices: Array<{ deviceId: string }> }) => {
      h.order.push('persist');
      return new Map(args.devices.map((d) => [d.deviceId, `del-${d.deviceId}`]));
    });
  });

  it('requires the endpoint_messages:send permission', () => {
    expect(permissionGateCalls).toContainEqual(['endpoint_messages', 'send']);
  });

  it('queues one notify_user command per device with the exact contract payload and returns 200 {batchId, deviceCount, results}', async () => {
    h.groups = [group(ORG_A, [1, 2])];
    const before = Date.now();
    const { res, json } = await post(baseBody({ targets: { deviceIds: [dev(1), dev(2)] } }));
    expect(res.status).toBe(200);
    expect(json.deviceCount).toBe(2);
    expect(json.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.results).toEqual([
      { deviceId: dev(1), orgId: ORG_A, status: 'queued', commandId: `cmd-${dev(1)}` },
      { deviceId: dev(2), orgId: ORG_A, status: 'queued', commandId: `cmd-${dev(2)}` },
    ]);
    expect(h.queue).toHaveBeenCalledTimes(2);
    const [deviceId, type, payload, options] = h.queue.mock.calls[0]!;
    expect(deviceId).toBe(dev(1));
    expect(type).toBe('notify_user');
    expect(Object.keys(payload).sort()).toEqual([
      'batchId', 'body', 'branding', 'expiresAt', 'messageId', 'persistent', 'requiresAck', 'severity', 'source', 'title', 'urgency',
    ]);
    expect(payload).toMatchObject({
      title: 'Reboot tonight',
      urgency: 'warning',
      severity: 'warning',
      messageId: MSG,
      batchId: json.batchId,
      persistent: true,
      requiresAck: true,
      source: 'endpoint_message',
      branding: { companyName: 'Acme IT', displayName: 'Acme IT', accent: '#112233' },
    });
    const expiresAt = Date.parse(payload.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60 * 60_000 - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60_000 + 1000);
    expect(options).toMatchObject({ userId: USER, expectedOrgId: ORG_A });
  });

  it('offline deliverBy is min(expiresAt, standard TTL): a 60 minute message waits at most 60 minutes', async () => {
    await post(baseBody({ expiresInMinutes: 60 }));
    const options = h.queue.mock.calls[0]![3];
    expect(options.offlinePolicy.kind).toBe('queue');
    expect(options.offlinePolicy.deliverWithinMs).toBeGreaterThan(59 * 60_000);
    expect(options.offlinePolicy.deliverWithinMs).toBeLessThanOrEqual(60 * 60_000);
  });

  it('"until closed" (expiresInMinutes null) is capped at the 168 h standard TTL', async () => {
    await post(baseBody({ expiresInMinutes: null }));
    const [, , payload, options] = h.queue.mock.calls[0]!;
    expect(options.offlinePolicy.deliverWithinMs).toBe(168 * 3_600_000);
    const hours = (Date.parse(payload.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(167.9);
    expect(hours).toBeLessThanOrEqual(168);
  });

  it('threads aiOrigin from the auth context into the queue options', async () => {
    const aiOrigin = { surface: 'chat', sessionId: 's1' };
    h.auth = { ...h.auth, aiOrigin };
    await post(baseBody());
    expect(h.queue.mock.calls[0]![3].aiOrigin).toBe(aiOrigin);
  });

  // --- behaviour 0: rollout flag ---------------------------------------------
  it('returns 403 feature_disabled when NO target device has endpoint messaging enabled, and queues nothing', async () => {
    h.flag.mockResolvedValue({ endpointMessaging: { enabled: false } });
    const { res, json } = await post(baseBody());
    expect(res.status).toBe(403);
    expect(json).toEqual({ error: 'feature_disabled' });
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.releaseIdem).toHaveBeenCalledWith(USER, MSG);
  });

  it('a device whose flag is off gets failed:feature_disabled while flagged devices are still queued', async () => {
    h.groups = [group(ORG_A, [1, 2])];
    h.flag.mockImplementation(async (deviceId: string) => ({ endpointMessaging: { enabled: deviceId === dev(2) } }));
    const { res, json } = await post(baseBody({ targets: { deviceIds: [dev(1), dev(2)] } }));
    expect(res.status).toBe(200);
    expect(json.results[0]).toMatchObject({ deviceId: dev(1), status: 'failed', errorCode: 'feature_disabled' });
    expect(json.results[1]).toMatchObject({ deviceId: dev(2), status: 'queued' });
    expect(h.queue).toHaveBeenCalledTimes(1);
  });

  it('treats a settings entry cached before the flag existed as disabled', async () => {
    h.flag.mockResolvedValue({ enabled: true });
    const { res } = await post(baseBody());
    expect(res.status).toBe(403);
  });

  // --- behaviour 1: caps and confirmation ------------------------------------
  it('above 100 devices requires confirmedCount equal to the resolved count: 409 confirmation_required with the count', async () => {
    h.groups = [group(ORG_A, Array.from({ length: 101 }, (_, i) => i + 1))];
    const { res, json } = await post(baseBody({ targets: { orgId: ORG_A } }));
    expect(res.status).toBe(409);
    expect(json).toEqual({ error: 'confirmation_required', deviceCount: 101 });
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.releaseIdem).toHaveBeenCalled();

    const wrong = await post(baseBody({ targets: { orgId: ORG_A }, confirmedCount: 100 }));
    expect(wrong.res.status).toBe(409);
  });

  it('above 100 devices proceeds when confirmedCount matches', async () => {
    h.groups = [group(ORG_A, Array.from({ length: 101 }, (_, i) => i + 1))];
    const { res, json } = await post(baseBody({ targets: { orgId: ORG_A }, confirmedCount: 101 }));
    expect(res.status).toBe(200);
    expect(json.deviceCount).toBe(101);
    expect(h.queue).toHaveBeenCalledTimes(101);
  });

  it('exactly 100 devices needs no confirmation', async () => {
    h.groups = [group(ORG_A, Array.from({ length: 100 }, (_, i) => i + 1))];
    const { res } = await post(baseBody({ targets: { orgId: ORG_A } }));
    expect(res.status).toBe(200);
  });

  it('above 5000 devices is cap_exceeded (400) even with a matching confirmedCount', async () => {
    h.groups = [group(ORG_A, Array.from({ length: 5001 }, (_, i) => i + 1))];
    const { res, json } = await post(baseBody({ targets: { orgId: ORG_A }, confirmedCount: 5001 }));
    expect(res.status).toBe(400);
    expect(json).toEqual({ error: 'cap_exceeded', deviceCount: 5001 });
    expect(h.queue).not.toHaveBeenCalled();
  });

  // --- behaviour 2: snapshot + per-device authorization ----------------------
  it('denied (inaccessible) devices are reported failed:no_permission and the rest still queue', async () => {
    h.groups = [group(ORG_A, [1])];
    h.denied = [{ deviceId: dev(9), orgId: ORG_B }];
    const { res, json } = await post(baseBody({ targets: { deviceIds: [dev(1), dev(9)] } }));
    expect(res.status).toBe(200);
    expect(json.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: dev(1), status: 'queued' }),
      { deviceId: dev(9), orgId: ORG_B, status: 'failed', errorCode: 'no_permission' },
    ]));
    expect(h.queue).toHaveBeenCalledTimes(1);
  });

  it('a request where nothing resolves is a 400 no_devices_resolved, not a silent success', async () => {
    h.groups = [];
    h.denied = [];
    const { res, json } = await post(baseBody({ targets: { siteIds: [SITE] } }));
    expect(res.status).toBe(400);
    expect(json.error).toBe('no_devices_resolved');
  });

  it('passes the caller\'s site permissions to target resolution', async () => {
    await post(baseBody());
    expect(h.resolveTargetsDetailed.mock.calls[0]![2]).toEqual({ permissions: { allowedSiteIds: undefined } });
  });

  // --- behaviour 3: idempotency (Review Focus 7) -----------------------------
  it('replaying the same messageId returns the first response and queues nothing new', async () => {
    const first = { batchId: 'b-1', deviceCount: 1, results: [{ deviceId: dev(1), orgId: ORG_A, status: 'queued', commandId: 'c-1' }] };
    h.claimIdem.mockResolvedValue({ state: 'replay', body: first });
    const { res, json } = await post(baseBody());
    expect(res.status).toBe(200);
    expect(json).toEqual(first);
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.resolveTargetsDetailed).not.toHaveBeenCalled();
    expect(h.actorLimit).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('claims idempotency per (actor, messageId) and stores the 200 body for replay', async () => {
    const { json } = await post(baseBody());
    expect(h.claimIdem).toHaveBeenCalledWith(USER, MSG, expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(h.completeIdem).toHaveBeenCalledWith(USER, MSG, expect.stringMatching(/^[0-9a-f]{64}$/), json);
  });

  it('a concurrent duplicate while the first is in flight gets 409 in_progress and queues nothing', async () => {
    h.claimIdem.mockResolvedValue({ state: 'in_progress' });
    const { res, json } = await post(baseBody());
    expect(res.status).toBe(409);
    expect(json.error).toBe('in_progress');
    expect(h.queue).not.toHaveBeenCalled();
  });

  it('503s (queues nothing) when the idempotency store is unavailable', async () => {
    h.claimIdem.mockResolvedValue({ state: 'unavailable' });
    const { res } = await post(baseBody());
    expect(res.status).toBe(503);
    expect(h.queue).not.toHaveBeenCalled();
  });

  // --- behaviour 4: rate limits ----------------------------------------------
  it('429 rate_limited with retryAfterSeconds when the actor limit trips, releasing the idempotency key', async () => {
    h.actorLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 321 });
    const { res, json } = await post(baseBody());
    expect(res.status).toBe(429);
    expect(json).toEqual({ error: 'rate_limited', retryAfterSeconds: 321 });
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.releaseIdem).toHaveBeenCalledWith(USER, MSG);
  });

  it('429 rate_limited when the partner delivery budget trips; cost is the number of eligible deliveries', async () => {
    h.groups = [group(ORG_A, [1, 2, 3])];
    h.partnerLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 77 });
    const { res, json } = await post(baseBody({ targets: { deviceIds: [dev(1), dev(2), dev(3)] } }));
    expect(res.status).toBe(429);
    expect(json).toEqual({ error: 'rate_limited', retryAfterSeconds: 77 });
    expect(h.partnerLimit).toHaveBeenCalledWith(PARTNER, 3);
    expect(h.queue).not.toHaveBeenCalled();
  });

  it('a rejected confirmation does not consume the actor send budget', async () => {
    h.groups = [group(ORG_A, Array.from({ length: 150 }, (_, i) => i + 1))];
    await post(baseBody({ targets: { orgId: ORG_A } }));
    expect(h.actorLimit).not.toHaveBeenCalled();
  });

  it('critical: a device that already got a critical in the last 5 minutes is failed:rate_limited, others queue', async () => {
    h.groups = [group(ORG_A, [1, 2])];
    h.claimCritical.mockImplementation(async (id: string) => id !== dev(1));
    const { res, json } = await post(baseBody({ severity: 'critical', targets: { deviceIds: [dev(1), dev(2)] } }));
    expect(res.status).toBe(200);
    expect(json.results[0]).toMatchObject({ deviceId: dev(1), status: 'failed', errorCode: 'rate_limited' });
    expect(json.results[1]).toMatchObject({ deviceId: dev(2), status: 'queued' });
    expect(h.queue).toHaveBeenCalledTimes(1);
  });

  it('non-critical severities never touch the critical limiter', async () => {
    await post(baseBody({ severity: 'warning' }));
    expect(h.claimCritical).not.toHaveBeenCalled();
  });

  it('a critical slot is returned when the command could not be queued', async () => {
    h.queue.mockResolvedValue({ error: 'boom' });
    await post(baseBody({ severity: 'critical' }));
    expect(h.releaseCritical).toHaveBeenCalledWith(dev(1));
  });

  // --- behaviour 5: version gate (Review Focus 3) ----------------------------
  it('does not queue to an agent below the messaging gate', async () => {
    h.supports.mockReturnValue(false);
    h.groups = [group(ORG_A, [1], '0.0.1')];
    const { res, json } = await post(baseBody());
    expect(res.status).toBe(200);
    expect(json.results[0]).toMatchObject({ status: 'failed', errorCode: 'agent_unsupported' });
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.supports).toHaveBeenCalledWith('0.0.1');
  });

  it('agent_unsupported devices are not charged against the partner budget', async () => {
    h.supports.mockReturnValue(false);
    await post(baseBody());
    expect(h.partnerLimit).not.toHaveBeenCalledWith(PARTNER, 1);
  });

  // --- behaviour 6: branding --------------------------------------------------
  it('fails closed (nothing queued) when branding cannot be resolved for an org', async () => {
    h.branding.mockResolvedValue(null);
    const { json } = await post(baseBody());
    expect(json.results[0]).toMatchObject({ status: 'failed', errorCode: 'queue_failed' });
    expect(h.queue).not.toHaveBeenCalled();
  });

  it('resolves branding once per org, from the org (never the body)', async () => {
    h.groups = [group(ORG_A, [1, 2]), group(ORG_B, [3])];
    await post(baseBody({ targets: { deviceIds: [dev(1), dev(2), dev(3)] } }));
    expect(h.branding).toHaveBeenCalledTimes(2);
    expect(h.branding.mock.calls.map((c) => c[0]).sort()).toEqual([ORG_A, ORG_B].sort());
  });

  // --- queue outcomes ---------------------------------------------------------
  it('per-device failure isolation: a throw for one device is failed:queue_failed and the others are still queued', async () => {
    h.groups = [group(ORG_A, [1, 2, 3])];
    h.queue.mockImplementation(async (deviceId: string) => {
      if (deviceId === dev(2)) throw new Error('connection reset');
      return { command: { id: `cmd-${deviceId}`, status: 'sent' }, delivery: 'delivered' };
    });
    const { res, json } = await post(baseBody({ targets: { deviceIds: [dev(1), dev(2), dev(3)] } }));
    expect(res.status).toBe(200);
    expect(json.results.map((r: any) => [r.deviceId, r.status, r.errorCode])).toEqual([
      [dev(1), 'queued', undefined],
      [dev(2), 'failed', 'queue_failed'],
      [dev(3), 'queued', undefined],
    ]);
    expect(JSON.stringify(json)).not.toContain('connection reset');
  });

  it('maps a partner-trust denial to no_permission and an offline refusal to offline_rejected', async () => {
    h.groups = [group(ORG_A, [1, 2])];
    h.queue.mockImplementation(async (deviceId: string) =>
      deviceId === dev(1)
        ? { error: 'TRUST_PROBATION', trust: { code: 'TRUST_PROBATION', reason: 'probation_default_deny' } }
        : { error: 'Device is offline' });
    const { json } = await post(baseBody({ targets: { deviceIds: [dev(1), dev(2)] } }));
    expect(json.results[0]).toMatchObject({ errorCode: 'no_permission' });
    expect(json.results[1]).toMatchObject({ errorCode: 'offline_rejected' });
  });

  // --- behaviour 8: audit (never the body) -----------------------------------
  it('writes one audit row per org group with counts, severity, body hash and length but NEVER the title or body text', async () => {
    h.groups = [group(ORG_A, [1, 2]), group(ORG_B, [3])];
    h.queue.mockImplementation(async (deviceId: string) =>
      deviceId === dev(2) ? { error: 'x' } : { command: { id: `c-${deviceId}`, status: 'sent' }, delivery: 'delivered' });
    const secret = 'secret phone number 555-0100';
    const { json } = await post(baseBody({
      title: 'Confidential heading',
      body: secret,
      targets: { deviceIds: [dev(1), dev(2), dev(3)] },
    }));
    expect(h.audit).toHaveBeenCalledTimes(2);
    const rows = h.audit.mock.calls.map((c) => (c as unknown as [unknown, Record<string, any>])[1]);
    const rowA = rows.find((r) => r.orgId === ORG_A)!;
    const rowB = rows.find((r) => r.orgId === ORG_B)!;
    for (const row of rows) {
      const text = JSON.stringify(row);
      expect(text).not.toContain('secret phone number');
      expect(text).not.toContain('Confidential heading');
      expect(row.details.bodySha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.details.bodySha256).toBe(createHash('sha256').update(secret).digest('hex'));
      expect(row.details.bodyLength).toBe(secret.length);
      expect(row).toMatchObject({
        action: 'endpoint_message.send',
        resourceType: 'endpoint_message',
        resourceId: MSG,
        actorId: USER,
      });
      expect(row.details).toMatchObject({ batchId: json.batchId, messageId: MSG, severity: 'warning', targetMode: 'devices' });
    }
    expect(rowA.details).toMatchObject({ deviceCount: 2, queued: 1, failed: 1 });
    expect(rowB.details).toMatchObject({ deviceCount: 1, queued: 1, failed: 0 });
  });

  it('records the target mode for site / group / org selections', async () => {
    await post(baseBody({ targets: { siteIds: [SITE] } }));
    expect((h.audit.mock.calls[0] as unknown as [unknown, Record<string, any>])[1].details.targetMode).toBe('sites');
  });

  it('stores nothing and queues nothing for an invalid body (http link, image, html)', async () => {
    for (const bad of [
      'visit [x](http://insecure.example)',
      '![img](https://example.com/a.png)',
      '<script>alert(1)</script>',
    ]) {
      const { res } = await post(baseBody({ body: bad }));
      expect(res.status).toBe(400);
    }
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.claimIdem).not.toHaveBeenCalled();
  });

  it('a request that throws unexpectedly releases the idempotency key', async () => {
    h.resolveTargetsDetailed.mockRejectedValue(new Error('db down'));
    const { res } = await post(baseBody());
    expect(res.status).toBe(500);
    expect(h.releaseIdem).toHaveBeenCalledWith(USER, MSG);
  });

  // --- Redis round-trips must run outside the held DB context ----------------
  it('runs every Redis round-trip (idempotency, limits, critical slot) outside the held DB context', async () => {
    const seen: Record<string, number> = {};
    const rec = (name: string, v: unknown) => async () => { seen[name] = h.outsideDepth; return v; };
    h.claimIdem.mockImplementation(rec('claim', { state: 'claimed' }));
    h.completeIdem.mockImplementation(async () => { seen.complete = h.outsideDepth; });
    h.actorLimit.mockImplementation(rec('actor', { allowed: true, retryAfterSeconds: 0 }));
    h.partnerLimit.mockImplementation(rec('partner', { allowed: true, retryAfterSeconds: 0 }));
    h.claimCritical.mockImplementation(rec('critical', true));
    const { res } = await post(baseBody({ severity: 'critical' }));
    expect(res.status).toBe(200);
    expect(seen).toEqual({ claim: 1, actor: 1, partner: 1, critical: 1, complete: 1 });
  });

  it('releases (idempotency + critical slot) outside the held DB context too', async () => {
    const seen: Record<string, number> = {};
    h.releaseIdem.mockImplementation(async () => { seen.releaseIdem = h.outsideDepth; });
    h.releaseCritical.mockImplementation(async () => { seen.releaseCritical = h.outsideDepth; });
    h.queue.mockResolvedValue({ error: 'offline', command: undefined });
    const { res } = await post(baseBody({ severity: 'critical' }));
    expect(res.status).toBe(200);
    expect(seen).toEqual({ releaseIdem: 1, releaseCritical: 1 });
  });

  // --- idempotency fingerprint ------------------------------------------------
  it('a replay of the same id with a DIFFERENT request returns 409 idempotency_conflict and queues nothing', async () => {
    h.claimIdem.mockResolvedValue({ state: 'conflict' });
    const { res, json } = await post(baseBody());
    expect(res.status).toBe(409);
    expect(json).toEqual({ error: 'idempotency_conflict' });
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.resolveTargetsDetailed).not.toHaveBeenCalled();
    expect(h.releaseIdem).not.toHaveBeenCalled();
  });

  it('the claim fingerprint ignores confirmedCount but changes with the body', async () => {
    await post(baseBody());
    await post(baseBody({ confirmedCount: 1 }));
    await post(baseBody({ body: 'Something else entirely.' }));
    const fp = h.claimIdem.mock.calls.map((c) => c[2]);
    expect(fp[0]).toBe(fp[1]);
    expect(fp[2]).not.toBe(fp[0]);
  });

  it('a 200 with zero queued devices releases the key instead of caching the response', async () => {
    h.supports.mockReturnValue(false);
    const { res, json } = await post(baseBody());
    expect(res.status).toBe(200);
    expect(json.results[0].status).toBe('failed');
    expect(h.completeIdem).not.toHaveBeenCalled();
    expect(h.releaseIdem).toHaveBeenCalledWith(USER, MSG);
  });
  describe('W02 persistence and carry-forwards (#8742)', () => {
    it('checks confirmation_required BEFORE resolving the per-device rollout flag', async () => {
      const ids = Array.from({ length: 101 }, (_, i) => i + 1);
      h.groups = [group(ORG_A, ids)];
      const { res, json } = await post(baseBody({ targets: { deviceIds: ids.map(dev) } }));
      expect(res.status).toBe(409);
      expect(json).toEqual({ error: 'confirmation_required', deviceCount: 101 });
      expect(h.flag).not.toHaveBeenCalled();
    });

    it('resolves the rollout flag without touching the Redis settings cache (no Redis inside the request transaction)', async () => {
      await post(baseBody());
      expect(h.flag).toHaveBeenCalledWith(dev(1), ORG_A, { skipCacheRead: true, skipCacheWrite: true });
    });

    it('persists the message and every delivery before queueing any command', async () => {
      h.groups = [group(ORG_A, [1, 2])];
      h.supports.mockImplementation((v: unknown) => v !== 'old');
      h.groups[0]!.devices[1]!.agentVersion = 'old';
      h.queue.mockImplementation(async (deviceId: string) => {
        h.order.push(`queue:${deviceId}`);
        return { command: { id: `cmd-${deviceId}`, status: 'sent' } };
      });
      const { res, json } = await post(baseBody({ targets: { deviceIds: [dev(1), dev(2)] } }));
      expect(res.status).toBe(200);
      expect(h.order).toEqual(['persist', `queue:${dev(1)}`]);
      const args = h.persist.mock.calls[0]![0];
      expect(args).toMatchObject({
        batchId: json.batchId,
        clientMessageId: MSG,
        actorId: USER,
        orgGroups: [{ orgId: ORG_A }],
      });
      expect(args.devices).toEqual([
        { deviceId: dev(1), orgId: ORG_A, status: 'queued' },
        { deviceId: dev(2), orgId: ORG_A, status: 'failed', errorCode: 'agent_unsupported' },
      ]);
      expect(h.attach).toHaveBeenCalledWith(`del-${dev(1)}`, `cmd-${dev(1)}`);
      expect(h.attach).toHaveBeenCalledTimes(1);
    });

    it('records a queue refusal on the delivery row', async () => {
      h.queue.mockResolvedValue({ error: 'device offline and policy rejects', command: undefined });
      const { json } = await post(baseBody());
      expect(json.results[0]).toMatchObject({ status: 'failed', errorCode: 'offline_rejected' });
      expect(h.markFailed).toHaveBeenCalledWith(`del-${dev(1)}`, 'offline_rejected');
    });

    it('fails closed when persistence throws: nothing is queued', async () => {
      h.persist.mockRejectedValue(new Error('db down'));
      const { res } = await post(baseBody());
      expect(res.status).toBe(500);
      expect(h.queue).not.toHaveBeenCalled();
      expect(h.releaseIdem).toHaveBeenCalled();
    });
  });
});
