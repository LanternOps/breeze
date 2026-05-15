import { and, eq, isNull } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { organizations, partners } from '../db/schema';

export class TenantInactiveError extends Error {
  constructor(message = 'Tenant is not active') {
    super(message);
    this.name = 'TenantInactiveError';
  }
}

function isUsableOrgStatus(status: string | null | undefined): boolean {
  return status === 'active' || status === 'trial';
}

export async function getActivePartner(partnerId: string): Promise<{ id: string } | null> {
  return withSystemDbAccessContext(async () => {
    const [partner] = await db
      .select({ id: partners.id, status: partners.status, deletedAt: partners.deletedAt })
      .from(partners)
      .where(and(eq(partners.id, partnerId), isNull(partners.deletedAt)))
      .limit(1);

    if (!partner || partner.status !== 'active') return null;
    return { id: partner.id };
  });
}

// Partner statuses allowed to hold an authenticated session. `pending`
// is legitimate — a self-service signup that has verified email but not
// yet completed payment. It MUST be able to authenticate so the
// downstream partnerGuard (status !== 'active' → 403 PARTNER_INACTIVE)
// can redirect it to the billing page. Feature gating is partnerGuard's
// job, not the auth/token gate's. `suspended`/`churned`/soft-deleted
// stay rejected — that is the SR-001..SR-024 (PR #568) mid-session
// cutoff we keep. Deliberately distinct from getActivePartner (strictly
// 'active'), which the org-cascade / API-key path relies on — do not
// merge them.
const PARTNER_SESSION_ALLOWED_STATUSES = new Set(['active', 'pending']);

export async function getSessionAllowedPartner(partnerId: string): Promise<{ id: string } | null> {
  return withSystemDbAccessContext(async () => {
    const [partner] = await db
      .select({ id: partners.id, status: partners.status, deletedAt: partners.deletedAt })
      .from(partners)
      .where(and(eq(partners.id, partnerId), isNull(partners.deletedAt)))
      .limit(1);

    if (!partner || !PARTNER_SESSION_ALLOWED_STATUSES.has(partner.status)) return null;
    return { id: partner.id };
  });
}

export async function getActiveOrgTenant(orgId: string): Promise<{ orgId: string; partnerId: string } | null> {
  return withSystemDbAccessContext(async () => {
    const [org] = await db
      .select({
        orgId: organizations.id,
        orgStatus: organizations.status,
        orgDeletedAt: organizations.deletedAt,
        partnerId: organizations.partnerId,
      })
      .from(organizations)
      .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
      .limit(1);

    if (!org || !isUsableOrgStatus(org.orgStatus) || org.orgDeletedAt) return null;

    const activePartner = await getActivePartner(org.partnerId);
    if (!activePartner) return null;

    return { orgId: org.orgId, partnerId: org.partnerId };
  });
}

export async function assertActiveTenantContext(context: {
  scope: 'system' | 'partner' | 'organization';
  partnerId: string | null;
  orgId: string | null;
}): Promise<void> {
  if (context.scope === 'system') return;

  if (context.scope === 'partner') {
    // Session gate, not feature gate: admit `pending` (partnerGuard
    // handles the billing redirect). Strictly-dead tenants still rejected.
    if (!context.partnerId || !(await getSessionAllowedPartner(context.partnerId))) {
      throw new TenantInactiveError('Partner is not active');
    }
    return;
  }

  if (!context.orgId) {
    throw new TenantInactiveError('Organization context required');
  }

  const org = await getActiveOrgTenant(context.orgId);
  if (!org || (context.partnerId && org.partnerId !== context.partnerId)) {
    throw new TenantInactiveError('Organization is not active');
  }
}
