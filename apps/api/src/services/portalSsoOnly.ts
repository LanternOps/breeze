import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  type PortalAccessPolicyField,
  type PortalAccessPolicyRowValues,
  type PortalSignInCapabilities,
} from '@breeze/shared';
import { db, withDbTransactionIfHeld } from '../db';
import { clientAiTenantMappings, organizations, portalAccessPolicies, portalUsers } from '../db/schema';
import {
  getPortalSignInCapabilities,
  isSignInMethodAllowed,
  pickEffectivePortalAccessPolicy,
  resolvePortalAccessPolicy,
  toPortalAccessPolicyRowValues,
} from './portalAccessPolicy';
import { portalUserHasIdentitySql } from './portalUserIdentities';

/**
 * `password_mode = sso_only` as a complete save flow (portal registration W4
 * #11381, plan D12; spec §5.11, inv. 11).
 *
 * - {@link computeSsoOnlyFlips}: which orgs a policy save would move from
 *   effective `allowed` to effective `sso_only`, with what it costs each one
 *   (the preview; reads only, no lock).
 * - {@link lockSsoOnlyImpact}: the same impact on the save's own transaction,
 *   computed from the candidate account rows it has locked `FOR UPDATE`, with
 *   the ids it may clear.
 * - {@link ssoOnlyImpactDigest}: the acknowledgement the save must carry, so
 *   neither a script nor a stale dialog clears hashes the MSP never saw.
 * - {@link clearPasswordsForSsoOnly}: on the save's own transaction, drops the
 *   hash and bumps the epoch of exactly the locked accounts that had a hash
 *   AND an identity when the impact was taken.
 * - {@link listSsoOnlyStranded}: the accounts with no identity, which keep their
 *   hash and cannot sign in until they link or are re-invited.
 *
 * Why the lock: a self-link inserts an identity (its FK check takes `FOR KEY
 * SHARE` on the account row; accountResolution also locks the row first) and
 * does not bump `auth_epoch`. Without the lock, a link committing between the
 * impact and the clear would have its hash cleared although the MSP
 * acknowledged that account as stranded. With it, such a link waits for the
 * save to commit, and the rows written are the rows counted.
 *
 * Only a policy SAVE clears (portalAccessPolicyWrites.ts). A flip caused by a
 * tenant proof or a deploy-time capability change clears nothing: W3's refusal
 * at use is the control there (inv. 11), and the Entra sign-in sheds hashes
 * lazily (D12).
 *
 * Every read and write runs under the CALLER'S DB context, never a system one:
 * the impact must be computed over exactly the rows the save can clear, and the
 * clear must commit in the same transaction as the policy upsert. For a partner
 * save that is every org the full-partner admin can reach (the partner-wide
 * write gate, canManagePartnerWidePolicies, admits only `orgAccess = 'all'`):
 * the partner's active/trial orgs. A suspended org is outside that context, so
 * it is neither counted nor cleared; its accounts are still refused password
 * sign-in at use, and shed their hash on their next Microsoft sign-in.
 *
 * No `status` / `browser_access` write: __tests__/portalAccountWriters.contract.test.ts
 * classifies this file `no-state`.
 */

export interface SsoOnlyOrgImpact { orgId: string; orgName: string; passwordsToClear: number; strandedTotal: number }
export interface StrandedPortalAccount { portalUserId: string; email: string; name: string | null; status: 'active' | 'invited' }

export type SsoOnlyPolicyOwner =
  | { kind: 'org'; orgId: string; partnerId: string }
  | { kind: 'partner'; partnerId: string };

/** `db` or a transaction handle (same shape as `IdentityExecutor`, services/portalUserIdentities.ts). */
export type DbTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

type PolicyPatch = Partial<PortalAccessPolicyRowValues>;

/** The only fields that can move an effective `passwordMode`. Any other patch flips nothing. */
const SSO_ONLY_INPUT_FIELDS: readonly PortalAccessPolicyField[] = ['entraEnabled', 'googleEnabled', 'passwordMode'];

const BLANK_ROW: PortalAccessPolicyRowValues = Object.freeze<PortalAccessPolicyRowValues>({
  entraEnabled: null,
  googleEnabled: null,
  passwordMode: null,
  selfRegistrationMode: null,
  ssoNewPersonMode: null,
  ssoSessionMaxHours: null,
});

const STRANDED_LIST_LIMIT = 200;

/** Ids per clear statement: one bind parameter each, far under Postgres's 65535. */
const CLEAR_BATCH_SIZE = 5000;

/** `undefined` = untouched; `null` = clear (inherit / built-in default). */
function definedOnly(patch: PolicyPatch): PolicyPatch {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as PolicyPatch;
}

/** Inputs for one org: its own row, and whether its Entra tenant is proven (W4 D2). */
export interface SsoOnlyFlipCandidate {
  orgId: string;
  orgName: string;
  orgRow: PortalAccessPolicyRowValues | null;
  entraTenantProven: boolean;
}

/**
 * Pure: the candidates whose effective passwordMode goes `allowed` → `sso_only`
 * when `patch` lands on `owner`'s row. Picked before and after with each org's
 * own facts, so an unproven org (Microsoft masked) or a deployment without the
 * capability flips nothing — exactly what the resolver will do at use.
 */
export function selectSsoOnlyFlips(
  owner: SsoOnlyPolicyOwner,
  patch: PolicyPatch,
  partnerRow: PortalAccessPolicyRowValues | null,
  candidates: SsoOnlyFlipCandidate[],
  caps: PortalSignInCapabilities,
): SsoOnlyFlipCandidate[] {
  const delta = definedOnly(patch);
  return candidates.filter((c) => {
    const facts = { entraTenantProven: c.entraTenantProven };
    const before = pickEffectivePortalAccessPolicy(c.orgRow, partnerRow, caps, facts);
    const after = owner.kind === 'org'
      ? pickEffectivePortalAccessPolicy({ ...(c.orgRow ?? BLANK_ROW), ...delta }, partnerRow, caps, facts)
      : pickEffectivePortalAccessPolicy(c.orgRow, { ...(partnerRow ?? BLANK_ROW), ...delta }, caps, facts);
    return before.effective.passwordMode.value === 'allowed' && after.effective.passwordMode.value === 'sso_only';
  });
}

/** Password-eligible, browser-granted, not disabled, and no external identity. */
export function isSsoOnlyStranded(facts: {
  status: string;
  browserAccess: string;
  authMethod: string;
  hasExternalIdentity: boolean;
}): boolean {
  return (facts.status === 'active' || facts.status === 'invited')
    && facts.browserAccess === 'granted'
    && facts.authMethod === 'password'
    && !facts.hasExternalIdentity;
}

/** SQL twin of {@link isSsoOnlyStranded} over the outer `portal_users` row. */
function strandedWhere(): SQL {
  return and(
    inArray(portalUsers.status, ['active', 'invited']),
    eq(portalUsers.browserAccess, 'granted'),
    eq(portalUsers.authMethod, 'password'),
    sql`not ${portalUserHasIdentitySql()}`,
  )!;
}

/** The accounts a save clears: a hash to drop and an identity to sign in with instead. */
function clearableWhere(): SQL {
  return and(isNotNull(portalUsers.passwordHash), portalUserHasIdentitySql())!;
}

/**
 * Every row that {@link clearableWhere} or {@link strandedWhere} can count,
 * whatever its identity: any row with a hash, and every active/invited,
 * browser-granted, password-eligible row. Identity-blind on purpose, so a
 * link cannot move a row into or out of the save's lock set.
 */
function impactCandidateWhere(): SQL {
  return or(
    isNotNull(portalUsers.passwordHash),
    and(
      inArray(portalUsers.status, ['active', 'invited']),
      eq(portalUsers.browserAccess, 'granted'),
      eq(portalUsers.authMethod, 'password'),
    ),
  )!;
}

interface FlippedOrg { orgId: string; orgName: string }
interface OrgCounts { passwordsToClear: number; strandedTotal: number }

/** The impacts, sorted by name, then id; an org with no counted rows reports zeros. */
function toImpacts(flipped: FlippedOrg[], countsByOrg: Map<string, OrgCounts>): SsoOnlyOrgImpact[] {
  return flipped
    .map((f) => ({
      orgId: f.orgId,
      orgName: f.orgName,
      passwordsToClear: countsByOrg.get(f.orgId)?.passwordsToClear ?? 0,
      strandedTotal: countsByOrg.get(f.orgId)?.strandedTotal ?? 0,
    }))
    .sort((a, b) => a.orgName.localeCompare(b.orgName) || compareIds(a.orgId, b.orgId));
}

/**
 * Orgs whose effective passwordMode goes allowed → sso_only if `patch` is
 * applied to `owner` (picked before/after with each org's facts), with the
 * number of hashes the save would clear and the number of stranded accounts.
 * Sorted by name, then id. Runs under the caller's context (see the header).
 *
 * The preview: no lock. The save recomputes it with {@link lockSsoOnlyImpact},
 * which counts the same predicates over the rows it locked.
 */
export async function computeSsoOnlyFlips(owner: SsoOnlyPolicyOwner, patch: PolicyPatch): Promise<SsoOnlyOrgImpact[]> {
  const flipped = await selectFlippedOrgs(owner, patch);
  if (flipped.length === 0) return [];

  const counts = await db.select({
    orgId: portalUsers.orgId,
    passwordsToClear: sql<number>`(count(*) filter (where ${clearableWhere()}))::int`,
    strandedTotal: sql<number>`(count(*) filter (where ${strandedWhere()}))::int`,
  }).from(portalUsers)
    .where(inArray(portalUsers.orgId, flipped.map((f) => f.orgId)))
    .groupBy(portalUsers.orgId);
  return toImpacts(flipped, new Map(counts.map((c): [string, OrgCounts] => [c.orgId, {
    passwordsToClear: Number(c.passwordsToClear),
    strandedTotal: Number(c.strandedTotal),
  }])));
}

export interface LockedSsoOnlyImpact {
  /** Same shape and order as {@link computeSsoOnlyFlips}; the digest is taken over these. */
  flips: SsoOnlyOrgImpact[];
  /** The locked rows that had a hash and an identity: exactly what the save may clear. */
  clearableUserIds: string[];
}

/**
 * The save's impact (D12), on the caller's transaction, from rows it holds:
 *  1. lock every candidate row of the flipped orgs ({@link impactCandidateWhere})
 *     `FOR UPDATE`, ordered by id so concurrent saves lock in one order. Only
 *     those rows, never the table;
 *  2. in a SEPARATE statement, read hash and identity for them. Under READ
 *     COMMITTED it takes a fresh snapshot, so a link that committed while step 1
 *     waited is seen; a link that starts later waits on the lock until the save
 *     commits (its identity insert's FK check needs `FOR KEY SHARE` on the row);
 *  3. count only locked rows (one inserted after step 1 was never seen).
 *
 * The caller compares the digest of `flips` with the acknowledgement, then
 * hands `clearableUserIds` to {@link clearPasswordsForSsoOnly}. A refusal rolls
 * the caller's savepoint back, which releases the locks.
 */
export async function lockSsoOnlyImpact(owner: SsoOnlyPolicyOwner, patch: PolicyPatch): Promise<LockedSsoOnlyImpact> {
  const flipped = await selectFlippedOrgs(owner, patch);
  if (flipped.length === 0) return { flips: [], clearableUserIds: [] };

  const candidates = and(inArray(portalUsers.orgId, flipped.map((f) => f.orgId)), impactCandidateWhere());
  const locked = await db.select({ id: portalUsers.id })
    .from(portalUsers)
    .where(candidates)
    .orderBy(asc(portalUsers.id))
    .for('update');

  const countsByOrg = new Map<string, OrgCounts>();
  const clearableUserIds: string[] = [];
  if (locked.length > 0) {
    const lockedIds = new Set(locked.map((r) => r.id));
    const facts = await db.select({
      id: portalUsers.id,
      orgId: portalUsers.orgId,
      clearable: sql<boolean>`${clearableWhere()}`,
      stranded: sql<boolean>`${strandedWhere()}`,
    }).from(portalUsers)
      .where(candidates)
      .orderBy(asc(portalUsers.id));
    for (const f of facts) {
      if (!lockedIds.has(f.id)) continue;
      const counts = countsByOrg.get(f.orgId) ?? { passwordsToClear: 0, strandedTotal: 0 };
      if (f.clearable) {
        counts.passwordsToClear += 1;
        clearableUserIds.push(f.id);
      }
      if (f.stranded) counts.strandedTotal += 1;
      countsByOrg.set(f.orgId, counts);
    }
  }
  return { flips: toImpacts(flipped, countsByOrg), clearableUserIds };
}

/**
 * The orgs a save of `patch` on `owner` moves from effective `allowed` to
 * effective `sso_only`, with their names. Shared by the preview and the save.
 */
async function selectFlippedOrgs(owner: SsoOnlyPolicyOwner, patch: PolicyPatch): Promise<FlippedOrg[]> {
  const delta = definedOnly(patch);
  if (!SSO_ONLY_INPUT_FIELDS.some((f) => f in delta)) return [];
  const caps = getPortalSignInCapabilities();
  // Neither SSO method can run here: nothing can become effectively sso_only.
  if (!caps.entra && !caps.google) return [];

  const orgs = await db.select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(owner.kind === 'org'
      ? eq(organizations.id, owner.orgId)
      : and(eq(organizations.partnerId, owner.partnerId), isNull(organizations.deletedAt)));
  if (orgs.length === 0) return [];
  const orgIds = orgs.map((o) => o.id);

  // Every org override in scope plus the partner default, in one read.
  const policyRows = await db.select({
    orgId: portalAccessPolicies.orgId,
    partnerId: portalAccessPolicies.partnerId,
    entraEnabled: portalAccessPolicies.entraEnabled,
    googleEnabled: portalAccessPolicies.googleEnabled,
    passwordMode: portalAccessPolicies.passwordMode,
    selfRegistrationMode: portalAccessPolicies.selfRegistrationMode,
    ssoNewPersonMode: portalAccessPolicies.ssoNewPersonMode,
    ssoSessionMaxHours: portalAccessPolicies.ssoSessionMaxHours,
  }).from(portalAccessPolicies)
    .where(or(
      inArray(portalAccessPolicies.orgId, orgIds),
      and(isNull(portalAccessPolicies.orgId), eq(portalAccessPolicies.partnerId, owner.partnerId)),
    ));
  const partnerRaw = policyRows.find((r) => r.orgId === null && r.partnerId === owner.partnerId);
  const partnerRow = partnerRaw ? toPortalAccessPolicyRowValues(partnerRaw) : null;
  const orgRowById = new Map(policyRows.filter((r) => r.orgId !== null)
    .map((r): [string, PortalAccessPolicyRowValues] => [r.orgId as string, toPortalAccessPolicyRowValues(r)]));

  const proven = await db.select({ orgId: clientAiTenantMappings.orgId })
    .from(clientAiTenantMappings)
    .where(and(inArray(clientAiTenantMappings.orgId, orgIds), isNotNull(clientAiTenantMappings.provenAt)));
  const provenOrgIds = new Set(proven.map((p) => p.orgId));

  return selectSsoOnlyFlips(owner, delta, partnerRow, orgs.map((o) => ({
    orgId: o.id,
    orgName: o.name,
    orgRow: orgRowById.get(o.id) ?? null,
    entraTenantProven: provenOrgIds.has(o.id),
  })), caps).map((f) => ({ orgId: f.orgId, orgName: f.orgName }));
}

function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** status IN (active, invited), browser granted, password-eligible, no identity. */
export async function listSsoOnlyStranded(
  orgId: string,
  limit: number = STRANDED_LIST_LIMIT,
): Promise<{ items: StrandedPortalAccount[]; total: number }> {
  const where = and(eq(portalUsers.orgId, orgId), strandedWhere());
  const items = await db.select({
    portalUserId: portalUsers.id,
    email: portalUsers.email,
    name: portalUsers.name,
    status: portalUsers.status,
  }).from(portalUsers)
    .where(where)
    .orderBy(asc(portalUsers.email), asc(portalUsers.id))
    .limit(limit);
  const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(portalUsers).where(where);
  return {
    items: items.map((i) => ({ ...i, status: i.status as StrandedPortalAccount['status'] })),
    total: Number(count?.total ?? 0),
  };
}

/**
 * On the caller's transaction: password_hash = NULL, auth_epoch + 1 WHERE
 * id = ANY(portalUserIds), the `clearableUserIds` of {@link lockSsoOnlyImpact}
 * on that same transaction. Nothing is re-selected: the rows are still locked,
 * so the rows written are the rows the acknowledged impact counted.
 * The epoch bump kills password sessions and outstanding reset/invite tokens
 * (inv. 11); the caller purges the cached sessions after commit (cleanup).
 */
export async function clearPasswordsForSsoOnly(
  tx: DbTx,
  input: { portalUserIds: string[] },
): Promise<{ clearedUserIds: string[] }> {
  const clearedUserIds: string[] = [];
  const now = new Date();
  for (let i = 0; i < input.portalUserIds.length; i += CLEAR_BATCH_SIZE) {
    const cleared = await tx.update(portalUsers)
      .set({ passwordHash: null, authEpoch: sql`${portalUsers.authEpoch} + 1`, updatedAt: now })
      .where(inArray(portalUsers.id, input.portalUserIds.slice(i, i + CLEAR_BATCH_SIZE)))
      .returning({ id: portalUsers.id });
    clearedUserIds.push(...cleared.map((r) => r.id));
  }
  return { clearedUserIds };
}

/** sha256 hex over the flips sorted by orgId as `${orgId}:${passwordsToClear}:${strandedTotal}` lines (D12). */
export function ssoOnlyImpactDigest(flips: SsoOnlyOrgImpact[]): string {
  const lines = [...flips]
    .sort((a, b) => compareIds(a.orgId, b.orgId))
    .map((f) => `${f.orgId}:${f.passwordsToClear}:${f.strandedTotal}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Which sign-in methods an invite email offers (spec §5.5): Microsoft when it is
 * effective for the org, a password when password sign-in is allowed. Read in a
 * savepoint of the held context, so a caller that catches a failure here leaves
 * its own transaction usable (#11203).
 */
export async function resolveInviteSignInMethods(orgId: string): Promise<{ microsoft: boolean; password: boolean }> {
  const policy = await withDbTransactionIfHeld(() => resolvePortalAccessPolicy(orgId));
  return { microsoft: isSignInMethodAllowed(policy, 'entra'), password: isSignInMethodAllowed(policy, 'password') };
}
