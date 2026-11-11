import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type Redis from 'ioredis';
import { db, withDbTransaction, withSystemDbAccessContext } from '../db';
import { portalUserIdentities, portalUsers } from '../db/schema';
import { clientAiTenantMappings } from '../db/schema/clientAi';
import { organizations, partners } from '../db/schema/orgs';
import { getOrgPolicy, isClientUserPermitted } from './clientAiPolicy';
import { linkLoginToContact, type LoginContactOutcome } from './contacts/loginLink';
import { resolveLinkableEntraAddress } from './clientAiEntraAddress';
import { isPgUniqueViolation, pgErrorConstraint } from '@breeze/shared/pgErrors';
import { captureException } from './sentry';
import { ensureEntraIdentity, entraIdentityMatch, insertEntraIdentity } from './portalUserIdentities';
import { initialPortalAccountState } from './portalAccountState';
import type { ClientAiEntraClaims } from './clientAiEntraJwt';
import {
  CLIENT_AI_REDIS_KEYS,
  CLIENT_AI_SESSION_TTL_SECONDS,
  CLIENT_AI_SESSION_MAX_AGE_SECONDS,
} from '../routes/clientAi/schemas';

export { purgeClientAiSessionsForUsers } from './clientAiSessionStore';

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
  authEpoch: number;
  /** The `contacts` row this login belongs to (#3258); null until resolved. */
  contactId: string | null;
};

/**
 * How this exchange resolved the login to a CONTACT (#3258).
 *
 * Beyond the resolver's own outcomes:
 *  - `kept`               — the login already carried a link, never re-derived.
 *  - `unverified-address` — the token's address is not one we will trust to
 *                           identify a person (see clientAiEntraAddress.ts).
 *  - `address-mismatch`   — the vouched address is not the one this login is
 *                           stored under, so linking would move the login onto
 *                           a different person.
 *  - `link-failed`        — the contacts write threw; the SSO login still
 *                           stands (see the catch below).
 *  - `not-attempted`      — the exchange was denied before linking was reached.
 *
 * Recorded in the audit details of EVERY outcome, denials included (both
 * `/client-ai/auth/exchange` and `/office-addin/auth/exchange` write
 * `outcome.audit.details` verbatim), because a null `contact_id` is not
 * self-explaining afterwards and "did this request touch `contacts`?" must be
 * answerable from the log alone.
 */
type ExchangeContactLink =
  | LoginContactOutcome
  | 'kept'
  | 'unverified-address'
  | 'address-mismatch'
  | 'link-failed'
  | 'not-attempted';

/** The three link fields every audit line carries. */
interface LinkAudit {
  contactLink: ExchangeContactLink;
  contactId: string | null;
  /** The address the link was actually attempted on, or null when none was. */
  linkAddress: string | null;
}

const NOT_ATTEMPTED: LinkAudit = { contactLink: 'not-attempted', contactId: null, linkAddress: null };

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
type Resolved = {
  user: ExchangeUser;
  provisioned: boolean;
  branding: ExchangeBranding;
  link: LinkAudit;
};

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
  authEpoch: portalUsers.authEpoch,
  contactId: portalUsers.contactId,
};

/**
 * The login a verified Entra token belongs to: the account its identity in
 * `portal_user_identities` points at (identities release B, spec §5.2). Never
 * the legacy `portal_users.entra_*` columns — those are still dual-written
 * for release-A instances (plan D4) but no longer read. One statement (a
 * join), so the identity and its login are read together.
 *
 * A login that still holds the columns but has lost its identity row is not
 * found: the JIT insert below then hits the login's own unique index and the
 * exchange fails closed as `provisioning_failed` (never a second login).
 */
async function selectLoginByEntraIdentity(claims: ClientAiEntraClaims) {
  const [row] = await db
    .select(USER_COLUMNS)
    .from(portalUsers)
    .innerJoin(portalUserIdentities, eq(portalUserIdentities.portalUserId, portalUsers.id))
    .where(entraIdentityMatch({ tid: claims.tid, oid: claims.oid }))
    .limit(1);
  return row;
}

/**
 * S2 - a login found by (tenant, oid) may sit in a DIFFERENT org than the one
 * the tenant currently maps to.
 *
 * `portal_users` is looked up by the Entra identity alone, because that is the
 * only stable key the token carries. The identity's org always equals its
 * login's org (composite FK, spec §6 inv. 4). Re-pointing a `client_ai_tenant_mappings`
 * row at another organization (a customer moved between tenants, an MSP fixed a
 * mis-mapping) leaves the old logins behind under the OLD org. Without this
 * check the exchange would mint a session against that stale org - and, worse,
 * the contact backfill would create a person inside it.
 *
 * Denied rather than silently re-homed: moving a login between tenants is a
 * data-migration decision with ticket-history consequences, not something an
 * SSO exchange may infer.
 */
function orgMismatchDenial(
  user: ExchangeUser | undefined,
  mappedOrgId: string,
  claims: ClientAiEntraClaims
): Denied | null {
  if (!user || user.orgId === mappedOrgId) return null;
  return {
    denied: {
      status: 403,
      error: 'org_mismatch',
      orgId: mappedOrgId,
      details: {
        reason: 'org_mismatch',
        tid: claims.tid,
        oid: claims.oid,
        portalUserId: user.id,
        loginOrgId: user.orgId,
        ...NOT_ATTEMPTED,
      },
    },
  };
}

/**
 * Resolve the CONTACT for a login whose session is about to be minted (#3258).
 *
 * Called only after every deny gate has passed, so nothing here can write to
 * `contacts` on a request that ends in a 403.
 *
 * Three refusals, each surfaced as its own audit outcome rather than a bare
 * null so the log says WHY a login is unlinked:
 *
 *  1. An existing link is never re-derived (`kept`). Whoever set it knew more
 *     than an email string does.
 *  2. The address must be one the customer demonstrably owns
 *     (`clientAiEntraAddress.ts`) - linking is an authorization decision, since
 *     the matched contact's emailed tickets become visible to this login.
 *  3. The vouched address must be the one the LOGIN is stored under. A tenant
 *     admin can change a user's UPN, and re-linking on the new address would
 *     move an established login onto a different person's contact - so a
 *     mismatch refuses instead, leaving the existing state alone.
 *
 * A failure of the contacts write itself never denies the login: the token is a
 * verified Entra identity and a `contacts` problem is ours, not the caller's.
 * It is reported (`link-failed` + Sentry) and the session proceeds unlinked;
 * the next login retries the backfill.
 */
async function resolveSessionContactLink(
  user: ExchangeUser,
  partnerId: string,
  claims: ClientAiEntraClaims
): Promise<LinkAudit> {
  if (user.contactId) {
    return { contactLink: 'kept', contactId: user.contactId, linkAddress: null };
  }

  const decision = await resolveLinkableEntraAddress(user.orgId, partnerId, claims);
  if (decision.kind === 'refused') {
    return { contactLink: decision.outcome, contactId: null, linkAddress: null };
  }

  if (decision.email !== user.email.trim().toLowerCase()) {
    return { contactLink: 'address-mismatch', contactId: null, linkAddress: decision.email };
  }

  try {
    // SAVEPOINT, for the same reason the provisioning INSERT has one: postgres.js
    // re-throws a database error at COMMIT time even after it has been caught
    // here (see the note in ticketConfigService/catalogService). A deadlock or
    // an FK violation raised on the OUTER transaction would therefore still
    // 500 the exchange despite the catch below — the nested transaction is what
    // makes this catch real. Releasing the savepoint reassigns the advisory
    // lock and the FOR KEY SHARE pin to the parent, so the follow-up
    // `portal_users.contact_id` write still holds both.
    const resolved = await db.transaction((tx) =>
      linkLoginToContact(tx, {
        orgId: user.orgId,
        email: decision.email,
        name: claims.name,
        // No acting Breeze user exists: the login provisions ITSELF from a
        // verified token, so `contacts.created_by` is genuinely null.
        actor: { userId: null },
        // An Entra login IS portal access, so it claims the role the invite does
        // (unlike the add-in's ticket requester, which grants nothing).
        roles: ['portal'],
        unionRoles: ['portal'],
      })
    );
    return {
      contactLink: resolved.outcome,
      contactId: resolved.contactId,
      linkAddress: decision.email,
    };
  } catch (err) {
    console.error('[client-ai] contact link failed for portal user:', {
      portalUserId: user.id,
      orgId: user.orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, { eventCode: 'client_ai_contact_link_failed' } as never);
    return { contactLink: 'link-failed', contactId: null, linkAddress: decision.email };
  }
}

export async function resolveAndMintClientSession(
  claims: ClientAiEntraClaims,
  redis: Redis
): Promise<ClientExchangeOutcome> {
  const resolution = await withSystemDbAccessContext(async (): Promise<Denied | Resolved> => {
    const [mapping] = await db
      .select({
        orgId: clientAiTenantMappings.orgId,
        partnerId: organizations.partnerId,
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
          details: { reason: 'tenant_not_provisioned', tid: claims.tid, ...NOT_ATTEMPTED },
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
          details: { reason: 'partner_not_enabled', tid: claims.tid, oid: claims.oid, ...NOT_ATTEMPTED },
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
          details: { reason: 'disabled', tid: claims.tid, oid: claims.oid, ...NOT_ATTEMPTED },
        },
      };
    }

    const now = new Date();
    let provisioned = false;
    let user = await selectLoginByEntraIdentity(claims);

    // Before ANY write: the backfill below would otherwise land in a stale org.
    const mismatched = orgMismatchDenial(user, mapping.orgId, claims);
    if (mismatched) return mismatched;

    if (!user) {
      // portal_users.email is NOT NULL; some Entra token shapes carry no usable
      // address — fall back to a synthetic, non-routable one. The CONTACT is
      // never keyed on it (see the linking block below).
      const email = claims.email ?? `${claims.oid}@${claims.tid}.entra.invalid`;
      try {
        // SAVEPOINT, not a bare insert. The whole exchange already runs inside
        // ONE transaction (withSystemDbAccessContext), so an unhandled 23505
        // poisons it: every later statement — including the recovery SELECT in
        // the catch — fails with 25P02 "current transaction is aborted". The
        // recovery below therefore could not work without this. A nested
        // `db.transaction` issues a SAVEPOINT, so the duplicate rolls back just
        // the insert and leaves the transaction usable.
        //
        // The external identity (portal_user_identities) is written in the
        // SAME savepoint: a 23505 from either insert rolls back both, so there
        // is never a login without its identity or vice versa. The legacy
        // entra_* columns are still written too (plan D4 writer fence): a
        // rolling-deploy release-A instance reads them, and the login's own
        // unique index on them is what refuses a second login for a (tid, oid)
        // whose identity row has gone missing.
        const inserted = await db.transaction(async (tx) => {
          const rows = await tx
            .insert(portalUsers)
            .values({
              orgId: mapping.orgId,
              email,
              name: claims.name,
              passwordHash: null,
              entraOid: claims.oid,
              entraTenantId: claims.tid,
              authMethod: 'entra',
              // active + browser_access none: an add-in login never grants the
              // browser portal (spec §6 invariant 9).
              ...initialPortalAccountState('addin_jit'),
              lastLoginAt: now,
            })
            .returning(USER_COLUMNS);
          if (rows[0]) {
            await insertEntraIdentity(tx, {
              orgId: mapping.orgId,
              portalUserId: rows[0].id,
              tid: claims.tid,
              oid: claims.oid,
              linkedVia: 'jit',
              usedAt: now,
            });
          }
          return rows;
        });
        user = inserted[0];
        provisioned = true;
      } catch (err) {
        // Concurrent first-exchange race: the winner committed its login and
        // identity, the loser 23505s — re-select the winner through its
        // identity.
        if (!isPgUniqueViolation(err)) throw err;
        const constraintName = pgErrorConstraint(err);
        user = await selectLoginByEntraIdentity(claims);
        if (!user) {
          // Not a race (a race leaves the winner findable): drift. Either the
          // login's own unique index refused a second login for a (tid, oid)
          // whose identity row is missing, or the identity insert collided
          // with an identity the lookup could not see. The savepoint rolled
          // back both inserts and the exchange fails closed as
          // provisioning_failed below; report it so the denial is explainable.
          console.error('[client-ai] portal identity drift: JIT refused and no login holds this Entra identity', {
            orgId: mapping.orgId,
            constraint: constraintName,
          });
          captureException(err, { eventCode: 'client_ai_identity_drift' } as never);
        }
        // The winner's row is found by (tenant, oid) alone, so re-assert the org.
        const stale = orgMismatchDenial(user, mapping.orgId, claims);
        if (stale) return stale;
      }
    }

    if (!user) {
      return {
        denied: {
          status: 403,
          error: 'provisioning_failed',
          orgId: mapping.orgId,
          details: { reason: 'provisioning_failed', tid: claims.tid, oid: claims.oid, ...NOT_ATTEMPTED },
        },
      };
    }

    // No `auth_method` gate (identities release B, plan D5): the identity
    // lookup above IS the gate. An account is reached only through an Entra
    // identity it holds, whatever its auth_method; in W3 every such account is
    // an add-in JIT row or an approved `entra` request (both 'entra').

    if (!provisioned) {
      await db
        .update(portalUsers)
        .set({ lastLoginAt: now, updatedAt: now, ...(claims.name ? { name: claims.name } : {}) })
        .where(eq(portalUsers.id, user.id));

      // Record the identity's use (`last_used_at`). The login was found
      // through this identity, so it is normally `present`; `inserted` or
      // `conflict` mean the identity moved between the read and this write —
      // drift, reported but not denied, because the session about to be
      // minted belongs to the account the identity resolved to. Any failure
      // of this bookkeeping write must not cost the user their sign-in: it
      // runs in a savepoint (withDbTransaction) with the catch outside, so it
      // cannot poison the exchange transaction.
      let identity: 'inserted' | 'present' | 'conflict' | 'failed';
      try {
        identity = await withDbTransaction(() => ensureEntraIdentity(db, {
          orgId: user!.orgId,
          portalUserId: user!.id,
          tid: claims.tid,
          oid: claims.oid,
          usedAt: now,
        }));
      } catch (err) {
        identity = 'failed';
        console.error('[client-ai] portal identity self-heal failed:', {
          portalUserId: user.id,
          orgId: user.orgId,
          error: err instanceof Error ? err.message : String(err),
        });
        captureException(err, { eventCode: 'client_ai_identity_write_failed' } as never);
      }
      if (identity === 'conflict') {
        console.error('[client-ai] portal identity drift: Entra subject does not resolve to this login', {
          portalUserId: user.id,
          orgId: user.orgId,
        });
        captureException(new Error('portal_user_identities drift on the Entra exchange'), {
          eventCode: 'client_ai_identity_drift',
        } as never);
      }
    }

    if (user.status !== 'active') {
      return {
        denied: {
          status: 403,
          error: 'account_inactive',
          orgId: mapping.orgId,
          details: { reason: 'account_inactive', portalUserId: user.id, ...NOT_ATTEMPTED },
        },
      };
    }

    if (!isClientUserPermitted(policy, user.id)) {
      return {
        denied: {
          status: 403,
          error: 'user_not_permitted',
          orgId: mapping.orgId,
          details: { reason: 'user_not_permitted', portalUserId: user.id, ...NOT_ATTEMPTED },
        },
      };
    }

    // #3258: a portal login is a login ATTACHED TO A PERSON, so an Entra
    // identity resolves to a `contacts` row the same way an invite or an
    // inbound email does. Without it the same human exists twice in one org —
    // once as an add-in login, once as the contact their emails created — and
    // their portal view cannot see their own emailed tickets, because
    // `portalTicketOwnership` matches on the contact, not the login.
    //
    // Deliberately the LAST thing before the session is minted: every deny gate
    // above has already passed, so no 403 path ever seeds or mutates a contacts
    // row. A tenant member who is not in `policy.selectedUserIds`, or whose
    // login is deactivated, leaves `contacts` untouched.
    const link = await resolveSessionContactLink(user, mapping.partnerId, claims);
    if (link.contactId && !user.contactId) {
      await db
        .update(portalUsers)
        .set({ contactId: link.contactId, updatedAt: now })
        .where(eq(portalUsers.id, user.id));
      // Refresh the in-memory row rather than leave it disagreeing with the
      // database: `user` was read BEFORE this write, so its `contactId` is now
      // stale, and it outlives this block as part of the returned resolution.
      user = { ...user, contactId: link.contactId };
    }

    return { user, provisioned, branding: brandingFromPolicy(policy.branding), link };
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

  const { user, provisioned, branding, link } = resolution;
  const token = nanoid(48);
  await redis.setex(
    CLIENT_AI_REDIS_KEYS.session(token),
    CLIENT_AI_SESSION_TTL_SECONDS,
    JSON.stringify({ portalUserId: user.id, orgId: user.orgId, authEpoch: user.authEpoch, createdAt: new Date().toISOString() })
  );
  await redis.sadd(CLIENT_AI_REDIS_KEYS.userSessions(user.id), token);
  await redis.expire(CLIENT_AI_REDIS_KEYS.userSessions(user.id), CLIENT_AI_SESSION_TTL_SECONDS * 2);

  return {
    kind: 'resolved',
    body: {
      accessToken: token,
      // The absolute cap (W4 OD1, middleware/clientAiAuth.ts) ends the session first.
      expiresInSeconds: Math.min(CLIENT_AI_SESSION_TTL_SECONDS, CLIENT_AI_SESSION_MAX_AGE_SECONDS),
      user: { id: user.id, email: user.email, name: user.name },
      org: { id: user.orgId },
      branding,
    },
    audit: {
      orgId: user.orgId,
      result: 'success',
      actorId: user.id,
      actorEmail: user.email,
      details: { tid: claims.tid, oid: claims.oid, provisioned, ...link },
    },
  };
}
