/**
 * Portal OIDC account resolution (portal registration W4 #11381, plan Task 5,
 * spec §5.6): which portal account a verified Microsoft identity signs in as,
 * links to, or asks for — and every reason it does not.
 *
 * The rules that make this the security core of Microsoft sign-in:
 *  - only a PROVEN tenant mapping resolves an org (inv. 2), and a custom-domain
 *    host must be that org (inv. 1);
 *  - an identity in another org is never placed here (inv. 4);
 *  - an identity is linked to an existing account only through an
 *    invitation-bound or a session-bound state, NEVER by email (inv. 5). An
 *    address match is only ever a refusal (`account_exists`);
 *  - an identity already bound to a different account than an invite or link
 *    names is refused, and the invite is not consumed (D11).
 *
 * Context rules: the callback holds no DB context. Reads open
 * `withSystemDbAccessContext` (the org is server-derived from the proven
 * tenant, never from anything the browser sent); each write branch is ONE
 * `withDbTransaction` inside such a context, refused with a throw inside it and
 * caught outside it, so a refusal rolls back every write of the branch.
 * `createPortalAccessRequest` and the injected invite consumer open their own
 * contexts and run outside every transaction here. No `Promise.all`.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, hasDbAccessContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import { portalUserIdentities, portalUsers } from '../../db/schema';
import { resolveLinkableEntraAddress } from '../clientAiEntraAddress';
import { createPortalAccessRequest } from '../portalAccessRequests';
import {
  PortalAccountTransitionError,
  planPortalAccountTransition,
  type PortalAccountTarget,
  type PortalAccountWriter,
} from '../portalAccountState';
import { isSignInMethodAllowed, resolvePortalAccessPolicy } from '../portalAccessPolicy';
import { findOrgByProvenEntraTenant } from '../portalEntraTenantProof';
import { createIdentityOnlyAccount } from '../portalIdentityAccounts';
import {
  entraIssuer,
  findPortalUserIdByEntraIdentity,
  linkPortalUserIdentity,
  portalUserHasIdentitySql,
} from '../portalUserIdentities';
import { getActiveOrgTenant } from '../tenantStatus';
import type { PortalOidcPurpose, PortalOidcVerifiedIdentity } from './types';

/**
 * Why a sign-in was refused. Server-side only: the portal shows one generic
 * message for every reason (D15); the reason goes to the audit row and log.
 * `no_address` (not in the plan's list): the token carried neither a UPN nor a
 * linkable address, so there is no address to create a request or an account
 * under.
 */
export type PortalOidcDenyReason = 'org_unresolved' | 'host_mismatch' | 'org_unavailable' | 'method_off' | 'identity_other_org'
  | 'identity_conflict' | 'account_inactive' | 'invited_only' | 'invite_invalid' | 'link_invalid' | 'requests_capped'
  | 'no_address';

export type PortalOidcSignInOutcome =
  /** Mint a browser session, pinned to `entraTenantId` (the token's tid; the session gate checks it per request). */
  | { kind: 'session'; portalUserId: string; orgId: string; authEpoch: number; entraTenantId: string; via: 'identity' | 'invite' | 'instant' | 'instant_grant' }
  | { kind: 'linked'; portalUserId: string; orgId: string }
  | { kind: 'request_sent'; orgId: string }
  | { kind: 'account_exists'; orgId: string }
  | { kind: 'denied'; reason: PortalOidcDenyReason; orgId: string | null };

export interface ResolvePortalOidcSignInInput {
  identity: PortalOidcVerifiedIdentity & { entraTenantId: string };
  purpose: Exclude<PortalOidcPurpose, { kind: 'tenant_proof' }>;
  /** The org whose verified custom domain served the start request, or null on the shared host (D5). */
  hostOrgId: string | null;
  /**
   * Consumes (GET+DEL) and validates the invite capability whose sha256 the
   * state carries; null for anything invalid. Called with no DB context held,
   * BEFORE the activation transaction: a later refusal has spent the token,
   * exactly as password accept-invite (W2). The route wires the real one.
   */
  inviteConsumer: (inviteTokenHash: string) => Promise<{ portalUserId: string; orgId: string; authEpoch: number } | null>;
  now?: Date;
}

type Denied = Extract<PortalOidcSignInOutcome, { kind: 'denied' }>;
type Session = Extract<PortalOidcSignInOutcome, { kind: 'session' }>;
type SsoNewPersonMode = 'invited_only' | 'approval' | 'instant';

interface Resolution {
  identity: ResolvePortalOidcSignInInput['identity'];
  purpose: ResolvePortalOidcSignInInput['purpose'];
  inviteConsumer: ResolvePortalOidcSignInInput['inviteConsumer'];
  tid: string;
  oid: string;
  orgId: string;
  partnerId: string;
  /** Effective `password_mode = sso_only` (D12: links and sign-ins clear the password hash). */
  ssoOnly: boolean;
  mode: SsoNewPersonMode;
  now: Date;
}

/** A refusal thrown INSIDE a write transaction (so it rolls back) and caught outside it. */
class ResolutionRefusal extends Error {
  constructor(readonly reason: PortalOidcDenyReason) {
    super(`portal OIDC sign-in refused: ${reason}`);
    this.name = 'ResolutionRefusal';
  }
}

const denied = (reason: PortalOidcDenyReason, orgId: string | null): Denied => ({ kind: 'denied', reason, orgId });

function session(r: Resolution, portalUserId: string, authEpoch: number, via: Session['via']): Session {
  return { kind: 'session', portalUserId, orgId: r.orgId, authEpoch, entraTenantId: r.tid, via };
}

/** One write branch: a system context, a transaction inside it, refusals caught OUTSIDE the transaction. */
async function inWriteTransaction<T>(r: Resolution, label: string, fn: () => Promise<T>): Promise<T | Denied> {
  return withSystemDbAccessContext(async () => {
    try {
      return await withDbTransaction(fn);
    } catch (err) {
      if (err instanceof ResolutionRefusal) return denied(err.reason, r.orgId);
      throw err;
    }
  }, label);
}

interface LockedAccount {
  id: string;
  email: string;
  name: string | null;
  status: string;
  browserAccess: string;
  authMethod: string;
  authEpoch: number;
  hasPasswordHash: boolean;
  hasExternalIdentity: boolean;
  hasEntraIdentity: boolean;
}

/**
 * The account, bounded by (id, org_id) together, locked FOR UPDATE for the
 * rest of the branch's transaction: a concurrent activation, link or grant of
 * the same account waits here and then re-reads the committed row (READ
 * COMMITTED), so its epoch / status checks see the winner's write.
 */
async function lockAccount(portalUserId: string, orgId: string): Promise<LockedAccount | null> {
  const [row] = await db
    .select({
      id: portalUsers.id,
      email: portalUsers.email,
      name: portalUsers.name,
      status: portalUsers.status,
      browserAccess: portalUsers.browserAccess,
      authMethod: portalUsers.authMethod,
      authEpoch: portalUsers.authEpoch,
      // Spelled as text for the #9692 reason documented on portalUserHasIdentitySql.
      hasPasswordHash: sql<boolean>`("portal_users"."password_hash" is not null)`,
      hasExternalIdentity: portalUserHasIdentitySql(),
      hasEntraIdentity: sql<boolean>`exists (select 1 from "portal_user_identities" "pui_entra" where "pui_entra"."portal_user_id" = "portal_users"."id" and "pui_entra"."provider" = 'entra')`,
    })
    .from(portalUsers)
    .where(and(eq(portalUsers.id, portalUserId), eq(portalUsers.orgId, orgId)))
    .for('update')
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    hasPasswordHash: Boolean(row.hasPasswordHash),
    hasExternalIdentity: Boolean(row.hasExternalIdentity),
    hasEntraIdentity: Boolean(row.hasEntraIdentity),
  };
}

/** The state module's target, or the branch's refusal (every status/browser_access write goes through it). */
function planOrRefuse(account: LockedAccount, writer: PortalAccountWriter, reason: PortalOidcDenyReason): PortalAccountTarget {
  try {
    return planPortalAccountTransition({
      status: account.status,
      browserAccess: account.browserAccess,
      authMethod: account.authMethod,
      hasPasswordHash: account.hasPasswordHash,
      hasExternalIdentity: account.hasExternalIdentity,
    }, writer);
  } catch (err) {
    if (err instanceof PortalAccountTransitionError) throw new ResolutionRefusal(reason);
    throw err;
  }
}

async function touchIdentity(r: Resolution, portalUserId: string): Promise<void> {
  await db
    .update(portalUserIdentities)
    .set({ lastUsedAt: r.now })
    .where(and(
      eq(portalUserIdentities.issuer, entraIssuer(r.tid)),
      eq(portalUserIdentities.subject, r.oid),
      eq(portalUserIdentities.portalUserId, portalUserId),
    ));
}

/**
 * Step 1 (and step 5): the identity `(entraIssuer(tid), oid)` already exists.
 * Returns null when it does not (the caller goes on to step 2, 3 or 4).
 */
async function resolveKnownIdentity(r: Resolution): Promise<PortalOidcSignInOutcome | null> {
  const found = await withSystemDbAccessContext(
    () => findPortalUserIdByEntraIdentity(db, { tid: r.tid, oid: r.oid }),
    'portalOidc.resolve.identity',
  );
  if (!found) return null;
  // inv. 4: an identity's org is its account's org (composite FK); a token for
  // a tenant now proven elsewhere never signs in to the old org's account here.
  if (found.orgId !== r.orgId) return denied('identity_other_org', r.orgId);

  const { purpose } = r;
  if (purpose.kind === 'invite') {
    // D11. An invite's account must have no entra identity (step 2), so a bound
    // identity can never complete one: refuse WITHOUT consuming the invite.
    return denied('identity_conflict', r.orgId);
  }
  if (purpose.kind === 'link') {
    return found.portalUserId === purpose.portalUserId
      ? { kind: 'linked', portalUserId: found.portalUserId, orgId: r.orgId }
      : denied('identity_conflict', r.orgId);
  }

  type AddinAccount = { kind: 'addin'; portalUserId: string; email: string; name: string | null };
  const step = await inWriteTransaction<Session | AddinAccount>(r, 'portalOidc.resolve.identitySignIn', async () => {
    const account = await lockAccount(found.portalUserId, r.orgId);
    if (!account || account.status !== 'active') throw new ResolutionRefusal('account_inactive');

    if (account.browserAccess === 'granted') {
      await touchIdentity(r, account.id);
      await db
        .update(portalUsers)
        .set({
          lastLoginAt: r.now,
          updatedAt: r.now,
          // D12 lazy convergence: under an effective sso_only (however it got
          // there) a Microsoft sign-in sheds the password, with no epoch bump.
          ...(r.ssoOnly ? { passwordHash: null } : {}),
        })
        .where(and(eq(portalUsers.id, account.id), eq(portalUsers.orgId, r.orgId)));
      return session(r, account.id, account.authEpoch, 'identity');
    }
    // Unknown stored value: fail closed.
    if (account.browserAccess !== 'none') throw new ResolutionRefusal('account_inactive');

    // Step 5: an add-in account is a new person for the browser portal.
    if (r.mode !== 'instant') return { kind: 'addin', portalUserId: account.id, email: account.email, name: account.name };

    const target = planOrRefuse(account, 'sso_instant_grant', 'account_inactive');
    const [granted] = await db
      .update(portalUsers)
      .set({
        status: target.status,
        browserAccess: target.browserAccess,
        // Never true for this writer: granting must not kill add-in sessions.
        ...(target.bumpEpoch ? { authEpoch: sql`${portalUsers.authEpoch} + 1` } : {}),
        lastLoginAt: r.now,
        updatedAt: r.now,
        ...(r.ssoOnly ? { passwordHash: null } : {}),
      })
      .where(and(eq(portalUsers.id, account.id), eq(portalUsers.orgId, r.orgId), eq(portalUsers.authEpoch, account.authEpoch)))
      .returning({ authEpoch: portalUsers.authEpoch });
    if (!granted) throw new ResolutionRefusal('account_inactive');
    await touchIdentity(r, account.id);
    return session(r, account.id, granted.authEpoch, 'instant_grant');
  });
  if (step.kind !== 'addin') return step;

  if (r.mode !== 'approval') return denied('invited_only', r.orgId);
  // Outside every transaction: it opens its own isolated system context.
  const request = await createPortalAccessRequest({
    source: 'addin_user',
    orgId: r.orgId,
    portalUserId: step.portalUserId,
    email: step.email,
    name: step.name ?? r.identity.name,
  }, r.now);
  return request.kind === 'capped' ? denied('requests_capped', r.orgId) : { kind: 'request_sent', orgId: r.orgId };
}

/**
 * Whether any login holds `(tid, oid)` on its legacy `portal_users
 * (entra_tenant_id, entra_oid)` columns (the W3 D4 writer fence keeps them
 * until identities release C). A login with those columns and no identity row
 * (drift the daily reconcile only reports) is invisible to step 1, yet
 * `linkPortalUserIdentity` refuses it as a conflict — so the invite step reads
 * it BEFORE spending the invite. This also refuses the edge where the invited
 * account itself is the drifted holder: the invite is not known until it is
 * consumed, and an unspent invite plus a generic refusal is the safe side.
 */
async function legacyEntraKeyHeld(r: Resolution): Promise<boolean> {
  const [holder] = await withSystemDbAccessContext(
    () => db
      .select({ id: portalUsers.id })
      .from(portalUsers)
      .where(and(eq(portalUsers.entraTenantId, r.tid), eq(portalUsers.entraOid, r.oid)))
      .limit(1),
    'portalOidc.resolve.legacyEntraKey',
  );
  return Boolean(holder);
}

/** Step 2: an invitation-bound sign-in activates the invited account and links the identity. */
async function acceptInvite(r: Resolution, inviteTokenHash: string): Promise<PortalOidcSignInOutcome> {
  // D11: a conflict that is knowable before consumption never spends the invite.
  if (await legacyEntraKeyHeld(r)) return denied('identity_conflict', r.orgId);

  const consumed = await r.inviteConsumer(inviteTokenHash);
  if (!consumed || consumed.orgId !== r.orgId) return denied('invite_invalid', r.orgId);

  return inWriteTransaction(r, 'portalOidc.resolve.invite', async () => {
    const account = await lockAccount(consumed.portalUserId, r.orgId);
    // The invite was issued at this exact durable generation; any disable,
    // re-invite or concurrent activation since has moved it.
    if (!account || account.authEpoch !== consumed.authEpoch || account.hasEntraIdentity) {
      throw new ResolutionRefusal('invite_invalid');
    }
    const target = planOrRefuse(account, 'sso_invite_accept', 'invite_invalid');

    const link = await linkPortalUserIdentity(db, {
      orgId: r.orgId,
      portalUserId: account.id,
      provider: 'entra',
      tid: r.tid,
      oid: r.oid,
      linkedVia: 'invite',
      clearPasswordHash: r.ssoOnly,
      now: r.now,
    });
    if (link.kind === 'conflict') throw new ResolutionRefusal('identity_conflict');

    const [activated] = await db
      .update(portalUsers)
      .set({
        // auth_method is left as it is (D13 / OD6).
        status: target.status,
        browserAccess: target.browserAccess,
        ...(target.bumpEpoch ? { authEpoch: sql`${portalUsers.authEpoch} + 1` } : {}),
        ...(!account.name && r.identity.name ? { name: r.identity.name } : {}),
        lastLoginAt: r.now,
        updatedAt: r.now,
      })
      .where(and(eq(portalUsers.id, account.id), eq(portalUsers.orgId, r.orgId), eq(portalUsers.authEpoch, consumed.authEpoch)))
      .returning({ authEpoch: portalUsers.authEpoch });
    if (!activated) throw new ResolutionRefusal('invite_invalid');
    return session(r, account.id, activated.authEpoch, 'invite');
  });
}

/** Step 3: a signed-in account (any method, same org, same epoch) links the identity. */
async function linkSignedIn(
  r: Resolution,
  purpose: Extract<ResolvePortalOidcSignInInput['purpose'], { kind: 'link' }>,
): Promise<PortalOidcSignInOutcome> {
  return inWriteTransaction(r, 'portalOidc.resolve.link', async () => {
    const account = await lockAccount(purpose.portalUserId, r.orgId);
    if (
      !account
      || account.status !== 'active'
      || account.browserAccess !== 'granted'
      || account.authEpoch !== purpose.authEpoch
      || account.hasEntraIdentity
    ) {
      throw new ResolutionRefusal('link_invalid');
    }
    const link = await linkPortalUserIdentity(db, {
      orgId: r.orgId,
      portalUserId: account.id,
      provider: 'entra',
      tid: r.tid,
      oid: r.oid,
      linkedVia: 'self_link',
      clearPasswordHash: r.ssoOnly,
      now: r.now,
    });
    if (link.kind === 'conflict') throw new ResolutionRefusal('identity_conflict');
    return { kind: 'linked' as const, portalUserId: account.id, orgId: r.orgId };
  });
}

/** Step 4: a new person (login purpose, no identity). */
async function resolveNewPerson(r: Resolution): Promise<PortalOidcSignInOutcome> {
  // D10: the email is the linkable address (the existing contact rule), else
  // the lowercased UPN (always on a tenant-verified domain).
  const linkable = await withSystemDbAccessContext(
    () => resolveLinkableEntraAddress(r.orgId, r.partnerId, r.identity),
    'portalOidc.resolve.address',
  );
  const linkableEmail = linkable.kind === 'linkable' ? linkable.email.trim().toLowerCase() : null;
  const upn = r.identity.upn?.trim().toLowerCase() || null;
  const email = linkableEmail ?? upn;
  if (!email) return denied('no_address', r.orgId);

  // An account at either address is a refusal, never a link (inv. 5).
  const addresses = [...new Set([email, upn, linkableEmail].filter((a): a is string => Boolean(a)))];
  const [existing] = await withSystemDbAccessContext(
    () => db
      .select({ id: portalUsers.id })
      .from(portalUsers)
      .where(and(eq(portalUsers.orgId, r.orgId), inArray(sql`lower(${portalUsers.email})`, addresses)))
      .limit(1),
    'portalOidc.resolve.accountExists',
  );
  // A concurrent first sign-in by the same person may have created the account
  // (and bound this identity) since step 1: re-run step 1 before refusing, so
  // the loser of that race is never told to sign in with a password it lacks.
  if (existing) return (await resolveKnownIdentity(r)) ?? { kind: 'account_exists', orgId: r.orgId };

  switch (r.mode) {
    case 'approval': {
      // Outside every transaction: it opens its own isolated system context.
      const request = await createPortalAccessRequest({
        source: 'entra', orgId: r.orgId, email, name: r.identity.name, tid: r.tid, oid: r.oid,
      }, r.now);
      return request.kind === 'capped' ? denied('requests_capped', r.orgId) : { kind: 'request_sent', orgId: r.orgId };
    }
    case 'instant': {
      const created = await inWriteTransaction(r, 'portalOidc.resolve.instant', async () => {
        const outcome = await createIdentityOnlyAccount(db, {
          orgId: r.orgId,
          provider: 'entra',
          tid: r.tid,
          oid: r.oid,
          email,
          name: r.identity.name,
          // D10: a contact link only for a linkable address.
          contactAddress: linkableEmail,
          actorUserId: null,
          writer: 'sso_instant',
          now: r.now,
        });
        // The writer may have linked a contact and inserted the login: roll back.
        if (outcome.kind === 'identity_linked') throw new ResolutionRefusal('identity_conflict');
        return outcome;
      });
      if (created.kind === 'denied') {
        // identity_linked: a concurrent sign-in (or an add-in exchange) bound
        // this identity since step 1. Retry step 1 once, then give up.
        return (await resolveKnownIdentity(r)) ?? denied('identity_conflict', r.orgId);
      }
      if (created.kind === 'account_exists') {
        // Same race, caught by the writer's address lock instead of the read above.
        return (await resolveKnownIdentity(r)) ?? { kind: 'account_exists', orgId: r.orgId };
      }
      return session(r, created.portalUserId, created.authEpoch, 'instant');
    }
    default:
      // invited_only, or an unknown stored mode: fail closed.
      return denied('invited_only', r.orgId);
  }
}

/**
 * Resolve a verified Microsoft identity to a portal outcome (spec §5.6), in
 * order:
 *  0. org — proven tenant → org (else `org_unresolved`), host binding, org and
 *     partner active, Microsoft allowed by the effective policy, a link state's
 *     org;
 *  1. identity found → its account (other org, conflicting purpose, inactive,
 *     or a session; browser_access none is step 5);
 *  2. invite → consume, then activate + link in one transaction;
 *  3. link → link to the signed-in account;
 *  4. new person (login) → `account_exists`, or the new-person mode;
 *  5. add-in account → the new-person mode for browser access.
 *
 * Must be called with no DB context held (an IdP callback before any session).
 */
export async function resolvePortalOidcSignIn(input: ResolvePortalOidcSignInInput): Promise<PortalOidcSignInOutcome> {
  if (hasDbAccessContext()) {
    throw new Error('resolvePortalOidcSignIn must run with no DB context held — it opens its own system contexts');
  }
  const now = input.now ?? new Date();
  const { identity, purpose } = input;
  const tid = identity.entraTenantId;

  // The verifier guarantees this; refuse rather than trust a mismatched shape.
  if (identity.provider !== 'entra' || identity.issuer !== entraIssuer(tid)) return denied('org_unresolved', null);

  // Step 0.
  const org = await findOrgByProvenEntraTenant(tid);
  if (!org) return denied('org_unresolved', null);
  const orgId = org.orgId;
  if (input.hostOrgId !== null && input.hostOrgId !== orgId) return denied('host_mismatch', orgId);
  const tenant = await getActiveOrgTenant(orgId);
  if (!tenant) return denied('org_unavailable', orgId);
  const policy = await resolvePortalAccessPolicy(orgId);
  if (!isSignInMethodAllowed(policy, 'entra')) return denied('method_off', orgId);
  if (purpose.kind === 'link' && purpose.orgId !== orgId) return denied('link_invalid', orgId);

  const r: Resolution = {
    identity,
    purpose,
    inviteConsumer: input.inviteConsumer,
    tid,
    oid: identity.subject,
    orgId,
    partnerId: tenant.partnerId,
    ssoOnly: policy.effective.passwordMode.value === 'sso_only',
    mode: policy.effective.ssoNewPersonMode.value,
    now,
  };

  // Step 1 (+5).
  const known = await resolveKnownIdentity(r);
  if (known) return known;

  switch (purpose.kind) {
    case 'invite': return acceptInvite(r, purpose.inviteTokenHash);
    case 'link': return linkSignedIn(r, purpose);
    case 'login': return resolveNewPerson(r);
    default: return denied('org_unresolved', orgId);
  }
}
