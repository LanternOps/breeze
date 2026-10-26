import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const stageRebindIntentMock = vi.hoisted(() => vi.fn());
const confirmRebindIntentMock = vi.hoisted(() => vi.fn());
const rateLimiterMock = vi.hoisted(() => vi.fn());
const getTrustedClientIpMock = vi.hoisted(() => vi.fn(() => '203.0.113.7'));

vi.mock('../../services/deviceReattach/stage', () => ({
  stageRebindIntent: (...args: unknown[]) => stageRebindIntentMock(...args),
}));
vi.mock('../../services/deviceReattach/confirm', () => ({
  confirmRebindIntent: (...args: unknown[]) => confirmRebindIntentMock(...args),
}));
vi.mock('../../services/rate-limit', () => ({
  rateLimiter: (...args: unknown[]) => rateLimiterMock(...args),
}));
vi.mock('../../services/redis', () => ({ getRedis: () => ({}) }));
vi.mock('../../services/clientIp', () => ({
  getTrustedClientIp: () => getTrustedClientIpMock(),
  rateLimitIpKey: (ip: string) => `ip:${ip}`,
}));
vi.mock('../../services/agentCertificateBinding', () => ({
  readAgentCertificateAssertion: () => ({ assertionTrusted: false, assertedVerified: false, assertedSerial: null }),
}));

import { REBIND_CONFIRM_FAILURE_LIMIT, REBIND_CONFIRM_IP_RATE_LIMIT, REBIND_RATE_LIMIT, rebindRoutes } from './rebind';

const AGENT_ID = 'a'.repeat(64);
const INTENT_ID = '00000000-0000-4000-8000-0000000000a1';
const HEX = (c: string) => c.repeat(64);
const STAGE_BODY = {
  intentId: INTENT_ID,
  stagedTokenHash: HEX('1'),
  stagedWatchdogTokenHash: HEX('2'),
  stagedHelperTokenHash: HEX('3'),
  confirmationTokenHash: HEX('4'),
};
const CONFIRM_TOKEN = `brz_rbc_${'z'.repeat(43)}`;
const allowed = { allowed: true, remaining: 1, resetAt: new Date(Date.now() + 60_000) };
const refused = { allowed: false, remaining: 0, resetAt: new Date(Date.now() + 120_000) };

function app(agent?: Record<string, unknown>) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    if (agent) c.set('agent', agent as never);
    await next();
  });
  a.route('/', rebindRoutes);
  return a;
}

const sourceAgent = { deviceId: 'dev-src', agentId: AGENT_ID, orgId: 'org-pool', role: 'agent' };

const post = (a: Hono, path: string, body: unknown, headers: Record<string, string> = {}) =>
  a.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  rateLimiterMock.mockResolvedValue(allowed);
});

describe('POST /:id/rebind (phase 1, #8318 §6.3)', () => {
  it('stages for the authenticated source and answers the staged identity', async () => {
    stageRebindIntentMock.mockResolvedValueOnce({
      ok: true,
      outcome: 'staged',
      intentId: INTENT_ID,
      stagedAgentId: HEX('b'),
      target: { deviceId: 'dev-tgt', orgId: 'org-a', siteId: 'site-a' },
      certificate: null,
      expiresAt: new Date('2026-10-24T12:15:00Z'),
    });
    const res = await post(app(sourceAgent), `/${AGENT_ID}/rebind`, STAGE_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      intentId: INTENT_ID,
      stagedAgentId: HEX('b'),
      target: { deviceId: 'dev-tgt', orgId: 'org-a', siteId: 'site-a' },
      certificate: null,
      expiresAt: '2026-10-24T12:15:00.000Z',
    });
    expect(stageRebindIntentMock).toHaveBeenCalledWith({ caller: { deviceId: 'dev-src', agentId: AGENT_ID }, ...STAGE_BODY });
    expect(rateLimiterMock).toHaveBeenCalledWith(expect.anything(), `agent-rebind:${AGENT_ID}`, REBIND_RATE_LIMIT.limit, REBIND_RATE_LIMIT.windowSeconds);
  });

  it('401 without an agent context; 403 for a watchdog credential (never reaches the service)', async () => {
    expect((await post(app(), `/${AGENT_ID}/rebind`, STAGE_BODY)).status).toBe(401);
    const res = await post(app({ ...sourceAgent, role: 'watchdog' }), `/${AGENT_ID}/rebind`, STAGE_BODY);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'agent_role_required' });
    expect(stageRebindIntentMock).not.toHaveBeenCalled();
  });

  it('429 with Retry-After past the per-agent limit', async () => {
    rateLimiterMock.mockResolvedValueOnce(refused);
    const res = await post(app(sourceAgent), `/${AGENT_ID}/rebind`, STAGE_BODY);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(stageRebindIntentMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing hash', { ...STAGE_BODY, confirmationTokenHash: undefined }],
    ['an uppercase hash', { ...STAGE_BODY, stagedTokenHash: HEX('A') }],
    ['a short hash', { ...STAGE_BODY, stagedHelperTokenHash: 'abc' }],
    ['a non-uuid intent', { ...STAGE_BODY, intentId: 'intent-1' }],
  ])('400 for %s', async (_label, body) => {
    expect((await post(app(sourceAgent), `/${AGENT_ID}/rebind`, body)).status).toBe(400);
    expect(stageRebindIntentMock).not.toHaveBeenCalled();
  });

  it('answers a refusal with its status, code, state and reason', async () => {
    stageRebindIntentMock.mockResolvedValueOnce({
      ok: false, status: 409, code: 'restage_refused', message: 'refused', state: 'cancelled', cancelReason: 'restage_refused',
    });
    const res = await post(app(sourceAgent), `/${AGENT_ID}/rebind`, STAGE_BODY);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'refused', code: 'restage_refused', state: 'cancelled', cancelReason: 'restage_refused' });
  });
});

describe('POST /:id/rebind-confirm (#8318 §6.4)', () => {
  const identity = { deviceId: 'dev-tgt', orgId: 'org-a', siteId: 'site-a', agentId: HEX('b') };

  it('authenticates with the confirm-only bearer and answers the identity, no secrets', async () => {
    confirmRebindIntentMock.mockResolvedValueOnce({ ok: true, identity, replay: false, intentId: INTENT_ID });
    const res = await post(app(), `/${AGENT_ID}/rebind-confirm`, {}, { authorization: `Bearer ${CONFIRM_TOKEN}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(identity);
    expect(confirmRebindIntentMock).toHaveBeenCalledWith(expect.objectContaining({ sourceAgentId: AGENT_ID, token: CONFIRM_TOKEN }));
  });

  it('a correct token is limited per client IP only, never against the per-:id failure budget', async () => {
    confirmRebindIntentMock.mockResolvedValue({ ok: true, identity, replay: true, intentId: INTENT_ID });
    await post(app(), `/${AGENT_ID}/rebind-confirm`, {}, { authorization: `Bearer ${CONFIRM_TOKEN}` });
    expect(rateLimiterMock.mock.calls.map((call) => call.slice(1))).toEqual([
      ['agent-rebind-confirm:ip:ip:203.0.113.7', REBIND_CONFIRM_IP_RATE_LIMIT.limit, REBIND_CONFIRM_IP_RATE_LIMIT.windowSeconds],
    ]);

    rateLimiterMock.mockResolvedValueOnce(refused);
    const byIp = await post(app(), `/${AGENT_ID}/rebind-confirm`, {}, { authorization: `Bearer ${CONFIRM_TOKEN}` });
    expect(byIp.status).toBe(429);
    expect(byIp.headers.get('Retry-After')).toBeTruthy();
  });

  it('a failed verification is charged to the :id after the mismatch: 401, then 429 once the budget is spent', async () => {
    confirmRebindIntentMock.mockResolvedValue({ ok: false, status: 401, code: 'invalid_confirmation', message: 'no' });
    const first = await post(app(), `/${AGENT_ID}/rebind-confirm`, {}, { authorization: `Bearer ${CONFIRM_TOKEN}` });
    expect(first.status).toBe(401);
    expect(rateLimiterMock.mock.calls.map((call) => call[1])).toEqual([
      'agent-rebind-confirm:ip:ip:203.0.113.7',
      `agent-rebind-confirm:fail:${AGENT_ID}`,
    ]);
    expect(rateLimiterMock.mock.calls[1]!.slice(2)).toEqual([REBIND_CONFIRM_FAILURE_LIMIT.limit, REBIND_CONFIRM_FAILURE_LIMIT.windowSeconds]);

    rateLimiterMock.mockResolvedValueOnce(allowed).mockResolvedValueOnce(refused);
    const spent = await post(app(), `/${AGENT_ID}/rebind-confirm`, {}, { authorization: `Bearer ${CONFIRM_TOKEN}` });
    expect(spent.status).toBe(429);
    expect(spent.headers.get('Retry-After')).toBeTruthy();
  });

  it('bogus confirms for an id do not block the correct token (the spent budget is never consulted for it)', async () => {
    // Every failure-budget charge is refused: the id's budget is spent.
    rateLimiterMock.mockImplementation(async (_redis: unknown, key: string) => (key.includes(':fail:') ? refused : allowed));
    confirmRebindIntentMock.mockResolvedValueOnce({ ok: false, status: 401, code: 'invalid_confirmation', message: 'no' });
    expect((await post(app(), `/${AGENT_ID}/rebind-confirm`, {}, { authorization: `Bearer ${CONFIRM_TOKEN}` })).status).toBe(429);
    confirmRebindIntentMock.mockResolvedValueOnce({ ok: true, identity, replay: false, intentId: INTENT_ID });
    const genuine = await post(app(), `/${AGENT_ID}/rebind-confirm`, {}, { authorization: `Bearer ${CONFIRM_TOKEN}` });
    expect(genuine.status).toBe(200);
    expect(await genuine.json()).toEqual(identity);
  });

  it.each([
    ['no bearer', {}],
    ['an agent token', { authorization: `Bearer brz_${'z'.repeat(60)}` }],
    ['a short confirm token', { authorization: 'Bearer brz_rbc_short' }],
  ])('401 for %s, without reaching the service (a failed verification)', async (_label, headers) => {
    const res = await post(app(), `/${AGENT_ID}/rebind-confirm`, {}, headers as Record<string, string>);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'invalid_confirmation' });
    expect(confirmRebindIntentMock).not.toHaveBeenCalled();
    expect(rateLimiterMock.mock.calls.map((call) => call[1])).toContain(`agent-rebind-confirm:fail:${AGENT_ID}`);
  });

  it('401 for an :id that can never be an agent id (no budget is charged for it)', async () => {
    const res = await post(app(), `/${'x'.repeat(65)}/rebind-confirm`, {}, { authorization: `Bearer ${CONFIRM_TOKEN}` });
    expect(res.status).toBe(401);
    expect(rateLimiterMock).toHaveBeenCalledTimes(1);
  });

  it('answers an ended intent with 409, its state and reason', async () => {
    confirmRebindIntentMock.mockResolvedValueOnce({
      ok: false, status: 409, code: 'cancelled', message: 'cancelled', state: 'cancelled', cancelReason: 'target_alive',
    });
    const res = await post(app(), `/${AGENT_ID}/rebind-confirm`, {}, { authorization: `Bearer ${CONFIRM_TOKEN}` });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'cancelled', code: 'cancelled', state: 'cancelled', cancelReason: 'target_alive' });
  });
});
