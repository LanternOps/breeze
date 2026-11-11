import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';

// Unit tests run the IN-MEMORY backend (PORTAL_USE_REDIS is false under
// NODE_ENV=test). The Redis path and its atomic consume are proved in
// __tests__/integration/portalCapabilityTokens.integration.test.ts.

const { rowRef, activeOrgMock, selectCols } = vi.hoisted(() => ({
  rowRef: { current: null as Record<string, unknown> | null },
  activeOrgMock: vi.fn(),
  selectCols: { current: null as Record<string, unknown> | null },
}));

vi.mock('../../db', () => ({
  db: {
    select: (cols: Record<string, unknown>) => {
      selectCols.current = cols;
      const chain: any = { from: () => chain, leftJoin: () => chain, where: () => chain, limit: () => Promise.resolve(rowRef.current ? [rowRef.current] : []) };
      return chain;
    },
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
  runOutsideDbContext: <T>(fn: () => T) => fn(),
}));
vi.mock('../../services/tenantStatus', () => ({ getActiveOrgTenant: activeOrgMock }));
// W3: the access-policy resolver is mocked at its boundary (the pick stays real).
const resolvePolicy = vi.hoisted(() => vi.fn());
vi.mock('../../services/portalAccessPolicy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/portalAccessPolicy')>()),
  resolvePortalAccessPolicy: resolvePolicy,
}));

import {
  consumePortalCapabilityToken,
  consumePortalCapabilityTokenByHash,
  hashPortalCapabilityToken,
  issuePortalCapabilityToken,
  peekPortalCapabilityToken,
  validatePortalCapability,
  type ConsumedCapability,
} from './capabilityTokens';
import { PortalAccessPolicyOrgNotFoundError, pickEffectivePortalAccessPolicy } from '../../services/portalAccessPolicy';

const NO_ROW = { entraEnabled: null, googleEnabled: null, passwordMode: null, selfRegistrationMode: null, ssoNewPersonMode: null, ssoSessionMaxHours: null };
function policyFor(orgId: string, mode: 'allowed' | 'sso_only') {
  const org = mode === 'sso_only' ? { ...NO_ROW, entraEnabled: true, passwordMode: 'sso_only' as const } : null;
  // The org's tenant is proven (W4 D2), so 'sso_only' is effective with Microsoft on.
  const entraTenant = org ? { tenantId: 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5', provenAt: '2027-01-23T10:00:00.000Z' } : null;
  return {
    orgId, partnerId: 'p-1', entraTenant,
    ...pickEffectivePortalAccessPolicy(org, null, { entra: true, google: false, selfRegistration: false }, { entraTenantProven: entraTenant !== null }),
  };
}
import { portalInviteTokens, portalResetTokens } from './helpers';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { portalUsers } from '../../db/schema/portal';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';
const OTHER_ORG = '7c0a1f7e-9999-4222-8333-444455556666';
const USER = '11111111-2222-4333-8444-555566667777';
const EMAIL = 'cust@acme.example';
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');

const invitedRow = (over: Record<string, unknown> = {}) => ({
  id: USER, orgId: ORG, email: EMAIL, name: null, passwordHash: null, authMethod: 'password',
  receiveNotifications: true, status: 'invited', authEpoch: 3, browserAccess: 'granted', hasExternalIdentity: false, orgName: 'Acme',
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
  resolvePolicy.mockReset();
  resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'allowed'));
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

describe('validatePortalCapability — external identity (W3 identities release B)', () => {
  it('reads hasExternalIdentity from portal_user_identities (EXISTS correlated to the row), never entra_oid', async () => {
    await validatePortalCapability('invite', v2());
    const cols = selectCols.current!;
    expect(cols).not.toHaveProperty('entraOid');
    expect(cols).toHaveProperty('hasExternalIdentity');
    // Rendered single-table on purpose: the correlation must survive drizzle's qualifier stripping (#9692).
    const text = new QueryBuilder().select({ id: portalUsers.id, has: cols.hasExternalIdentity as SQL }).from(portalUsers).toSQL().sql;
    expect(text).toMatch(/exists \(select 1 from "portal_user_identities" "\w+" where "\w+"\."portal_user_id" = "portal_users"\."id"\)/);
  });

  it('an account with an identity row is identity-managed even when entra_oid is NULL (the fact reaches the caller)', async () => {
    rowRef.current = invitedRow({ entraOid: null, hasExternalIdentity: true });
    const check = await validatePortalCapability('invite', v2());
    expect(check).toMatchObject({ ok: true, user: { hasExternalIdentity: true } });
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

// Portal registration W3 (#11380): a token outstanding when password sign-in
// is switched off is refused at consume with the generic invalid (inv. 7 / 8).
describe('validatePortalCapability — access policy (W3)', () => {
  const reset = () => v2({ purpose: 'reset' });

  it('consults the policy of the row\'s org and accepts while password is allowed (no rows)', async () => {
    expect((await validatePortalCapability('invite', v2())).ok).toBe(true);
    expect(resolvePolicy).toHaveBeenCalledWith(ORG);
  });

  it('invite and reset under sso_only → invalid, before the org gate (no org state learned)', async () => {
    resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'sso_only'));
    activeOrgMock.mockResolvedValue(null);
    expect(await validatePortalCapability('invite', v2())).toEqual({ ok: false, reason: 'invalid' });
    rowRef.current = invitedRow({ status: 'active', passwordHash: 'h' });
    expect(await validatePortalCapability('reset', reset())).toEqual({ ok: false, reason: 'invalid' });
    expect(activeOrgMock).not.toHaveBeenCalled();
  });

  it('a legacy invite under sso_only → invalid', async () => {
    resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'sso_only'));
    expect(await validatePortalCapability('invite', { format: 'legacy', portalUserId: USER })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('an org the resolver cannot find → invalid', async () => {
    resolvePolicy.mockRejectedValue(new PortalAccessPolicyOrgNotFoundError(ORG));
    expect(await validatePortalCapability('invite', v2())).toEqual({ ok: false, reason: 'invalid' });
  });

  it('never consults the policy for a token the row already refuses', async () => {
    rowRef.current = invitedRow({ authEpoch: 9 });
    expect(await validatePortalCapability('invite', v2())).toEqual({ ok: false, reason: 'invalid' });
    expect(resolvePolicy).not.toHaveBeenCalled();
  });
});

// Portal registration W4 (#11381, plan Task 7): the Microsoft invite path.
// The OIDC start PEEKS the invite (the token must survive the round trip to
// Microsoft); the callback consumes it by the sha256 the state carries, then
// validates it without the password-method requirement.
describe('W4: hash consume, peek, and the Microsoft invite validation', () => {
  const issueInvite = () => issuePortalCapabilityToken({ purpose: 'invite', portalUserId: USER, orgId: ORG, email: EMAIL, authEpoch: 3 });

  it('hashPortalCapabilityToken is the sha256 the store is keyed by', async () => {
    const raw = await issueInvite();
    expect(hashPortalCapabilityToken(raw!)).toBe(sha(raw!));
    expect(portalInviteTokens.has(hashPortalCapabilityToken(raw!))).toBe(true);
  });

  it('consumePortalCapabilityTokenByHash consumes exactly once by the sha256 hash', async () => {
    const raw = await issueInvite();
    expect(await consumePortalCapabilityTokenByHash('invite', sha(raw!))).toEqual(v2());
    expect(await consumePortalCapabilityTokenByHash('invite', sha(raw!))).toBeNull();
    // The raw-token consume sees the same burn.
    expect(await consumePortalCapabilityToken('invite', raw!)).toBeNull();
  });

  it('consumePortalCapabilityTokenByHash refuses a malformed hash without touching the store', async () => {
    const raw = await issueInvite();
    expect(await consumePortalCapabilityTokenByHash('invite', raw!)).toBeNull();
    expect(await consumePortalCapabilityTokenByHash('invite', sha(raw!).toUpperCase())).toBeNull();
    expect(await consumePortalCapabilityTokenByHash('invite', '')).toBeNull();
    expect(portalInviteTokens.has(sha(raw!))).toBe(true);
  });

  it('consumePortalCapabilityTokenByHash keeps purposes apart', async () => {
    const raw = await issueInvite();
    expect(await consumePortalCapabilityTokenByHash('reset', sha(raw!))).toBeNull();
    expect(await consumePortalCapabilityTokenByHash('invite', sha(raw!))).toEqual(v2());
  });

  it('peekPortalCapabilityToken reads without consuming', async () => {
    const raw = await issueInvite();
    expect(await peekPortalCapabilityToken('invite', raw!)).toEqual(v2());
    expect(await peekPortalCapabilityToken('invite', raw!)).toEqual(v2());
    expect(portalInviteTokens.has(sha(raw!))).toBe(true);
    expect(await consumePortalCapabilityToken('invite', raw!)).toEqual(v2());
    expect(await peekPortalCapabilityToken('invite', raw!)).toBeNull();
  });

  it('peekPortalCapabilityToken refuses an expired entry, an unknown token and the other purpose', async () => {
    portalInviteTokens.set(sha('expired'), {
      payload: JSON.stringify({ v: 2, purpose: 'invite', portalUserId: USER, orgId: ORG, email: EMAIL, authEpoch: 3 }),
      expiresAt: new Date(Date.now() - 1), createdAt: new Date(),
    });
    expect(await peekPortalCapabilityToken('invite', 'expired')).toBeNull();
    expect(await peekPortalCapabilityToken('invite', 'never-issued')).toBeNull();
    const raw = await issueInvite();
    expect(await peekPortalCapabilityToken('reset', raw!)).toBeNull();
  });

  describe('validatePortalCapability(…, { requirePasswordMethod: false })', () => {
    const sso = { requirePasswordMethod: false } as const;

    it('accepts an invite while the org is effectively sso_only (the password path refuses it)', async () => {
      resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'sso_only'));
      expect(await validatePortalCapability('invite', v2())).toEqual({ ok: false, reason: 'invalid' });
      expect(await validatePortalCapability('invite', v2(), sso)).toEqual({ ok: true, user: invitedRow() });
    });

    it('does not require a password-eligible row', async () => {
      rowRef.current = invitedRow({ authMethod: 'entra' });
      expect((await validatePortalCapability('invite', v2())).ok).toBe(false);
      expect(await validatePortalCapability('invite', v2(), sso)).toEqual({ ok: true, user: invitedRow({ authMethod: 'entra' }) });
    });

    it.each([
      ['epoch drift', () => invitedRow({ authEpoch: 4 })],
      ['org mismatch', () => invitedRow({ orgId: OTHER_ORG })],
      ['email mismatch', () => invitedRow({ email: 'someone-else@acme.example' })],
      ['non-invited status (active)', () => invitedRow({ status: 'active' })],
      ['browser_access none', () => invitedRow({ browserAccess: 'none' })],
      ['row gone', () => null],
    ])('still refuses %s', async (_name, row) => {
      rowRef.current = row();
      expect(await validatePortalCapability('invite', v2(), sso)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('still reports an unavailable org', async () => {
      activeOrgMock.mockResolvedValueOnce(null);
      expect(await validatePortalCapability('invite', v2(), sso)).toEqual({ ok: false, reason: 'org_unavailable' });
    });

    it('refuses a legacy invite (no issue-time epoch to pin the activation to)', async () => {
      expect(await validatePortalCapability('invite', { format: 'legacy', portalUserId: USER }, sso)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('refuses a reset token (a reset is always a password capability)', async () => {
      rowRef.current = invitedRow({ status: 'active', passwordHash: 'h' });
      expect(await validatePortalCapability('reset', v2({ purpose: 'reset' }), sso)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('requirePasswordMethod defaults to true', async () => {
      resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'sso_only'));
      expect(await validatePortalCapability('invite', v2(), {})).toEqual({ ok: false, reason: 'invalid' });
    });
  });
});
