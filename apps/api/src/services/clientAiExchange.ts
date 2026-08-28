import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type Redis from 'ioredis';
import { db, withSystemDbAccessContext } from '../db';
import { portalUsers } from '../db/schema';
import { clientAiTenantMappings } from '../db/schema/clientAi';
import { organizations, partners } from '../db/schema/orgs';
import { getOrgPolicy, isClientUserPermitted } from './clientAiPolicy';
import type { ClientAiEntraClaims } from './clientAiEntraJwt';
import {
  CLIENT_AI_REDIS_KEYS,
  CLIENT_AI_SESSION_TTL_SECONDS,
} from '../routes/clientAi/schemas';

/**
 * Resolves a verified Entra ID token's claims to a Breeze client-AI session
 * (tenant mapping → partner entitlement → org policy → portal-user JIT →
 * status/permission checks), then mints the Redis session. Extracted from
 * `routes/clientAi/auth.ts` so the neutral `/office-addin/auth/exchange`
 * route (Task 10) can reuse the same resolution without duplicating it.
 *
 * DB work stays inside one tight `withSystemDbAccessContext` block; the
 * Redis mint runs OUTSIDE that block — never hold a DB transaction across
 * Redis I/O (#1105).
 */

export type ExchangeUser = {
  id: string;
  orgId: string;
  email: string;
  name: string | null;
  status: string;
};

/** White-label footer fields (spec §11), sourced from the org policy's branding JSONB. */
export type ExchangeBranding = { displayName: string | null; logoUrl: string | null };

type Denied = {
  denied: {
    status: 403 | 404;
    error: string;
    orgId: string | null;
    details: Record<string, unknown>;
  };
};
type Resolved = { user: ExchangeUser; provisioned: boolean; branding: ExchangeBranding };

export type ClientExchangeOutcome =
  | {
      kind: 'denied';
      status: 403 | 404;
      body: { error: string; reason?: string };
      audit: {
        orgId: string | null;
        result: string;
        actorEmail: string | null;
        details: Record<string, unknown>;
      };
    }
  | {
      kind: 'resolved';
      body: {
        accessToken: string;
        expiresInSeconds: number;
        user: { id: string; email: string; name: string | null };
        org: { id: string };
        branding: { displayName: string | null; logoUrl: string | null };
      };
      audit: {
        orgId: string;
        result: 'success';
        actorId: string;
        actorEmail: string;
        details: Record<string, unknown>;
      };
    };

/** policy.branding is free-form JSONB — pull only the two known string fields, coercing anything else to null. */
export function brandingFromPolicy(
  branding: Record<string, unknown> | null | undefined
): ExchangeBranding {
  const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    displayName: asString(branding?.displayName),
    logoUrl: asString(branding?.logoUrl),
  };
}

const USER_COLUMNS = {
  id: portalUsers.id,
  orgId: portalUsers.orgId,
  email: portalUsers.email,
  name: portalUsers.name,
  status: portalUsers.status,
};

export async function resolveAndMintClientSession(
  claims: ClientAiEntraClaims,
  redis: Redis
): Promise<ClientExchangeOutcome> {
  const resolution = await withSystemDbAccessContext(async (): Promise<Denied | Resolved> => {
    const [mapping] = await db
      .select({
        orgId: clientAiTenantMappings.orgId,
        partnerEnabled: partners.aiForOfficeEnabled,
      })
      .from(clientAiTenantMappings)
      .innerJoin(organizations, eq(organizations.id, clientAiTenantMappings.orgId))
      .innerJoin(partners, eq(partners.id, organizations.partnerId))
      .where(eq(clientAiTenantMappings.entraTenantId, claims.tid))
      .limit(1);

    if (!mapping) {
      return {
        denied: {
          status: 404,
          error: 'tenant_not_provisioned',
          orgId: null,
          details: { reason: 'tenant_not_provisioned', tid: claims.tid },
        },
      };
    }

    // Per-partner entitlement gate (the cost gate): no enabled partner ⇒ no
    // session ⇒ no AI spend. Sits above the per-org policy.enabled check below.
    if (!mapping.partnerEnabled) {
      return {
        denied: {
          status: 403,
          error: 'disabled',
          orgId: mapping.orgId,
          details: { reason: 'partner_not_enabled', tid: claims.tid, oid: claims.oid },
        },
      };
    }

    const policy = await getOrgPolicy(mapping.orgId);
    if (!policy.enabled) {
      return {
        denied: {
          status: 403,
          error: 'disabled',
          orgId: mapping.orgId,
          details: { reason: 'disabled', tid: claims.tid, oid: claims.oid },
        },
      };
    }

    const now = new Date();
    let provisioned = false;
    let [user] = await db
      .select(USER_COLUMNS)
      .from(portalUsers)
      .where(
        and(eq(portalUsers.entraTenantId, claims.tid), eq(portalUsers.entraOid, claims.oid))
      )
      .limit(1);

    if (!user) {
      // portal_users.email is NOT NULL; some Entra token shapes carry no usable
      // address — fall back to a synthetic, non-routable one.
      const email = claims.email ?? `${claims.oid}@${claims.tid}.entra.invalid`;
      try {
        const inserted = await db
          .insert(portalUsers)
          .values({
            orgId: mapping.orgId,
            email,
            name: claims.name,
            passwordHash: null,
            entraOid: claims.oid,
            entraTenantId: claims.tid,
            authMethod: 'entra',
            lastLoginAt: now,
          })
          .returning(USER_COLUMNS);
        user = inserted[0];
        provisioned = true;
      } catch (err) {
        // Concurrent first-exchange race: portal_users_entra_identity_uniq
        // makes the loser 23505 — re-select the winner's row.
        if ((err as { cause?: { code?: string } }).cause?.code !== '23505') throw err;
        [user] = await db
          .select(USER_COLUMNS)
          .from(portalUsers)
          .where(
            and(eq(portalUsers.entraTenantId, claims.tid), eq(portalUsers.entraOid, claims.oid))
          )
          .limit(1);
      }
    } else {
      await db
        .update(portalUsers)
        .set({ lastLoginAt: now, updatedAt: now, ...(claims.name ? { name: claims.name } : {}) })
        .where(eq(portalUsers.id, user.id));
    }

    if (!user) {
      return {
        denied: {
          status: 403,
          error: 'provisioning_failed',
          orgId: mapping.orgId,
          details: { reason: 'provisioning_failed', tid: claims.tid, oid: claims.oid },
        },
      };
    }

    if (user.status !== 'active') {
      return {
        denied: {
          status: 403,
          error: 'account_inactive',
          orgId: mapping.orgId,
          details: { reason: 'account_inactive', portalUserId: user.id },
        },
      };
    }

    if (!isClientUserPermitted(policy, user.id)) {
      return {
        denied: {
          status: 403,
          error: 'user_not_permitted',
          orgId: mapping.orgId,
          details: { reason: 'user_not_permitted', portalUserId: user.id },
        },
      };
    }

    return { user, provisioned, branding: brandingFromPolicy(policy.branding) };
  });

  if ('denied' in resolution) {
    return {
      kind: 'denied',
      status: resolution.denied.status,
      body: { error: resolution.denied.error },
      audit: {
        orgId: resolution.denied.orgId,
        result: 'denied',
        actorEmail: null,
        details: resolution.denied.details,
      },
    };
  }

  const { user, provisioned, branding } = resolution;
  const token = nanoid(48);
  await redis.setex(
    CLIENT_AI_REDIS_KEYS.session(token),
    CLIENT_AI_SESSION_TTL_SECONDS,
    JSON.stringify({ portalUserId: user.id, orgId: user.orgId, createdAt: new Date().toISOString() })
  );
  await redis.sadd(CLIENT_AI_REDIS_KEYS.userSessions(user.id), token);
  await redis.expire(CLIENT_AI_REDIS_KEYS.userSessions(user.id), CLIENT_AI_SESSION_TTL_SECONDS * 2);

  return {
    kind: 'resolved',
    body: {
      accessToken: token,
      expiresInSeconds: CLIENT_AI_SESSION_TTL_SECONDS,
      user: { id: user.id, email: user.email, name: user.name },
      org: { id: user.orgId },
      branding,
    },
    audit: {
      orgId: user.orgId,
      result: 'success',
      actorId: user.id,
      actorEmail: user.email,
      details: { tid: claims.tid, oid: claims.oid, provisioned },
    },
  };
}

/**
 * Drop every live client-AI (Excel/Word/Outlook add-in) session belonging to a
 * set of portal users. Used by the org-merge fence (`services/orgMerge.ts`) so
 * add-in principals stop writing under an org the moment it is fenced.
 *
 * `/client-ai` is a SECOND portal_users ingress with its own Redis namespace,
 * so the portal purge does not reach it: an add-in user would keep inserting
 * `ai_messages` and updating `ai_sessions` under the loser org through the
 * drain and into Phase B, where those rows are stranded by the re-tenant and
 * then destroyed by the erasure that follows.
 *
 * Lives here, next to `resolveAndMintClientSession` (which is what `sadd`s each
 * token into the `userSessions` index above), so the purge and the mint can
 * never disagree about the key layout.
 *
 * Best-effort by design — the durable control is the org-status gate in
 * `clientAiAuthMiddleware`, which rejects any session surviving this purge on
 * its very next request.
 */
export async function purgeClientAiSessionsForUsers(
  redis: Redis,
  portalUserIds: string[]
): Promise<number> {
  let purged = 0;
  for (const portalUserId of new Set(portalUserIds)) {
    try {
      const indexKey = CLIENT_AI_REDIS_KEYS.userSessions(portalUserId);
      const tokens = await redis.smembers(indexKey);
      if (tokens.length > 0) {
        await redis.del(...tokens.map((t) => CLIENT_AI_REDIS_KEYS.session(t)));
        purged += tokens.length;
      }
      await redis.del(indexKey);
    } catch (err) {
      console.error('[client-ai] Failed to purge sessions for portal user:', {
        portalUserId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return purged;
}
