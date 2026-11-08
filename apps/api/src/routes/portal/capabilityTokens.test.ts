import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';

// Unit tests run the IN-MEMORY backend (PORTAL_USE_REDIS is false under
// NODE_ENV=test). The Redis path and its atomic consume are proved in
// __tests__/integration/portalCapabilityTokens.integration.test.ts.

const { rowRef, activeOrgMock } = vi.hoisted(() => ({
  rowRef: { current: null as Record<string, unknown> | null },
  activeOrgMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    select: () => {
      const chain: any = { from: () => chain, where: () => chain, limit: () => Promise.resolve(rowRef.current ? [rowRef.current] : []) };
      return chain;
    },
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
  runOutsideDbContext: <T>(fn: () => T) => fn(),
}));
vi.mock('../../services/tenantStatus', () => ({ getActiveOrgTenant: activeOrgMock }));

import {
  consumePortalCapabilityToken,
  issuePortalCapabilityToken,
  validatePortalCapability,
  type ConsumedCapability,
} from './capabilityTokens';
import { portalInviteTokens, portalResetTokens } from './helpers';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';
const OTHER_ORG = '7c0a1f7e-9999-4222-8333-444455556666';
const USER = '11111111-2222-4333-8444-555566667777';
const EMAIL = 'cust@acme.example';
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');

const invitedRow = (over: Record<string, unknown> = {}) => ({
  id: USER, orgId: ORG, email: EMAIL, name: null, passwordHash: null, authMethod: 'password',
  receiveNotifications: true, status: 'invited', authEpoch: 3, browserAccess: 'granted', entraOid: null, orgName: 'Acme',
  ...over,
});

const v2 = (over: Partial<Extract<ConsumedCapability, { format: 'v2' }>['payload']> = {}): ConsumedCapability => ({
  format: 'v2',
  payload: { v: 2, purpose: 'invite', portalUserId: USER, orgId: ORG, email: EMAIL, authEpoch: 3, ...over },
});

beforeEach(() => {
  portalInviteTokens.clear();
  portalResetTokens.clear();
  rowRef.current = invitedRow();
  activeOrgMock.mockReset();
  activeOrgMock.mockResolvedValue({ orgId: ORG, partnerId: 'p-1' });
});

describe('issue + consume', () => {
  it('round-trips a v2 invite payload once; second consume returns null', async () => {
    const raw = await issuePortalCapabilityToken({ purpose: 'invite', portalUserId: USER, orgId: ORG, email: 'Cust@Acme.example ', authEpoch: 3 });
    expect(raw).toEqual(expect.any(String));
    const first = await consumePortalCapabilityToken('invite', raw!);
    expect(first).toEqual(v2());
    expect(await consumePortalCapabilityToken('invite', raw!)).toBeNull();
  });

  it('keys stay purpose-separated: an invite token is not found as a reset token', async () => {
    const raw = await issuePortalCapabilityToken({ purpose: 'invite', portalUserId: USER, orgId: ORG, email: EMAIL, authEpoch: 3 });
    expect(await consumePortalCapabilityToken('reset', raw!)).toBeNull();
    // The reset lookup did not touch the invite key.
    expect(await consumePortalCapabilityToken('invite', raw!)).toEqual(v2());
  });

  it('refuses a payload whose purpose differs from the requested one and still burns it', async () => {
    const raw = 'planted-token';
    const payload = JSON.stringify({ v: 2, purpose: 'invite', portalUserId: USER, orgId: ORG, email: EMAIL, authEpoch: 3 });
    portalResetTokens.set(sha(raw), { payload, expiresAt: new Date(Date.now() + 60_000), createdAt: new Date() });
    expect(await consumePortalCapabilityToken('reset', raw)).toBeNull();
    expect(portalResetTokens.has(sha(raw))).toBe(false);
  });

  it('refuses an expired entry and an unknown payload version', async () => {
    portalInviteTokens.set(sha('expired'), {
      payload: JSON.stringify({ v: 2, purpose: 'invite', portalUserId: USER, orgId: ORG, email: EMAIL, authEpoch: 3 }),
      expiresAt: new Date(Date.now() - 1), createdAt: new Date(),
    });
    expect(await consumePortalCapabilityToken('invite', 'expired')).toBeNull();
    portalInviteTokens.set(sha('v3'), { payload: JSON.stringify({ v: 3, purpose: 'invite' }), expiresAt: new Date(Date.now() + 60_000), createdAt: new Date() });
    expect(await consumePortalCapabilityToken('invite', 'v3')).toBeNull();
    portalInviteTokens.set(sha('junk'), { payload: 'not json', expiresAt: new Date(Date.now() + 60_000), createdAt: new Date() });
    expect(await consumePortalCapabilityToken('invite', 'junk')).toBeNull();
  });

  it('parses a legacy {portalUserId} invite and a legacy {userId} reset', async () => {
    portalInviteTokens.set(sha('old-invite'), { payload: JSON.stringify({ portalUserId: USER }), expiresAt: new Date(Date.now() + 60_000), createdAt: new Date() });
    expect(await consumePortalCapabilityToken('invite', 'old-invite')).toEqual({ format: 'legacy', portalUserId: USER });
    portalResetTokens.set(sha('old-reset'), { payload: JSON.stringify({ userId: USER }), expiresAt: new Date(Date.now() + 60_000), createdAt: new Date() });
    expect(await consumePortalCapabilityToken('reset', 'old-reset')).toEqual({ format: 'legacy', portalUserId: USER });
  });
});

describe('validatePortalCapability — invite', () => {
  it('accepts a v2 invite that matches the row', async () => {
    const check = await validatePortalCapability('invite', v2());
    expect(check).toEqual({ ok: true, user: invitedRow() });
  });

  it.each([
    ['epoch drift', () => invitedRow({ authEpoch: 4 })],
    ['org mismatch', () => invitedRow({ orgId: OTHER_ORG })],
    ['email mismatch', () => invitedRow({ email: 'someone-else@acme.example' })],
    ['non-invited status (active)', () => invitedRow({ status: 'active' })],
    ['non-invited status (disabled)', () => invitedRow({ status: 'disabled' })],
    ['entra row', () => invitedRow({ authMethod: 'entra' })],
    ['browser_access none', () => invitedRow({ browserAccess: 'none' })],
    ['row gone', () => null],
  ])('refuses %s', async (_name, row) => {
    rowRef.current = row();
    expect(await validatePortalCapability('invite', v2())).toEqual({ ok: false, reason: 'invalid' });
  });

  it('compares the row email case-insensitively', async () => {
    rowRef.current = invitedRow({ email: 'Cust@Acme.Example' });
    expect((await validatePortalCapability('invite', v2())).ok).toBe(true);
  });

  it('reports org_unavailable when getActiveOrgTenant returns null', async () => {
    activeOrgMock.mockResolvedValueOnce(null);
    expect(await validatePortalCapability('invite', v2())).toEqual({ ok: false, reason: 'org_unavailable' });
  });

  it('never reveals org state for a token that is otherwise invalid', async () => {
    rowRef.current = invitedRow({ authEpoch: 9 });
    activeOrgMock.mockResolvedValue(null);
    expect(await validatePortalCapability('invite', v2())).toEqual({ ok: false, reason: 'invalid' });
  });

  // Review Focus 2: an invite emailed the day before deploy, clicked after.
  it('accepts a legacy invite token once for an invited row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await validatePortalCapability('invite', { format: 'legacy', portalUserId: USER })).toEqual({ ok: true, user: invitedRow() });
      expect(warn).toHaveBeenCalledWith('[portal] legacy invite token accepted', { portalUserId: USER });
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects a legacy invite token for an active row', async () => {
    rowRef.current = invitedRow({ status: 'active' });
    expect(await validatePortalCapability('invite', { format: 'legacy', portalUserId: USER })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a legacy invite token for an entra row or a none row', async () => {
    rowRef.current = invitedRow({ authMethod: 'entra' });
    expect((await validatePortalCapability('invite', { format: 'legacy', portalUserId: USER })).ok).toBe(false);
    rowRef.current = invitedRow({ browserAccess: 'none' });
    expect((await validatePortalCapability('invite', { format: 'legacy', portalUserId: USER })).ok).toBe(false);
  });
});

describe('validatePortalCapability — reset', () => {
  const reset = (over: Record<string, unknown> = {}) => v2({ purpose: 'reset', ...over });

  it('accepts a v2 reset for an active or invited password row', async () => {
    rowRef.current = invitedRow({ status: 'active', passwordHash: 'h' });
    expect((await validatePortalCapability('reset', reset())).ok).toBe(true);
    rowRef.current = invitedRow({ status: 'invited' });
    expect((await validatePortalCapability('reset', reset())).ok).toBe(true);
  });

  it('refuses a disabled account', async () => {
    rowRef.current = invitedRow({ status: 'disabled', passwordHash: 'h' });
    expect(await validatePortalCapability('reset', reset())).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses epoch drift (password changed since the token was issued) and an entra row', async () => {
    rowRef.current = invitedRow({ status: 'active', authEpoch: 4 });
    expect((await validatePortalCapability('reset', reset())).ok).toBe(false);
    rowRef.current = invitedRow({ status: 'active', authMethod: 'entra' });
    expect((await validatePortalCapability('reset', reset())).ok).toBe(false);
  });

  // Review Focus 2: a pre-deploy reset link gives the ordinary generic 400.
  it('rejects a legacy reset token with the generic invalid', async () => {
    rowRef.current = invitedRow({ status: 'active', passwordHash: 'h' });
    expect(await validatePortalCapability('reset', { format: 'legacy', portalUserId: USER })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a v2 payload validated under the other purpose', async () => {
    expect(await validatePortalCapability('reset', v2())).toEqual({ ok: false, reason: 'invalid' });
  });
});
