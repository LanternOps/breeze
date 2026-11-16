/**
 * Who a self-registration submit is for (portal registration W6, plan D5–D7).
 *
 * Runs in the worker with NO DB context held: the W5 read API runs in system
 * scope and throws inside a request transaction, and every other read here
 * opens its own system context. Order (Task 3 rules 1–5):
 *   1. the address's exact domain → the ONE org it is currently verified for
 *      (W5 `findOrgByVerifiedDomain`, which re-checks evidence at use). Never
 *      a direct `customer_email_domains` read, never a stricter local rule.
 *   2. host binding (D6, inv. 1): a request served on an org's verified
 *      custom portal domain may only reach that org.
 *   3. the org (and its partner) is active.
 *   4. the org's effective `selfRegistrationMode` is not `off`.
 *   5. ANY `portal_users` row in that org at the address (any status, any
 *      browser access) → existing account. Self-registration never touches an
 *      existing account (spec §5.9 step 5). Rows in other orgs do not count.
 */
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { organizations, partners, portalUsers } from '../../db/schema';
import { resolvePortalHostOrgId } from '../../routes/portal/branding';
import { portalLoginEmailEquals } from '../contacts/portalInvite';
import { PortalAccessPolicyOrgNotFoundError, resolvePortalAccessPolicy } from '../portalAccessPolicy';
import { findOrgByVerifiedDomain } from '../portalDomainVerification';
import { getActiveOrgTenant } from '../tenantStatus';
import { emailDomainOf } from './emailDomain';
import type { SelfRegistrationTarget } from './types';

export { emailDomainOf };

async function loadOrgSender(orgId: string): Promise<{ orgName: string; partnerName: string | null } | null> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .select({ orgName: organizations.name, partnerName: partners.name })
      .from(organizations)
      .leftJoin(partners, eq(partners.id, organizations.partnerId))
      .where(eq(organizations.id, orgId))
      .limit(1),
  );
  return row ?? null;
}

async function hasAccountInOrg(orgId: string, email: string): Promise<boolean> {
  const rows = await withSystemDbAccessContext(() =>
    db
      .select({ id: portalUsers.id })
      .from(portalUsers)
      .where(and(eq(portalUsers.orgId, orgId), portalLoginEmailEquals(email)))
      .limit(1),
  );
  return rows.length > 0;
}

export async function resolveSelfRegistrationTarget(input: { email: string; host: string | null }): Promise<SelfRegistrationTarget> {
  const domain = emailDomainOf(input.email);
  if (!domain) return { kind: 'ineligible', reason: 'no_verified_domain' };

  const fact = await findOrgByVerifiedDomain(domain);
  if (!fact) return { kind: 'ineligible', reason: 'no_verified_domain' };

  const hostOrgId = input.host ? await resolvePortalHostOrgId(input.host) : null;
  if (hostOrgId !== null && hostOrgId !== fact.orgId) return { kind: 'ineligible', reason: 'host_mismatch' };

  const tenant = await getActiveOrgTenant(fact.orgId);
  if (!tenant) return { kind: 'ineligible', reason: 'org_inactive' };

  let policy;
  try {
    policy = await resolvePortalAccessPolicy(fact.orgId);
  } catch (err) {
    if (err instanceof PortalAccessPolicyOrgNotFoundError) return { kind: 'ineligible', reason: 'org_inactive' };
    throw err;
  }
  const mode = policy.effective.selfRegistrationMode.value;
  if (mode === 'off') return { kind: 'ineligible', reason: 'mode_off' };

  const sender = await loadOrgSender(fact.orgId);
  if (!sender) return { kind: 'ineligible', reason: 'org_inactive' };

  const base = {
    orgId: fact.orgId,
    partnerId: tenant.partnerId,
    orgName: sender.orgName,
    partnerName: sender.partnerName,
    domain,
    mode,
  };
  if (await hasAccountInOrg(fact.orgId, input.email)) return { kind: 'existing_account', ...base };
  return { kind: 'eligible', ...base, policyFingerprint: policy.fingerprint };
}
