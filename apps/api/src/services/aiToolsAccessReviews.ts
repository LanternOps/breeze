/**
 * `manage_access_reviews` (full-control W11, #6781): the AI twin of
 * GET /access-reviews, GET /access-reviews/:id, POST /access-reviews and
 * PATCH /access-reviews/:id/items/:itemId.
 *
 * `complete` — the act that deletes memberships, advances auth epochs, revokes
 * refresh families and can neutralise an account — is human-only and ABSENT
 * from this tool (no action, no enum member, no code path). So is `notify`
 * (it emails a person). aiToolSchemas.securityPolicy.test.ts pins both.
 *
 * Gates are the router's: a partner caller needs full partner scope
 * (`canManagePartnerWidePolicies`), system scope is refused, a review is
 * matched on the caller's own partner or org. Writes carry the route's MFA
 * requirement through `MFA_GATED_TOOL_ACTIONS`. Item decisions apply the same
 * separation-of-duties rule (`canSelfDecideAccessReviewItem`).
 *
 * Stricter than REST (W11-D6, W11-D7): a site- or device-restricted session
 * gets nothing (a review enumerates every member of the org), and a
 * `reviewerId` must be a member of the review's own scope. The whole tool is
 * `AGENT_HUMAN_ONLY_TOOLS` (identity governance; plan exposure table).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  accessReviewItems, accessReviews, organizationUsers, partnerUsers, permissions, rolePermissions, roles, users,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { mfaGatedToolError } from './aiToolMfaGate';
import { canSelfDecideAccessReviewItem, type AccessReviewOwner } from './accessReviewSelfDecision';
import { canManagePartnerWidePolicies } from './partnerWideAccess';
import { canMutateOrgWideGovernance } from './siteCeilingAccess';
import { pageEnvelope, pageParamSchema, readPageArgs } from './aiToolPagination';
import { isRestrictedCaller } from './aiToolsNetworkMonitoringShared';
import { ACCESS_REVIEW_ACTIONS, ACCESS_REVIEW_DECISIONS } from './aiToolSchemasSecurityPolicy';
import { auditToolWrite, bounded, json, jsonError, notFound, requireFields, str, thrown } from './aiToolsSecurityPolicyShared';

type Action = (typeof ACCESS_REVIEW_ACTIONS)[number];
type Decision = (typeof ACCESS_REVIEW_DECISIONS)[number];
const TOOL = 'manage_access_reviews';
const PAGE = { defaultLimit: 50, maxLimit: 200 } as const;

/** The router's gate plus `getScopeContext`, as one answer: the review owner, or an error result. */
function reviewOwner(auth: AuthContext): AccessReviewOwner | string {
  // Site- or device-restricted (and, for an org user, the governance ceiling): a review enumerates every member.
  if (isRestrictedCaller(auth) || !canMutateOrgWideGovernance(auth)) {
    return jsonError('Access reviews cover every member of the organization; a site- or device-restricted session cannot use them', 'ACCESS_DENIED');
  }
  if (auth.scope === 'partner') {
    if (!auth.partnerId) return jsonError('Partner context required', 'ACCESS_DENIED');
    if (!canManagePartnerWidePolicies(auth)) return jsonError('Full partner organization access required', 'ACCESS_DENIED');
    return { scope: 'partner', partnerId: auth.partnerId };
  }
  if (auth.scope === 'organization' && auth.orgId) return { scope: 'organization', orgId: auth.orgId };
  return jsonError('Partner or organization context required', 'ACCESS_DENIED');
}

function ownerCondition(owner: AccessReviewOwner) {
  return owner.scope === 'partner' ? eq(accessReviews.partnerId, owner.partnerId) : eq(accessReviews.orgId, owner.orgId);
}

async function isScopeMember(owner: AccessReviewOwner, userId: string): Promise<boolean> {
  const rows = owner.scope === 'partner'
    ? await db.select({ id: partnerUsers.userId }).from(partnerUsers)
      .where(and(eq(partnerUsers.partnerId, owner.partnerId), eq(partnerUsers.userId, userId))).limit(1)
    : await db.select({ id: organizationUsers.userId }).from(organizationUsers)
      .where(and(eq(organizationUsers.orgId, owner.orgId), eq(organizationUsers.userId, userId))).limit(1);
  return rows.length > 0;
}

export function registerAccessReviewTools(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1,
    domain: 'security',
    searchHint: 'user access reviews (recertification): list members to keep or revoke, record each decision',
    deviceArgs: [],
    definition: {
      name: 'manage_access_reviews',
      description:
        'User access reviews. Actions: list, get (reviewId), create (name, snapshots every member), decide_item (reviewId, itemId, decision approved, revoked or pending). Decisions are only recorded: completing a review, which removes revoked users, is done by a person in the web app.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...ACCESS_REVIEW_ACTIONS], description: 'The action to perform' },
          reviewId: { type: 'string', description: 'get / decide_item: access review UUID' },
          itemId: { type: 'string', description: 'decide_item: review item UUID from get' },
          name: { type: 'string', description: 'create: review name (max 255)' },
          description: { type: 'string', description: 'create: description (max 2000)' },
          dueDate: { type: 'string', description: 'create: due date, ISO 8601' },
          reviewerId: { type: 'string', description: 'create: reviewer user UUID, a member of this partner or organization (default: you)' },
          decision: { type: 'string', enum: [...ACCESS_REVIEW_DECISIONS], description: 'decide_item: keep (approved), remove at completion (revoked), or reset (pending)' },
          notes: { type: 'string', description: 'decide_item: reason (max 2000)' },
          ...pageParamSchema(PAGE.defaultLimit, PAGE.maxLimit),
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      try {
        return await handle(input, auth);
      } catch (error) {
        return thrown(TOOL, error);
      }
    },
  });
}

async function handle(input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  const action = input.action as Action;
  if (!ACCESS_REVIEW_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
  const owner = reviewOwner(auth);
  if (typeof owner === 'string') return owner;
  const mfa = mfaGatedToolError(TOOL, action, auth);
  if (mfa) return mfa;

  if (action === 'list') {
    const rows = await db
      .select({
        id: accessReviews.id, name: accessReviews.name, description: accessReviews.description, status: accessReviews.status,
        reviewerId: accessReviews.reviewerId, reviewerName: users.name, dueDate: accessReviews.dueDate,
        createdAt: accessReviews.createdAt, completedAt: accessReviews.completedAt,
      })
      .from(accessReviews)
      .leftJoin(users, eq(accessReviews.reviewerId, users.id))
      .where(ownerCondition(owner))
      .orderBy(asc(accessReviews.createdAt))
      .limit(201);
    return bounded({ reviews: rows.slice(0, 200), truncated: rows.length > 200 });
  }

  if (action === 'get') {
    const missing = requireFields(input, ['reviewId'], action);
    if (missing) return missing;
    const page = readPageArgs(TOOL, input, PAGE);
    if (!page.ok) return jsonError(page.error, page.code);
    const [review] = await db
      .select({
        id: accessReviews.id, name: accessReviews.name, description: accessReviews.description, status: accessReviews.status,
        reviewerId: accessReviews.reviewerId, dueDate: accessReviews.dueDate, createdAt: accessReviews.createdAt, completedAt: accessReviews.completedAt,
      })
      .from(accessReviews)
      .where(and(eq(accessReviews.id, String(input.reviewId)), ownerCondition(owner)))
      .limit(1);
    if (!review) return notFound('Access review');
    const items = await db
      .select({
        id: accessReviewItems.id, userId: accessReviewItems.userId, userName: users.name, userEmail: users.email,
        lastActiveAt: users.lastLoginAt, roleId: accessReviewItems.roleId, roleName: roles.name,
        decision: accessReviewItems.decision, notes: accessReviewItems.notes, reviewedAt: accessReviewItems.reviewedAt,
        selfDecided: accessReviewItems.selfDecided,
      })
      .from(accessReviewItems)
      .innerJoin(users, eq(accessReviewItems.userId, users.id))
      .innerJoin(roles, eq(accessReviewItems.roleId, roles.id))
      .where(eq(accessReviewItems.reviewId, review.id))
      .orderBy(asc(users.email), asc(accessReviewItems.id));
    const pageItems = items.slice(page.offset, page.offset + page.limit);
    // Permissions once per role (not per item), so a large review stays inside the result budget.
    const roleIds = [...new Set(pageItems.map((item) => item.roleId))];
    const rolePerms = roleIds.length
      ? await db.select({ roleId: rolePermissions.roleId, resource: permissions.resource, action: permissions.action })
        .from(rolePermissions).innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
        .where(inArray(rolePermissions.roleId, roleIds))
      : [];
    const roleMap: Record<string, { name: string; permissions: string[] }> = {};
    for (const item of pageItems) roleMap[item.roleId] ??= { name: item.roleName, permissions: [] };
    for (const row of rolePerms) roleMap[row.roleId]?.permissions.push(`${row.resource}:${row.action}`);
    let selfDecision: 'blocked' | 'single_admin_exception' | null = null;
    if (review.status !== 'completed' && items.some((item) => item.userId === auth.user.id)) {
      selfDecision = (await canSelfDecideAccessReviewItem(owner, auth.user.id)) ? 'single_admin_exception' : 'blocked';
    }
    const counts = Object.fromEntries(ACCESS_REVIEW_DECISIONS.map((d) => [d, items.filter((i) => i.decision === d).length]));
    return bounded({
      review,
      decisionCounts: counts,
      roles: roleMap,
      viewer: { userId: auth.user.id, selfDecision },
      note: 'Completing a review (which removes revoked members) is done by a person in the Breeze web app.',
      ...pageEnvelope({
        key: 'items',
        items: pageItems.map(({ roleName: _r, ...item }) => item),
        limit: page.limit, offset: page.offset, fingerprint: page.fingerprint, total: items.length,
      }),
    });
  }

  if (action === 'create') {
    const missing = requireFields(input, ['name'], action);
    if (missing) return missing;
    const reviewerId = str(input.reviewerId) ?? auth.user.id;
    if (!(await isScopeMember(owner, reviewerId))) {
      return jsonError('reviewerId must be a member of this access review\'s partner or organization', 'VALIDATION_ERROR');
    }
    const result = await db.transaction(async (tx) => {
      const [review] = await tx.insert(accessReviews).values({
        partnerId: owner.scope === 'partner' ? owner.partnerId : null,
        orgId: owner.scope === 'organization' ? owner.orgId : null,
        name: String(input.name),
        description: str(input.description) ?? null,
        dueDate: str(input.dueDate) ? new Date(String(input.dueDate)) : null,
        reviewerId,
        status: 'pending',
      }).returning({ id: accessReviews.id, name: accessReviews.name, status: accessReviews.status });
      if (!review) throw new Error('access review insert returned no row');
      const members = owner.scope === 'partner'
        ? await tx.select({ userId: partnerUsers.userId, roleId: partnerUsers.roleId }).from(partnerUsers).where(eq(partnerUsers.partnerId, owner.partnerId))
        : await tx.select({ userId: organizationUsers.userId, roleId: organizationUsers.roleId }).from(organizationUsers).where(eq(organizationUsers.orgId, owner.orgId));
      if (members.length > 0) {
        await tx.insert(accessReviewItems).values(members.map((m) => ({ reviewId: review.id, userId: m.userId, roleId: m.roleId, decision: 'pending' as const })));
      }
      return { review, itemCount: members.length };
    });
    auditToolWrite(auth, {
      orgId: owner.scope === 'organization' ? owner.orgId : null,
      partnerId: owner.scope === 'partner' ? owner.partnerId : null,
      action: 'access_review.create', resourceType: 'access_review', resourceId: result.review.id, resourceName: result.review.name,
      details: { itemCount: result.itemCount },
    });
    return json({ created: true, ...result.review, itemCount: result.itemCount });
  }

  if (action === 'decide_item') {
    // decide_item: records a decision; nothing changes until a person completes the review.
    const missing = requireFields(input, ['reviewId', 'itemId', 'decision'], action);
    if (missing) return missing;
    const decision = input.decision as Decision;
    if (!ACCESS_REVIEW_DECISIONS.includes(decision)) return jsonError("decision must be 'approved', 'revoked' or 'pending'", 'VALIDATION_ERROR');
    const [review] = await db.select({ id: accessReviews.id, status: accessReviews.status }).from(accessReviews)
      .where(and(eq(accessReviews.id, String(input.reviewId)), ownerCondition(owner))).limit(1);
    if (!review) return notFound('Access review');
    if (review.status === 'completed') return jsonError('Cannot modify a completed review', 'INVALID_STATE');
    const [item] = await db.select({ id: accessReviewItems.id, userId: accessReviewItems.userId }).from(accessReviewItems)
      .where(and(eq(accessReviewItems.id, String(input.itemId)), eq(accessReviewItems.reviewId, review.id))).limit(1);
    if (!item) return notFound('Review item');
    const isOwnItem = item.userId === auth.user.id;
    if (isOwnItem && !(await canSelfDecideAccessReviewItem(owner, auth.user.id))) {
      return jsonError('You cannot decide on your own access. Another administrator must review this item.', 'ACCESS_REVIEW_SELF_DECISION');
    }
    const [updated] = await db.update(accessReviewItems).set({
      decision,
      notes: str(input.notes) ?? null,
      reviewedAt: new Date(),
      reviewedBy: auth.user.id,
      selfDecided: isOwnItem && decision !== 'pending',
    }).where(and(eq(accessReviewItems.id, item.id), eq(accessReviewItems.reviewId, review.id)))
      .returning({ id: accessReviewItems.id, decision: accessReviewItems.decision, notes: accessReviewItems.notes, reviewedAt: accessReviewItems.reviewedAt, selfDecided: accessReviewItems.selfDecided });
    if (!updated) return notFound('Review item');
    if (review.status === 'pending') {
      await db.update(accessReviews).set({ status: 'in_progress' }).where(and(eq(accessReviews.id, review.id), eq(accessReviews.status, 'pending')));
    }
    auditToolWrite(auth, {
      orgId: owner.scope === 'organization' ? owner.orgId : null,
      partnerId: owner.scope === 'partner' ? owner.partnerId : null,
      action: 'access_review.item.update', resourceType: 'access_review', resourceId: review.id,
      details: { decision, subjectUserId: item.userId, selfDecided: updated.selfDecided },
    });
    return json({ updated: true, item: updated, note: 'Recorded only. Nothing changes until a person completes the review in the Breeze web app.' });
  }
  return jsonError(`Unknown action: ${String(action)}`);
}
