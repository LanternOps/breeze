import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({
  enabled: vi.fn(), lookup: vi.fn(), limit: vi.fn(), exhausted: vi.fn(), miss: vi.fn(), decide: vi.fn(),
  contexts: [] as string[], redisCalls: 0,
}));
vi.mock('../services/callerVerification/gate', () => ({ isCallerVerificationEnabled: m.enabled }));
vi.mock('../services/callerVerification/publicLookup', async (orig) => ({
  ...await orig<typeof import('../services/callerVerification/publicLookup')>(),
  lookupPublicToken: m.lookup,
}));
vi.mock('../services/callerVerification/service', () => ({ applyDecision: m.decide }));
vi.mock('../services/redis', () => ({ getRedis: () => { m.redisCalls++; return null; } }));
vi.mock('../services/rate-limit', () => ({ rateLimiter: m.limit }));
vi.mock('../services/supportCodeMissBudget', () => ({ isSupportCodeMissBudgetExhausted: m.exhausted, recordSupportCodeMiss: m.miss }));
vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => { m.contexts.push('system'); return fn(); },
}));
vi.mock('../services/clientIp', async (orig) => ({
  ...await orig<typeof import('../services/clientIp')>(),
  getTrustedClientIp: () => '198.51.100.10',
}));

import { callerVerifyPublicRoutes } from './callerVerifyPublic';
import { hashLinkToken } from '../services/callerVerification/linkChallenge';
import { CallerVerificationValidationError } from '../services/callerVerification/errors';

const app = new Hono().route('/verify', callerVerifyPublicRoutes);
const token = 'A'.repeat(43);
const path = `/verify/${token}`;
const id = '11111111-1111-4111-8111-111111111111';
const live = (over: Record<string, unknown> = {}) => ({
  id, method: 'sms', status: 'pending', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
  technicianLabel: 'Taylor', actionScope: 'reset_password', targetLabel: 'alex@example.com', reverseCode: '7291',
  challengeChoices: ['83', '42', '17'], contactName: 'Alex Example', partnerName: 'Example MSP',
  logoUrl: null, accentColor: null, headline: null, ...over,
});
const post = (body: unknown, url = path) => app.request(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  m.contexts = []; m.redisCalls = 0;
  m.enabled.mockReturnValue(true);
  m.limit.mockResolvedValue({ allowed: true, remaining: 1, resetAt: new Date() });
  m.exhausted.mockResolvedValue(false);
  m.lookup.mockResolvedValue(null);
  m.decide.mockResolvedValue({});
});

describe('flag off', () => {
  it.each(['GET', 'POST'])('%s is dark before any Redis or DB work', async (method) => {
    m.enabled.mockReturnValue(false);
    const res = method === 'GET' ? await app.request(path) : await post({ choice: '42' });
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(m.redisCalls).toBe(0);
    expect(m.limit).not.toHaveBeenCalled();
    expect(m.lookup).not.toHaveBeenCalled();
    expect(m.contexts).toEqual([]);
  });
});

describe('GET /verify/:token', () => {
  it('returns a live card with no-store, no-referrer headers and the stored choice order', async () => {
    m.lookup.mockResolvedValue(live());
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    const body = await res.json();
    expect(body).toMatchObject({ status: 'pending', choices: ['83', '42', '17'], contactFirstName: 'Alex', reverseCode: '7291' });
    expect(JSON.stringify(body)).not.toContain(id);
    expect(m.lookup).toHaveBeenCalledWith(hashLinkToken(token));
    expect(m.miss).not.toHaveBeenCalled();
    expect(m.contexts).toEqual(['system']);
  });

  it.each([
    ['unknown', null],
    ['used', live({ status: 'verified' })],
    ['rejected', live({ status: 'rejected_by_user' })],
    ['expired', live({ expiresAt: new Date(0) })],
    ['unprepared', live({ challengeChoices: null })],
  ])('answers an %s token with the identical expired body', async (_label, row) => {
    m.lookup.mockResolvedValue(row);
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'expired' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('spends miss budget only on an unknown well-formed token', async () => {
    await app.request(path);
    expect(m.miss).toHaveBeenCalledWith(null, '198.51.100.10', 'caller-verification');
    m.miss.mockClear();
    m.lookup.mockResolvedValue(live({ status: 'expired' }));
    await app.request(path);
    expect(m.miss).not.toHaveBeenCalled();
  });

  it('answers a malformed token generically without a lookup', async () => {
    const res = await app.request('/verify/short');
    expect(await res.json()).toEqual({ status: 'expired' });
    expect(m.lookup).not.toHaveBeenCalled();
    expect(m.miss).not.toHaveBeenCalled();
  });

  it('applies per-IP and per-token limits keyed without the clear token', async () => {
    m.lookup.mockResolvedValue(live());
    await app.request(path);
    const keys = m.limit.mock.calls.map((c) => c[1] as string);
    expect(keys).toContain('caller-verification:public:198.51.100.10');
    expect(keys).toContain(`caller-verification:token:${hashLinkToken(token)}`);
    expect(keys.join()).not.toContain(token);
  });

  it.each([
    ['per-IP', (key: string) => key.startsWith('caller-verification:public:')],
    ['per-token', (key: string) => key.startsWith('caller-verification:token:')],
  ])('the %s limit refuses before lookup', async (_label, match) => {
    m.limit.mockImplementation(async (_r: unknown, key: string) => ({ allowed: !match(key), remaining: 0, resetAt: new Date() }));
    expect((await app.request(path)).status).toBe(429);
    expect(m.lookup).not.toHaveBeenCalled();
  });

  it('an exhausted miss budget refuses before lookup', async () => {
    m.exhausted.mockResolvedValue(true);
    expect((await app.request(path)).status).toBe(429);
    expect(m.exhausted).toHaveBeenCalledWith(null, '198.51.100.10', 'caller-verification');
    expect(m.lookup).not.toHaveBeenCalled();
  });
});

describe('POST /verify/:token', () => {
  it.each(['42', '17', 'not_me'])('answers generically to both a miss and a resolved %s', async (choice) => {
    expect(await (await post({ choice })).json()).toEqual({ status: 'received' });
    expect(m.decide).not.toHaveBeenCalled();
    expect(m.miss).toHaveBeenCalledTimes(1);
    m.lookup.mockResolvedValue(live({ status: 'expired', expiresAt: new Date(0) }));
    const res = await post({ choice });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(await res.json()).toEqual({ status: 'received' });
    expect(m.decide).toHaveBeenCalledWith({
      verificationId: id, fromIp: '198.51.100.10',
      decision: choice === 'not_me' ? { kind: 'not_me' } : { kind: 'choice', value: choice },
    });
    // Lookup and decision share ONE short system transaction.
    expect(m.contexts).toEqual(['system', 'system']);
    expect(m.miss).toHaveBeenCalledTimes(1);
  });

  it('a CAS loser or invisible row still answers received', async () => {
    m.lookup.mockResolvedValue(live());
    m.decide.mockRejectedValueOnce(new CallerVerificationValidationError('not_found', 'gone'));
    expect(await (await post({ choice: '42' })).json()).toEqual({ status: 'received' });
  });

  it('an unexpected failure is not reported as received', async () => {
    m.lookup.mockResolvedValue(live());
    m.decide.mockRejectedValueOnce(new Error('db down'));
    expect((await post({ choice: '42' })).status).toBe(500);
  });

  it.each([{ choice: '4' }, { choice: 42 }, {}, { choice: '42', orgId: 'forged' }, { choice: 'NOT_ME' }])('rejects malformed body %j before any lookup', async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(m.lookup).not.toHaveBeenCalled();
    expect(m.decide).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON body', async () => {
    const res = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'nope' });
    expect(res.status).toBe(400);
  });

  it('never decides on a non-link row even if its hash matched', async () => {
    m.lookup.mockResolvedValue(live({ method: 'workstation' }));
    expect(await (await post({ choice: '42' })).json()).toEqual({ status: 'received' });
    expect(m.decide).not.toHaveBeenCalled();
  });

  it('returns 429 before lookup when a budget is exhausted', async () => {
    m.exhausted.mockResolvedValue(true);
    expect((await post({ choice: '42' })).status).toBe(429);
    expect(m.lookup).not.toHaveBeenCalled();
  });
});
