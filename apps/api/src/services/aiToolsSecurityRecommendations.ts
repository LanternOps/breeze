/**
 * `manage_security_recommendations` (full-control W11, #6781): the AI twin of
 * GET /security/recommendations and POST /security/recommendations/:id/
 * {complete,dismiss}.
 *
 * Recommendations are computed (`buildBe9Recommendations`), not stored; a
 * complete / dismiss inserts one `audit_logs` row that the status map reads,
 * exactly as the route does. Nothing is remediated, no command, no event;
 * `reopen` in the UI undoes either (t2). `reopen` itself is not offered.
 *
 * Stricter than REST (W11-D6, quorum QW4): the recommendation set and its
 * status are org-wide, so a session bound to specific devices cannot read the
 * list, and a site- or device-restricted session cannot mark one.
 */
import { db } from '../db';
import { auditLogs } from '../db/schema';
import type { AiTool } from './aiTools';
import { aiOriginAuditActor } from './aiOriginColumns';
import { pageEnvelope, pageParamSchema, readPageArgs } from './aiToolPagination';
import {
  buildBe9Recommendations,
  getPolicyOrgId,
  getRecommendationStatusMap,
  resolveOrgRecommendationBreakdown,
  resolveRecommendationStatus,
} from '../routes/security/helpers';
import { SECURITY_RECOMMENDATION_ACTIONS } from './aiToolSchemasSecurityPolicy';
import {
  bounded, deviceBoundDenied, json, jsonError, notFound, orgWideWriteDenied, requireFields, str, thrown,
} from './aiToolsSecurityPolicyShared';

type Action = (typeof SECURITY_RECOMMENDATION_ACTIONS)[number];
const TOOL = 'manage_security_recommendations';
const PAGE = { defaultLimit: 25, maxLimit: 100 } as const;
const AUDIT_ACTION: Record<Exclude<Action, 'list'>, string> = {
  complete: 'security.recommendation.complete',
  dismiss: 'security.recommendation.dismiss',
};

export function registerSecurityRecommendationTools(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1,
    domain: 'security',
    searchHint: 'security recommendations: enable AV, firewall, disk encryption, password policy; mark one completed or dismissed',
    deviceArgs: [],
    definition: {
      name: TOOL,
      description:
        'Fleet security recommendations computed from posture. Actions: list, complete (recommendationId), dismiss (recommendationId). Complete and dismiss only record a status for one organization; nothing is changed on devices.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...SECURITY_RECOMMENDATION_ACTIONS], description: 'The action to perform' },
          recommendationId: { type: 'string', description: 'complete / dismiss: recommendation id from list (e.g. rec-enable-firewall)' },
          orgId: { type: 'string', description: 'Organization UUID (required to complete / dismiss when you can reach several)' },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'list: only this priority' },
          category: { type: 'string', description: 'list: only this category (antivirus, firewall, encryption, …)' },
          status: { type: 'string', enum: ['open', 'dismissed', 'completed'], description: 'list: only this status' },
          ...pageParamSchema(PAGE.defaultLimit, PAGE.maxLimit),
        },
        required: ['action'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!SECURITY_RECOMMENDATION_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const orgId = str(input.orgId);
      if (orgId && !auth.canAccessOrg(orgId)) return notFound('Organization');

      try {
        if (action === 'list') {
          const denied = deviceBoundDenied(auth, 'The recommendation list');
          if (denied) return denied;
          const page = readPageArgs(TOOL, input, PAGE);
          if (!page.ok) return jsonError(page.error, page.code);
          const built = await buildBe9Recommendations(auth, orgId);
          if (built.error) return jsonError(built.error.message, built.error.status === 403 ? 'ACCESS_DENIED' : 'VALIDATION_ERROR');
          const statusMap = await getRecommendationStatusMap(auth, orgId);
          const all = built.recommendations.map((rec) => ({
            id: rec.id,
            title: rec.title,
            description: rec.description,
            priority: rec.priority,
            category: rec.category,
            affectedDevices: rec.affectedDevices,
            status: resolveRecommendationStatus(rec.id, built.affectedByOrg?.get(rec.id), statusMap),
            orgs: resolveOrgRecommendationBreakdown(rec.id, built.affectedByOrg?.get(rec.id), statusMap),
          }));
          const filtered = all.filter((rec) =>
            (!input.priority || rec.priority === input.priority)
            && (!input.category || rec.category === input.category)
            && (!input.status || rec.status === input.status));
          return bounded({
            summary: {
              total: all.length,
              open: all.filter((r) => r.status === 'open').length,
              completed: all.filter((r) => r.status === 'completed').length,
              dismissed: all.filter((r) => r.status === 'dismissed').length,
              criticalAndHigh: all.filter((r) => r.priority === 'critical' || r.priority === 'high').length,
            },
            ...pageEnvelope({
              key: 'recommendations',
              items: filtered.slice(page.offset, page.offset + page.limit),
              limit: page.limit, offset: page.offset, fingerprint: page.fingerprint, total: filtered.length,
            }),
          });
        }

        // complete / dismiss: one org-wide status row, as the route writes it.
        const denied = orgWideWriteDenied(auth, 'A recommendation status');
        if (denied) return denied;
        const missing = requireFields(input, ['recommendationId'], action);
        if (missing) return missing;
        const targetOrgId = orgId ?? getPolicyOrgId(auth);
        if (!targetOrgId) return jsonError('orgId is required: choose an organization to act on this recommendation', 'VALIDATION_ERROR');
        const recommendationId = String(input.recommendationId);
        const built = await buildBe9Recommendations(auth, targetOrgId);
        if (built.error) return jsonError(built.error.message, built.error.status === 403 ? 'ACCESS_DENIED' : 'VALIDATION_ERROR');
        if (!built.recommendations.some((rec) => rec.id === recommendationId)) return notFound('Recommendation');

        // The status map reads every complete / dismiss / reopen row whoever wrote it. Attribution follows the AI
        // origin (a person's chat or MCP key → that user; an agent run → the agent; a flow → system automation).
        const actor = auth.aiOrigin
          ? aiOriginAuditActor(auth.aiOrigin, { agentActorId: auth.user.id, humanActorId: auth.user.id })
          : { actorType: 'user' as const, actorId: auth.user.id, initiatedBy: 'ai' as const, originDetails: {} };
        await db.insert(auditLogs).values({
          orgId: targetOrgId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          actorEmail: actor.actorType === 'user' ? auth.user.email : null,
          action: AUDIT_ACTION[action],
          resourceType: 'security_recommendation',
          resourceName: recommendationId,
          details: { recommendationId, ...actor.originDetails },
          result: 'success',
          initiatedBy: actor.initiatedBy,
        });
        return json({ id: recommendationId, orgId: targetOrgId, status: action === 'complete' ? 'completed' : 'dismissed' });
      } catch (error) {
        return thrown(TOOL, error);
      }
    },
  });
}
