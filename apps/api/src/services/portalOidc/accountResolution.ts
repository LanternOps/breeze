/**
 * Portal OIDC account resolution (portal registration W4 #11381, plan Task 5,
 * spec §5.6; W7 #11384 adds Google through a provider adapter, plan D4): which
 * portal account a verified Microsoft or Google identity signs in as, links
 * to, or asks for — and every reason it does not. Everything provider-specific
 * lives in ./signInProviders.ts; the order below is shared.
 *
 * The rules that make this the security core of SSO sign-in:
 *  - only a PROVEN tenant mapping (Microsoft) or a CURRENTLY verified `hd`
 *    domain (Google) resolves an org (inv. 2), and a custom-domain host must
 *    be that org (inv. 1);
 *  - an identity in another org is never placed here (inv. 4);
 *  - an identity is linked to an existing account only through an
 *    invitation-bound or a session-bound state, NEVER by email (inv. 5). An
 *    address match is only ever a refusal (`account_exists`);
 *  - an identity already bound to a different account than an invite or link
 *    names is refused, and the invite is not consumed (D11);
 *  - a Google write branch holds the verified domain row for its transaction
 *    (W7 D15), so a domain displaced after step 0 never gets an account,
 *    identity or grant written in the old org.
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
import { createPortalAccessRequest } from '../portalAccessRequests';
import {
  PortalAccountTransitionError,
  planPortalAccountTransition,
  type PortalAccountTarget,
  type PortalAccountWriter,
} from '../portalAccountState';
import { isSignInMethodAllowed, resolvePortalAccessPolicy } from '../portalAccessPolicy';
import { createIdentityOnlyAccount } from '../portalIdentityAccounts';
import {
  findPortalUserIdByEntraIdentity,
  findPortalUserIdByIdentity,
  identityIssuerSubject,
  linkPortalUserIdentity,
  portalUserHasIdentitySql,
  type PortalIdentityKey,
} from '../portalUserIdentities';
import { getActiveOrgTenant } from '../tenantStatus';
import { signInProviderFor, type PortalOidcResolvedOrg, type PortalOidcSignInProvider } from './signInProviders';
import type { PortalOidcPurpose, PortalOidcVerifiedIdentity } from './types';

/**
 * Why a sign-in was refused. Server-side only: the portal shows one generic
 * message for every reason (D15), except `request_conflict` on a login, which
 * lands on `sso=request_pending` (it describes only the person's own address);
 * the reason goes to the audit row and log.
 * `no_address` (not in the plan's list): the token carried neither a UPN nor a
 * linkable address, so there is no address to create a request or an account
 * under. `request_conflict` (W7 D9): the address already has a pending request
 * for a DIFFERENT identity; nothing is written, the MSP decides that one first.
 */
export type PortalOidcDenyReason = 'org_unresolved' | 'host_mismatch' | 'org_unavailable' | 'method_off' | 'identity_other_org'
  | 'identity_conflict' | 'account_inactive' | 'invited_only' | 'invite_invalid' | 'link_invalid' | 'requests_capped'
  | 'no_address' | 'request_conflict';

interface PortalOidcSessionBase {
  kind: 'session';
  portalUserId: string;
  orgId: string;
  authEpoch: number;
  via: 'identity' | 'invite' | 'instant' | 'instant_grant';
}

/**
 * Mint a browser session, pinned to what the session gate re-checks per
 * request: an Entra session to the token's tid (`entraTenantId`), a Google
 * session to the token's `hd` (`googleHostedDomain`, W7 D7). An Entra outcome
 * carries no `method` key at all — W4's outcome shape, byte-identical — so
 * `method === 'google'` is the discriminant and anything else is Entra.
 */
export type PortalOidcSessionOutcome =
  | (PortalOidcSessionBase & { method?: 'entra'; entraTenantId: string; googleHostedDomain?: undefined })
  | (PortalOidcSessionBase & { method: 'google'; entraTenantId: null; googleHostedDomain: string });

export type PortalOidcSignInOutcome =
  | PortalOidcSessionOutcome
  | { kind: 'linked'; portalUserId: string; orgId: string }
  | { kind: 'request_sent'; orgId: string }
  | { kind: 'account_exists'; orgId: string }
  | { kind: 'denied'; reason: PortalOidcDenyReason; orgId: string | null };

export interface ResolvePortalOidcSignInInput {
  /** The verified identity; its `provider` selects the adapter (never request input). */
  identity: PortalOidcVerifiedIdentity;
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
type Session = PortalOidcSessionOutcome;
type SsoNewPersonMode = 'invited_only' | 'approval' | 'instant';

interface Resolution {
  /** Selected from the verified identity's provider, never from request input (D4). */
  adapter: PortalOidcSignInProvider;
  identity: ResolvePortalOidcSignInInput['identity'];
  /** `adapter.identityKey(identity)`: lookup, touch and link all use it. */
  key: PortalIdentityKey;
  purpose: ResolvePortalOidcSignInInput['purpose'];
  inviteConsumer: ResolvePortalOidcSignInInput['inviteConsumer'];
  /** Step 0's org, with the proof observation the write branches fence on (D15). */
  org: PortalOidcResolvedOrg;
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
  const base = { kind: 'session' as const, portalUserId, orgId: r.orgId, authEpoch, via };
  const pin = r.adapter.sessionPin(r.identity);
  if (r.adapter.provider === 'google' && pin.googleHostedDomain !== null && pin.entraTenantId === null) {
    return { ...base, method: 'google', entraTenantId: null, googleHostedDomain: pin.googleHostedDomain };
  }
  if (r.adapter.provider === 'entra' && pin.entraTenantId !== null && pin.googleHostedDomain === null) {
    return { ...base, entraTenantId: pin.entraTenantId };
  }
  // A session must never be minted unpinned or pinned to the other provider's proof.
  throw new Error('portal OIDC session without a valid pin for its provider');
}

/**
 * D15: the first statement of a write branch's transaction. The adapter
 * re-reads the proof step 0 observed and holds it to commit (Google: the
 * verified domain row FOR SHARE; Entra: a no-op). No proof → `org_unresolved`,
 * rolling the branch back.
 */
async function fenceOrRefuse(r: Resolution): Promise<void> {
  if (!(await r.adapter.fenceProof(r.org, r.identity))) throw new ResolutionRefusal('org_unresolved');
}

/** A request outcome as a resolution outcome. `claims_conflict` (W7 D9) is a refusal, never "request sent". */
function requestOutcome(r: Resolution, request: Awaited<ReturnType<typeof createPortalAccessRequest>>): PortalOidcSignInOutcome {
  switch (request.kind) {
    case 'created':
    case 'already_pending':
      return { kind: 'request_sent', orgId: r.orgId };
    case 'capped':
      return denied('requests_capped', r.orgId);
    case 'claims_conflict':
      return denied('request_conflict', r.orgId);
    default:
      // An unknown outcome: fail closed.
      return denied('request_conflict', r.orgId);
  }
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
  /** The account already has an identity of the signing-in provider (one per provider, spec §5.2). */
  hasProviderIdentity: boolean;
}

/**
 * The account, bounded by (id, org_id) together, locked FOR UPDATE for the
 * rest of the branch's transaction: a concurrent activation, link or grant of
 * the same account waits here and then re-reads the committed row (READ
 * COMMITTED), so its epoch / status checks see the winner's write.
 * `hasProviderIdentity` is for `provider` only: an Entra identity never blocks
 * a Google link or invite, and the reverse (W7 D4).
 */
async function lockAccount(portalUserId: string, orgId: string, provider: PortalOidcSignInProvider['provider']): Promise<LockedAccount | null> {
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
      hasGoogleIdentity: sql<boolean>`exists (select 1 from "portal_user_identities" "pui_google" where "pui_google"."portal_user_id" = "portal_users"."id" and "pui_google"."provider" = 'google')`,
    })
    .from(portalUsers)
    .where(and(eq(portalUsers.id, portalUserId), eq(portalUsers.orgId, orgId)))
    .for('update')
    .limit(1);
  if (!row) return null;
  const { hasEntraIdentity, hasGoogleIdentity, ...rest } = row;
  let hasProviderIdentity: boolean;
  switch (provider) {
    case 'entra': hasProviderIdentity = Boolean(hasEntraIdentity); break;
    case 'google': hasProviderIdentity = Boolean(hasGoogleIdentity); break;
    // Unknown provider: read as "already linked", so every link / invite refuses.
    default: hasProviderIdentity = true;
  }
  return {
    ...rest,
    hasPasswordHash: Boolean(row.hasPasswordHash),
    hasExternalIdentity: Boolean(row.hasExternalIdentity),
    hasProviderIdentity,
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
  const { issuer, subject } = identityIssuerSubject(r.key);
  await db
    .update(portalUserIdentities)
    .set({ lastUsedAt: r.now })
    .where(and(
      eq(portalUserIdentities.issuer, issuer),
      eq(portalUserIdentities.subject, subject),
      eq(portalUserIdentities.portalUserId, portalUserId),
    ));
}

/**
 * Step 1's reader: the account the identity key belongs to, matched on
 * provider, issuer and subject (each provider's lookup ignores the other's
 * identities). Entra keeps W4's wrapper, the reader the add-in exchange shares.
 */
function findIdentityOwner(key: PortalIdentityKey): Promise<{ portalUserId: string; orgId: string } | null> {
  if (key.provider === 'entra') return findPortalUserIdByEntraIdentity(db, { tid: key.tid, oid: key.oid });
  return findPortalUserIdByIdentity(db, key);
}

/**
 * Step 1 (and step 5): the identity `identityIssuerSubject(key)` already exists.
 * Returns null when it does not (the caller goes on to step 2, 3 or 4).
 */
async function resolveKnownIdentity(r: Resolution): Promise<PortalOidcSignInOutcome | null> {
  const found = await withSystemDbAccessContext(() => findIdentityOwner(r.key), 'portalOidc.resolve.identity');
  if (!found) return null;
  // inv. 4: an identity's org is its account's org (composite FK); a token for
  // a tenant now proven elsewhere never signs in to the old org's account here.
  if (found.orgId !== r.orgId) return denied('identity_other_org', r.orgId);

  const { purpose } = r;
  if (purpose.kind === 'invite') {
    // D11. An invite's account must have no identity of this provider (step 2),
    // so a bound identity can never complete one: refuse WITHOUT consuming the invite.
    return denied('identity_conflict', r.orgId);
  }
  if (purpose.kind === 'link') {
    return found.portalUserId === purpose.portalUserId
      ? { kind: 'linked', portalUserId: found.portalUserId, orgId: r.orgId }
      : denied('identity_conflict', r.orgId);
  }

  type AddinAccount = { kind: 'addin'; portalUserId: string; email: string; name: string | null };
  const step = await inWriteTransaction<Session | AddinAccount>(r, 'portalOidc.resolve.identitySignIn', async () => {
    const account = await lockAccount(found.portalUserId, r.orgId, r.adapter.provider);
    if (!account || account.status !== 'active') throw new ResolutionRefusal('account_inactive');

    if (account.browserAccess === 'granted') {
      // No proof fence (D15): nothing is placed in the org here, and the
      // session gate re-checks the pin on every request (D7).
      await touchIdentity(r, account.id);
      await db
        .update(portalUsers)
        .set({
          lastLoginAt: r.now,
          updatedAt: r.now,
          // D12 lazy convergence: under an effective sso_only (however it got
          // there) an SSO sign-in sheds the password, with no epoch bump.
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
    // D15: the grant is a write the step-0 proof authorized; hold that proof.
    await fenceOrRefuse(r);
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
  return requestOutcome(r, request);
}

/** Step 2: an invitation-bound sign-in activates the invited account and links the identity. */
async function acceptInvite(r: Resolution, inviteTokenHash: string): Promise<PortalOidcSignInOutcome> {
  // D11: a conflict that is knowable before consumption never spends the invite
  // (Entra: a login holding the key on the legacy columns; see the adapter).
  if (await r.adapter.legacyKeyHeld(r.identity)) return denied('identity_conflict', r.orgId);

  const consumed = await r.inviteConsumer(inviteTokenHash);
  if (!consumed || consumed.orgId !== r.orgId) return denied('invite_invalid', r.orgId);

  return inWriteTransaction(r, 'portalOidc.resolve.invite', async () => {
    await fenceOrRefuse(r);
    const account = await lockAccount(consumed.portalUserId, r.orgId, r.adapter.provider);
    // The invite was issued at this exact durable generation; any disable,
    // re-invite or concurrent activation since has moved it.
    if (!account || account.authEpoch !== consumed.authEpoch || account.hasProviderIdentity) {
      throw new ResolutionRefusal('invite_invalid');
    }
    const target = planOrRefuse(account, 'sso_invite_accept', 'invite_invalid');

    const link = await linkPortalUserIdentity(db, {
      orgId: r.orgId,
      portalUserId: account.id,
      ...r.key,
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
    await fenceOrRefuse(r);
    const account = await lockAccount(purpose.portalUserId, r.orgId, r.adapter.provider);
    if (
      !account
      || account.status !== 'active'
      || account.browserAccess !== 'granted'
      || account.authEpoch !== purpose.authEpoch
      || account.hasProviderIdentity
    ) {
      throw new ResolutionRefusal('link_invalid');
    }
    const link = await linkPortalUserIdentity(db, {
      orgId: r.orgId,
      portalUserId: account.id,
      ...r.key,
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
  // The adapter's address rule (Entra: W4 D10; Google: D3). No DB context is held here.
  const address = await r.adapter.newPersonAddress(r.identity, { orgId: r.orgId, partnerId: r.partnerId });
  if (!address) return denied('no_address', r.orgId);
  const { email } = address;

  // An account at any of the adapter's addresses is a refusal, never a link (inv. 5).
  const [existing] = await withSystemDbAccessContext(
    () => db
      .select({ id: portalUsers.id })
      .from(portalUsers)
      .where(and(eq(portalUsers.orgId, r.orgId), inArray(sql`lower(${portalUsers.email})`, address.refuseIfAnyAccountAt)))
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
      const request = await createPortalAccessRequest(
        r.adapter.accessRequest(r.identity, { orgId: r.orgId, email, name: r.identity.name }),
        r.now,
      );
      return requestOutcome(r, request);
    }
    case 'instant': {
      const created = await inWriteTransaction(r, 'portalOidc.resolve.instant', async () => {
        await fenceOrRefuse(r);
        const outcome = await createIdentityOnlyAccount(db, {
          orgId: r.orgId,
          ...r.key,
          email,
          name: r.identity.name,
          // The adapter's contact rule (Entra: W4 D10, a linkable address only; Google: D3).
          contactAddress: address.contactAddress,
          actorUserId: null,
          writer: 'sso_instant',
          now: r.now,
        });
        // The writer may have linked a contact and inserted the login: roll back.
        if (outcome.kind === 'identity_linked') throw new ResolutionRefusal('identity_conflict');
        return outcome;
      });
      if (created.kind === 'denied') {
        // The proof fence refused (D15): the org no longer holds it; never retry into it.
        if (created.reason !== 'identity_conflict') return created;
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
 * Resolve a verified Microsoft or Google identity to a portal outcome (spec
 * §5.6), in order:
 *  0. org — the adapter's proof → org (Microsoft: proven tenant; Google: the
 *     `hd` currently verified for exactly one org; else `org_unresolved`), host
 *     binding, org and partner active, the provider allowed by the effective
 *     policy, a link state's org;
 *  1. identity found → its account (other org, conflicting purpose, inactive,
 *     or a session; browser_access none is step 5);
 *  2. invite → consume, then fence + activate + link in one transaction;
 *  3. link → fence + link to the signed-in account;
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
  // Server-side, from the VERIFIED identity (D4); never from request input.
  const adapter = signInProviderFor(identity.provider);

  // Step 0 (the adapter refuses a mismatched identity shape with null).
  const org = await adapter.resolveOrg(identity);
  if (!org) return denied('org_unresolved', null);
  const orgId = org.orgId;
  if (input.hostOrgId !== null && input.hostOrgId !== orgId) return denied('host_mismatch', orgId);
  const tenant = await getActiveOrgTenant(orgId);
  if (!tenant) return denied('org_unavailable', orgId);
  const policy = await resolvePortalAccessPolicy(orgId);
  if (!isSignInMethodAllowed(policy, adapter.provider)) return denied('method_off', orgId);
  if (purpose.kind === 'link' && purpose.orgId !== orgId) return denied('link_invalid', orgId);

  const r: Resolution = {
    adapter,
    identity,
    key: adapter.identityKey(identity),
    purpose,
    inviteConsumer: input.inviteConsumer,
    org,
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
