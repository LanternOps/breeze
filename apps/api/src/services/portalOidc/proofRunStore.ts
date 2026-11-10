/**
 * Entra tenant proof-run links (portal registration W4, plan D6, Task 8).
 *
 * An MSP creates a link (routes/orgPortalEntraTenant.ts) and sends it to the
 * customer's tenant admin, who opens it on the portal
 * (`GET {PORTAL_ENTRA_PROOF_RUN_PATH}?run=<token>`, routes/portal/oidc.ts),
 * signs in to the portal Entra app and passes the live Graph role check. The
 * run record is
 *   - stored under `PORTAL_REDIS_KEYS.entraProofRun(sha256(token))` for 72 h;
 *     the raw token travels only in the link;
 *   - always pinned to a tenant (`expectedTenantId`, D6), so a forwarded or
 *     leaked link cannot prove some other tenant whose admin opens it;
 *   - PEEKED (GET, no DEL) when the sign-in starts, so a failed sign-in or a
 *     failed admin check does not burn it;
 *   - CONSUMED by hash with the shared Lua GET+DEL (`luaGetDel`) right before
 *     the proof is recorded — on Redis one server-side step, in memory a get +
 *     delete in one synchronous tick — so two concurrent callbacks record one
 *     proof.
 *
 * The backend follows `PORTAL_USE_REDIS` — Redis in production, the in-memory
 * twin in routes/portal/helpers.ts otherwise — the same switch as the OIDC
 * state (./stateStore.ts), sessions and capability tokens.
 */
import { createHash, randomBytes, randomUUID } from 'crypto';
import { getRedis } from '../redis';
import { PORTAL_REDIS_KEYS, PORTAL_USE_REDIS } from '../../routes/portal/schemas';
import {
  PORTAL_ENTRA_PROOF_RUN_CAP,
  capMapByOldest,
  luaGetDel,
  portalEntraProofRuns,
} from '../../routes/portal/helpers';
import { isGuid, isProvableEntraTenantId, isSha256Hex } from './validators';

export const PORTAL_ENTRA_PROOF_RUN_TTL_SECONDS = 72 * 60 * 60;
/** Where the link points: the public portal route that starts the proof sign-in. */
export const PORTAL_ENTRA_PROOF_RUN_PATH = '/api/v1/portal/auth/oidc/entra/proof';
const RUN_TTL_MS = PORTAL_ENTRA_PROOF_RUN_TTL_SECONDS * 1000;
/** Generous bound on a `run` query value; ours are 43 characters. */
const MAX_RAW_TOKEN_LENGTH = 512;

/** The stored run. Never holds the raw token. */
export interface PortalEntraProofRunRecord {
  v: 1;
  runId: string;
  orgId: string;
  partnerId: string;
  /** The MSP user who created the link; re-authorized at record time (D6). */
  createdByUserId: string;
  /** Lowercased tenant GUID the proof sign-in is pinned to. Never null (D6). */
  expectedTenantId: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

export interface CreatePortalEntraProofRunInput {
  orgId: string;
  partnerId: string;
  createdByUserId: string;
  expectedTenantId: string;
}

/** Redis is required (production backend) but not available: nothing was stored. */
export class PortalEntraProofRunUnavailableError extends Error {
  override readonly name = 'PortalEntraProofRunUnavailableError';
  constructor() {
    super('Portal Entra proof-run store unavailable');
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Stores a new run and returns the raw token (32 random bytes, base64url) for
 * the link. Throws on an input that is not a pinned tenant and real ids (a
 * caller bug), and PortalEntraProofRunUnavailableError when Redis is required
 * but absent, so no link is ever handed out that could not be redeemed.
 */
export async function createPortalEntraProofRun(
  input: CreatePortalEntraProofRunInput,
): Promise<{ token: string; runId: string; expiresAt: Date }> {
  const expectedTenantId = typeof input.expectedTenantId === 'string' ? input.expectedTenantId.trim().toLowerCase() : '';
  if (!isProvableEntraTenantId(expectedTenantId)) {
    throw new Error('createPortalEntraProofRun: a proof run must be pinned to an Entra tenant id');
  }
  if (!isGuid(input.orgId) || !isGuid(input.partnerId) || !isGuid(input.createdByUserId)) {
    throw new Error('createPortalEntraProofRun: invalid org, partner or user id');
  }

  const token = randomBytes(32).toString('base64url');
  const createdAt = Date.now();
  const record: PortalEntraProofRunRecord = {
    v: 1,
    runId: randomUUID(),
    orgId: input.orgId,
    partnerId: input.partnerId,
    createdByUserId: input.createdByUserId,
    expectedTenantId,
    createdAt,
  };
  const payload = JSON.stringify(record);
  const tokenHash = sha256Hex(token);

  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) throw new PortalEntraProofRunUnavailableError();
    await redis.setex(PORTAL_REDIS_KEYS.entraProofRun(tokenHash), PORTAL_ENTRA_PROOF_RUN_TTL_SECONDS, payload);
  } else {
    portalEntraProofRuns.set(tokenHash, {
      payload,
      createdAt: new Date(createdAt),
      expiresAt: new Date(createdAt + RUN_TTL_MS),
    });
    capMapByOldest(portalEntraProofRuns, PORTAL_ENTRA_PROOF_RUN_CAP, (entry) => entry.createdAt.getTime());
  }

  return { token, runId: record.runId, expiresAt: new Date(createdAt + RUN_TTL_MS) };
}

/** A found record that was refused. Logged by reason only — never a token, hash or payload value. */
function reject(reason: 'parse' | 'version' | 'shape' | 'expired'): null {
  console.warn('[portal] Entra proof run rejected', { reason });
  return null;
}

function parseRun(raw: string): PortalEntraProofRunRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reject('parse');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject('shape');
  const { v, runId, orgId, partnerId, createdByUserId, expectedTenantId, createdAt } = parsed as Record<string, unknown>;
  if (v !== 1) return reject('version');
  if (
    !isGuid(runId)
    || !isGuid(orgId)
    || !isGuid(partnerId)
    || !isGuid(createdByUserId)
    || !isProvableEntraTenantId(expectedTenantId)
    || typeof createdAt !== 'number'
    || !Number.isFinite(createdAt)
  ) {
    return reject('shape');
  }
  // The store's TTL is the primary expiry; this holds the same 72 h across
  // both backends even if a TTL was lost.
  if (Date.now() - createdAt >= RUN_TTL_MS) return reject('expired');
  return { v: 1, runId, orgId, partnerId, createdByUserId, expectedTenantId, createdAt };
}

/**
 * Reads the run for a raw link token WITHOUT consuming it (GET, no DEL), plus
 * the token's sha256 for the later consume. Null for an unknown, expired or
 * malformed run, and when Redis is required but unavailable.
 */
export async function peekPortalEntraProofRun(
  rawToken: string,
): Promise<{ record: PortalEntraProofRunRecord; tokenHash: string } | null> {
  if (typeof rawToken !== 'string' || !rawToken || rawToken.length > MAX_RAW_TOKEN_LENGTH) return null;
  const tokenHash = sha256Hex(rawToken);

  let raw: string | null;
  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) return null;
    raw = await redis.get(PORTAL_REDIS_KEYS.entraProofRun(tokenHash));
  } else {
    const entry = portalEntraProofRuns.get(tokenHash);
    raw = entry && entry.expiresAt.getTime() > Date.now() ? entry.payload : null;
  }
  if (raw === null) return null;

  const record = parseRun(raw);
  return record ? { record, tokenHash } : null;
}

/**
 * GET+DEL by the token's sha256: of any number of concurrent callers exactly
 * one gets the record. Null (the run is gone either way) for an unknown,
 * expired or malformed run, and — with nothing consumed — when Redis is
 * required but unavailable.
 */
export async function consumePortalEntraProofRunByHash(tokenHash: string): Promise<PortalEntraProofRunRecord | null> {
  if (!isSha256Hex(tokenHash)) return null;

  let raw: string | null;
  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) return null;
    raw = await luaGetDel(redis, PORTAL_REDIS_KEYS.entraProofRun(tokenHash));
  } else {
    // get + delete in one synchronous tick: no await between them.
    const entry = portalEntraProofRuns.get(tokenHash);
    portalEntraProofRuns.delete(tokenHash);
    raw = entry && entry.expiresAt.getTime() > Date.now() ? entry.payload : null;
  }
  return raw === null ? null : parseRun(raw);
}
