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
      { kind: 'tenant_proof', runTokenHash: sha256Hex('r'), orgId: ORG, expectedTenantId: '11111111-1111-4111-8111-111111111111' },
      { kind: 'tenant_proof', runTokenHash: sha256Hex('r2'), orgId: ORG, expectedTenantId: null },
    ];
    for (const purpose of purposes) {
      const minted = await mint(purpose);
      expect((await consumePortalOidcState(minted.state, minted.bindingCookie))?.purpose).toEqual(purpose);
    }
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
