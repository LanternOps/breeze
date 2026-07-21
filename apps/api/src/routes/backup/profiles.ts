// Backup selection profiles — CRUD for the Cove-style "what to protect"
// entity (docs/superpowers/specs/backup/2026-07-13-backup-profiles-design.md).
//
// Dual-ownership (epic #2135): a profile is org-owned (org_id set) or
// partner-wide (partner_id set, org_id NULL). Partner-wide create/update/
// delete is gated on canManagePartnerWidePolicies. Reads use the dual-axis
// app condition gated on partner scope — RLS remains stricter, never claim
// parity (org tokens carry a partnerId but never pass
// breeze_has_partner_access).

import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { eq, and, desc, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import {
  backupProfiles,
  configPolicyBackupSettings,
  configPolicyFeatureLinks,
  configurationPolicies,
} from '../../db/schema';
import { requireMfa, requirePermission } from '../../middleware/auth';
import type { AuthContext } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { pgErrorCode } from '../../utils/pgErrors';
import { PERMISSIONS } from '../../services/permissions';
import {
  canManagePartnerWidePolicies,
} from '../../services/partnerWideAccess';
import {
  createBackupProfileSchema,
  updateBackupProfileSchema,
} from '@breeze/shared';
import { resolveScopedOrgId } from './helpers';

export const profilesRoutes = new Hono();

const profileIdParamSchema = z.object({ id: z.string() });

const listProfilesQuerySchema = z.object({
  includeInactive: z.enum(['true', 'false']).optional(),
  orgId: z.string().optional(),
});

// Dual-axis access condition (same shape as softwarePolicyAccessCondition):
// org-owned rows the caller can reach OR partner-wide rows owned by the
// caller's own partner, the latter only for partner-scope callers.
function profileAccessCondition(auth: AuthContext): SQL | undefined {
  const orgCond = auth.orgCondition(backupProfiles.orgId);
  if (!orgCond) return undefined; // system scope
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${orgCond} OR (${backupProfiles.orgId} IS NULL AND ${backupProfiles.partnerId} = ${auth.partnerId}))`;
  }
  return orgCond;
}

async function getProfileWithAccess(profileId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(backupProfiles.id, profileId)];
  const accessCondition = profileAccessCondition(auth);
  if (accessCondition) conditions.push(accessCondition);
  const [profile] = await db
    .select()
    .from(backupProfiles)
    .where(and(...conditions))
    .limit(1);
  return profile ?? null;
}

/** Config policies whose backup link references this profile (for in-use 409s and the UI's in-use count). */
async function referencingPolicies(profileId: string) {
  return db
    .select({
      policyId: configurationPolicies.id,
      policyName: configurationPolicies.name,
    })
    .from(configPolicyBackupSettings)
    .innerJoin(
      configPolicyFeatureLinks,
      eq(configPolicyBackupSettings.featureLinkId, configPolicyFeatureLinks.id)
    )
    .innerJoin(
      configurationPolicies,
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id)
    )
    .where(eq(configPolicyBackupSettings.backupProfileId, profileId));
}

profilesRoutes.get(
  '/profiles',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('query', listProfilesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const conditions: SQL[] = [];
    const accessCondition = profileAccessCondition(auth);
    if (accessCondition) conditions.push(accessCondition);
    if (query.includeInactive !== 'true') {
      conditions.push(eq(backupProfiles.isActive, true));
    }

    const rows = await db
      .select()
      .from(backupProfiles)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(backupProfiles.updatedAt));

    // In-use counts in one grouped query (0-30 profiles; fine to fetch all).
    const counts = await db
      .select({
        profileId: configPolicyBackupSettings.backupProfileId,
        count: sql<number>`count(*)`,
      })
      .from(configPolicyBackupSettings)
      .groupBy(configPolicyBackupSettings.backupProfileId);
    const countByProfile = new Map(
      counts
        .filter((row) => row.profileId !== null)
        .map((row) => [row.profileId as string, Number(row.count)])
    );

    return c.json({
      data: rows.map((row) => ({
        ...row,
        inUseByPolicies: countByProfile.get(row.id) ?? 0,
      })),
    });
  }
);

profilesRoutes.get(
  '/profiles/:id',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('param', profileIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const profile = await getProfileWithAccess(id, auth);
    if (!profile) return c.json({ error: 'Profile not found' }, 404);
    const referencing = await referencingPolicies(id);
    return c.json({ data: { ...profile, inUseByPolicies: referencing.length } });
  }
);

profilesRoutes.post(
  '/profiles',
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('json', createBackupProfileSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    // Ownership axis: partner-wide profiles apply to devices in ALL orgs under
    // the partner (including orgs created later) — same gate as every
    // dual-axis config table. The partner always comes from the caller's token.
    let owner: { orgId: string | null; partnerId: string | null };
    if (payload.ownerScope === 'partner') {
      if (!auth.partnerId) {
        return c.json({ error: 'Partner-wide backup profiles require partner scope' }, 403);
      }
      if (!canManagePartnerWidePolicies(auth)) {
        return c.json({ error: 'Partner-wide backup profiles require full partner org access (orgAccess must be "all")' }, 403);
      }
      owner = { orgId: null, partnerId: auth.partnerId };
    } else {
      const orgId = resolveScopedOrgId(auth, payload.orgId ?? c.req.query('orgId'));
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }
      owner = { orgId, partnerId: null };
    }

    const [profile] = await db
      .insert(backupProfiles)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        name: payload.name,
        description: payload.description ?? null,
        selections: payload.selections,
        isActive: payload.isActive ?? true,
        createdBy: auth.user?.id ?? null,
      })
      .returning();
    if (!profile) return c.json({ error: 'Failed to create backup profile' }, 500);

    writeRouteAudit(c, {
      orgId: profile.orgId,
      action: 'backup.profile.create',
      resourceType: 'backup_profile',
      resourceId: profile.id,
      resourceName: profile.name,
      details: { ownerScope: payload.ownerScope },
    });

    return c.json({ data: profile }, 201);
  }
);

profilesRoutes.patch(
  '/profiles/:id',
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', profileIdParamSchema),
  zValidator('json', updateBackupProfileSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const existing = await getProfileWithAccess(id, auth);
    if (!existing) return c.json({ error: 'Profile not found' }, 404);
    if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: 'Modifying a partner-wide backup profile requires full partner org access (orgAccess must be "all")' }, 403);
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (payload.name !== undefined) updateData.name = payload.name;
    if (payload.description !== undefined) updateData.description = payload.description;
    if (payload.selections !== undefined) updateData.selections = payload.selections;
    if (payload.isActive !== undefined) updateData.isActive = payload.isActive;

    const [updated] = await db
      .update(backupProfiles)
      .set(updateData)
      .where(eq(backupProfiles.id, id))
      .returning();
    // 0 rows means RLS hid the row from the write (the read above uses the
    // app-layer condition, which is looser than the policy) — a 404, not a 500.
    if (!updated) return c.json({ error: 'Profile not found' }, 404);

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'backup.profile.update',
      resourceType: 'backup_profile',
      resourceId: updated.id,
      resourceName: updated.name,
      details: { fields: Object.keys(payload) },
    });

    return c.json({ data: updated });
  }
);

profilesRoutes.delete(
  '/profiles/:id',
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', profileIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const existing = await getProfileWithAccess(id, auth);
    if (!existing) return c.json({ error: 'Profile not found' }, 404);
    if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: 'Deleting a partner-wide backup profile requires full partner org access (orgAccess must be "all")' }, 403);
    }

    // Friendly 409 before the RESTRICT FK fires, listing what still uses it.
    const referencing = await referencingPolicies(id);
    if (referencing.length > 0) {
      return c.json(
        {
          error: 'Backup profile is in use by configuration policies',
          referencingPolicies: referencing,
        },
        409
      );
    }

    // Check the rowcount: under forced RLS a DELETE that matches nothing is a
    // silent no-op, not an error — reporting success would be a lie.
    let deleted: { id: string }[];
    try {
      deleted = await db
        .delete(backupProfiles)
        .where(eq(backupProfiles.id, id))
        .returning({ id: backupProfiles.id });
    } catch (err) {
      // A policy can link this profile between the check above and here; the
      // RESTRICT FK then fires. Re-read and return the same friendly 409.
      if (pgErrorCode(err) === '23503') {
        const stillReferencing = await referencingPolicies(id);
        return c.json(
          {
            error: 'Backup profile is in use by configuration policies',
            referencingPolicies: stillReferencing,
          },
          409
        );
      }
      throw err;
    }

    if (deleted.length === 0) {
      return c.json({ error: 'Profile not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'backup.profile.delete',
      resourceType: 'backup_profile',
      resourceId: existing.id,
      resourceName: existing.name,
    });

    return c.json({ success: true });
  }
);
