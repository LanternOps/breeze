/**
 * `apply_topology_template` (full-control W08, #6778): the AI twin of
 * routes/topology/templateApplications.ts — preview a template application to
 * named sites, apply the previewed effect, read an application's outcome.
 *
 * Actions and classes (aiGuardrails.ts, plan W08):
 *  - `preview` — tier 2: it persists a short-lived preview record (and a
 *    single-use token) but changes no site configuration. Each named site is
 *    checked with the route's `write` capability; a site outside the caller's
 *    ceilings is an indistinguishable `topology_site_not_found`.
 *  - `apply` — SUPERVISED: it rewrites the monitoring configuration of every
 *    previewed site. The approval is for the preview token the person just
 *    read in this chat. The release rebuilds the REQUESTER's auth (W08-D2:
 *    `actorContext.ts` carries the requester's live session epochs for this one
 *    action) because `freezeApplicationActor` needs a `user_session` with
 *    epochs. The idempotency key is derived from the token, so a replayed
 *    release is the same application.
 *  - `status` — tier 1 read.
 *
 * Principal matrix (the service refuses anything else, nothing is relabelled
 * to pass): a signed-in person's session works for all three; an MCP key or an
 * agent principal has no session epochs and gets `topology_permission_denied`.
 */
import { createHash } from 'node:crypto';
import { topologyTemplateApplyRequestSchema, topologyTemplatePreviewRequestSchema } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { TOPOLOGY_APPLY_ACTIONS } from './aiToolSchemasTopologyOps';
import {
  agentRefusal, boundedJson, hiddenSiteResult, isAgentPrincipal, jsonError, requireFields, topologyPermissions, topologyThrown,
} from './aiToolsTopologyShared';
import { applyTopologyTemplatePreview, getTopologyTemplateApplication, previewTopologyTemplateApplication } from './topology/templateApply';

type Action = (typeof TOPOLOGY_APPLY_ACTIONS)[number];

/** A site outside the caller's site allowlist is the same indistinguishable refusal the site gate gives. */
function siteHidden(auth: AuthContext, siteId: unknown): boolean {
  return typeof siteId === 'string' && auth.canAccessSite !== undefined && !auth.canAccessSite(siteId);
}

/** A stable key per preview token: the same approved token is the same application. */
export function applyIdempotencyKey(token: string): string {
  return `ai-apply-${createHash('sha256').update(token).digest('hex').slice(0, 48)}`;
}

export function registerTopologyApplyTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('apply_topology_template', {
    tier: 1,
    domain: 'network',
    searchHint: 'preview and apply a published topology template to sites, check an application\'s progress',
    deviceArgs: [],
    captureExempt: true,
    definition: {
      name: 'apply_topology_template',
      description:
        'Apply a published topology template to sites. Actions: preview,apply,status. preview takes partnerVersionId, orgVersionId and sites; apply takes the preview token and needs approval; status takes operationId.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...TOPOLOGY_APPLY_ACTIONS], description: 'The action to perform' },
          partnerVersionId: { type: 'string', description: 'preview: published partner template version UUID, or null' },
          orgVersionId: { type: 'string', description: 'preview: published organization template version UUID, or null' },
          sites: {
            type: 'array',
            description: 'preview: sites to apply to (max 100) with the binding revision you last read',
            items: {
              type: 'object',
              properties: {
                siteId: { type: 'string', description: 'Site UUID' },
                expectedBindingRevision: { type: 'string', description: 'Binding revision from get_settings' },
                overrides: { type: 'object', description: 'Optional site-level overrides' },
              },
              required: ['siteId', 'expectedBindingRevision'],
              additionalProperties: false,
            },
          },
          token: { type: 'string', description: 'apply: the single-use token returned by preview' },
          operationId: { type: 'string', description: 'status: application UUID returned by apply' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!TOPOLOGY_APPLY_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      if (action !== 'status' && isAgentPrincipal(auth)) return agentRefusal(action);
      const permissions = await topologyPermissions(auth);
      if (!permissions) return jsonError('Topology permission denied', 'topology_permission_denied');
      try {
        switch (action) {
          case 'preview': {
            const missing = requireFields(input, ['sites'], action);
            if (missing) return missing;
            const named = Array.isArray(input.sites) ? (input.sites as Array<{ siteId?: unknown }>) : [];
            if (named.some((entry) => siteHidden(auth, entry.siteId))) return hiddenSiteResult();
            const request = topologyTemplatePreviewRequestSchema.parse({
              partnerVersionId: input.partnerVersionId ?? null,
              orgVersionId: input.orgVersionId ?? null,
              sites: input.sites,
            });
            return boundedJson(await previewTopologyTemplateApplication(auth, permissions, request));
          }
          case 'apply': {
            const missing = requireFields(input, ['token'], action);
            if (missing) return missing;
            const { token } = topologyTemplateApplyRequestSchema.parse({ token: input.token });
            return boundedJson(await applyTopologyTemplatePreview(auth, permissions, token, applyIdempotencyKey(token)));
          }
          case 'status': {
            const missing = requireFields(input, ['operationId'], action);
            if (missing) return missing;
            return boundedJson(await getTopologyTemplateApplication(auth, permissions, String(input.operationId)));
          }
        }
      } catch (error) {
        return topologyThrown('apply_topology_template', error);
      }
    },
  });
}
