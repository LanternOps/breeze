import { describe, expect, it } from 'vitest';
import { createGrantStore } from './grants';
import { GRANT_SESSION_TTL_MS } from './limits';
import type { GatewayGrantInput } from './types';

const input = (over: Partial<GatewayGrantInput> = {}): GatewayGrantInput => ({
  config: { source: 'gateway', kind: 'openai_compatible', partnerId: 'p1', connectionId: 'c1', configVersion: 1, baseUrl: 'https://x.example.com/v1' },
  credential: { secret: 'sk-secret' },
  wireModels: ['m1'],
  orgId: 'o1', aiSessionId: null, purpose: 'dispatch',
  ...over,
});

describe('grant store', () => {
  it('issues an unguessable token and finds the grant by it', () => {
    const store = createGrantStore(() => 1_000);
    const { token } = store.issue(input());
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.lookup(token)?.config.connectionId).toBe('c1');
    expect(store.lookup(`${token}x`)).toBeNull();
  });

  it('refuses a dispatch grant without an org (every forwarded turn must be audited)', () => {
    const store = createGrantStore(() => 0);
    expect(() => store.issue(input({ orgId: null }))).toThrow(/org/);
    expect(() => store.issue(input({ orgId: null, purpose: 'verification' }))).not.toThrow();
  });

  it('expires after the TTL', () => {
    let now = 1_000;
    const store = createGrantStore(() => now);
    const { token } = store.issue(input({ ttlMs: 500 }));
    now = 1_499; expect(store.lookup(token)).not.toBeNull();
    now = 1_501; expect(store.lookup(token)).toBeNull();
  });

  it('revoke aborts in-flight requests and forgets the grant', () => {
    const store = createGrantStore(() => 0);
    const { token } = store.issue(input());
    const grant = store.lookup(token)!;
    const ac = new AbortController();
    grant.inFlight.add(ac);
    store.revoke(token);
    expect(ac.signal.aborted).toBe(true);
    expect(store.lookup(token)).toBeNull();
  });

  it('never stores the raw token (only its digest)', () => {
    const store = createGrantStore(() => 0);
    const { token } = store.issue(input());
    expect(JSON.stringify([...store.__debugKeys()])).not.toContain(token);
  });

  it('sweep() drops expired grants', () => {
    let now = 0;
    const store = createGrantStore(() => now);
    store.issue(input({ ttlMs: 10 }));
    now = 20; store.sweep();
    expect(store.size()).toBe(0);
  });

  it('rejects a grant with no wire model', () => {
    const store = createGrantStore(() => 0);
    expect(() => store.issue(input({ wireModels: [] }))).toThrow(/wire model/);
  });

  it('clamps an over-long or non-finite TTL to the session cap', () => {
    let now = 0;
    const store = createGrantStore(() => now);
    const { token } = store.issue(input({ ttlMs: Number.POSITIVE_INFINITY }));
    now = GRANT_SESSION_TTL_MS + 1;
    expect(store.lookup(token)).toBeNull();
  });

  it('copies the credential: revoking clears the store copy, never the caller object', () => {
    const store = createGrantStore(() => 0);
    const credential = { secret: 'sk-secret-xyz' };
    const { token } = store.issue(input({ credential }));
    const rec = store.lookup(token)!;
    store.revoke(token);
    expect(rec.credential.secret).toBeNull();
    expect(credential.secret).toBe('sk-secret-xyz');
  });
});
