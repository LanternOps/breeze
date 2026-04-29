import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  partners,
  users,
  roles,
  partnerUsers,
  rolePermissions,
  organizations,
  sites,
} from '../db/schema';

export interface CreatePartnerInput {
  orgName: string;
  adminEmail: string;
  adminName: string;
  /** Null for MCP-originated bootstraps; users set their password later. */
  passwordHash: string | null;
  origin: { mcp: false } | { mcp: true; ip?: string; userAgent?: string };
  /**
   * Initial partner status. Defaults to 'active' if omitted.
   * Hosted signups should pass 'pending' so the existing partnerGuard
   * middleware (status !== 'active' → 402) blocks features until
   * breeze-billing flips the partner to 'active' post-payment.
   */
  status?: 'active' | 'pending' | 'suspended' | 'churned';
}

export interface CreatePartnerResult {
  partnerId: string;
  orgId: string;
  siteId: string;
  adminUserId: string;
  adminRoleId: string;
  mcpOrigin: boolean;
}

/**
 * Create a new partner, admin role, admin user, partner-user link,
 * default org, and default site inside a single atomic transaction.
 *
 * Shared by `/register-partner` and the MCP `create_tenant` bootstrap tool.
 * Behavior for the non-MCP path is a direct transplant of the inline
 * transaction that previously lived in `register.ts`.
 */
export async function createPartner(input: CreatePartnerInput): Promise<CreatePartnerResult> {
  const normalizedEmail = input.adminEmail.toLowerCase();
  const mcpOrigin = input.origin.mcp;

  return db.transaction(async (tx) => {
    // Signup / bootstrap is an unauthenticated, system-initiated tenant-creation
    // flow. Elevate this tx to system scope so RLS policies on partners,
    // organizations, and any other tenant-root tables in this tx pass for rows
    // whose ids aren't yet in any accessible_*_ids list.
    await tx.execute(sql`select set_config('breeze.scope', 'system', true)`);
    await tx.execute(sql`select set_config('breeze.org_id', '', true)`);
    await tx.execute(sql`select set_config('breeze.accessible_org_ids', '*', true)`);
    await tx.execute(sql`select set_config('breeze.accessible_partner_ids', '*', true)`);

    // Resolve a unique slug (partners.slug has a unique constraint).
    const slug = await resolveUniqueSlug(tx, input.orgName);

    const [newPartner] = await tx
      .insert(partners)
      .values({
        name: input.orgName,
        slug,
        type: 'msp',
        plan: 'free',
        status: input.status ?? (mcpOrigin ? 'pending' : 'active'),
        billingEmail: normalizedEmail,
        mcpOrigin,
        mcpOriginIp: mcpOrigin ? (input.origin as { ip?: string }).ip ?? null : null,
        mcpOriginUserAgent: mcpOrigin ? (input.origin as { userAgent?: string }).userAgent ?? null : null,
      })
      .returning();

    if (!newPartner) {
      throw new Error('Failed to create company');
    }

    const [adminRole] = await tx
      .insert(roles)
      .values({
        partnerId: newPartner.id,
        scope: 'partner',
        name: 'Partner Admin',
        description: 'Full access to partner and all organizations',
        isSystem: true,
      })
      .returning();

    if (!adminRole) {
      throw new Error('Failed to create admin role');
    }

    const [newUser] = await tx
      .insert(users)
      .values({
        partnerId: newPartner.id,
        email: normalizedEmail,
        name: input.adminName,
        passwordHash: input.passwordHash,
        status: 'active',
      })
      .returning();

    if (!newUser) {
      throw new Error('Failed to create user');
    }

    await tx.insert(partnerUsers).values({
      partnerId: newPartner.id,
      userId: newUser.id,
      roleId: adminRole.id,
      orgAccess: 'all',
    });

    // Copy permissions from the seeded system Partner Admin role so the new
    // partner's admin inherits the full permission set.
    const [systemPartnerAdmin] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(
          eq(roles.name, 'Partner Admin'),
          eq(roles.isSystem, true),
          isNull(roles.partnerId),
        ),
      )
      .limit(1);

    if (!systemPartnerAdmin) {
      throw new Error('System Partner Admin role not found — run seed first');
    }

    const systemPerms = await tx
      .select({ permissionId: rolePermissions.permissionId })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, systemPartnerAdmin.id));

    for (const perm of systemPerms) {
      await tx.insert(rolePermissions).values({
        roleId: adminRole.id,
        permissionId: perm.permissionId,
      });
    }

    // Default organization.
    const orgSlug = slug + '-org';
    const [newOrg] = await tx
      .insert(organizations)
      .values({
        partnerId: newPartner.id,
        name: input.orgName,
        slug: orgSlug,
        type: 'customer',
        status: 'active',
      })
      .returning();

    if (!newOrg) {
      throw new Error('Failed to create default organization');
    }

    // Default site.
    const [newSite] = await tx
      .insert(sites)
      .values({
        orgId: newOrg.id,
        name: 'Main Office',
        timezone: 'UTC',
      })
      .returning();

    if (!newSite) {
      throw new Error('Failed to create default site');
    }

    // Mark setup complete — new partners don't need the setup wizard. For the
    // MCP path the user hasn't logged in yet, so don't stamp lastLoginAt.
    const userUpdate: Record<string, unknown> = { setupCompletedAt: new Date() };
    if (!mcpOrigin) {
      userUpdate.lastLoginAt = new Date();
    }
    await tx.update(users).set(userUpdate).where(eq(users.id, newUser.id));

    return {
      partnerId: newPartner.id,
      orgId: newOrg.id,
      siteId: newSite.id,
      adminUserId: newUser.id,
      adminRoleId: adminRole.id,
      mcpOrigin,
    };
  });
}

/**
 * Find the most recently created MCP-origin partner matching the given
 * org name + admin email. Used by the MCP `create_tenant` tool to make
 * bootstrap calls idempotent (retries don't create duplicate tenants).
 *
 * Not called from inside `createPartner` — the caller decides whether to
 * short-circuit based on the result.
 */
export async function findRecentMcpPartnerByAdminEmail(
  email: string,
  orgName: string,
  since: Date,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: partners.id })
    .from(partners)
    .innerJoin(partnerUsers, eq(partnerUsers.partnerId, partners.id))
    .innerJoin(users, eq(users.id, partnerUsers.userId))
    .where(
      and(
        eq(partners.name, orgName),
        eq(partners.mcpOrigin, true),
        eq(users.email, email.toLowerCase()),
        gt(partners.createdAt, since),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Generate a URL-safe slug from a company name and ensure uniqueness by
 * appending a numeric suffix if needed.
 */
async function resolveUniqueSlug(tx: { select: any }, name: string): Promise<string> {
  const baseSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);

  let slug = baseSlug || 'partner';
  let suffix = 1;
  // Loop bound matches the previous register.ts behavior.
  while (suffix <= 100) {
    const existing = await tx
      .select({ id: partners.id })
      .from(partners)
      .where(eq(partners.slug, slug))
      .limit(1);

    if (!existing || existing.length === 0) return slug;
    slug = `${baseSlug}-${suffix}`;
    suffix++;
  }
  throw new Error('Unable to generate unique company identifier');
}
