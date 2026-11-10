/**
 * The portal access-request queue (portal registration W3, #11380; spec §5.1,
 * §5.6 steps 4–5, §5.10). One row per person asking for browser access to one
 * org's portal (`portal_access_requests`, tenancy shape 1, plan D9).
 *
 *  - `createPortalAccessRequest` — the producers' entry (W4 SSO, W6 add-in,
 *    W7 self-registration). At most one pending row per (org, email) (plan
 *    D3): a repeat only bumps `last_requested_at`. Expiry is lazy: a pending
 *    row past `expires_at` reads as expired and create replaces it.
 *  - `approvePortalAccessRequest` / `denyPortalAccessRequest` — the MSP's
 *    decision. Each owns ONE `withDbTransaction` around its whole body, so a
 *    refusal rolls back every write it made and the route's catch (outside the
 *    call) maps it to a 4xx without poisoning the request transaction
 *    (#11203, docs/agents/tenancy-rls.md).
 *  - `listPortalAccessRequests` / `summarizePendingPortalAccessRequests` —
 *    reads under the caller's RLS context.
 *
 * Every `status` / `browser_access` written to `portal_users` here comes from
 * services/portalAccountState.ts (`portalAccountWriters.contract.test.ts`).
 * No `Promise.all` inside any transaction: every statement is sequential.
 */
import { and, desc, eq, gt, isNotNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { db, withDbTransaction, withSystemDbAccessContextIsolated } from '../db';
import {
  clientAiTenantMappings,
  organizations,
  portalAccessRequests,
  portalUsers,
  users,
  type PortalAccessRequestSource,
  type PortalAccessRequestStatus,
} from '../db/schema';
import { linkLoginToContact } from './contacts/loginLink';
import { lockPortalInviteAddresses, portalLoginEmailEquals } from './contacts/portalInvite';
import {
  PORTAL_ACCOUNT_TRANSITION_REFUSED,
  PortalAccountTransitionError,
  initialPortalAccountState,
  planPortalAccountTransition,
} from './portalAccountState';
import { createIdentityOnlyAccount } from './portalIdentityAccounts';
import { PORTAL_GOOGLE_ISSUER, entraIssuer, portalUserHasIdentitySql } from './portalUserIdentities';

export { PORTAL_GOOGLE_ISSUER };

export const PORTAL_ACCESS_REQUEST_TTL_DAYS = 14;
export const PORTAL_ACCESS_REQUEST_PENDING_CAP = 200;
/** Key 1 of the per-org admission lock in {@link createPortalAccessRequest} (key 2 is `hashtext(org_id)`). */
const PORTAL_ACCESS_REQUEST_ADMISSION_LOCK_NAMESPACE = 'portal_access_request_admission';

const DAY_MS = 86_400_000;
const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PortalAccessRequestErrorCode =
  | 'PORTAL_ACCESS_REQUEST_NOT_FOUND'
  | 'PORTAL_ACCESS_REQUEST_NOT_PENDING'
  | 'PORTAL_ACCESS_REQUEST_ACCOUNT_EXISTS'
  | 'PORTAL_ACCESS_REQUEST_IDENTITY_LINKED'
  | 'PORTAL_ACCESS_REQUEST_ENTRA_TENANT_NOT_PROVEN';

export class PortalAccessRequestError extends Error {
  constructor(
    readonly code: PortalAccessRequestErrorCode,
    readonly httpStatus: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'PortalAccessRequestError';
  }
}

const notFound = () => new PortalAccessRequestError('PORTAL_ACCESS_REQUEST_NOT_FOUND', 404, 'Access request not found.');
const notPending = () => new PortalAccessRequestError(
  'PORTAL_ACCESS_REQUEST_NOT_PENDING', 409, 'This access request has already been decided or has expired.',
);
const accountExists = () => new PortalAccessRequestError(
  'PORTAL_ACCESS_REQUEST_ACCOUNT_EXISTS', 409, 'A portal account with this email already exists in this organization.',
);
// The message is deliberately neutral: "already linked" would tell an approver
// the (issuer, subject) identity exists in some other org they cannot see. The
// specifics (the identity or legacy entra_* key is already held by a login)
// stay in this comment only.
const identityLinked = () => new PortalAccessRequestError(
  'PORTAL_ACCESS_REQUEST_IDENTITY_LINKED', 409, 'This sign-in identity cannot be approved. Ask the person to request access again.',
);
// One message for "no proven mapping" and "proven for another tenant": the
// approver learns nothing about which org holds the tenant now.
const entraTenantNotProven = () => new PortalAccessRequestError(
  'PORTAL_ACCESS_REQUEST_ENTRA_TENANT_NOT_PROVEN', 409,
  "This organization's Microsoft tenant has changed since this request was made. Ask the person to sign in again.",
);

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type CreatePortalAccessRequestInput =
  | { source: 'self'; orgId: string; email: string; name: string | null }
  | { source: 'entra'; orgId: string; email: string; name: string | null; tid: string; oid: string }
  | { source: 'google'; orgId: string; email: string; name: string | null; sub: string }
  | { source: 'addin_user'; orgId: string; portalUserId: string; email: string; name: string | null };

export type CreatePortalAccessRequestOutcome =
  | { kind: 'created' | 'already_pending'; requestId: string }
  | { kind: 'capped' };

/** The claim columns for a source (the `portal_access_requests_claims_chk` shape). */
function requestClaims(input: CreatePortalAccessRequestInput): {
  issuer: string | null; subject: string | null; entraTenantId: string | null; portalUserId: string | null;
} {
  switch (input.source) {
    case 'entra':
      return { issuer: entraIssuer(input.tid), subject: input.oid, entraTenantId: input.tid, portalUserId: null };
    case 'google':
      return { issuer: PORTAL_GOOGLE_ISSUER, subject: input.sub, entraTenantId: null, portalUserId: null };
    case 'addin_user':
      return { issuer: null, subject: null, entraTenantId: null, portalUserId: input.portalUserId };
    case 'self':
      return { issuer: null, subject: null, entraTenantId: null, portalUserId: null };
  }
}

/**
 * Record (or re-record) one person's request for browser access to an org's
 * portal. For W4/W6/W7 (no W3 producer).
 *
 * Joins a held context, else opens a system context
 * (`withSystemDbAccessContextIsolated`):
 *  - with a context held (an add-in exchange under its system context, a
 *    portal route under its org context) it runs in a savepoint in THAT scope:
 *    it never escalates, RLS still bounds the org, and a failed statement stops
 *    at the savepoint so the caller's catch works (#11203, #11225);
 *  - with none held (an IdP callback before any session exists) it opens a
 *    system context. The caller has derived `orgId` server-side.
 *
 * Steps: take the org's admission lock, normalise the email (`lower(btrim)`),
 * expire this address's stale pending row, refuse at
 * {@link PORTAL_ACCESS_REQUEST_PENDING_CAP} live pending rows, then
 * insert-or-bump on the pending-only unique index. The cap counts the org's
 * OTHER addresses, so a repeat from someone already queued still bumps rather
 * than reading as `capped`.
 *
 * The admission lock (`pg_advisory_xact_lock`, one per org) makes the count and
 * the insert one step: concurrent creates for an org run one at a time, so two
 * at 199 admit exactly one. It is transaction-scoped, so with a context held it
 * passes to the caller's transaction and is released when that ends.
 *
 * The cap is admission control, not an invariant: an org merge can combine two
 * queues above it.
 */
export async function createPortalAccessRequest(
  input: CreatePortalAccessRequestInput,
  now: Date = new Date(),
): Promise<CreatePortalAccessRequestOutcome> {
  const email = input.email.trim().toLowerCase();
  const name = input.name?.trim() || null;
  const claims = requestClaims(input);
  const expiresAt = new Date(now.getTime() + PORTAL_ACCESS_REQUEST_TTL_DAYS * DAY_MS);

  return withSystemDbAccessContextIsolated(async () => {
    // Before the expire / count / insert: without it, two creates can both
    // count 199 and both insert.
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${PORTAL_ACCESS_REQUEST_ADMISSION_LOCK_NAMESPACE}), hashtext(${input.orgId}))`,
    );

    await db
      .update(portalAccessRequests)
      .set({ status: 'expired', updatedAt: now })
      .where(and(
        eq(portalAccessRequests.orgId, input.orgId),
        eq(portalAccessRequests.email, email),
        eq(portalAccessRequests.status, 'pending'),
        lte(portalAccessRequests.expiresAt, now),
      ));

    const [counted] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(portalAccessRequests)
      .where(and(
        eq(portalAccessRequests.orgId, input.orgId),
        eq(portalAccessRequests.status, 'pending'),
        gt(portalAccessRequests.expiresAt, now),
        ne(portalAccessRequests.email, email),
      ));
    if (Number(counted?.n ?? 0) >= PORTAL_ACCESS_REQUEST_PENDING_CAP) return { kind: 'capped' };

    const [row] = await db
      .insert(portalAccessRequests)
      .values({
        orgId: input.orgId,
        email,
        name,
        source: input.source,
        ...claims,
        status: 'pending',
        requestedAt: now,
        lastRequestedAt: now,
        expiresAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        // Mirrors portal_access_requests_pending_email_uq; Postgres infers a
        // partial index as the arbiter only from a matching predicate (42P10).
        target: [portalAccessRequests.orgId, portalAccessRequests.email],
        targetWhere: sql`${portalAccessRequests.status} = 'pending'`,
        set: { lastRequestedAt: now, updatedAt: now },
      })
      // xmax = 0 only on a freshly inserted tuple; the DO UPDATE branch stamps it.
      .returning({ id: portalAccessRequests.id, inserted: sql<boolean>`(xmax = 0)` });
    if (!row) throw new Error('portal access request upsert returned no row');
    return { kind: row.inserted ? 'created' : 'already_pending', requestId: row.id };
  });
}

// ---------------------------------------------------------------------------
// Approve / deny
// ---------------------------------------------------------------------------

export type ApprovePortalAccessRequestResult = {
  outcome: 'account_created' | 'invite_pending' | 'browser_access_granted';
  portalUserId: string;
  email: string;
  name: string | null;
  authEpoch: number;
  source: PortalAccessRequestSource;
};

type DecisionInput = { orgId: string; requestId: string; deciderUserId: string; now?: Date };

type LockedRequest = {
  id: string;
  orgId: string;
  email: string;
  name: string | null;
  source: PortalAccessRequestSource;
  issuer: string | null;
  subject: string | null;
  entraTenantId: string | null;
  portalUserId: string | null;
  status: PortalAccessRequestStatus;
  expiresAt: Date;
};

type ApprovedAccount = Omit<ApprovePortalAccessRequestResult, 'source'>;

/**
 * `SELECT … FOR UPDATE` on the request, bounded by (id, org_id) together. A
 * concurrent second decider blocks here; once the first commits, READ
 * COMMITTED re-reads the row (the WHERE names no status on purpose) and it
 * sees `approved` / `denied` → NOT_PENDING (Review Focus 3). A pending row past
 * `expires_at` is NOT_PENDING too, and is not written: the throw rolls back,
 * and lists derive `expired` from `expires_at`.
 */
async function lockPendingRequest(orgId: string, requestId: string, now: Date): Promise<LockedRequest> {
  if (!UUID_RE.test(requestId)) throw notFound();
  const [row] = await db
    .select({
      id: portalAccessRequests.id,
      orgId: portalAccessRequests.orgId,
      email: portalAccessRequests.email,
      name: portalAccessRequests.name,
      source: portalAccessRequests.source,
      issuer: portalAccessRequests.issuer,
      subject: portalAccessRequests.subject,
      entraTenantId: portalAccessRequests.entraTenantId,
      portalUserId: portalAccessRequests.portalUserId,
      status: portalAccessRequests.status,
      expiresAt: portalAccessRequests.expiresAt,
    })
    .from(portalAccessRequests)
    .where(and(eq(portalAccessRequests.id, requestId), eq(portalAccessRequests.orgId, orgId)))
    .for('update')
    .limit(1);
  if (!row) throw notFound();
  if (row.status !== 'pending' || row.expiresAt.getTime() <= now.getTime()) throw notPending();
  return row;
}

/**
 * The address lock every creator of a login takes (MSP invite, contact link,
 * inbound email), then "never link by email" (spec §5.6 step 4): any account
 * in the org at this address refuses. `portal_users.email` is not unique (spec
 * F3), so the lock is what keeps a concurrent invite from making a second one.
 */
async function lockAddressAndRefuseExisting(request: LockedRequest): Promise<void> {
  await lockPortalInviteAddresses(db, request.orgId, [request.email]);
  const [existing] = await db
    .select({ id: portalUsers.id })
    .from(portalUsers)
    .where(and(eq(portalUsers.orgId, request.orgId), portalLoginEmailEquals(request.email)))
    .limit(1);
  if (existing) throw accountExists();
}

/** Bind the new login to the org's contact for the address (creating one), as the invite does. */
async function linkContact(request: LockedRequest, deciderUserId: string): Promise<string | null> {
  const { contactId } = await linkLoginToContact(db, {
    orgId: request.orgId,
    email: request.email,
    name: request.name,
    actor: { userId: deciderUserId },
    roles: ['portal'],
    unionRoles: ['portal'],
  });
  return contactId;
}

/** `addin_user`: grant the browser portal to the existing add-in login. */
async function grantBrowserAccess(request: LockedRequest, now: Date): Promise<ApprovedAccount> {
  if (!request.portalUserId) throw new Error('addin_user access request has no portal_user_id');
  const [account] = await db
    .select({
      id: portalUsers.id,
      email: portalUsers.email,
      name: portalUsers.name,
      status: portalUsers.status,
      browserAccess: portalUsers.browserAccess,
      authMethod: portalUsers.authMethod,
      // Spelled as text for the same #9692 reason as portalUserHasIdentitySql.
      hasPasswordHash: sql<boolean>`("portal_users"."password_hash" is not null)`,
      authEpoch: portalUsers.authEpoch,
      hasExternalIdentity: portalUserHasIdentitySql(),
    })
    .from(portalUsers)
    .where(and(eq(portalUsers.id, request.portalUserId), eq(portalUsers.orgId, request.orgId)))
    .limit(1);
  if (!account) throw notFound();

  const target = planPortalAccountTransition({
    status: account.status,
    browserAccess: account.browserAccess,
    authMethod: account.authMethod,
    hasPasswordHash: Boolean(account.hasPasswordHash),
    hasExternalIdentity: Boolean(account.hasExternalIdentity),
  }, 'access_request_approve');

  const [moved] = await db
    .update(portalUsers)
    .set({
      status: target.status,
      browserAccess: target.browserAccess,
      ...(target.bumpEpoch ? { authEpoch: sql`${portalUsers.authEpoch} + 1` } : {}),
      updatedAt: now,
    })
    .where(and(
      eq(portalUsers.id, account.id),
      eq(portalUsers.orgId, request.orgId),
      eq(portalUsers.authEpoch, account.authEpoch),
    ))
    .returning({ id: portalUsers.id, authEpoch: portalUsers.authEpoch });
  if (!moved) {
    throw new PortalAccountTransitionError(
      PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'access_request_approve', 'epoch_moved',
      'This account changed while it was being approved. Try again.',
    );
  }
  return { outcome: 'browser_access_granted', portalUserId: moved.id, email: account.email, name: account.name, authEpoch: moved.authEpoch };
}

/**
 * inv. 4 at approval time (W4 #11381). An `entra` request carries the tenant
 * its sign-in resolved through the org's PROVEN mapping, captured up to
 * {@link PORTAL_ACCESS_REQUEST_TTL_DAYS} days ago. If that tenant has since
 * been displaced to another org, removed or replaced, creating
 * `(entraIssuer(tid), oid)` here would place an identity in an org that no
 * longer owns the tenant, and the person would be locked out
 * (`identity_other_org`). So the org's proven mapping must still name the
 * request's tenant, or the approval is refused.
 *
 * `FOR SHARE` on that mapping row, held to commit: a concurrent displacement
 * (recordEntraTenantProof: `FOR UPDATE`, then `DELETE`), removal, or repoint
 * (the AI for Office PUT, whose trigger clears the proof) waits for this
 * approval. Once it commits, the displacement's epoch bump sees the new account
 * like any other identity the org holds in the tenant. One that committed first
 * leaves no proven row for the tenant (READ COMMITTED re-checks `proven_at` on
 * the updated row), and the approval is refused.
 */
async function lockProvenEntraTenant(request: LockedRequest): Promise<void> {
  const [mapping] = await db
    .select({ tenantId: clientAiTenantMappings.entraTenantId })
    .from(clientAiTenantMappings)
    .where(and(eq(clientAiTenantMappings.orgId, request.orgId), isNotNull(clientAiTenantMappings.provenAt)))
    .for('share')
    .limit(1);
  if (!mapping || !request.entraTenantId || mapping.tenantId.toLowerCase() !== request.entraTenantId.toLowerCase()) {
    throw entraTenantNotProven();
  }
}

/**
 * `entra` / `google`: an identity-only account (plan D2), written by the
 * shared services/portalIdentityAccounts.ts writer (W4 instant mode uses the
 * same one). An `entra` request first re-checks its tenant
 * ({@link lockProvenEntraTenant}: ENTRA_TENANT_NOT_PROVEN). The writer's
 * outcomes map back to this queue's 409s, and the throw rolls back everything
 * the writer did (the contact link, a login row): `account_exists` →
 * ACCOUNT_EXISTS, `identity_linked` → IDENTITY_LINKED. The contact is linked at
 * the request's address, as an MSP invite does (the approval is an MSP action).
 */
async function createIdentityAccount(request: LockedRequest, deciderUserId: string, now: Date): Promise<ApprovedAccount> {
  const provider = request.source;
  if ((provider !== 'entra' && provider !== 'google') || !request.issuer || !request.subject) {
    throw new Error('SSO access request is missing its identity claims');
  }
  if (provider === 'entra' && !request.entraTenantId) throw new Error('entra access request has no tenant id');
  if (provider === 'entra') await lockProvenEntraTenant(request);

  const outcome = await createIdentityOnlyAccount(db, {
    orgId: request.orgId,
    email: request.email,
    name: request.name,
    contactAddress: request.email,
    actorUserId: deciderUserId,
    writer: 'sso_request_approved',
    now,
    // portal_access_requests_claims_chk pins issuer to these exact forms.
    ...(provider === 'entra'
      ? { provider, tid: request.entraTenantId!, oid: request.subject }
      : { provider, sub: request.subject }),
  });
  if (outcome.kind === 'account_exists') throw accountExists();
  if (outcome.kind === 'identity_linked') throw identityLinked();

  return { outcome: 'account_created', portalUserId: outcome.portalUserId, email: request.email, name: request.name, authEpoch: outcome.authEpoch };
}

/** `self`: an invited password account, exactly what an MSP invite creates. The route sends the invite. */
async function createInvitedAccount(request: LockedRequest, deciderUserId: string, now: Date): Promise<ApprovedAccount> {
  await lockAddressAndRefuseExisting(request);
  const contactId = await linkContact(request, deciderUserId);

  const [created] = await db
    .insert(portalUsers)
    .values({
      orgId: request.orgId,
      email: request.email,
      name: request.name,
      passwordHash: null,
      authMethod: 'password',
      ...initialPortalAccountState('self_request_approved'),
      invitedAt: now,
      invitedBy: deciderUserId,
      contactId,
    })
    .returning({ id: portalUsers.id, authEpoch: portalUsers.authEpoch });
  if (!created) throw new Error('portal user insert returned no row');
  return { outcome: 'invite_pending', portalUserId: created.id, email: request.email, name: request.name, authEpoch: created.authEpoch };
}

/**
 * Approve a pending request (Review Focus 3).
 *
 * PRECONDITION: called inside a held DB access context — the request's
 * `withDbAccessContext` — because `withDbTransaction` throws without one. The
 * whole body is ONE `withDbTransaction`, so any refusal (`PortalAccessRequestError`,
 * `PortalAccountTransitionError`) rolls back every write and leaves the request
 * pending. Callers catch OUTSIDE this call and add no transaction of their own.
 *
 * Outcomes: `account_created` (entra/google), `invite_pending` (self — the
 * route issues the invite), `browser_access_granted` (addin_user).
 */
export async function approvePortalAccessRequest(input: DecisionInput): Promise<ApprovePortalAccessRequestResult> {
  const now = input.now ?? new Date();
  return withDbTransaction(async () => {
    const request = await lockPendingRequest(input.orgId, input.requestId, now);

    let account: ApprovedAccount;
    switch (request.source) {
      case 'addin_user':
        account = await grantBrowserAccess(request, now);
        break;
      case 'entra':
      case 'google':
        account = await createIdentityAccount(request, input.deciderUserId, now);
        break;
      case 'self':
        account = await createInvitedAccount(request, input.deciderUserId, now);
        break;
      default:
        throw new Error('unknown portal access request source');
    }

    await db
      .update(portalAccessRequests)
      .set({
        status: 'approved',
        decidedAt: now,
        decidedByUserId: input.deciderUserId,
        portalUserId: account.portalUserId,
        updatedAt: now,
      })
      .where(and(eq(portalAccessRequests.id, request.id), eq(portalAccessRequests.orgId, input.orgId)));

    return { ...account, source: request.source };
  });
}

/**
 * Deny a pending request. Same precondition and transaction shape as
 * {@link approvePortalAccessRequest}: the request row lock and the pending
 * check, then `denied` with the decider.
 */
export async function denyPortalAccessRequest(
  input: DecisionInput,
): Promise<{ email: string; source: PortalAccessRequestSource }> {
  const now = input.now ?? new Date();
  return withDbTransaction(async () => {
    const request = await lockPendingRequest(input.orgId, input.requestId, now);
    await db
      .update(portalAccessRequests)
      .set({ status: 'denied', decidedAt: now, decidedByUserId: input.deciderUserId, updatedAt: now })
      .where(and(eq(portalAccessRequests.id, request.id), eq(portalAccessRequests.orgId, input.orgId)));
    return { email: request.email, source: request.source };
  });
}

// ---------------------------------------------------------------------------
// Reads (caller's RLS context)
// ---------------------------------------------------------------------------

export interface PortalAccessRequestListItem {
  id: string;
  email: string;
  name: string | null;
  source: PortalAccessRequestSource;
  /** `expired` when the row is still `pending` but past `expires_at`. */
  status: PortalAccessRequestStatus;
  requestedAt: string;
  lastRequestedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: { id: string; name: string | null } | null;
  portalUserId: string | null;
  /** Any portal account in the org at this address (approve would refuse with ACCOUNT_EXISTS). */
  accountExists: boolean;
}

/**
 * One page of an org's requests. `pending` = live pending (`expires_at > now`),
 * newest first; `decided` = everything else, most recently decided or expired
 * first. `limit` defaults to 100 and is clamped to 1–200; `hasMore` comes from
 * reading one extra row.
 */
export async function listPortalAccessRequests(
  orgId: string,
  opts: { status: 'pending' | 'decided'; limit?: number; now?: Date },
): Promise<{ items: PortalAccessRequestListItem[]; hasMore: boolean }> {
  const now = opts.now ?? new Date();
  const limit = Math.min(LIST_MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? LIST_DEFAULT_LIMIT)));
  const t = portalAccessRequests;
  const filter: SQL | undefined = opts.status === 'pending'
    ? and(eq(t.status, 'pending'), gt(t.expiresAt, now))
    : or(ne(t.status, 'pending'), lte(t.expiresAt, now));
  const order = opts.status === 'pending'
    ? [desc(t.requestedAt), desc(t.id)]
    : [desc(sql`coalesce(${t.decidedAt}, ${t.expiresAt})`), desc(t.id)];

  const rows = await db
    .select({
      id: t.id,
      email: t.email,
      name: t.name,
      source: t.source,
      status: t.status,
      requestedAt: t.requestedAt,
      lastRequestedAt: t.lastRequestedAt,
      expiresAt: t.expiresAt,
      decidedAt: t.decidedAt,
      decidedByUserId: t.decidedByUserId,
      decidedByName: users.name,
      portalUserId: t.portalUserId,
      accountExists: sql<boolean>`exists (select 1 from "portal_users" "pu_acct" where "pu_acct"."org_id" = "portal_access_requests"."org_id" and lower("pu_acct"."email") = "portal_access_requests"."email")`,
    })
    .from(t)
    .leftJoin(users, eq(users.id, t.decidedByUserId))
    .where(and(eq(t.orgId, orgId), filter))
    .orderBy(...order)
    .limit(limit + 1);

  const items = rows.slice(0, limit).map((r): PortalAccessRequestListItem => ({
    id: r.id,
    email: r.email,
    name: r.name,
    source: r.source,
    status: r.status === 'pending' && r.expiresAt.getTime() <= now.getTime() ? 'expired' : r.status,
    requestedAt: r.requestedAt.toISOString(),
    lastRequestedAt: r.lastRequestedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    decidedBy: r.decidedByUserId ? { id: r.decidedByUserId, name: r.decidedByName ?? null } : null,
    portalUserId: r.portalUserId,
    accountExists: Boolean(r.accountExists),
  }));
  return { items, hasMore: rows.length > limit };
}

/**
 * Live pending requests per org, under the CALLER's RLS context: a partner
 * context sees only the orgs it can access. Soft-deleted orgs are left out.
 */
export async function summarizePendingPortalAccessRequests(
  now: Date = new Date(),
): Promise<{ pendingTotal: number; orgs: Array<{ orgId: string; orgName: string; pending: number }> }> {
  const rows = await db
    .select({
      orgId: portalAccessRequests.orgId,
      orgName: organizations.name,
      pending: sql<number>`count(*)::int`,
    })
    .from(portalAccessRequests)
    .innerJoin(organizations, eq(organizations.id, portalAccessRequests.orgId))
    .where(and(
      eq(portalAccessRequests.status, 'pending'),
      gt(portalAccessRequests.expiresAt, now),
      sql`${organizations.deletedAt} is null`,
    ))
    .groupBy(portalAccessRequests.orgId, organizations.name)
    .orderBy(organizations.name, portalAccessRequests.orgId);
  const orgs = rows.map((r) => ({ orgId: r.orgId, orgName: r.orgName, pending: Number(r.pending) }));
  return { pendingTotal: orgs.reduce((sum, o) => sum + o.pending, 0), orgs };
}
