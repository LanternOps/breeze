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
 *   effective `allowed` to effective `sso_only`, with what it costs each one.
 * - {@link ssoOnlyImpactDigest}: the acknowledgement the save must carry, so
 *   neither a script nor a stale dialog clears hashes the MSP never saw.
 * - {@link clearPasswordsForSsoOnly}: on the save's own transaction, drops the
 *   hash and bumps the epoch of every flipped-org account that HAS an identity.
 * - {@link listSsoOnlyStranded}: the accounts with no identity, which keep their
 *   hash and cannot sign in until they link or are re-invited.
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
 * Orgs whose effective passwordMode goes allowed → sso_only if `patch` is
 * applied to `owner` (picked before/after with each org's facts), with the
 * number of hashes the save would clear and the number of stranded accounts.
 * Sorted by name, then id. Runs under the caller's context (see the header).
 */
export async function computeSsoOnlyFlips(owner: SsoOnlyPolicyOwner, patch: PolicyPatch): Promise<SsoOnlyOrgImpact[]> {
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

  const flipped = selectSsoOnlyFlips(owner, delta, partnerRow, orgs.map((o) => ({
    orgId: o.id,
    orgName: o.name,
    orgRow: orgRowById.get(o.id) ?? null,
    entraTenantProven: provenOrgIds.has(o.id),
  })), caps);
  if (flipped.length === 0) return [];

  const counts = await db.select({
    orgId: portalUsers.orgId,
    passwordsToClear: sql<number>`(count(*) filter (where ${clearableWhere()}))::int`,
    strandedTotal: sql<number>`(count(*) filter (where ${strandedWhere()}))::int`,
  }).from(portalUsers)
    .where(inArray(portalUsers.orgId, flipped.map((f) => f.orgId)))
    .groupBy(portalUsers.orgId);
  const countsByOrg = new Map(counts.map((c): [string, (typeof counts)[number]] => [c.orgId, c]));

  return flipped
    .map((f) => ({
      orgId: f.orgId,
      orgName: f.orgName,
      passwordsToClear: Number(countsByOrg.get(f.orgId)?.passwordsToClear ?? 0),
      strandedTotal: Number(countsByOrg.get(f.orgId)?.strandedTotal ?? 0),
    }))
    .sort((a, b) => a.orgName.localeCompare(b.orgName) || compareIds(a.orgId, b.orgId));
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
 * org_id = ANY(orgIds) AND password_hash IS NOT NULL AND an identity exists.
 * The epoch bump kills password sessions and outstanding reset/invite tokens
 * (inv. 11); the caller purges the cached sessions after commit (cleanup).
 */
export async function clearPasswordsForSsoOnly(tx: DbTx, orgIds: string[]): Promise<{ clearedUserIds: string[] }> {
  if (orgIds.length === 0) return { clearedUserIds: [] };
  const cleared = await tx.update(portalUsers)
    .set({ passwordHash: null, authEpoch: sql`${portalUsers.authEpoch} + 1`, updatedAt: new Date() })
    .where(and(inArray(portalUsers.orgId, orgIds), clearableWhere()))
    .returning({ id: portalUsers.id });
  return { clearedUserIds: cleared.map((r) => r.id) };
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
