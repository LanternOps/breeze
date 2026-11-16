/**
 * SCIM Users operations for one org's Entra tenant (portal registration W9
 * #11386, plan D3–D8, D10).
 *
 * A SCIM User IS a `portal_user_identities` row of the token's tenant, marked
 * SCIM-managed (`scim_provisioned_at`). Its SCIM id is the identity id, its
 * externalId the identity's `subject` (the Entra objectId).
 *
 * VISIBILITY (D8). Every read, write and locked-row re-validation is scoped
 * by {@link scimVisible}: the token's org AND provider `entra` AND the token
 * tenant's issuer AND SCIM-managed AND not deleted. A token never sees another
 * org's identities, nor an earlier tenant's identities in its own org.
 *
 * ONE TRANSACTION PER MUTATION (D6). A create, PATCH, PUT or DELETE runs in one
 * system transaction under one lock order — the `(org, 'entra')` advisory lock
 * (the W8 lock), the address lock (when a userName is written), the account
 * `FOR UPDATE`, the identity `FOR UPDATE`, then the token and the proven tenant
 * `FOR SHARE` (D2) — and writes attributes, blockers, the tombstone and the
 * audit together. A refusal is a thrown {@link ScimError}, which rolls the
 * whole transaction back (including a login `createIdentityOnlyAccount` wrote
 * before it found the identity taken); a uniqueness refusal is then audited in
 * a transaction of its own (D10). Session purges run after commit.
 *
 * Never: linking by email (an address match refuses), touching a directory or
 * MSP blocker, or reactivating an account disabled by the MSP or a directory
 * (the W8 writer and liftScimBlockerInTransaction enforce it).
 */
import { and, asc, count, eq, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { db, hasDbAccessContext, withSystemDbAccessContext } from '../../db';
import { auditLogs, portalUserIdentities, portalUsers } from '../../db/schema';
import type { PortalIdentityBlocker } from '../../db/schema/portal';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { lockPortalInviteAddresses } from '../contacts/portalInvite';
import {
  disableIdentityInTransaction,
  liftScimBlockerInTransaction,
  lockPortalDirectorySource,
  purgeIdentitySessions,
} from '../portalDirectory/identityDisable';
import { planPortalAccountTransition } from '../portalAccountState';
import { createIdentityOnlyAccount } from '../portalIdentityAccounts';
import {
  ScimError,
  portalNameFrom,
  type ScimReplaceAttrs,
  type ScimUserAttrs,
  type ScimUserPatch,
  type ScimUserRecord,
} from './protocol';
import { lockLiveScimToken, type VerifiedScimToken } from './tokens';

export const AUDIT_SCIM_USER_CREATE = 'portal.scim.user.create';
export const AUDIT_SCIM_USER_ADOPT = 'portal.scim.user.adopt';
export const AUDIT_SCIM_USER_UPDATE = 'portal.scim.user.update';
export const AUDIT_SCIM_USER_DELETE = 'portal.scim.user.delete';
export const AUDIT_SCIM_USER_CONFLICT = 'portal.scim.user.conflict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () => new ScimError(404, 'Resource not found.');
/** The router renders every 401 with one fixed body; the message here is never shown. */
const unauthorized = () => new ScimError(401, 'token_no_longer_valid');

type ConflictReason = 'external_id_taken' | 'external_id_other_org' | 'user_name_taken' | 'address_has_account';

class ScimConflict extends ScimError {
  constructor(readonly reason: ConflictReason, detail: string, readonly externalId: string | null) {
    super(409, detail, 'uniqueness');
  }
}

function assertNoHeldContext(operation: string): void {
  if (hasDbAccessContext()) {
    throw new Error(`${operation} opens its own system-scope transaction — call it with no DB context held`);
  }
}

/** D8: the only rows a token may read or write. */
export function scimVisible(token: VerifiedScimToken): SQL {
  return and(
    eq(portalUserIdentities.orgId, token.orgId),
    eq(portalUserIdentities.provider, 'entra'),
    eq(portalUserIdentities.issuer, token.issuer),
    isNotNull(portalUserIdentities.scimProvisionedAt),
    isNull(portalUserIdentities.scimDeletedAt),
  )!;
}

const recordColumns = {
  id: portalUserIdentities.id,
  subject: portalUserIdentities.subject,
  disabledBlockers: portalUserIdentities.disabledBlockers,
  scimUserName: portalUserIdentities.scimUserName,
  scimDisplayName: portalUserIdentities.scimDisplayName,
  scimGivenName: portalUserIdentities.scimGivenName,
  scimFamilyName: portalUserIdentities.scimFamilyName,
  scimProvisionedAt: portalUserIdentities.scimProvisionedAt,
};

type RecordRow = {
  id: string;
  subject: string;
  disabledBlockers: PortalIdentityBlocker[];
  scimUserName: string | null;
  scimDisplayName: string | null;
  scimGivenName: string | null;
  scimFamilyName: string | null;
  scimProvisionedAt: Date | null;
};

function toRecord(row: RecordRow): ScimUserRecord {
  return {
    id: row.id,
    externalId: row.subject,
    userName: row.scimUserName ?? '',
    // D3: SCIM's own assertion — the identity does not carry SCIM's blocker.
    active: !row.disabledBlockers.includes('scim'),
    displayName: row.scimDisplayName,
    givenName: row.scimGivenName,
    familyName: row.scimFamilyName,
    created: row.scimProvisionedAt ?? new Date(0),
  };
}

async function readVisible(token: VerifiedScimToken, identityId: string): Promise<ScimUserRecord | null> {
  const [row] = await db
    .select(recordColumns)
    .from(portalUserIdentities)
    .where(and(scimVisible(token), eq(portalUserIdentities.id, identityId)))
    .limit(1);
  return row ? toRecord(row) : null;
}

async function insertScimAudit(token: VerifiedScimToken, action: string, resourceId: string, details: Record<string, unknown>): Promise<void> {
  await db.insert(auditLogs).values({
    orgId: token.orgId,
    actorType: 'system',
    actorId: ANONYMOUS_ACTOR_ID,
    action,
    resourceType: 'portal_user',
    resourceId,
    details: { ...details, scimTokenId: token.tokenId },
    result: 'success',
  });
}

/** D10: a refusal's audit, in its own transaction AFTER the refused one rolled back. */
async function auditConflict(token: VerifiedScimToken, conflict: ScimConflict): Promise<void> {
  try {
    await withSystemDbAccessContext(
      () => db.insert(auditLogs).values({
        orgId: token.orgId,
        actorType: 'system',
        actorId: ANONYMOUS_ACTOR_ID,
        action: AUDIT_SCIM_USER_CONFLICT,
        resourceType: 'portal_scim_token',
        resourceId: token.tokenId,
        details: { reason: conflict.reason, externalId: conflict.externalId },
        result: 'failure',
      }),
      'portalScim.auditConflict',
    );
  } catch (err) {
    // The refusal stands either way; ids only.
    console.error('[portal-scim] conflict audit failed', { orgId: token.orgId, tokenId: token.tokenId, error: err instanceof Error ? err.name : 'unknown' });
  }
}

/** Run a mutation; on a uniqueness refusal, audit it after the rollback and rethrow. */
async function withConflictAudit<T>(token: VerifiedScimToken, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ScimConflict) await auditConflict(token, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reads (D8)
// ---------------------------------------------------------------------------

export async function getScimUser(token: VerifiedScimToken, identityId: string): Promise<ScimUserRecord> {
  assertNoHeldContext('getScimUser');
  if (!UUID_RE.test(identityId)) throw notFound();
  const record = await withSystemDbAccessContext(() => readVisible(token, identityId), 'portalScim.getUser');
  if (!record) throw notFound();
  return record;
}

export async function listScimUsers(
  token: VerifiedScimToken,
  filter: { attribute: 'userName' | 'externalId'; value: string } | null,
  page: { startIndex: number; count: number },
): Promise<{ total: number; records: ScimUserRecord[] }> {
  assertNoHeldContext('listScimUsers');
  const match = !filter
    ? undefined
    : filter.attribute === 'userName'
      ? sql`lower(${portalUserIdentities.scimUserName}) = lower(${filter.value})`
      : eq(portalUserIdentities.subject, filter.value.trim().toLowerCase());
  const where = match ? and(scimVisible(token), match) : scimVisible(token);
  return withSystemDbAccessContext(async () => {
    const [counted] = await db.select({ n: count() }).from(portalUserIdentities).where(where);
    const rows = page.count === 0
      ? []
      : await db
        .select(recordColumns)
        .from(portalUserIdentities)
        .where(where)
        .orderBy(asc(portalUserIdentities.scimProvisionedAt), asc(portalUserIdentities.id))
        .limit(page.count)
        .offset(page.startIndex - 1);
    return { total: Number(counted?.n ?? 0), records: rows.map(toRecord) };
  }, 'portalScim.listUsers');
}

// ---------------------------------------------------------------------------
// Shared write steps
// ---------------------------------------------------------------------------

interface LockedAccount {
  id: string;
  status: string;
  browserAccess: string;
  authMethod: string;
  passwordHash: string | null;
  email: string;
  name: string | null;
  disabledBy: string | null;
}

interface LockedIdentity extends RecordRow { portalUserId: string; linkedVia: string }

async function lockAccount(orgId: string, portalUserId: string): Promise<LockedAccount | null> {
  const [row] = await db
    .select({
      id: portalUsers.id,
      status: portalUsers.status,
      browserAccess: portalUsers.browserAccess,
      authMethod: portalUsers.authMethod,
      passwordHash: portalUsers.passwordHash,
      email: portalUsers.email,
      name: portalUsers.name,
      disabledBy: portalUsers.disabledBy,
    })
    .from(portalUsers)
    .where(and(eq(portalUsers.id, portalUserId), eq(portalUsers.orgId, orgId)))
    .for('update')
    .limit(1);
  return row ?? null;
}

async function lockIdentity(where: SQL): Promise<LockedIdentity | null> {
  const [row] = await db
    .select({ ...recordColumns, portalUserId: portalUserIdentities.portalUserId, linkedVia: portalUserIdentities.linkedVia })
    .from(portalUserIdentities)
    .where(where)
    .for('update')
    .limit(1);
  return row ?? null;
}

/** D3: userName is unique among the token's visible resources (case-insensitive), checked under the address lock. */
async function assertUserNameFree(token: VerifiedScimToken, userName: string, exceptIdentityId: string | null, externalId: string | null): Promise<void> {
  const [taken] = await db
    .select({ id: portalUserIdentities.id })
    .from(portalUserIdentities)
    .where(and(
      scimVisible(token),
      sql`lower(${portalUserIdentities.scimUserName}) = lower(${userName})`,
      ...(exceptIdentityId ? [ne(portalUserIdentities.id, exceptIdentityId)] : []),
    ))
    .limit(1);
  if (taken) throw new ScimConflict('user_name_taken', 'Another provisioned user already has this userName.', externalId);
}

type Desired = Pick<ScimUserAttrs, 'userName' | 'displayName' | 'givenName' | 'familyName'>;

/**
 * D5: write the SCIM attributes, the portal account's name, and its login
 * address when the account is identity-only and no other account in the org
 * is at the new address. Returns the names of the attributes that changed.
 */
async function writeAttributes(
  token: VerifiedScimToken,
  account: LockedAccount,
  identity: LockedIdentity,
  next: Desired,
  opts: { force: boolean; now: Date },
): Promise<{ changed: string[]; emailKept: boolean }> {
  const changed: string[] = [];
  if (opts.force || next.userName !== identity.scimUserName) changed.push('userName');
  if (opts.force || next.displayName !== identity.scimDisplayName) changed.push('displayName');
  if (opts.force || next.givenName !== identity.scimGivenName) changed.push('name.givenName');
  if (opts.force || next.familyName !== identity.scimFamilyName) changed.push('name.familyName');
  if (changed.length > 0) {
    await db
      .update(portalUserIdentities)
      .set({
        scimUserName: next.userName,
        scimDisplayName: next.displayName,
        scimGivenName: next.givenName,
        scimFamilyName: next.familyName,
      })
      .where(and(eq(portalUserIdentities.id, identity.id), eq(portalUserIdentities.orgId, token.orgId)));
  }

  const accountSet: { name?: string; email?: string } = {};
  const name = portalNameFrom(next);
  if (name && name !== account.name) accountSet.name = name;

  let emailKept = false;
  const address = next.userName.toLowerCase();
  // The login address follows userName only on an account SCIM itself created (identity
  // linked_via 'scim', identity-only). A password-eligible account, and an account SCIM
  // adopted, never has its address changed by a directory push (security review).
  if (identity.linkedVia === 'scim' && account.authMethod !== 'password' && account.email.toLowerCase() !== address) {
    const [other] = await db
      .select({ id: portalUsers.id })
      .from(portalUsers)
      .where(and(eq(portalUsers.orgId, token.orgId), sql`lower(${portalUsers.email}) = ${address}`, ne(portalUsers.id, account.id)))
      .limit(1);
    if (other) emailKept = true;
    else accountSet.email = address;
  }
  if (accountSet.name !== undefined || accountSet.email !== undefined) {
    await db
      .update(portalUsers)
      .set({ ...accountSet, updatedAt: opts.now })
      .where(and(eq(portalUsers.id, account.id), eq(portalUsers.orgId, token.orgId)));
  }
  return { changed, emailKept };
}

/** D6: apply SCIM's `active` inside the caller's transaction; true when sessions must be purged after commit. */
async function applyActive(token: VerifiedScimToken, identity: LockedIdentity, active: boolean | undefined, now: Date): Promise<boolean> {
  if (active === undefined) return false;
  const blocked = identity.disabledBlockers.includes('scim');
  if (!active && !blocked) {
    const disabled = await disableIdentityInTransaction({
      orgId: token.orgId,
      identityId: identity.id,
      blocker: 'scim',
      reason: 'scim_deactivated',
      auditDetails: { via: 'scim', scimTokenId: token.tokenId },
      now,
    });
    return disabled.purge;
  }
  if (active && blocked) {
    await liftScimBlockerInTransaction({ orgId: token.orgId, identityId: identity.id, scimTokenId: token.tokenId, now });
  }
  return false;
}

/**
 * The shared frame of PATCH / PUT / DELETE: one system transaction, the lock
 * order above, the D2 re-check, then `work`. Purges after commit.
 */
async function mutateVisible<T>(
  token: VerifiedScimToken,
  identityId: string,
  userNameToLock: string | null,
  label: string,
  work: (account: LockedAccount, identity: LockedIdentity, now: Date) => Promise<{ value: T; purge: boolean }>,
): Promise<T> {
  assertNoHeldContext(label);
  if (!UUID_RE.test(identityId)) throw notFound();
  const now = new Date();
  const out = await withSystemDbAccessContext(async () => {
    await lockPortalDirectorySource(token.orgId, 'entra');
    if (userNameToLock) await lockPortalInviteAddresses(db, token.orgId, [userNameToLock.toLowerCase()]);
    const [owner] = await db
      .select({ portalUserId: portalUserIdentities.portalUserId })
      .from(portalUserIdentities)
      .where(and(scimVisible(token), eq(portalUserIdentities.id, identityId)))
      .limit(1);
    if (!owner) throw notFound();
    const account = await lockAccount(token.orgId, owner.portalUserId);
    // Re-validated on the locked row: still this org, tenant, account, managed, not deleted.
    const identity = await lockIdentity(and(scimVisible(token), eq(portalUserIdentities.id, identityId), eq(portalUserIdentities.portalUserId, owner.portalUserId))!);
    if (!account || !identity) throw notFound();
    if (!(await lockLiveScimToken(token))) throw unauthorized();
    const result = await work(account, identity, now);
    return { ...result, portalUserId: account.id };
  }, label);
  if (out.purge) await purgeIdentitySessions(out.portalUserId, now);
  return out.value;
}

async function updateVisible(
  token: VerifiedScimToken,
  identityId: string,
  resolve: (identity: LockedIdentity) => { next: Desired; active: boolean | undefined },
  userNameToLock: string | null,
  label: string,
): Promise<ScimUserRecord> {
  return withConflictAudit(token, () => mutateVisible(token, identityId, userNameToLock, label, async (account, identity, now) => {
    const { next, active } = resolve(identity);
    if (next.userName !== identity.scimUserName) await assertUserNameFree(token, next.userName, identity.id, identity.subject);
    const { changed, emailKept } = await writeAttributes(token, account, identity, next, { force: false, now });
    const purge = await applyActive(token, identity, active, now);
    if (changed.length > 0) {
      await insertScimAudit(token, AUDIT_SCIM_USER_UPDATE, account.id, { identityId: identity.id, changed, emailKept });
    }
    const record = await readVisible(token, identity.id);
    if (!record) throw notFound();
    return { value: record, purge };
  }));
}

// ---------------------------------------------------------------------------
// PATCH / PUT / DELETE
// ---------------------------------------------------------------------------

export async function patchScimUser(token: VerifiedScimToken, identityId: string, patch: ScimUserPatch): Promise<ScimUserRecord> {
  return updateVisible(token, identityId, (identity) => {
    if (patch.externalId !== undefined && patch.externalId !== identity.subject) {
      throw new ScimError(400, 'externalId is immutable.', 'mutability');
    }
    return {
      next: {
        userName: patch.userName ?? identity.scimUserName ?? '',
        displayName: patch.displayName !== undefined ? patch.displayName : identity.scimDisplayName,
        givenName: patch.givenName !== undefined ? patch.givenName : identity.scimGivenName,
        familyName: patch.familyName !== undefined ? patch.familyName : identity.scimFamilyName,
      },
      active: patch.active,
    };
  }, patch.userName ?? null, 'portalScim.patchUser');
}

export async function replaceScimUser(token: VerifiedScimToken, identityId: string, attrs: ScimReplaceAttrs): Promise<ScimUserRecord> {
  return updateVisible(token, identityId, (identity) => {
    if (attrs.externalId !== identity.subject) throw new ScimError(400, 'externalId is immutable.', 'mutability');
    return {
      next: { userName: attrs.userName, displayName: attrs.displayName, givenName: attrs.givenName, familyName: attrs.familyName },
      active: attrs.active,
    };
  }, attrs.userName, 'portalScim.replaceUser');
}

/**
 * D7: the SCIM disable AND the tombstone in one transaction, so a concurrent
 * `active: true` can never leave a deleted-but-enabled identity. The identity
 * stays (it keeps `(issuer, subject)` reserved); a later POST adopts it.
 */
export async function deleteScimUser(token: VerifiedScimToken, identityId: string): Promise<void> {
  await mutateVisible(token, identityId, null, 'portalScim.deleteUser', async (account, identity, now) => {
    const purge = await applyActive(token, identity, false, now);
    await db
      .update(portalUserIdentities)
      .set({ scimDeletedAt: now })
      .where(and(eq(portalUserIdentities.id, identity.id), eq(portalUserIdentities.orgId, token.orgId)));
    await insertScimAudit(token, AUDIT_SCIM_USER_DELETE, account.id, { identityId: identity.id });
    return { value: undefined, purge };
  });
}

// ---------------------------------------------------------------------------
// POST (D4)
// ---------------------------------------------------------------------------

/**
 * POST /Users. Finds an existing account ONLY by `(issuer, externalId)`:
 *  1. that identity in this org → 409 when SCIM already manages it, else adopt;
 *  2. in another org (or the legacy `entra_*` key elsewhere) → 409;
 *  3. another resource has the userName → 409;
 *  4. any account in this org at the userName address → 409 (never link by email);
 *  5. else an identity-only account, `linked_via = 'scim'`, no contact link.
 */
export async function createScimUser(token: VerifiedScimToken, attrs: ScimUserAttrs): Promise<{ record: ScimUserRecord; adopted: boolean }> {
  assertNoHeldContext('createScimUser');
  const now = new Date();
  const address = attrs.userName.toLowerCase();

  return withConflictAudit(token, async () => {
    const out = await withSystemDbAccessContext(async () => {
      await lockPortalDirectorySource(token.orgId, 'entra');
      await lockPortalInviteAddresses(db, token.orgId, [address]);
      if (!(await lockLiveScimToken(token))) throw unauthorized();

      // System scope: sees the identity in ANY org, so a cross-org holder is refused here.
      const [existing] = await db
        .select({ id: portalUserIdentities.id, orgId: portalUserIdentities.orgId, portalUserId: portalUserIdentities.portalUserId })
        .from(portalUserIdentities)
        .where(and(eq(portalUserIdentities.issuer, token.issuer), eq(portalUserIdentities.subject, attrs.externalId)))
        .limit(1);
      if (existing && existing.orgId !== token.orgId) {
        throw new ScimConflict('external_id_other_org', 'This externalId is already provisioned elsewhere.', attrs.externalId);
      }

      if (existing) return adopt(token, attrs, existing, now);

      await assertUserNameFree(token, attrs.userName, null, attrs.externalId);
      const created = await createIdentityOnlyAccount(db, {
        orgId: token.orgId,
        provider: 'entra',
        tid: token.tenantId,
        oid: attrs.externalId,
        email: address,
        name: portalNameFrom(attrs),
        // Quorum D4 / OD1: a SCIM userName is not a verified claim; no contact link.
        contactAddress: null,
        actorUserId: null,
        writer: attrs.active ? 'scim_provision' : 'scim_provision_inactive',
        scim: { userName: attrs.userName, displayName: attrs.displayName, givenName: attrs.givenName, familyName: attrs.familyName },
        now,
      });
      if (created.kind === 'account_exists') {
        throw new ScimConflict(
          'address_has_account',
          'A portal account with this address already exists. Ask the IT provider to send it a Microsoft sign-in invite.',
          attrs.externalId,
        );
      }
      if (created.kind === 'identity_linked') {
        // Taken in an org this transaction cannot match (or the legacy key): roll everything back.
        throw new ScimConflict('external_id_other_org', 'This externalId is already provisioned elsewhere.', attrs.externalId);
      }
      await insertScimAudit(token, AUDIT_SCIM_USER_CREATE, created.portalUserId, { identityId: created.identityId, active: attrs.active });
      const record = await readVisible(token, created.identityId);
      if (!record) throw new Error('createScimUser: the created identity is not visible to its own token');
      return { record, adopted: false, purge: false, portalUserId: created.portalUserId };
    }, 'portalScim.createUser');
    if (out.purge) await purgeIdentitySessions(out.portalUserId, now);
    return { record: out.record, adopted: out.adopted };
  });
}

/** D4.1: SCIM takes over an identity of this person that already exists in this org. */
async function adopt(
  token: VerifiedScimToken,
  attrs: ScimUserAttrs,
  existing: { id: string; portalUserId: string },
  now: Date,
): Promise<{ record: ScimUserRecord; adopted: true; purge: boolean; portalUserId: string }> {
  const account = await lockAccount(token.orgId, existing.portalUserId);
  const identity = await lockIdentity(and(
    eq(portalUserIdentities.id, existing.id),
    eq(portalUserIdentities.orgId, token.orgId),
    eq(portalUserIdentities.issuer, token.issuer),
    eq(portalUserIdentities.portalUserId, existing.portalUserId),
  )!);
  if (!account || !identity) throw notFound();
  const managed = await db
    .select({ id: portalUserIdentities.id })
    .from(portalUserIdentities)
    .where(and(scimVisible(token), eq(portalUserIdentities.id, identity.id)))
    .limit(1);
  if (managed.length > 0) {
    throw new ScimConflict('external_id_taken', 'A provisioned user with this externalId already exists.', attrs.externalId);
  }
  await assertUserNameFree(token, attrs.userName, identity.id, attrs.externalId);

  await db
    .update(portalUserIdentities)
    .set({ scimProvisionedAt: now, scimDeletedAt: null })
    .where(and(eq(portalUserIdentities.id, identity.id), eq(portalUserIdentities.orgId, token.orgId)));
  const { emailKept } = await writeAttributes(token, account, identity, attrs, { force: true, now });

  // Spec §5.1: SCIM is a browser-access grant path. An add-in account the
  // directory assigns to the portal gets browser access (no epoch bump).
  let browserGranted = false;
  if (attrs.active && account.status === 'active' && account.browserAccess === 'none') {
    const target = planPortalAccountTransition({
      status: account.status,
      browserAccess: account.browserAccess,
      authMethod: account.authMethod,
      hasPasswordHash: Boolean(account.passwordHash),
      hasExternalIdentity: true,
    }, 'scim_grant_browser_access');
    await db
      .update(portalUsers)
      .set({ status: target.status, browserAccess: target.browserAccess, updatedAt: now })
      .where(and(eq(portalUsers.id, account.id), eq(portalUsers.orgId, token.orgId)));
    browserGranted = true;
  }

  const purge = await applyActive(token, identity, attrs.active, now);
  await insertScimAudit(token, AUDIT_SCIM_USER_ADOPT, account.id, { identityId: identity.id, active: attrs.active, browserGranted, emailKept });
  const record = await readVisible(token, identity.id);
  if (!record) throw new Error('createScimUser: the adopted identity is not visible to its own token');
  return { record, adopted: true, purge, portalUserId: account.id };
}

// ---------------------------------------------------------------------------
// MSP summary (D11)
// ---------------------------------------------------------------------------

/** SCIM-managed resources of the org (any tenant): provisioned and how many SCIM deactivated. */
export async function countPortalScimUsers(orgId: string): Promise<{ provisioned: number; deactivated: number }> {
  assertNoHeldContext('countPortalScimUsers');
  if (!UUID_RE.test(orgId)) return { provisioned: 0, deactivated: 0 };
  const [row] = await withSystemDbAccessContext(
    () => db
      .select({
        provisioned: count(),
        deactivated: sql<number>`count(*) FILTER (WHERE 'scim' = ANY(${portalUserIdentities.disabledBlockers}))::int`,
      })
      .from(portalUserIdentities)
      .where(and(
        eq(portalUserIdentities.orgId, orgId),
        isNotNull(portalUserIdentities.scimProvisionedAt),
        isNull(portalUserIdentities.scimDeletedAt),
      )),
    'portalScim.countUsers',
  );
  return { provisioned: Number(row?.provisioned ?? 0), deactivated: Number(row?.deactivated ?? 0) };
}
