import type { WSContext } from 'hono/ws';
import { describe, expect, it, vi } from 'vitest';
import {
  bindRemoteConnection,
  expireExactRemoteConnectionForwarding,
  expireOpeningRemoteConnection,
  installLocalRemoteConnection,
  ownsSafeRemoteConnection,
  removeExactLocalRemoteConnection,
  renewExactRemoteConnectionLease,
  updateExactRemoteConnectionDeadline,
  type RemoteConnectionIdentity,
  type RemoteConnectionLease,
} from './remoteWsOwnership';
import type { RemoteWsSharedLeaseClaim } from './remoteWsSharedLease';

function claim(overrides: Partial<RemoteWsSharedLeaseClaim> = {}): RemoteWsSharedLeaseClaim {
  return {
    kind: 'terminal',
    sessionId: 'session-1',
    connectionId: '11111111-1111-4111-8111-111111111111',
    generation: 1,
    instanceId: '22222222-2222-4222-8222-222222222222',
    leaseToken: '33333333-3333-4333-8333-333333333333',
    ownerValue: 'opaque-owner',
    safeForwardingUntilMonotonicMs: 20_000,
    ...overrides,
  };
}

function identity(shared: RemoteWsSharedLeaseClaim): RemoteConnectionIdentity {
  return {
    connectionId: shared.connectionId,
    generation: shared.generation,
    instanceId: shared.instanceId,
    leaseToken: shared.leaseToken,
  };
}

function fakeWs(): WSContext {
  return { send: vi.fn(), close: vi.fn() } as unknown as WSContext;
}

describe('remote websocket local ownership', () => {
  it('installs only a Redis-issued claim and never replaces an existing local owner', () => {
    const sessions = new Map<string, RemoteConnectionLease>();
    const first = claim();

    expect(
      installLocalRemoteConnection(sessions, first.sessionId, first, (shared) => ({
        ...shared,
        state: 'opening',
        userWs: null,
      })),
    ).toEqual({ ok: true });

    expect(
      installLocalRemoteConnection(
        sessions,
        first.sessionId,
        claim({ generation: 2, ownerValue: 'new-owner' }),
        (shared) => ({ ...shared, state: 'opening', userWs: null }),
      ),
    ).toEqual({ ok: false, reason: 'already_owned' });
    expect(sessions.get(first.sessionId)?.generation).toBe(1);
  });

  it('refuses to install a claim under a different session key', () => {
    const sessions = new Map<string, RemoteConnectionLease>();
    const shared = claim({ sessionId: 'session-a' });

    expect(
      installLocalRemoteConnection(sessions, 'session-b', shared, (value) => ({
        ...value,
        state: 'opening',
        userWs: null,
      })),
    ).toEqual({ ok: false, reason: 'already_owned' });
    expect(sessions.size).toBe(0);
  });

  it('binds only the matching identity and requires exact socket plus a live deadline', () => {
    const sessions = new Map<string, RemoteConnectionLease>();
    const shared = claim();
    const ws = fakeWs();
    const foreignWs = fakeWs();
    const expected = identity(shared);
    installLocalRemoteConnection(sessions, shared.sessionId, shared, (value) => ({
      ...value,
      state: 'opening',
      userWs: null,
    }));

    expect(bindRemoteConnection(sessions, shared.sessionId, { ...expected, generation: 2 }, ws)).toBe(false);
    expect(bindRemoteConnection(sessions, shared.sessionId, expected, ws)).toBe(true);
    expect(ownsSafeRemoteConnection(sessions, shared.sessionId, expected, foreignWs, 10_000)).toBe(false);
    expect(
      ownsSafeRemoteConnection(
        sessions,
        shared.sessionId,
        { ...expected, leaseToken: 'foreign-token' },
        ws,
        10_000,
      ),
    ).toBe(false);
    expect(ownsSafeRemoteConnection(sessions, shared.sessionId, expected, ws, 19_999)).toBe(true);
    expect(ownsSafeRemoteConnection(sessions, shared.sessionId, expected, ws, 20_000)).toBe(false);
  });

  it('updates or expires forwarding only for the exact identity', () => {
    const sessions = new Map<string, RemoteConnectionLease>();
    const shared = claim();
    const expected = identity(shared);
    installLocalRemoteConnection(sessions, shared.sessionId, shared, (value) => ({
      ...value,
      state: 'active',
      userWs: fakeWs(),
    }));

    expect(
      updateExactRemoteConnectionDeadline(
        sessions,
        shared.sessionId,
        { ...expected, connectionId: 'foreign' },
        40_000,
      ),
    ).toBe(false);
    expect(updateExactRemoteConnectionDeadline(sessions, shared.sessionId, expected, 40_000)).toBe(true);
    expect(sessions.get(shared.sessionId)?.safeForwardingUntilMonotonicMs).toBe(40_000);
    expect(
      expireExactRemoteConnectionForwarding(
        sessions,
        shared.sessionId,
        { ...expected, generation: 9 },
      ),
    ).toBe(false);
    expect(expireExactRemoteConnectionForwarding(sessions, shared.sessionId, expected)).toBe(true);
    expect(sessions.get(shared.sessionId)?.safeForwardingUntilMonotonicMs).toBe(0);
  });

  it('expires the exact installed lease before renewal and updates only the same entry on success', async () => {
    const sessions = new Map<string, RemoteConnectionLease>();
    const shared = claim();
    const expected = identity(shared);
    const ws = fakeWs();
    installLocalRemoteConnection(sessions, shared.sessionId, shared, (value) => ({
      ...value,
      state: 'active',
      userWs: ws,
    }));

    let rejectRenewal!: (error: Error) => void;
    const failedRenewal = new Promise<RemoteWsSharedLeaseClaim>((_resolve, reject) => {
      rejectRenewal = reject;
    });
    const failed = renewExactRemoteConnectionLease(
      sessions,
      shared.sessionId,
      expected,
      ws,
      () => failedRenewal,
    );
    expect(sessions.get(shared.sessionId)?.safeForwardingUntilMonotonicMs).toBe(0);
    rejectRenewal(new Error('redis unavailable'));
    await expect(failed).resolves.toBe(false);
    expect(sessions.get(shared.sessionId)?.safeForwardingUntilMonotonicMs).toBe(0);

    const renewed = { ...shared, safeForwardingUntilMonotonicMs: 45_000 };
    expect(
      await renewExactRemoteConnectionLease(
        sessions,
        shared.sessionId,
        expected,
        ws,
        async () => renewed,
      ),
    ).toBe(true);
    expect(sessions.get(shared.sessionId)?.safeForwardingUntilMonotonicMs).toBe(45_000);
  });

  it('a stale close cannot remove a newer generation', () => {
    const sessions = new Map<string, RemoteConnectionLease>();
    const newer = claim({ generation: 2, ownerValue: 'new-owner' });
    installLocalRemoteConnection(sessions, newer.sessionId, newer, (value) => ({
      ...value,
      state: 'active',
      userWs: fakeWs(),
    }));

    expect(
      removeExactLocalRemoteConnection(
        sessions,
        newer.sessionId,
        identity(claim({ generation: 1 })),
      ),
    ).toBe(false);
    expect(sessions.get(newer.sessionId)?.generation).toBe(2);
    expect(removeExactLocalRemoteConnection(sessions, newer.sessionId, identity(newer))).toBe(true);
  });

  it('opening expiry releases only the same still-unbound generation', async () => {
    const sessions = new Map<string, RemoteConnectionLease>();
    const opening = claim();
    const release = vi.fn(async () => true);
    installLocalRemoteConnection(sessions, opening.sessionId, opening, (value) => ({
      ...value,
      state: 'opening',
      userWs: null,
    }));

    expect(
      await expireOpeningRemoteConnection(
        sessions,
        opening.sessionId,
        identity(opening),
        release,
      ),
    ).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(sessions.has(opening.sessionId)).toBe(false);

    const replacement = claim({ generation: 2, ownerValue: 'replacement' });
    installLocalRemoteConnection(sessions, replacement.sessionId, replacement, (value) => ({
      ...value,
      state: 'opening',
      userWs: null,
    }));
    expect(
      await expireOpeningRemoteConnection(
        sessions,
        replacement.sessionId,
        identity(opening),
        release,
      ),
    ).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(sessions.get(replacement.sessionId)?.generation).toBe(2);
  });
});
