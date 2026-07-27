import type { Redis } from 'ioredis';

export const REMOTE_WS_TOPOLOGY_EVIDENCE_MAX_AGE_MS = 5_000;

export interface RemoteWsRedisTopologyEvidence {
  observedAtMonotonicMs: number;
  role: string;
  primaryIdentity: string;
  failoverState: string;
  aofEnabled: boolean;
  maxmemoryPolicy: string;
  clusterEnabled: boolean;
}

export type RemoteWsRedisTopologyStatus =
  | { ok: true; evidence: RemoteWsRedisTopologyEvidence }
  | { ok: false; reason: 'unsupported_topology' | 'unavailable' };

export interface RemoteWsRedisTopologyMonitor {
  requireAdmission(): Promise<{ ok: true } | { ok: false; reason: 'unsupported_topology' | 'unavailable' }>;
  peek(): RemoteWsRedisTopologyStatus;
}

function parseInfo(raw: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    result.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return result;
}

function parseConfigValue(raw: unknown): string | null {
  if (Array.isArray(raw) && raw.length >= 2 && typeof raw[1] === 'string') {
    return raw[1];
  }
  if (raw && typeof raw === 'object') {
    const value = (raw as Record<string, unknown>)['maxmemory-policy'];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

function isSupportedEvidence(evidence: RemoteWsRedisTopologyEvidence): boolean {
  return (
    evidence.role === 'master'
    && evidence.primaryIdentity.length > 0
    && evidence.failoverState === 'no-failover'
    && evidence.aofEnabled
    && evidence.maxmemoryPolicy === 'noeviction'
    && !evidence.clusterEnabled
  );
}

export function createRemoteWsRedisTopologyMonitor(input: {
  redis: Redis;
  requiredTopology: 'standalone-single-primary';
  monotonicNow?: () => number;
}): RemoteWsRedisTopologyMonitor {
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  let status: RemoteWsRedisTopologyStatus = { ok: false, reason: 'unavailable' };
  let lastObservedAt = Number.NEGATIVE_INFINITY;
  let initialPrimaryIdentity: string | null = null;
  let refreshInFlight = false;

  async function refresh(): Promise<RemoteWsRedisTopologyStatus> {
    if (refreshInFlight) {
      status = { ok: false, reason: 'unavailable' };
      return status;
    }
    refreshInFlight = true;
    try {
      if (input.requiredTopology !== 'standalone-single-primary') {
        status = { ok: false, reason: 'unsupported_topology' };
        return status;
      }

      const [replicationRaw, persistenceRaw, policyRaw, clusterRaw] = await Promise.all([
        input.redis.info('replication'),
        input.redis.info('persistence'),
        input.redis.config('GET', 'maxmemory-policy'),
        input.redis.info('cluster'),
      ]);
      const replication = parseInfo(replicationRaw);
      const persistence = parseInfo(persistenceRaw);
      const cluster = parseInfo(clusterRaw);
      const observedAtMonotonicMs = monotonicNow();
      const evidence: RemoteWsRedisTopologyEvidence = {
        observedAtMonotonicMs,
        role: replication.get('role') ?? '',
        primaryIdentity: replication.get('master_replid') ?? '',
        failoverState: replication.get('master_failover_state') ?? '',
        aofEnabled: persistence.get('aof_enabled') === '1',
        maxmemoryPolicy: parseConfigValue(policyRaw) ?? '',
        clusterEnabled: cluster.get('cluster_enabled') === '1',
      };
      lastObservedAt = observedAtMonotonicMs;

      if (!isSupportedEvidence(evidence)) {
        status = { ok: false, reason: 'unsupported_topology' };
        return status;
      }
      if (initialPrimaryIdentity === null) {
        initialPrimaryIdentity = evidence.primaryIdentity;
      } else if (initialPrimaryIdentity !== evidence.primaryIdentity) {
        status = { ok: false, reason: 'unsupported_topology' };
        return status;
      }

      status = { ok: true, evidence };
      return status;
    } catch {
      status = { ok: false, reason: 'unavailable' };
      return status;
    } finally {
      refreshInFlight = false;
    }
  }

  return {
    async requireAdmission() {
      const now = monotonicNow();
      if (
        Number.isFinite(lastObservedAt)
        && now - lastObservedAt <= REMOTE_WS_TOPOLOGY_EVIDENCE_MAX_AGE_MS
      ) {
        return status.ok ? { ok: true } : status;
      }
      const refreshed = await refresh();
      return refreshed.ok ? { ok: true } : refreshed;
    },
    peek() {
      const now = monotonicNow();
      if (
        !Number.isFinite(lastObservedAt)
        || now - lastObservedAt > REMOTE_WS_TOPOLOGY_EVIDENCE_MAX_AGE_MS
      ) {
        return { ok: false, reason: 'unavailable' };
      }
      return status;
    },
  };
}
