/**
 * AI agent notification recipients — validated at write time, re-resolved at
 * notification time (spec §4.3, wave-1 gap closed by wave 3b, owner decision 3).
 *
 * `ai_agents.recipients` is notification-only data: it must NEVER influence an
 * authorization or eligibility decision (the fan-out/eligibility resolvers in
 * services/actionIntents/intentApprovers.ts are structurally pinned to never
 * consult this module). Two contracts live here:
 *
 * - **Write time** (`validateAgentRecipients`): every stored id must be real
 *   and belong to the agent owner's tenant, so a typo'd or cross-tenant id can
 *   never be persisted. Org-owned agent: a userId must be an active direct
 *   member of the org, or a partner user of the org's owning partner whose
 *   orgAccess covers it. Partner-owned agent: an active member of that
 *   partner. A roleId must exist and be visible to the owner tenant — its own
 *   org/partner roles, the owning partner's roles for an org-owned agent, or a
 *   seeded system role (mirrors GET /roles visibility, routes/roles.ts).
 *
 * - **Notification time** (`resolveRecipientUserIds`): membership is
 *   re-derived live against the RUN org — the tenant whose data the
 *   notification will describe. A stale id (revoked membership, disabled
 *   account, role unassigned) silently drops rather than erroring: the
 *   notification layer must never receive an unvalidated userId, because
 *   createNotification (services/userNotifications.ts) inserts whatever it is
 *   handed under a system context.
 *
 * Both functions read membership tables (organization_users, partner_users —
 * partner-axis RLS a caller's org-scoped context can never see) under
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))`. The
 * runOutsideDbContext wrapper is load-bearing: a bare system wrapper inside an
 * ambient request context is a no-op (db/index.ts), and both entry points are
 * called from inside request transactions (agentService mutations; wave-3b
 * outcome notify).
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { AiAgentRecipients } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  organizations,
  organizationUsers,
  partnerUsers,
  roles,
  users,
} from '../../db/schema';

export class InvalidAgentRecipientsError extends Error {
  readonly code = 'invalid_recipients';

  constructor(
    public invalidUserIds: string[],
    public invalidRoleIds: string[],
  ) {
    super(
      `invalid_recipients: userIds=[${invalidUserIds.join(', ')}] roleIds=[${invalidRoleIds.join(', ')}]`,
    );
    this.name = 'InvalidAgentRecipientsError';
  }
}

export interface AgentRecipientsOwner {
  orgId: string | null;
  partnerId: string | null;
}

function coversOrg(
  member: { orgAccess: string; orgIds: string[] | null },
  orgId: string,
): boolean {
  return (
    member.orgAccess === 'all' ||
    (member.orgAccess === 'selected' && (member.orgIds?.includes(orgId) ?? false))
  );
}

/**
 * Active direct members of `orgId` among `userIds` (or holding one of
 * `roleIds` when keyed by role). Join shape mirrors resolveIntentApprovers
 * (intentApprovers.ts) / getUsersForAlert (notifications.ts): join `users`,
 * gate on status='active' — a disabled or still-invited account is never a
 * valid recipient.
 */
async function activeOrgMembers(
  orgId: string,
  key: { userIds: string[] } | { roleIds: string[] },
): Promise<string[]> {
  const keyCondition =
    'userIds' in key
      ? inArray(organizationUsers.userId, key.userIds)
      : inArray(organizationUsers.roleId, key.roleIds);
  const rows = await db
    .select({ userId: organizationUsers.userId })
    .from(organizationUsers)
    .innerJoin(users, eq(users.id, organizationUsers.userId))
    .where(and(eq(organizationUsers.orgId, orgId), keyCondition, eq(users.status, 'active')));
  return rows.map((row) => row.userId);
}

/** Active members of `partnerId` among `userIds`/`roleIds`, with their org coverage. */
async function activePartnerMembers(
  partnerId: string,
  key: { userIds: string[] } | { roleIds: string[] },
): Promise<Array<{ userId: string; orgAccess: string; orgIds: string[] | null }>> {
  const keyCondition =
    'userIds' in key
      ? inArray(partnerUsers.userId, key.userIds)
      : inArray(partnerUsers.roleId, key.roleIds);
  return db
    .select({
      userId: partnerUsers.userId,
      orgAccess: partnerUsers.orgAccess,
      orgIds: partnerUsers.orgIds,
    })
    .from(partnerUsers)
    .innerJoin(users, eq(users.id, partnerUsers.userId))
    .where(and(eq(partnerUsers.partnerId, partnerId), keyCondition, eq(users.status, 'active')));
}

/**
 * Throw InvalidAgentRecipientsError unless every entry of `recipients` is
 * valid for the owner tenant. Input ids are de-duplicated before querying;
 * an empty/absent recipients object validates without touching the DB.
 */
export async function validateAgentRecipients(
  owner: AgentRecipientsOwner,
  recipients: Partial<AiAgentRecipients>,
): Promise<void> {
  const userIds = [...new Set(recipients.userIds ?? [])];
  const roleIds = [...new Set(recipients.roleIds ?? [])];
  if (userIds.length === 0 && roleIds.length === 0) return;

  const { validUserIds, validRoleIds } = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const validUsers = new Set<string>();
      const validRoles = new Set<string>();

      // The partner axis of the owner tenant: the owner itself for a
      // partner-owned agent, the org's owning partner for an org-owned one.
      let partnerId = owner.partnerId;
      if (owner.orgId) {
        const [org] = await db
          .select({ partnerId: organizations.partnerId })
          .from(organizations)
          .where(eq(organizations.id, owner.orgId))
          .limit(1);
        partnerId = org?.partnerId ?? null;
      }

      if (userIds.length > 0) {
        if (owner.orgId) {
          for (const userId of await activeOrgMembers(owner.orgId, { userIds })) {
            validUsers.add(userId);
          }
          if (partnerId) {
            for (const member of await activePartnerMembers(partnerId, { userIds })) {
              if (coversOrg(member, owner.orgId)) validUsers.add(member.userId);
            }
          }
        } else if (partnerId) {
          // Partner-owned agent: membership in the partner is enough at write
          // time — which orgs the user can actually see is enforced per run
          // org at notification time by resolveRecipientUserIds.
          for (const member of await activePartnerMembers(partnerId, { userIds })) {
            validUsers.add(member.userId);
          }
        }
      }

      if (roleIds.length > 0) {
        const roleRows = await db
          .select({
            id: roles.id,
            partnerId: roles.partnerId,
            orgId: roles.orgId,
            isSystem: roles.isSystem,
          })
          .from(roles)
          .where(inArray(roles.id, roleIds));
        for (const role of roleRows) {
          const visibleToOwner =
            role.isSystem ||
            (owner.orgId !== null && role.orgId === owner.orgId) ||
            (partnerId !== null && role.partnerId === partnerId);
          if (visibleToOwner) validRoles.add(role.id);
        }
      }

      return { validUserIds: validUsers, validRoleIds: validRoles };
    }),
  );

  const invalidUserIds = userIds.filter((id) => !validUserIds.has(id));
  const invalidRoleIds = roleIds.filter((id) => !validRoleIds.has(id));
  if (invalidUserIds.length > 0 || invalidRoleIds.length > 0) {
    throw new InvalidAgentRecipientsError(invalidUserIds, invalidRoleIds);
  }
}

/**
 * Task 6 (wave 4b, #3826) act-mode activation prerequisite: does this agent
 * currently have at least one recipient that resolves to a real, active
 * user? An unattended agent whose only recipient is a role nobody currently
 * holds (or a userId whose membership has since lapsed) notifies no one when
 * something goes wrong — never a state act mode should be allowed to start
 * in. `validateAgentRecipients` only proves each STORED id is real and
 * VISIBLE to the owner tenant at write time; it does not prove anyone
 * currently resolves from it (a roleId can be visible and valid while zero
 * users hold it), so this is a genuinely separate check, not a restatement.
 *
 * Org-owned agent: delegates straight to `resolveRecipientUserIds` against
 * the only org an org-owned agent's runs are ever admitted for. Partner-owned
 * (baseline) agent: there is no run org yet to resolve against, so this
 * checks direct partner membership only — the same asymmetry
 * `validateAgentRecipients` already draws between the two ownership shapes
 * (a partner-wide agent's eventual per-org visibility is re-derived live at
 * notification time, same as today).
 */
export async function hasResolvableAgentRecipient(
  owner: AgentRecipientsOwner,
  recipients: Partial<AiAgentRecipients>,
): Promise<boolean> {
  const userIds = [...new Set(recipients.userIds ?? [])];
  const roleIds = [...new Set(recipients.roleIds ?? [])];
  if (userIds.length === 0 && roleIds.length === 0) return false;

  if (owner.orgId) {
    const resolved = await resolveRecipientUserIds(
      { orgId: owner.orgId, partnerId: owner.partnerId, recipients },
      owner.orgId,
    );
    return resolved.length > 0;
  }

  if (!owner.partnerId) return false;
  const partnerId = owner.partnerId;
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      if (userIds.length > 0 && (await activePartnerMembers(partnerId, { userIds })).length > 0) {
        return true;
      }
      if (roleIds.length > 0 && (await activePartnerMembers(partnerId, { roleIds })).length > 0) {
        return true;
      }
      return false;
    }),
  );
}

/**
 * Resolve the user ids to notify about a run/intent in `orgId`, from live
 * membership. Explicit userIds are kept only while currently active with
 * access to the org (direct member, or partner user of the org's owning
 * partner whose orgAccess covers it); roleIds expand to the users currently
 * holding the role with the same access rule; union, dedupe. Stale entries
 * drop silently — see the module header.
 */
export async function resolveRecipientUserIds(
  agent: {
    orgId: string | null;
    partnerId: string | null;
    recipients: Partial<AiAgentRecipients>;
  },
  orgId: string,
): Promise<string[]> {
  const userIds = [...new Set(agent.recipients.userIds ?? [])];
  const roleIds = [...new Set(agent.recipients.roleIds ?? [])];
  if (userIds.length === 0 && roleIds.length === 0) return [];

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const resolved = new Set<string>();

      // Always keyed by the RUN org's owning partner, not the agent's owner:
      // access to the org whose data the notification describes is what
      // qualifies a recipient.
      const [org] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      const partnerId = org?.partnerId ?? null;

      if (userIds.length > 0) {
        for (const userId of await activeOrgMembers(orgId, { userIds })) {
          resolved.add(userId);
        }
        if (partnerId) {
          for (const member of await activePartnerMembers(partnerId, { userIds })) {
            if (coversOrg(member, orgId)) resolved.add(member.userId);
          }
        }
      }

      if (roleIds.length > 0) {
        for (const userId of await activeOrgMembers(orgId, { roleIds })) {
          resolved.add(userId);
        }
        if (partnerId) {
          for (const member of await activePartnerMembers(partnerId, { roleIds })) {
            if (coversOrg(member, orgId)) resolved.add(member.userId);
          }
        }
      }

      return [...resolved];
    }),
  );
}
