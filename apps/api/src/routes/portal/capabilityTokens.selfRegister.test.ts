import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';

// Portal registration W6 (plan D8): the `self_register` capability token
// family. This file runs the IN-MEMORY backend (PORTAL_USE_REDIS is false
// under NODE_ENV=test); capabilityTokens.selfRegister.redis.test.ts runs the
// Redis backend against a fake client.

vi.mock('../../db', () => ({
  db: {},
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
  runOutsideDbContext: <T>(fn: () => T) => fn(),
}));
vi.mock('../../services/tenantStatus', () => ({ getActiveOrgTenant: vi.fn() }));

import {
  consumePortalCapabilityToken,
  consumePortalSelfRegistrationToken,
  issuePortalCapabilityToken,
  issuePortalSelfRegistrationToken,
  peekPortalCapabilityToken,
  type PortalSelfRegistrationPayload,
} from './capabilityTokens';
import { portalInviteTokens, portalResetTokens, portalSelfRegisterTokens, sweepPortalState } from './helpers';
import { PORTAL_REDIS_KEYS, PORTAL_SELF_REGISTER_TOKEN_CAP, SELF_REGISTER_TTL_MS, SELF_REGISTER_TTL_SECONDS } from './schemas';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';
const USER = '11111111-2222-4333-8444-555566667777';
const FP = 'a'.repeat(64);
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
const input = (over: Partial<PortalSelfRegistrationPayload> = {}) => ({
  orgId: ORG, email: 'Pat@Contoso.Example.com ', name: 'Pat Doe', domain: 'Contoso.Example.com', policyFingerprint: FP, ...over,
});
const stored = (over: Record<string, unknown> = {}) => JSON.stringify({
  v: 2, purpose: 'self_register', orgId: ORG, email: 'pat@contoso.example.com', name: 'Pat Doe', domain: 'contoso.example.com', policyFingerprint: FP, ...over,
});
const plant = (raw: string, payload: string, ttlMs = 60_000) => {
  portalSelfRegisterTokens.set(sha(raw), { payload, expiresAt: new Date(Date.now() + ttlMs), createdAt: new Date() });
};

beforeEach(() => {
  portalInviteTokens.clear();
  portalResetTokens.clear();
  portalSelfRegisterTokens.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('self_register token (W6 D8)', () => {
  it('the Redis key is portal:self-register:<hash> and the TTL is 1800 s', () => {
    expect(PORTAL_REDIS_KEYS.selfRegisterToken('abc')).toBe('portal:self-register:abc');
    expect(SELF_REGISTER_TTL_SECONDS).toBe(1800);
    expect(SELF_REGISTER_TTL_MS).toBe(1_800_000);
    expect(PORTAL_SELF_REGISTER_TOKEN_CAP).toBe(10_000);
  });

  it('issues a self_register token stored only by sha256 with a 30-minute expiry, normalizing email and domain', async () => {
    const before = Date.now();
    const raw = await issuePortalSelfRegistrationToken(input());
    expect(raw).toEqual(expect.any(String));
    expect(raw!.length).toBeGreaterThanOrEqual(43);
    expect([...portalSelfRegisterTokens.keys()]).toEqual([sha(raw!)]);
    const entry = portalSelfRegisterTokens.get(sha(raw!))!;
    expect(entry.payload).not.toContain(raw!);
    expect(entry.expiresAt.getTime()).toBeGreaterThanOrEqual(before + SELF_REGISTER_TTL_MS);
    expect(entry.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + SELF_REGISTER_TTL_MS);
    expect(JSON.parse(entry.payload)).toEqual(JSON.parse(stored()));
  });

  it('consume returns the payload once; a second consume returns null', async () => {
    const raw = await issuePortalSelfRegistrationToken(input());
    expect(await consumePortalSelfRegistrationToken(raw!)).toEqual(JSON.parse(stored()));
    expect(await consumePortalSelfRegistrationToken(raw!)).toBeNull();
  });

  it('concurrent consumes of one self_register token: exactly one wins', async () => {
    const raw = await issuePortalSelfRegistrationToken(input());
    const results = await Promise.all(Array.from({ length: 8 }, () => consumePortalSelfRegistrationToken(raw!)));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('an expired or unknown token returns null', async () => {
    plant('expired', stored(), -1);
    expect(await consumePortalSelfRegistrationToken('expired')).toBeNull();
    expect(await consumePortalSelfRegistrationToken('never-issued')).toBeNull();
    expect(await consumePortalSelfRegistrationToken('')).toBeNull();
  });

  it('a self_register token is never accepted by the invite or reset consumers, and vice versa', async () => {
    const raw = await issuePortalSelfRegistrationToken(input());
    expect(await consumePortalCapabilityToken('invite', raw!)).toBeNull();
    expect(await consumePortalCapabilityToken('reset', raw!)).toBeNull();
    expect(await peekPortalCapabilityToken('invite', raw!)).toBeNull();
    // The other consumers did not touch the self_register key.
    expect(await consumePortalSelfRegistrationToken(raw!)).not.toBeNull();

    const invite = await issuePortalCapabilityToken({ purpose: 'invite', portalUserId: USER, orgId: ORG, email: 'a@contoso.example.com', authEpoch: 1 });
    const reset = await issuePortalCapabilityToken({ purpose: 'reset', portalUserId: USER, orgId: ORG, email: 'a@contoso.example.com', authEpoch: 1 });
    expect(await consumePortalSelfRegistrationToken(invite!)).toBeNull();
    expect(await consumePortalSelfRegistrationToken(reset!)).toBeNull();
    expect(await consumePortalCapabilityToken('invite', invite!)).not.toBeNull();
  });

  it('rejects a stored payload with a wrong purpose, version or shape (logged, never the token)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cases: Array<[string, string]> = [
      ['wrong-purpose', stored({ purpose: 'invite' })],
      ['wrong-version', stored({ v: 3 })],
      ['legacy-shape', JSON.stringify({ portalUserId: USER })],
      ['not-json', 'not json'],
      ['missing-fp', stored({ policyFingerprint: undefined })],
      ['empty-org', stored({ orgId: '' })],
      ['numeric-email', stored({ email: 5 })],
      ['empty-name', stored({ name: '' })],
      ['array', '[]'],
    ];
    for (const [raw, payload] of cases) {
      plant(raw, payload);
      expect(await consumePortalSelfRegistrationToken(raw)).toBeNull();
      // Burned even when refused.
      expect(portalSelfRegisterTokens.has(sha(raw))).toBe(false);
    }
    expect(warn).toHaveBeenCalledTimes(cases.length);
    for (const call of warn.mock.calls) {
      const text = JSON.stringify(call);
      for (const [raw] of cases) expect(text).not.toContain(sha(raw));
      expect(text).not.toContain('pat@contoso.example.com');
    }
  });

  it('the in-memory fallback map is capped and swept', async () => {
    for (let i = 0; i < PORTAL_SELF_REGISTER_TOKEN_CAP + 5; i += 1) {
      portalSelfRegisterTokens.set(`h${i}`, { payload: '{}', expiresAt: new Date(Date.now() + 3_600_000), createdAt: new Date(1_000 + i) });
    }
    portalSelfRegisterTokens.set('expired', { payload: '{}', expiresAt: new Date(Date.now() - 1), createdAt: new Date(10_000_000) });
    sweepPortalState(Date.now() + 10 * 60_000);
    expect(portalSelfRegisterTokens.has('expired')).toBe(false);
    expect(portalSelfRegisterTokens.size).toBeLessThanOrEqual(PORTAL_SELF_REGISTER_TOKEN_CAP);
    // The oldest go first.
    expect(portalSelfRegisterTokens.has('h0')).toBe(false);
    expect(portalSelfRegisterTokens.has(`h${PORTAL_SELF_REGISTER_TOKEN_CAP + 4}`)).toBe(true);
  });

  it('issue caps the in-memory map at once', async () => {
    for (let i = 0; i < PORTAL_SELF_REGISTER_TOKEN_CAP; i += 1) {
      portalSelfRegisterTokens.set(`h${i}`, { payload: '{}', expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(1_000 + i) });
    }
    const raw = await issuePortalSelfRegistrationToken(input());
    expect(portalSelfRegisterTokens.size).toBeLessThanOrEqual(PORTAL_SELF_REGISTER_TOKEN_CAP);
    expect(portalSelfRegisterTokens.has(sha(raw!))).toBe(true);
  });
});
