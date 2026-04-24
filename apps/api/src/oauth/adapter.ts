import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthAuthorizationCodes, oauthClients, oauthRefreshTokens } from '../db/schema';

const asSystem = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

type OidcPayload = Record<string, unknown>;
type StoredPayload = { payload: OidcPayload; expiresAt: Date | null };

const inMemory = new Map<string, Map<string, StoredPayload>>();

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
