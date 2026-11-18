/**
 * The org gate for a partner's per-org billing configuration (the org's
 * billing-profile assignment). Lifted verbatim from routes/orgBillingProfile.ts
 * (full-control W14, #6784) so the route and `manage_billing_profiles`
 * (`get_org_profile` / `set_org_profile` / `clear_org_profile`) share it.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { partnerMemberMayReachOrg } from './partnerOrgSelection';
import { isUnassignedPoolOrgType } from './unassignedPool/orgType';

/**
 * The org when the partner caller may configure its billing, else null (one
 * answer for "missing", "another partner's" and "the holding org").
 * The caller must already be partner-scoped with a partnerId.
 */
export async function resolveBillingConfigurableOrg(
  auth: AuthContext,
  id: string,
): Promise<{ id: string; partnerId: string } | null> {
  if (!auth.partnerId) return null;
  // Suspended orgs are absent from canAccessOrg; use the canonical raw member
  // selection for that case, then independently prove partner ownership.
  if (!auth.canAccessOrg(id) && !await partnerMemberMayReachOrg(auth, id)) return null;
  const load = () => db.select({ id: organizations.id, partnerId: organizations.partnerId, type: organizations.type })
    .from(organizations)
    .where(and(eq(organizations.id, id), eq(organizations.partnerId, auth.partnerId!), isNull(organizations.deletedAt)))
    .limit(1);
  const [org] = auth.canAccessOrg(id)
    ? await load()
    : await runOutsideDbContext(() => withSystemDbAccessContext(load));
  if (!org || org.partnerId !== auth.partnerId) return null;
  // The partner's holding org is managed by Breeze and has no billing identity
  // of its own; refuse it indistinguishably from "not found".
  if (isUnassignedPoolOrgType(org.type)) return null;
  return { id: org.id, partnerId: auth.partnerId };
}
