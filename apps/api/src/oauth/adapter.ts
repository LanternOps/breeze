import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthAuthorizationCodes, oauthClients, oauthRefreshTokens } from '../db/schema';
import { revokeJti } from './revocationCache';

const asSystem = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

type OidcPayload = Record<string, unknown>;
type StoredPayload = { payload: OidcPayload; expiresAt: Date | null };

const inMemory = new Map<string, Map<string, StoredPayload>>();

// Side table for Breeze tenancy metadata attached to a Grant. We can't put
// this on the Grant payload itself because oidc-provider's Grant.IN_PAYLOAD
// allowlist (lib/models/grant.js) drops unknown fields on save, so anything
// we set via `grant.breeze = ...` is lost the moment the provider serializes
// the grant. The map shares the same restart-loses-state model as the
// in-memory Session/Grant store above, which is acceptable for the MVP:
// in-flight grants die on restart anyway.
type GrantBreezeMeta = { partner_id: string; org_id: string | null };
type StoredBreezeMeta = { meta: GrantBreezeMeta; expiresAt: Date | null };

const grantBreezeMeta = new Map<string, StoredBreezeMeta>();

export function setGrantBreezeMeta(
  grantId: string,
  meta: GrantBreezeMeta,
  ttlSeconds?: number,
): void {
  grantBreezeMeta.set(grantId, {
    meta,
    expiresAt: ttlSeconds === undefined ? null : new Date(Date.now() + ttlSeconds * 1000),
  });
}

export function getGrantBreezeMeta(grantId: string | undefined | null): GrantBreezeMeta | undefined {
  if (!grantId) return undefined;
  const stored = grantBreezeMeta.get(grantId);
  if (!stored) return undefined;
  if (stored.expiresAt && stored.expiresAt < new Date()) {
    grantBreezeMeta.delete(grantId);
    return undefined;
  }
  return stored.meta;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function expiresAtFrom(expiresIn?: number): Date | null {
  return expiresIn === undefined ? null : new Date(Date.now() + expiresIn * 1000);
}

function requiredPartnerId(payload: OidcPayload): string {
  const partnerId = extraField(payload, 'partner_id');
  if (typeof partnerId !== 'string' || partnerId.length === 0) {
    throw new Error('RefreshToken payload missing required extra.partner_id');
  }
  return partnerId;
}

function stringField(payload: OidcPayload, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`OIDC payload missing required ${key}`);
  }
  return value;
}

function extraField(payload: OidcPayload, key: string): unknown {
  const extra = payload.extra;
  return extra && typeof extra === 'object' ? (extra as Record<string, unknown>)[key] : undefined;
}

export class BreezeOidcAdapter {
  constructor(private readonly model: string) {}

  async upsert(id: string, payload: OidcPayload, expiresIn?: number): Promise<void> {
    const expiresAt = expiresAtFrom(expiresIn);
    return asSystem(async () => {
      if (this.model === 'Client') {
        await db.insert(oauthClients).values({
          id,
          partnerId: null,
          clientSecretHash: typeof payload.client_secret === 'string' ? sha256(payload.client_secret) : null,
          metadata: payload,
        }).onConflictDoUpdate({
          target: oauthClients.id,
          set: { metadata: payload, lastUsedAt: new Date() },
        });
      } else if (this.model === 'AuthorizationCode') {
        await db.insert(oauthAuthorizationCodes).values({
          id,
          userId: stringField(payload, 'accountId'),
          clientId: stringField(payload, 'clientId'),
          partnerId: extraField(payload, 'partner_id') as string,
          orgId: (extraField(payload, 'org_id') as string | null) ?? null,
          payload,
          expiresAt: expiresAt!,
        }).onConflictDoUpdate({
          target: oauthAuthorizationCodes.id,
          set: { payload, expiresAt: expiresAt! },
        });
      } else if (this.model === 'RefreshToken') {
        await db.insert(oauthRefreshTokens).values({
          id,
          userId: stringField(payload, 'accountId'),
          clientId: stringField(payload, 'clientId'),
          partnerId: requiredPartnerId(payload),
          orgId: (extraField(payload, 'org_id') as string | null) ?? null,
          payload,
          expiresAt: expiresAt!,
        }).onConflictDoUpdate({
          target: oauthRefreshTokens.id,
          set: { payload, expiresAt: expiresAt!, lastUsedAt: new Date() },
        });
      } else {
        const modelStore = inMemory.get(this.model) ?? new Map<string, StoredPayload>();
        modelStore.set(id, { payload, expiresAt });
        inMemory.set(this.model, modelStore);
      }
    });
  }

  async find(id: string): Promise<OidcPayload | undefined> {
    return asSystem(async () => {
      if (this.model === 'Client') {
        const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, id));
        return row && !row.disabledAt ? row.metadata as OidcPayload : undefined;
      }
      if (this.model === 'AuthorizationCode') {
        const [row] = await db.select().from(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.id, id));
        return row && !row.consumedAt && row.expiresAt >= new Date() ? row.payload as OidcPayload : undefined;
      }
      if (this.model === 'RefreshToken') {
        const [row] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.id, id));
        return row && !row.revokedAt && row.expiresAt >= new Date() ? row.payload as OidcPayload : undefined;
      }

      const stored = inMemory.get(this.model)?.get(id);
      if (!stored) return undefined;
      if (stored.expiresAt && stored.expiresAt < new Date()) {
        inMemory.get(this.model)?.delete(id);
        return undefined;
      }
      return stored.payload;
    });
  }

  async consume(id: string): Promise<void> {
    return asSystem(async () => {
      if (this.model === 'AuthorizationCode') {
        await db.update(oauthAuthorizationCodes).set({ consumedAt: new Date() }).where(eq(oauthAuthorizationCodes.id, id));
      }
    });
  }

  async destroy(id: string): Promise<void> {
    // For token models we MUST write to the revocation cache before (or as
    // part of) destroying the row. oidc-provider 8.x doesn't emit the
    // `revocation.success` event we previously listened for, so the adapter's
    // destroy is the only sync hook we have on the revocation path. We look
    // up the payload here to extract `jti`/`exp` and write the cache entry
    // with the remaining TTL — bearer auth checks the cache on every request.
    if (this.model === 'AccessToken' || this.model === 'RefreshToken') {
      await this.cacheRevocation(id);
    }
    return asSystem(async () => {
      if (this.model === 'RefreshToken') {
        await db.update(oauthRefreshTokens).set({ revokedAt: new Date() }).where(eq(oauthRefreshTokens.id, id));
      } else if (this.model === 'Client') {
        await db.update(oauthClients).set({ disabledAt: new Date() }).where(eq(oauthClients.id, id));
      } else {
        inMemory.get(this.model)?.delete(id);
      }
    });
  }

  /**
   * Look up the token's `jti` and `exp` and write a revocation marker that
   * lives at least until the token would have naturally expired. The id we
   * receive from oidc-provider is the model id; for AccessToken/RefreshToken
   * it equals the `jti` claim, but we still read the payload's `exp` (or
   * fall back to the row's `expiresAt`) to pick a sensible TTL. Failures
   * are logged but do not block destroy — the DB revocation row is still
   * authoritative for refresh tokens.
   */
  private async cacheRevocation(id: string): Promise<void> {
    try {
      let exp: number | undefined;
      if (this.model === 'RefreshToken') {
        const row = await asSystem(async () => {
          const [r] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.id, id));
          return r;
        });
        if (row) {
          const payloadExp = (row.payload as { exp?: number } | null)?.exp;
          exp = typeof payloadExp === 'number' ? payloadExp : Math.floor(row.expiresAt.getTime() / 1000);
        }
      } else {
        // AccessToken lives in the in-memory store; pull exp directly.
        const stored = inMemory.get(this.model)?.get(id);
        const payloadExp = (stored?.payload as { exp?: number } | undefined)?.exp;
        if (typeof payloadExp === 'number') {
          exp = payloadExp;
        } else if (stored?.expiresAt) {
          exp = Math.floor(stored.expiresAt.getTime() / 1000);
        }
      }
      if (exp === undefined) return; // nothing to cache
      const ttl = Math.max(exp - Math.floor(Date.now() / 1000), 1);
      await revokeJti(id, ttl);
    } catch (err) {
      console.error('[oauth] revocation cache write failed', err);
    }
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    return asSystem(async () => {
      await db.update(oauthRefreshTokens).set({ revokedAt: new Date() }).where(sql`payload->>'grantId' = ${grantId}`);
    });
  }

  async findByUid(uid: string): Promise<OidcPayload | undefined> {
    // oidc-provider's session-bound models (AuthorizationCode, AccessToken,
    // RefreshToken) call Session.findByUid(uid) during token issuance to
    // confirm the session that authorized the grant still exists. We persist
    // Session payloads in the in-memory map keyed by jti, so we scan the
    // store for a payload whose `uid` field matches. Sessions are short-
    // lived (14 days TTL by config) and the store is small, so a linear
    // scan is acceptable for the MVP.
    const store = inMemory.get(this.model);
    if (!store) return undefined;
    for (const [, stored] of store) {
      if (stored.expiresAt && stored.expiresAt < new Date()) continue;
      if ((stored.payload as { uid?: unknown }).uid === uid) return stored.payload;
    }
    return undefined;
  }

  async findByUserCode(_code: string): Promise<undefined> { return undefined; }
}
