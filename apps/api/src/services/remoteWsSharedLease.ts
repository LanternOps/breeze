import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { RemoteConnectionIdentity, RemoteWsKind } from './remoteWsOwnership';
import { createRemoteWsRedisTopologyMonitor } from './remoteWsRedisTopology';
import { getRedis } from './redis';

export const REMOTE_WS_SHARED_LEASE_TTL_MS = 30_000;
export const REMOTE_WS_SHARED_LEASE_RENEW_EVERY_MS = 5_000;
export const REMOTE_WS_FORWARDING_SAFETY_MARGIN_MS = 10_000;
export const REMOTE_WS_SHARED_LEASE_MAX_ROUND_TRIP_MS = 2_000;

export interface RemoteWsSharedLeaseClaim extends RemoteConnectionIdentity {
  kind: RemoteWsKind;
  sessionId: string;
  ownerValue: string;
  safeForwardingUntilMonotonicMs: number;
}

export type AcquireRemoteWsSharedLeaseResult =
  | { ok: true; claim: RemoteWsSharedLeaseClaim }
  | {
      ok: false;
      reason:
        | 'already_owned'
        | 'desktop_finalizing'
        | 'desktop_orphan_recovery'
        | 'unsupported_topology'
        | 'unavailable';
    };

export type BeginRemoteWsSharedCloseResult =
  | { ok: true; ownership: 'still_owner' }
  | { ok: false; reason: 'owner_mismatch' | 'unavailable' };

export type WriteDesktopFinalizationIntentResult =
  | 'written'
  | 'already_written'
  | 'owner_mismatch'
  | 'conflict'
  | 'unavailable';

export type ClaimDesktopOrphanResult =
  | 'claimed'
  | 'already_owned'
  | 'conflict'
  | 'unavailable';

export interface RemoteWsRedisKeys {
  owner: string;
  generation: string;
  finalizing?: string;
  finalizationPayload?: string;
}

export interface DesktopFinalizationSharedState {
  ownerPresent: boolean;
  finalizationId: string | null;
  canonicalPayload: string | null;
  consistent: boolean;
}

export function getRemoteWsRedisKeys(kind: RemoteWsKind, sessionId: string): RemoteWsRedisKeys {
  const slot = `{${kind}:${sessionId}}`;
  const base = `remote:ws:${slot}`;
  return {
    generation: `${base}:generation`,
    owner: `${base}:owner`,
    ...(kind === 'desktop'
      ? {
          finalizing: `${base}:finalizing`,
          finalizationPayload: `${base}:finalization-payload`,
        }
      : {}),
  };
}

export const REMOTE_WS_SHARED_LEASE_SCRIPTS = {
  acquire: `
    local owner = redis.call('GET', KEYS[1])
    if owner then return {'already_owned'} end
    if #KEYS == 4 then
      local fence = redis.call('GET', KEYS[3])
      local payload = redis.call('GET', KEYS[4])
      if (fence and not payload) or (payload and not fence) then
        return {'inconsistent_finalization'}
      end
      if fence and payload then
        if string.find(payload, '"reason":"orphan_recovery"', 1, true) then
          return {'desktop_orphan_recovery'}
        end
        return {'desktop_finalizing'}
      end
    end
    local generation = redis.call('INCR', KEYS[2])
    local value = string.gsub(ARGV[1], '__GENERATION__', tostring(generation))
    redis.call('SET', KEYS[1], value, 'PX', ARGV[2], 'NX')
    return {'acquired', tostring(generation)}
  `,
  renew: `
    if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {'owner_mismatch'} end
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
    return {'renewed'}
  `,
  beginClose: `
    if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {'owner_mismatch'} end
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
    return {'still_owner'}
  `,
  release: `
    if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {'owner_mismatch'} end
    redis.call('DEL', KEYS[1])
    return {'released'}
  `,
  writeDesktopIntent: `
    if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {'owner_mismatch'} end
    local fence = redis.call('GET', KEYS[2])
    local payload = redis.call('GET', KEYS[3])
    if not fence and not payload then
      redis.call('SET', KEYS[2], ARGV[2])
      redis.call('SET', KEYS[3], ARGV[3])
      return {'written'}
    end
    if fence == ARGV[2] and payload == ARGV[3] then return {'already_written'} end
    return {'conflict'}
  `,
  claimDesktopOrphan: `
    if redis.call('GET', KEYS[1]) then return {'already_owned'} end
    if redis.call('GET', KEYS[2]) or redis.call('GET', KEYS[3]) then return {'conflict'} end
    redis.call('SET', KEYS[2], ARGV[1])
    redis.call('SET', KEYS[3], ARGV[2])
    return {'claimed'}
  `,
  releaseDesktopIntent: `
    if redis.call('GET', KEYS[2]) ~= ARGV[1] then return {'owner_mismatch'} end
    if redis.call('GET', KEYS[3]) ~= ARGV[2] then return {'owner_mismatch'} end
    redis.call('DEL', KEYS[2], KEYS[3])
    return {'released'}
  `,
  observeDesktopFinalization: `
    local owner = redis.call('GET', KEYS[1])
    local fence = redis.call('GET', KEYS[2])
    local payload = redis.call('GET', KEYS[3])
    return {
      owner and '1' or '0',
      fence or '',
      payload or '',
      ((fence and payload) or (not fence and not payload)) and '1' or '0'
    }
  `,
} as const;

function parseScriptReply(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((value) => typeof value === 'string')) {
    return null;
  }
  return raw;
}

function buildOwnerTemplate(input: {
  instanceId: string;
  connectionId: string;
  leaseToken: string;
}): string {
  return `v1|${input.instanceId}|${input.connectionId}|__GENERATION__|${input.leaseToken}`;
}

function buildOwnerValue(
  instanceId: string,
  connectionId: string,
  generation: number,
  leaseToken: string,
): string {
  return `v1|${instanceId}|${connectionId}|${generation}|${leaseToken}`;
}

function hasCanonicalOwnerValue(claim: RemoteWsSharedLeaseClaim): boolean {
  return claim.ownerValue === buildOwnerValue(
    claim.instanceId,
    claim.connectionId,
    claim.generation,
    claim.leaseToken,
  );
}

export function createRemoteWsSharedLeaseManager(input: {
  redis: Redis;
  instanceId: string;
  requiredTopology: 'standalone-single-primary';
  monotonicNow?: () => number;
}) {
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const topology = createRemoteWsRedisTopologyMonitor({
    redis: input.redis,
    requiredTopology: input.requiredTopology,
    monotonicNow,
  });

  async function evalTimed(
    script: string,
    keys: string[],
    args: Array<string | number>,
    requestStart: number,
  ): Promise<string[]> {
    let raw: unknown;
    try {
      raw = await input.redis.eval(script, keys.length, ...keys, ...args);
    } catch {
      throw new Error('remote websocket lease unavailable');
    }
    if (monotonicNow() - requestStart > REMOTE_WS_SHARED_LEASE_MAX_ROUND_TRIP_MS) {
      throw new Error('remote websocket lease reply was slow');
    }
    const reply = parseScriptReply(raw);
    if (!reply) {
      throw new Error('remote websocket lease reply was malformed');
    }
    return reply;
  }

  return {
    async acquire(
      kind: RemoteWsKind,
      sessionId: string,
    ): Promise<AcquireRemoteWsSharedLeaseResult> {
      const topologyStatus = await topology.requireAdmission();
      if (!topologyStatus.ok) return topologyStatus;

      const requestStart = monotonicNow();
      const connectionId = randomUUID();
      const leaseToken = randomUUID();
      const keys = getRemoteWsRedisKeys(kind, sessionId);
      const scriptKeys = kind === 'desktop'
        ? [keys.owner, keys.generation, keys.finalizing!, keys.finalizationPayload!]
        : [keys.owner, keys.generation];
      let reply: string[];
      try {
        reply = await evalTimed(
          REMOTE_WS_SHARED_LEASE_SCRIPTS.acquire,
          scriptKeys,
          [
            buildOwnerTemplate({ instanceId: input.instanceId, connectionId, leaseToken }),
            REMOTE_WS_SHARED_LEASE_TTL_MS,
          ],
          requestStart,
        );
      } catch {
        return { ok: false, reason: 'unavailable' };
      }

      switch (reply[0]) {
        case 'already_owned':
          return { ok: false, reason: 'already_owned' };
        case 'desktop_finalizing':
          return { ok: false, reason: 'desktop_finalizing' };
        case 'desktop_orphan_recovery':
          return { ok: false, reason: 'desktop_orphan_recovery' };
        case 'inconsistent_finalization':
          return { ok: false, reason: 'unavailable' };
        case 'acquired': {
          const generation = Number(reply[1]);
          if (!Number.isSafeInteger(generation) || generation <= 0) {
            return { ok: false, reason: 'unavailable' };
          }
          return {
            ok: true,
            claim: {
              kind,
              sessionId,
              connectionId,
              generation,
              instanceId: input.instanceId,
              leaseToken,
              ownerValue: buildOwnerValue(
                input.instanceId,
                connectionId,
                generation,
                leaseToken,
              ),
              safeForwardingUntilMonotonicMs:
                requestStart
                + REMOTE_WS_SHARED_LEASE_TTL_MS
                - REMOTE_WS_FORWARDING_SAFETY_MARGIN_MS,
            },
          };
        }
        default:
          return { ok: false, reason: 'unavailable' };
      }
    },

    async renew(claim: RemoteWsSharedLeaseClaim): Promise<RemoteWsSharedLeaseClaim> {
      claim.safeForwardingUntilMonotonicMs = 0;
      if (!hasCanonicalOwnerValue(claim)) {
        throw new Error('remote websocket lease owner_mismatch: claim identity mismatch');
      }
      const topologyStatus = await topology.requireAdmission();
      if (!topologyStatus.ok) {
        throw new Error(`remote websocket lease ${topologyStatus.reason}`);
      }
      const requestStart = monotonicNow();
      const keys = getRemoteWsRedisKeys(claim.kind, claim.sessionId);
      const reply = await evalTimed(
        REMOTE_WS_SHARED_LEASE_SCRIPTS.renew,
        [keys.owner],
        [claim.ownerValue, REMOTE_WS_SHARED_LEASE_TTL_MS],
        requestStart,
      );
      if (reply[0] !== 'renewed') {
        throw new Error(
          reply[0] === 'owner_mismatch'
            ? 'remote websocket lease owner_mismatch'
            : 'remote websocket lease reply was malformed',
        );
      }
      claim.safeForwardingUntilMonotonicMs =
        requestStart
        + REMOTE_WS_SHARED_LEASE_TTL_MS
        - REMOTE_WS_FORWARDING_SAFETY_MARGIN_MS;
      return claim;
    },

    async beginClose(claim: RemoteWsSharedLeaseClaim): Promise<BeginRemoteWsSharedCloseResult> {
      claim.safeForwardingUntilMonotonicMs = 0;
      if (!hasCanonicalOwnerValue(claim)) {
        return { ok: false, reason: 'owner_mismatch' };
      }
      const requestStart = monotonicNow();
      const keys = getRemoteWsRedisKeys(claim.kind, claim.sessionId);
      try {
        const reply = await evalTimed(
          REMOTE_WS_SHARED_LEASE_SCRIPTS.beginClose,
          [keys.owner],
          [claim.ownerValue, REMOTE_WS_SHARED_LEASE_TTL_MS],
          requestStart,
        );
        if (reply[0] === 'still_owner') return { ok: true, ownership: 'still_owner' };
        if (reply[0] === 'owner_mismatch') return { ok: false, reason: 'owner_mismatch' };
        return { ok: false, reason: 'unavailable' };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },

    async release(claim: RemoteWsSharedLeaseClaim): Promise<boolean> {
      claim.safeForwardingUntilMonotonicMs = 0;
      if (!hasCanonicalOwnerValue(claim)) return false;
      const requestStart = monotonicNow();
      const keys = getRemoteWsRedisKeys(claim.kind, claim.sessionId);
      try {
        const reply = await evalTimed(
          REMOTE_WS_SHARED_LEASE_SCRIPTS.release,
          [keys.owner],
          [claim.ownerValue],
          requestStart,
        );
        return reply[0] === 'released';
      } catch {
        return false;
      }
    },

    async writeDesktopFinalizationIntent(
      claim: RemoteWsSharedLeaseClaim,
      finalizationId: string,
      canonicalPayload: string,
    ): Promise<WriteDesktopFinalizationIntentResult> {
      if (claim.kind !== 'desktop') return 'unavailable';
      if (!hasCanonicalOwnerValue(claim)) return 'owner_mismatch';
      const keys = getRemoteWsRedisKeys('desktop', claim.sessionId);
      const requestStart = monotonicNow();
      try {
        const reply = await evalTimed(
          REMOTE_WS_SHARED_LEASE_SCRIPTS.writeDesktopIntent,
          [keys.owner, keys.finalizing!, keys.finalizationPayload!],
          [claim.ownerValue, finalizationId, canonicalPayload],
          requestStart,
        );
        if (
          reply[0] === 'written'
          || reply[0] === 'already_written'
          || reply[0] === 'owner_mismatch'
          || reply[0] === 'conflict'
        ) {
          return reply[0];
        }
        return 'unavailable';
      } catch {
        return 'unavailable';
      }
    },

    async claimDesktopOrphan(
      sessionId: string,
      finalizationId: string,
      canonicalPayload: string,
    ): Promise<ClaimDesktopOrphanResult> {
      const topologyStatus = await topology.requireAdmission();
      if (!topologyStatus.ok) return 'unavailable';
      const keys = getRemoteWsRedisKeys('desktop', sessionId);
      const requestStart = monotonicNow();
      try {
        const reply = await evalTimed(
          REMOTE_WS_SHARED_LEASE_SCRIPTS.claimDesktopOrphan,
          [keys.owner, keys.finalizing!, keys.finalizationPayload!],
          [finalizationId, canonicalPayload],
          requestStart,
        );
        if (
          reply[0] === 'claimed'
          || reply[0] === 'already_owned'
          || reply[0] === 'conflict'
        ) {
          return reply[0];
        }
        return 'unavailable';
      } catch {
        return 'unavailable';
      }
    },

    async releaseDesktopFinalizationIntent(
      sessionId: string,
      finalizationId: string,
      canonicalPayload: string,
    ): Promise<boolean> {
      const keys = getRemoteWsRedisKeys('desktop', sessionId);
      const requestStart = monotonicNow();
      try {
        const reply = await evalTimed(
          REMOTE_WS_SHARED_LEASE_SCRIPTS.releaseDesktopIntent,
          [keys.owner, keys.finalizing!, keys.finalizationPayload!],
          [finalizationId, canonicalPayload],
          requestStart,
        );
        return reply[0] === 'released';
      } catch {
        return false;
      }
    },

    async observeDesktopFinalization(
      sessionId: string,
    ): Promise<DesktopFinalizationSharedState> {
      const keys = getRemoteWsRedisKeys('desktop', sessionId);
      const requestStart = monotonicNow();
      const reply = await evalTimed(
        REMOTE_WS_SHARED_LEASE_SCRIPTS.observeDesktopFinalization,
        [keys.owner, keys.finalizing!, keys.finalizationPayload!],
        [],
        requestStart,
      );
      if (
        reply.length !== 4
        || (reply[0] !== '0' && reply[0] !== '1')
        || (reply[3] !== '0' && reply[3] !== '1')
      ) {
        throw new Error('remote websocket desktop intent reply was malformed');
      }
      return {
        ownerPresent: reply[0] === '1',
        finalizationId: reply[1] === '' ? null : (reply[1] ?? null),
        canonicalPayload: reply[2] === '' ? null : (reply[2] ?? null),
        consistent: reply[3] === '1',
      };
    },

    topology,
  };
}

export type RemoteWsSharedLeaseManager = ReturnType<
  typeof createRemoteWsSharedLeaseManager
>;

const remoteWsProcessInstanceId = randomUUID();
let sharedLeaseManager: RemoteWsSharedLeaseManager | null = null;
let sharedLeaseRedis: Redis | null = null;

/**
 * One manager per API process. Tests and route factories may inject a manager,
 * but production callers share this exact process boot identity.
 */
export function getRemoteWsSharedLeaseManager(): RemoteWsSharedLeaseManager | null {
  const redis = getRedis();
  if (!redis) return null;
  if (!sharedLeaseManager || sharedLeaseRedis !== redis) {
    sharedLeaseRedis = redis;
    sharedLeaseManager = createRemoteWsSharedLeaseManager({
      redis,
      instanceId: remoteWsProcessInstanceId,
      requiredTopology: 'standalone-single-primary',
    });
  }
  return sharedLeaseManager;
}
