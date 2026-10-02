import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { GRANT_DEFAULT_TTL_MS, GRANT_SESSION_TTL_MS } from './limits';
import type { GatewayConnectionConfig, GatewayCredential, GatewayGrantInput, GatewayGrantRecord } from './types';

/**
 * Grants are keyed by the SHA-256 digest of the token: the raw token is never
 * held, and a lookup is a Map hit on the digest of the FULL presented token (no
 * prefix or byte-wise comparison exists to time).
 */
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export interface GrantStore {
  issue(input: GatewayGrantInput): { token: string; record: GatewayGrantRecord };
  lookup(token: string): GatewayGrantRecord | null;
  revoke(token: string): void;
  /** Revokes every grant bound to the connection; returns how many were revoked. */
  revokeConnection(connectionId: string): number;
  revokeAll(): void;
  sweep(): void;
  size(): number;
  /** Test-only: the map keys (digests). */
  __debugKeys(): IterableIterator<string>;
}

function clampTtl(ttlMs: number | undefined): number {
  const ttl = ttlMs ?? GRANT_DEFAULT_TTL_MS;
  if (!Number.isFinite(ttl)) return GRANT_SESSION_TTL_MS;
  return Math.min(Math.max(ttl, 1), GRANT_SESSION_TTL_MS);
}

export function createGrantStore(now: () => number = Date.now): GrantStore {
  const byDigest = new Map<string, GatewayGrantRecord>();

  const drop = (key: string): void => {
    const rec = byDigest.get(key);
    if (!rec) return;
    byDigest.delete(key);
    for (const ac of rec.inFlight) ac.abort();
    rec.inFlight.clear();
    // Best effort: drop the plaintext from the record handed out by reference
    // (the record owns a private copy of the credential, see issue()).
    rec.credential.secret = null;
  };

  return {
    issue(input) {
      if (input.wireModels.length === 0) throw new Error('A gateway grant needs at least one wire model.');
      // A dispatch is always an org's turn, and the per-request egress audit row
      // is keyed by org: an org-less dispatch grant would forward unaudited. The
      // input type already requires it; this guards untyped and cast callers.
      if (input.purpose === 'dispatch' && !(input.orgId as string | null)) {
        throw new Error('A dispatch gateway grant needs an org.');
      }
      const token = randomBytes(32).toString('base64url');
      const record: GatewayGrantRecord = {
        id: randomUUID(),
        config: { ...input.config },
        credential: { secret: input.credential.secret },
        wireModels: new Set(input.wireModels),
        orgId: input.orgId,
        aiSessionId: input.aiSessionId,
        purpose: input.purpose,
        expiresAt: now() + clampTtl(input.ttlMs),
        inFlight: new Set(),
      };
      byDigest.set(digest(token), record);
      return { token, record };
    },
    lookup(token) {
      if (!TOKEN_SHAPE.test(token)) return null;
      const key = digest(token);
      const rec = byDigest.get(key);
      if (!rec) return null;
      if (rec.expiresAt <= now()) { drop(key); return null; }
      return rec;
    },
    revoke(token) { drop(digest(token)); },
    revokeConnection(connectionId) {
      let n = 0;
      for (const [key, rec] of [...byDigest]) {
        if (rec.config.connectionId === connectionId) { drop(key); n += 1; }
      }
      return n;
    },
    revokeAll() { for (const key of [...byDigest.keys()]) drop(key); },
    sweep() {
      const t = now();
      for (const [key, rec] of [...byDigest]) if (rec.expiresAt <= t) drop(key);
    },
    size: () => byDigest.size,
    __debugKeys: () => byDigest.keys(),
  };
}

/** How long an in-process discovery record is good for (the call itself is capped far below this). */
const DISCOVERY_RECORD_TTL_MS = 60_000;

/**
 * A grant record used IN-PROCESS for a partner-level discovery call. It is never
 * registered in a GrantStore and no token exists for it, so it cannot be
 * presented to the loopback gateway: it only feeds forwardUpstream (origin/path
 * pin, SSRF guard, credential injection). Org-less by design — discovery is a
 * partner-level action — so forwardUpstream writes no llm_egress_events row for
 * it (that table is org-scoped). It binds no wire model.
 */
export function discoveryGrantRecord(config: GatewayConnectionConfig, credential: GatewayCredential): GatewayGrantRecord {
  return {
    id: randomUUID(),
    config: { ...config },
    credential: { secret: credential.secret },
    wireModels: new Set<string>(),
    orgId: null,
    aiSessionId: null,
    purpose: 'discovery',
    expiresAt: Date.now() + DISCOVERY_RECORD_TTL_MS,
    inFlight: new Set(),
  };
}
