/**
 * Keeps live model-gateway grants in step with gateway-connection writes.
 *
 * A grant outlives the moment it was issued (a chat session's lasts hours), so
 * a disconnect, key rotation or URL change must stop it reaching the upstream:
 *  - in THIS process: `revokeGatewayConnectionGrants` after the write commits
 *    revokes every grant the local gateway holds for the connection;
 *  - on every OTHER replica: `gatewayConnectionCheck`, registered with the
 *    gateway at boot, is consulted before each upstream dial and refuses a
 *    grant whose connection is no longer active at the grant's config_version
 *    (read through a short per-connection cache, so a change elsewhere takes
 *    effect within GATEWAY_CONNECTION_CHECK_TTL_MS).
 *
 * The gateway starts lazily; revocation never starts it (a process that never
 * started it holds no grants). Every in-process caller that needs the gateway
 * goes through `acquireModelGateway` so that state is known here.
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partnerAiConnections } from '../../db/schema';
import { captureException } from '../sentry';
import { getModelGateway, setGatewayConnectionCheck, type ModelGateway } from './gateway';
import { safeErrorMessage } from './safeDbError';

export const GATEWAY_CONNECTION_CHECK_TTL_MS = 15_000;
/** Expired entries are swept once the cache grows past this. */
const CACHE_SWEEP_SIZE = 1_000;

let gatewayAcquired = false;

/** The gateway, started on first use. The only way this process should obtain it. */
export async function acquireModelGateway(): Promise<ModelGateway> {
  const gateway = await getModelGateway();
  gatewayAcquired = true;
  return gateway;
}

interface CachedConnectionState {
  status: string | null;
  configVersion: number | null;
  expiresAt: number;
}

const cache = new Map<string, CachedConnectionState>();

function sweep(now: number): void {
  if (cache.size <= CACHE_SWEEP_SIZE) return;
  for (const [id, entry] of cache) if (entry.expiresAt <= now) cache.delete(id);
}

/**
 * Whether a grant bound to `configVersion` of `connectionId` may still dial:
 * the connection exists, is active, and is at that config version. A read
 * failure throws (the gateway fails closed) and is not cached.
 */
export async function gatewayConnectionCheck(connectionId: string, configVersion: number): Promise<boolean> {
  const now = Date.now();
  let entry = cache.get(connectionId);
  if (!entry || entry.expiresAt <= now) {
    // System scope: the check runs inside the gateway's request handler, with
    // no tenant context. Two columns only; no key material is read.
    const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(
      () => db
        .select({ status: partnerAiConnections.status, configVersion: partnerAiConnections.configVersion })
        .from(partnerAiConnections)
        .where(eq(partnerAiConnections.id, connectionId))
        .limit(1),
      'aiModels.gatewayConnectionCheck',
    ));
    entry = {
      status: row?.status ?? null,
      configVersion: row?.configVersion ?? null,
      expiresAt: now + GATEWAY_CONNECTION_CHECK_TTL_MS,
    };
    sweep(now);
    cache.set(connectionId, entry);
  }
  return entry.status === 'active' && entry.configVersion === configVersion;
}

/** Boot (API and worker): every upstream dial of this process's gateway runs the check. */
export function registerGatewayConnectionCheck(): void {
  setGatewayConnectionCheck(gatewayConnectionCheck);
}

/**
 * After a COMMITTED disconnect, key change or URL change: revoke this
 * process's live grants for the connection and drop its cached check entry.
 * Best effort: a failure is logged and captured, never thrown — the write has
 * already happened, and the connection check still refuses the stale grant.
 */
export async function revokeGatewayConnectionGrants(connectionId: string): Promise<void> {
  cache.delete(connectionId);
  if (!gatewayAcquired) return;
  try {
    const revoked = (await getModelGateway()).revokeConnection(connectionId);
    if (revoked > 0) console.info(`[aiModels] revoked ${revoked} live gateway grant(s) for connection ${connectionId}`);
  } catch (error) {
    console.error(`[aiModels] could not revoke gateway grants for connection ${connectionId}: ${safeErrorMessage(error)}`);
    captureException(error, undefined, { service: 'aiModels', stage: 'gateway_revoke' });
  }
}

export function __resetGatewayConnectionStateForTests(): void {
  gatewayAcquired = false;
  cache.clear();
}
