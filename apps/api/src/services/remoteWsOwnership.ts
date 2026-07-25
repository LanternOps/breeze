import type { WSContext } from 'hono/ws';
import type { RemoteWsSharedLeaseClaim } from './remoteWsSharedLease';

export type RemoteWsKind = 'terminal' | 'desktop' | 'tunnel';
export type RemoteWsLeaseState = 'opening' | 'active' | 'closing';

export interface RemoteConnectionLease {
  connectionId: string;
  generation: number;
  instanceId: string;
  leaseToken: string;
  state: RemoteWsLeaseState;
  userWs: WSContext | null;
  safeForwardingUntilMonotonicMs: number;
  cleanupPromise?: Promise<void>;
}

export interface RemoteConnectionIdentity {
  connectionId: string;
  generation: number;
  instanceId: string;
  leaseToken: string;
}

export type InstallLocalConnectionResult =
  | { ok: true }
  | { ok: false; reason: 'already_owned' };

function hasExactIdentity(
  value: RemoteConnectionIdentity,
  expected: RemoteConnectionIdentity,
): boolean {
  return (
    value.connectionId === expected.connectionId
    && value.generation === expected.generation
    && value.instanceId === expected.instanceId
    && value.leaseToken === expected.leaseToken
  );
}

export function installLocalRemoteConnection<T extends RemoteConnectionLease>(
  sessions: Map<string, T>,
  sessionId: string,
  shared: RemoteWsSharedLeaseClaim,
  build: (shared: RemoteWsSharedLeaseClaim) => T,
): InstallLocalConnectionResult {
  if (shared.sessionId !== sessionId || sessions.has(sessionId)) {
    return { ok: false, reason: 'already_owned' };
  }
  sessions.set(sessionId, build(shared));
  return { ok: true };
}

export function bindRemoteConnection<T extends RemoteConnectionLease>(
  sessions: Map<string, T>,
  sessionId: string,
  identity: RemoteConnectionIdentity,
  ws: WSContext,
): boolean {
  const current = sessions.get(sessionId);
  if (
    !current
    || !hasExactIdentity(current, identity)
    || current.state !== 'opening'
    || current.userWs !== null
  ) {
    return false;
  }
  current.userWs = ws;
  current.state = 'active';
  return true;
}

export function ownsSafeRemoteConnection<T extends RemoteConnectionLease>(
  sessions: Map<string, T>,
  sessionId: string,
  identity: RemoteConnectionIdentity,
  ws: WSContext,
  monotonicNowMs = performance.now(),
): boolean {
  const current = sessions.get(sessionId);
  return Boolean(
    current
    && current.state === 'active'
    && current.userWs === ws
    && hasExactIdentity(current, identity)
    && monotonicNowMs < current.safeForwardingUntilMonotonicMs,
  );
}

export function updateExactRemoteConnectionDeadline<T extends RemoteConnectionLease>(
  sessions: Map<string, T>,
  sessionId: string,
  identity: RemoteConnectionIdentity,
  safeForwardingUntilMonotonicMs: number,
): boolean {
  const current = sessions.get(sessionId);
  if (!current || !hasExactIdentity(current, identity) || current.state === 'closing') {
    return false;
  }
  current.safeForwardingUntilMonotonicMs = safeForwardingUntilMonotonicMs;
  return true;
}

export function expireExactRemoteConnectionForwarding<T extends RemoteConnectionLease>(
  sessions: Map<string, T>,
  sessionId: string,
  identity: RemoteConnectionIdentity,
): boolean {
  const current = sessions.get(sessionId);
  if (!current || !hasExactIdentity(current, identity)) {
    return false;
  }
  current.safeForwardingUntilMonotonicMs = 0;
  return true;
}

export async function renewExactRemoteConnectionLease<T extends RemoteConnectionLease>(
  sessions: Map<string, T>,
  sessionId: string,
  identity: RemoteConnectionIdentity,
  expectedWs: WSContext | null,
  renewShared: () => Promise<RemoteWsSharedLeaseClaim>,
): Promise<boolean> {
  const current = sessions.get(sessionId);
  if (
    !current
    || !hasExactIdentity(current, identity)
    || current.state === 'closing'
    || current.userWs !== expectedWs
  ) {
    return false;
  }

  const expectedState = current.state;
  current.safeForwardingUntilMonotonicMs = 0;

  let renewed: RemoteWsSharedLeaseClaim;
  try {
    renewed = await renewShared();
  } catch {
    return false;
  }

  const afterRenewal = sessions.get(sessionId);
  if (
    afterRenewal !== current
    || !hasExactIdentity(afterRenewal, identity)
    || afterRenewal.state !== expectedState
    || afterRenewal.userWs !== expectedWs
    || renewed.sessionId !== sessionId
    || !hasExactIdentity(renewed, identity)
    || !Number.isFinite(renewed.safeForwardingUntilMonotonicMs)
  ) {
    return false;
  }
  afterRenewal.safeForwardingUntilMonotonicMs = renewed.safeForwardingUntilMonotonicMs;
  return true;
}

export function removeExactLocalRemoteConnection<T extends RemoteConnectionLease>(
  sessions: Map<string, T>,
  sessionId: string,
  identity: RemoteConnectionIdentity,
): boolean {
  const current = sessions.get(sessionId);
  if (!current || !hasExactIdentity(current, identity)) {
    return false;
  }
  return sessions.delete(sessionId);
}

export async function expireOpeningRemoteConnection<T extends RemoteConnectionLease>(
  sessions: Map<string, T>,
  sessionId: string,
  identity: RemoteConnectionIdentity,
  releaseShared: () => Promise<boolean>,
): Promise<boolean> {
  const current = sessions.get(sessionId);
  if (
    !current
    || !hasExactIdentity(current, identity)
    || current.state !== 'opening'
    || current.userWs !== null
  ) {
    return false;
  }
  current.state = 'closing';
  current.safeForwardingUntilMonotonicMs = 0;
  const released = await releaseShared();
  if (!released) return false;

  const afterRelease = sessions.get(sessionId);
  if (
    afterRelease !== current
    || !hasExactIdentity(afterRelease, identity)
    || afterRelease.state !== 'closing'
    || afterRelease.userWs !== null
  ) {
    return false;
  }
  return sessions.delete(sessionId);
}
