import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests run the IN-MEMORY backend (PORTAL_USE_REDIS is false under
// NODE_ENV=test). The Redis path and its atomic consume are proved against a
// real Redis in __tests__/integration/portalOidcStateStore.integration.test.ts.

import {
  PORTAL_OIDC_BINDING_COOKIE,
  PORTAL_OIDC_STATE_TTL_SECONDS,
  buildClearPortalOidcBindingCookie,
  buildPortalOidcBindingCookie,
  consumePortalOidcState,
  createPortalOidcState,
} from './stateStore';
import type { PortalOidcPurpose } from './types';
import { portalOidcStates } from '../../routes/portal/helpers';
import { PORTAL_USE_REDIS } from '../../routes/portal/schemas';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';
const USER = '11111111-2222-4333-8444-555566667777';
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const sha256Hex = (raw: string) => createHash('sha256').update(raw).digest('hex');
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

async function mint(purpose: PortalOidcPurpose = { kind: 'login' }, hostOrgId: string | null = null) {
  return createPortalOidcState({ provider: 'entra', purpose, hostOrgId, authority: 'organizations' });
}

beforeEach(() => {
  portalOidcStates.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('portal OIDC state store (in-memory backend)', () => {
  it('runs the in-memory backend in unit tests', () => {
    expect(PORTAL_USE_REDIS).toBe(false);
  });

  it('mints 32-byte base64url state, nonce and binding values and an S256 challenge of the stored verifier', async () => {
    const minted = await mint();
    expect(minted.state).toMatch(BASE64URL_32_BYTES);
    expect(minted.nonce).toMatch(BASE64URL_32_BYTES);
    expect(minted.bindingCookie).toMatch(BASE64URL_32_BYTES);
    expect(new Set([minted.state, minted.nonce, minted.bindingCookie]).size).toBe(3);

    const consumed = await consumePortalOidcState(minted.state, minted.bindingCookie);
    expect(consumed).not.toBeNull();
    expect(createHash('sha256').update(consumed!.codeVerifier).digest('base64url')).toBe(minted.codeChallenge);
    expect(consumed!.nonce).toBe(minted.nonce);
  });

  it('consumes a state exactly once', async () => {
    const purpose: PortalOidcPurpose = { kind: 'link', portalUserId: USER, orgId: ORG, authEpoch: 4 };
    const minted = await mint(purpose, ORG);

    const first = await consumePortalOidcState(minted.state, minted.bindingCookie);
    expect(first).toMatchObject({
      v: 1,
      provider: 'entra',
      purpose,
      nonce: minted.nonce,
      bindingHash: sha256Hex(minted.bindingCookie),
      hostOrgId: ORG,
      authority: 'organizations',
    });
    expect(typeof first!.createdAt).toBe('number');

    expect(await consumePortalOidcState(minted.state, minted.bindingCookie)).toBeNull();
    expect(portalOidcStates.size).toBe(0);
  });

  it('a wrong or missing binding cookie returns null and still burns the state', async () => {
    const wrong = await mint();
    const other = await mint();
    expect(await consumePortalOidcState(wrong.state, other.bindingCookie)).toBeNull();
    // Burned: the right cookie no longer helps.
    expect(await consumePortalOidcState(wrong.state, wrong.bindingCookie)).toBeNull();

    const missing = await mint();
    expect(await consumePortalOidcState(missing.state, undefined)).toBeNull();
    expect(await consumePortalOidcState(missing.state, missing.bindingCookie)).toBeNull();

    const empty = await mint();
    expect(await consumePortalOidcState(empty.state, '')).toBeNull();
    expect(await consumePortalOidcState(empty.state, empty.bindingCookie)).toBeNull();

    // The other browser's own state is untouched by the cross-browser attempt.
    expect(await consumePortalOidcState(other.state, other.bindingCookie)).not.toBeNull();
  });

  it('an unknown state returns null', async () => {
    expect(await consumePortalOidcState('not-a-state', 'not-a-cookie')).toBeNull();
    expect(await consumePortalOidcState('', '')).toBeNull();
  });

  it('expires after 600 s', async () => {
    expect(PORTAL_OIDC_STATE_TTL_SECONDS).toBe(600);
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-11-09T12:00:00Z');

    vi.setSystemTime(start);
    const fresh = await mint();
    vi.setSystemTime(start.getTime() + 599_000);
    expect(await consumePortalOidcState(fresh.state, fresh.bindingCookie)).not.toBeNull();

    vi.setSystemTime(start);
    const stale = await mint();
    vi.setSystemTime(start.getTime() + 600_000);
    expect(await consumePortalOidcState(stale.state, stale.bindingCookie)).toBeNull();
  });

  it('stores only sha256 of the state and of the binding value', async () => {
    const minted = await mint({ kind: 'invite', inviteTokenHash: sha256Hex('invite-token') });
    expect([...portalOidcStates.keys()]).toEqual([sha256Hex(minted.state)]);

    const entry = portalOidcStates.get(sha256Hex(minted.state))!;
    expect(entry.payload).not.toContain(minted.state);
    expect(entry.payload).not.toContain(minted.bindingCookie);
    const stored = JSON.parse(entry.payload) as Record<string, unknown>;
    expect(stored.bindingHash).toBe(sha256Hex(minted.bindingCookie));
    expect(Object.keys(stored).sort()).toEqual(
      ['authority', 'bindingHash', 'codeVerifier', 'createdAt', 'hostOrgId', 'nonce', 'provider', 'purpose', 'v'],
    );
    expect(entry.expiresAt.getTime() - entry.createdAt.getTime()).toBe(PORTAL_OIDC_STATE_TTL_SECONDS * 1000);
  });

  it('refuses (and burns) a stored record of another version or shape', async () => {
    const minted = await mint();
    const key = sha256Hex(minted.state);
    const entry = portalOidcStates.get(key)!;
    portalOidcStates.set(key, { ...entry, payload: JSON.stringify({ ...JSON.parse(entry.payload), v: 2 }) });
    expect(await consumePortalOidcState(minted.state, minted.bindingCookie)).toBeNull();
    expect(portalOidcStates.has(key)).toBe(false);

    const second = await mint();
    const key2 = sha256Hex(second.state);
    const entry2 = portalOidcStates.get(key2)!;
    portalOidcStates.set(key2, { ...entry2, payload: JSON.stringify({ ...JSON.parse(entry2.payload), purpose: { kind: 'admin' } }) });
    expect(await consumePortalOidcState(second.state, second.bindingCookie)).toBeNull();

    const third = await mint();
    portalOidcStates.set(sha256Hex(third.state), { ...portalOidcStates.get(sha256Hex(third.state))!, payload: '{not json' });
    expect(await consumePortalOidcState(third.state, third.bindingCookie)).toBeNull();
  });

  it('round-trips every purpose kind', async () => {
    const purposes: PortalOidcPurpose[] = [
      { kind: 'login' },
      { kind: 'invite', inviteTokenHash: sha256Hex('i') },
      { kind: 'link', portalUserId: USER, orgId: ORG, authEpoch: 1 },
    ];
    for (const purpose of purposes) {
      const minted = await mint(purpose);
      expect((await consumePortalOidcState(minted.state, minted.bindingCookie))?.purpose).toEqual(purpose);
    }
    // A proof sign-in's authority is the pinned tenant itself (D6).
    const proof: PortalOidcPurpose = { kind: 'tenant_proof', runTokenHash: sha256Hex('r'), orgId: ORG, expectedTenantId: TENANT };
    const minted = await createPortalOidcState({ provider: 'entra', purpose: proof, hostOrgId: null, authority: TENANT });
    expect(await consumePortalOidcState(minted.state, minted.bindingCookie)).toMatchObject({ purpose: proof, authority: TENANT });
  });

  it('refuses a tenant_proof state that is not pinned to a tenant (a proof run always is, D6)', async () => {
    for (const expectedTenantId of [null, '', undefined]) {
      const minted = await createPortalOidcState({
        provider: 'entra',
        purpose: { kind: 'tenant_proof', runTokenHash: sha256Hex('r'), orgId: ORG, expectedTenantId: TENANT },
        hostOrgId: null,
        authority: TENANT,
      });
      const key = sha256Hex(minted.state);
      const entry = portalOidcStates.get(key)!;
      const stored = JSON.parse(entry.payload);
      portalOidcStates.set(key, { ...entry, payload: JSON.stringify({ ...stored, purpose: { ...stored.purpose, expectedTenantId } }) });
      expect(await consumePortalOidcState(minted.state, minted.bindingCookie)).toBeNull();
    }
  });
});

/**
 * Strict parse: a stored record whose fields are not the shapes the start
 * routes write is treated as gone (null), and burned. Each case mints a valid
 * state, then rewrites ONE field of the stored payload.
 */
describe('portal OIDC state store: strict shapes', () => {
  const proofPurpose = { kind: 'tenant_proof' as const, runTokenHash: sha256Hex('r'), orgId: ORG, expectedTenantId: TENANT };

  async function consumeTampered(
    minted: { state: string; bindingCookie: string },
    rewrite: (stored: Record<string, any>) => Record<string, unknown>,
  ) {
    const key = sha256Hex(minted.state);
    const entry = portalOidcStates.get(key)!;
    portalOidcStates.set(key, { ...entry, payload: JSON.stringify(rewrite(JSON.parse(entry.payload))) });
    const out = await consumePortalOidcState(minted.state, minted.bindingCookie);
    expect(portalOidcStates.has(key)).toBe(false);
    return out;
  }
  const mintProof = () => createPortalOidcState({ provider: 'entra', purpose: proofPurpose, hostOrgId: null, authority: TENANT });
  const withPurpose = (patch: Record<string, unknown>) => (s: Record<string, any>) => ({ ...s, purpose: { ...s.purpose, ...patch } });

  it('tenant_proof: the expected tenant must be a lowercase tenant GUID and never the consumer tenant', async () => {
    for (const expectedTenantId of ['ABCDEF01-2345-4678-9ABC-DEF012345678', CONSUMER_TENANT, 'contoso.example', `${TENANT}x`, 42]) {
      expect(await consumeTampered(await mintProof(), (s) => ({
        ...withPurpose({ expectedTenantId })(s),
        // Keep authority === expectedTenantId so only the tenant shape is under test.
        authority: expectedTenantId,
      }))).toBeNull();
    }
  });

  it('tenant_proof: runTokenHash must be 64 lowercase hex and orgId a GUID', async () => {
    for (const runTokenHash of ['abc', sha256Hex('r').toUpperCase(), `${sha256Hex('r')}0`, 7]) {
      expect(await consumeTampered(await mintProof(), withPurpose({ runTokenHash }))).toBeNull();
    }
    for (const orgId of ['org-1', `${ORG}0`, '', 5]) {
      expect(await consumeTampered(await mintProof(), withPurpose({ orgId }))).toBeNull();
    }
  });

  it('tenant_proof: the authority must be the expected tenant (not organizations, not another tenant)', async () => {
    for (const authority of ['organizations', OTHER_TENANT, 'common']) {
      expect(await consumeTampered(await mintProof(), (s) => ({ ...s, authority }))).toBeNull();
    }
  });

  it('link: portalUserId and orgId must be GUIDs', async () => {
    const link = { kind: 'link' as const, portalUserId: USER, orgId: ORG, authEpoch: 2 };
    for (const patch of [{ portalUserId: 'pu-1' }, { portalUserId: 1 }, { orgId: 'org-1' }, { orgId: `${ORG} ` }]) {
      expect(await consumeTampered(await mint(link), withPurpose(patch))).toBeNull();
    }
  });

  it('invite: inviteTokenHash must be 64 lowercase hex', async () => {
    const invite = { kind: 'invite' as const, inviteTokenHash: sha256Hex('i') };
    for (const inviteTokenHash of ['not-a-hash', sha256Hex('i').toUpperCase()]) {
      expect(await consumeTampered(await mint(invite), withPurpose({ inviteTokenHash }))).toBeNull();
    }
  });

  it('login / invite / link: the authority must be organizations (never a tenant, common or consumers)', async () => {
    const purposes: PortalOidcPurpose[] = [
      { kind: 'login' },
      { kind: 'invite', inviteTokenHash: sha256Hex('i') },
      { kind: 'link', portalUserId: USER, orgId: ORG, authEpoch: 1 },
    ];
    for (const purpose of purposes) {
      for (const authority of [TENANT, 'common', 'consumers']) {
        expect(await consumeTampered(await mint(purpose), (s) => ({ ...s, authority }))).toBeNull();
      }
    }
  });

  it('hostOrgId must be a GUID or null', async () => {
    for (const hostOrgId of ['acme.example', 3, '']) {
      expect(await consumeTampered(await mint(), (s) => ({ ...s, hostOrgId }))).toBeNull();
    }
  });

  it('an unchanged valid record still parses (the tamper helper is not what refuses)', async () => {
    expect(await consumeTampered(await mintProof(), (s) => s)).toMatchObject({ purpose: proofPurpose, authority: TENANT });
    expect(await consumeTampered(await mint(), (s) => s)).toMatchObject({ purpose: { kind: 'login' }, authority: 'organizations' });
  });

  it('create refuses a record its own parse would refuse (a caller bug), and stores nothing', async () => {
    const bad: Array<Parameters<typeof createPortalOidcState>[0]> = [
      { provider: 'entra', purpose: proofPurpose, hostOrgId: null, authority: 'organizations' },
      { provider: 'entra', purpose: { ...proofPurpose, expectedTenantId: CONSUMER_TENANT }, hostOrgId: null, authority: CONSUMER_TENANT },
      { provider: 'entra', purpose: { kind: 'login' }, hostOrgId: null, authority: TENANT },
      { provider: 'entra', purpose: { kind: 'link', portalUserId: 'pu-1', orgId: ORG, authEpoch: 1 }, hostOrgId: null, authority: 'organizations' },
      { provider: 'entra', purpose: { kind: 'login' }, hostOrgId: 'acme.example', authority: 'organizations' },
    ];
    for (const input of bad) {
      await expect(createPortalOidcState(input)).rejects.toThrow(/createPortalOidcState/);
    }
    expect(portalOidcStates.size).toBe(0);
  });
});

describe('portal OIDC binding cookie', () => {
  const saved = { portal: process.env.PORTAL_COOKIE_SAME_SITE, generic: process.env.COOKIE_SAME_SITE };
  afterEach(() => {
    if (saved.portal === undefined) delete process.env.PORTAL_COOKIE_SAME_SITE;
    else process.env.PORTAL_COOKIE_SAME_SITE = saved.portal;
    if (saved.generic === undefined) delete process.env.COOKIE_SAME_SITE;
    else process.env.COOKIE_SAME_SITE = saved.generic;
  });

  it('is HttpOnly, scoped to the OIDC path, Lax and 600 s; Secure only when asked', () => {
    expect(PORTAL_OIDC_BINDING_COOKIE).toBe('breeze_portal_oidc');
    expect(buildPortalOidcBindingCookie('abc_-123', { secure: true })).toBe(
      'breeze_portal_oidc=abc_-123; Path=/api/v1/portal/auth/oidc; HttpOnly; SameSite=Lax; Secure; Max-Age=600',
    );
    expect(buildPortalOidcBindingCookie('abc_-123', { secure: false })).toBe(
      'breeze_portal_oidc=abc_-123; Path=/api/v1/portal/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=600',
    );
  });

  it('stays Lax whatever PORTAL_COOKIE_SAME_SITE says (it must survive Microsoft\'s top-level redirect)', () => {
    process.env.PORTAL_COOKIE_SAME_SITE = 'Strict';
    process.env.COOKIE_SAME_SITE = 'None';
    expect(buildPortalOidcBindingCookie('v', { secure: true })).toContain('; SameSite=Lax;');
    expect(buildClearPortalOidcBindingCookie({ secure: true })).toContain('; SameSite=Lax;');
  });

  it('clears with the same attributes and Max-Age=0', () => {
    expect(buildClearPortalOidcBindingCookie({ secure: true })).toBe(
      'breeze_portal_oidc=; Path=/api/v1/portal/auth/oidc; HttpOnly; SameSite=Lax; Secure; Max-Age=0',
    );
    expect(buildClearPortalOidcBindingCookie({ secure: false })).toBe(
      'breeze_portal_oidc=; Path=/api/v1/portal/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=0',
    );
  });
});
