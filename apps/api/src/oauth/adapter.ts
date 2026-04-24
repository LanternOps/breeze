import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  oauthAuthorizationCodes,
  oauthClients,
  oauthGrants,
  oauthInteractions,
  oauthRefreshTokens,
  oauthSessions,
} from '../db/schema';
import { revokeGrant, revokeJti } from './revocationCache';

// Grant-revocation marker TTL must outlive the longest-lived access token
// minted under the grant. Kept in sync with `ACCESS_TOKEN_TTL_SECONDS` in
// provider.ts (we'd import it but provider.ts already imports from this
// file, and pulling in the whole provider module here would cycle).
const GRANT_REVOCATION_TTL_SECONDS = 600;

const asSystem = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

type OidcPayload = Record<string, unknown>;
type StoredPayload = { payload: OidcPayload; expiresAt: Date | null };

const inMemory = new Map<string, Map<string, StoredPayload>>();

// Side cache for Breeze tenancy metadata attached to a Grant. oidc-provider's
// Grant.IN_PAYLOAD allowlist (lib/models/grant.js) drops unknown fields on
// save, so we can't simply set `grant.breeze = ...`. Historically this map
// was the only store; now that Grants are persisted to `oauth_grants`, the
// map is just a fast process-local cache and `setGrantBreezeMeta` ALSO
// writes the metadata to the DB row so it survives restart.
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
  // Persist to DB so a process restart between consent and the first
  // refresh-token grant doesn't orphan the partner_id. The Grant row is
  // INSERTed by `BreezeOidcAdapter.upsert` during `grant.save()`, which the
  // consent route calls immediately before invoking us — so an UPDATE here
  // hits an existing row. We swallow errors: the in-memory cache is enough
  // for the auth-code → token exchange that happens in the same process.
  asSystem(async () => {
    await db.update(oauthGrants)
      .set({ partnerId: meta.partner_id, orgId: meta.org_id })
      .where(eq(oauthGrants.id, grantId));
  }).catch((err) => {
    console.error('[oauth] failed to persist Grant breeze meta', { grantId, err });
  });
}

export async function getGrantBreezeMetaAsync(
  grantId: string | undefined | null,
): Promise<GrantBreezeMeta | undefined> {
  if (!grantId) return undefined;
  const cached = getGrantBreezeMeta(grantId);
  if (cached) return cached;
  // Cache miss — possibly a different process / post-restart. Fall back to
  // the DB row, populated by the consent route.
  try {
    const row = await asSystem(async () => {
      const [r] = await db.select({ partnerId: oauthGrants.partnerId, orgId: oauthGrants.orgId })
        .from(oauthGrants)
        .where(eq(oauthGrants.id, grantId));
      return r;
    });
    if (!row || !row.partnerId) return undefined;
    return { partner_id: row.partnerId, org_id: row.orgId };
  } catch (err) {
    console.error('[oauth] DB lookup for Grant breeze meta failed', { grantId, err });
    return undefined;
  }
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

async function requiredPartnerId(payload: OidcPayload): Promise<string> {
  // First try extra.partner_id (kept for backward compatibility / tests). If
  // not present, fall back to deriving it from the Grant via the cache, then
  // the DB — the RefreshToken model's IN_PAYLOAD allowlist drops `extra`
  // (only AccessToken/ClientCredentials carry it), so for tokens minted via
  // the authorization_code grant the only thing we have to key on is
  // `grantId`. The DB fallback is critical post-restart: a refresh-token
  // exchange a few minutes after an API redeploy lost the in-memory cache.
  const partnerId = extraField(payload, 'partner_id');
  if (typeof partnerId === 'string' && partnerId.length > 0) {
    return partnerId;
  }
  const grantId = typeof payload.grantId === 'string' ? payload.grantId : undefined;
  const meta = getGrantBreezeMeta(grantId) ?? (await getGrantBreezeMetaAsync(grantId));
  if (meta && meta.partner_id) {
    return meta.partner_id;
  }
  throw new Error('RefreshToken payload missing required partner_id (no extra.partner_id and no grant meta)');
}

async function resolvedOrgId(payload: OidcPayload): Promise<string | null> {
  const fromExtra = extraField(payload, 'org_id');
  if (typeof fromExtra === 'string' && fromExtra.length > 0) return fromExtra;
  const grantId = typeof payload.grantId === 'string' ? payload.grantId : undefined;
  const meta = getGrantBreezeMeta(grantId) ?? (await getGrantBreezeMetaAsync(grantId));
  return meta?.org_id ?? null;
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
        const [partnerId, orgId] = await Promise.all([
          requiredPartnerId(payload),
          resolvedOrgId(payload),
        ]);
        await db.insert(oauthRefreshTokens).values({
          id,
          userId: stringField(payload, 'accountId'),
          clientId: stringField(payload, 'clientId'),
          partnerId,
          orgId,
          payload,
          expiresAt: expiresAt!,
        }).onConflictDoUpdate({
          target: oauthRefreshTokens.id,
          set: { payload, expiresAt: expiresAt!, lastUsedAt: new Date() },
        });
      } else if (this.model === 'Session') {
        // Session.id === Session.jti; uid is a separate, longer-lived alias
        // used by Session.findByUid during token exchange. accountId is null
        // for anonymous (pre-login) sessions and gets populated by
        // session.loginAccount(...). expiresAt is required by the column —
        // oidc-provider always passes a TTL for Session.save.
        const uid = typeof payload.uid === 'string' && payload.uid.length > 0
          ? payload.uid
          : id;
        const accountIdRaw = payload.accountId;
        const accountId = typeof accountIdRaw === 'string' && accountIdRaw.length > 0
          ? accountIdRaw
          : null;
        await db.insert(oauthSessions).values({
          id,
          uid,
          accountId,
          payload,
          expiresAt: expiresAt!,
        }).onConflictDoUpdate({
          target: oauthSessions.id,
          set: { uid, accountId, payload, expiresAt: expiresAt!, lastUsedAt: new Date() },
        });
      } else if (this.model === 'Interaction') {
        // Interaction is the short-lived (~1h) record bridging /authorize →
        // consent UI → resume. Persisted so an API restart mid-flow doesn't
        // 404 the user with "interaction expired or mismatched". The
        // interaction's session pointer (payload.session.accountId) starts
        // null and gets populated after login; the RLS policy checks that
        // pointer for user-scope access, with a system bypass for the
        // adapter's writes.
        await db.insert(oauthInteractions).values({
          id,
          payload,
          expiresAt: expiresAt!,
        }).onConflictDoUpdate({
          target: oauthInteractions.id,
          set: { payload, expiresAt: expiresAt! },
        });
      } else if (this.model === 'Grant') {
        // Grant payload is the IN_PAYLOAD-filtered subset (accountId,
        // clientId, resources, openid, rejected, rar). partner_id/org_id
        // are populated by the consent route via setGrantBreezeMeta() —
        // INSERT them as NULL here and the subsequent UPDATE fills them in.
        await db.insert(oauthGrants).values({
          id,
          accountId: stringField(payload, 'accountId'),
          clientId: stringField(payload, 'clientId'),
          partnerId: null,
          orgId: null,
          payload,
          expiresAt: expiresAt!,
        }).onConflictDoUpdate({
          target: oauthGrants.id,
          set: { payload, expiresAt: expiresAt! },
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
      if (this.model === 'Session') {
        const [row] = await db.select().from(oauthSessions).where(eq(oauthSessions.id, id));
        return row && row.expiresAt >= new Date() ? row.payload as OidcPayload : undefined;
      }
      if (this.model === 'Grant') {
        const [row] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, id));
        return row && row.expiresAt >= new Date() ? row.payload as OidcPayload : undefined;
      }
      if (this.model === 'Interaction') {
        const [row] = await db.select().from(oauthInteractions).where(eq(oauthInteractions.id, id));
        return row && row.expiresAt >= new Date() ? row.payload as OidcPayload : undefined;
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
      } else if (this.model === 'RefreshToken') {
        // oidc-provider rotates refresh tokens by minting a new one and
        // calling consume() on the previous. Mark it revoked so
        // `find()` (which filters on revokedAt IS NULL) returns undefined,
        // preventing replay of the old token after rotation.
        await db.update(oauthRefreshTokens).set({ revokedAt: new Date() }).where(eq(oauthRefreshTokens.id, id));
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
      } else if (this.model === 'Session') {
        await db.delete(oauthSessions).where(eq(oauthSessions.id, id));
      } else if (this.model === 'Grant') {
        await db.delete(oauthGrants).where(eq(oauthGrants.id, id));
      } else if (this.model === 'Interaction') {
        await db.delete(oauthInteractions).where(eq(oauthInteractions.id, id));
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
      let grantId: string | undefined;
      if (this.model === 'RefreshToken') {
        const row = await asSystem(async () => {
          const [r] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.id, id));
          return r;
        });
        if (row) {
          const payloadExp = (row.payload as { exp?: number } | null)?.exp;
          exp = typeof payloadExp === 'number' ? payloadExp : Math.floor(row.expiresAt.getTime() / 1000);
          // RefreshToken payload carries grantId — cache the grant-wide
          // marker too so every access JWT minted from this grant is
          // immediately rejected by bearer middleware. Without this the
          // access tokens (separate jtis) would survive until natural
          // 10-minute expiry.
          const payloadGrantId = (row.payload as { grantId?: string } | null)?.grantId;
          if (typeof payloadGrantId === 'string' && payloadGrantId.length > 0) {
            grantId = payloadGrantId;
          }
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
      if (grantId) {
        await revokeGrant(grantId, GRANT_REVOCATION_TTL_SECONDS);
      }
    } catch (err) {
      console.error('[oauth] revocation cache write failed', err);
    }
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    // Mark the grant revoked in the cache FIRST so any in-flight bearer
    // checks immediately reject. Then mark every refresh token revoked in
    // the DB (so the next refresh-token grant exchange fails with
    // "invalid_grant" rather than minting a fresh access token).
    await revokeGrant(grantId, GRANT_REVOCATION_TTL_SECONDS).catch((err) => {
      console.error('[oauth] grant revocation cache write failed', err);
    });
    return asSystem(async () => {
      await db.update(oauthRefreshTokens).set({ revokedAt: new Date() }).where(sql`payload->>'grantId' = ${grantId}`);
    });
  }

  async findByUid(uid: string): Promise<OidcPayload | undefined> {
    // Session.findByUid is called during token issuance to confirm the
    // authorizing session still exists. Sessions are persisted to
    // `oauth_sessions` with a dedicated `uid` index — lookup is a single
    // indexed query.
    if (this.model === 'Session') {
      return asSystem(async () => {
        const [row] = await db.select().from(oauthSessions).where(eq(oauthSessions.uid, uid));
        return row && row.expiresAt >= new Date() ? row.payload as OidcPayload : undefined;
      });
    }
    // Fallback for models still in the in-memory store (Interaction,
    // AccessToken, ReplayDetection, etc.). None of these are typically
    // looked up by uid in our flow, but keep the scan as a safety net.
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
