/**
 * `manage_topology_templates` (full-control W08, #6778): the AI twin of the
 * template-library routes in routes/topology/templates.ts — partner- or
 * organization-owned monitoring-configuration templates, their versions, and
 * the published versions a site may apply.
 *
 * Actions and classes (aiGuardrails.ts, plan W08):
 *  - `list_templates`, `list_versions`, `site_options` — tier 1 reads.
 *  - `create_template`, `update_template`, `create_version` — tier 2: a draft or
 *    metadata edit with a revision compare-and-swap; nothing is appliable until
 *    a version is published.
 *  - `publish_version`, `revoke_template` — SUPERVISED. Publishing makes a
 *    version appliable partner- or organization-wide and cannot be unpublished;
 *    revoking is terminal and disables every policy that references the
 *    template (`template_revocation_terminal`). `update_template` refuses
 *    `lifecycle: revoked` so the supervised action is the only way.
 *
 * Authorization is the service's own (`assertTopologyTemplateAccess`):
 * topology + devices grants, satisfied MFA and no `ai_agent` principal for a
 * write, `canManagePartnerWidePolicies` for a partner-owned template, and
 * `canReadPartnerWideRows` to read one; an org caller cannot touch a
 * partner-wide row.
 */
import {
  createTopologyTemplate, createTopologyTemplateSchema, createTopologyTemplateVersion, createTopologyTemplateVersionSchema,
  listEligibleTopologyVersions, listTopologyTemplates, listTopologyTemplateVersions, publishTopologyTemplateVersion,
  publishTopologyTemplateVersionSchema, updateTopologyTemplate, updateTopologyTemplateSchema,
} from './topology/templateLibrary';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { TOPOLOGY_TEMPLATE_ACTIONS } from './aiToolSchemasTopologyOps';
import {
  agentRefusal, boundedJson, committedJson, defined, hiddenSiteResult, isAgentPrincipal, jsonError, requireFields, topologyPermissions, topologySite, topologyThrown,
} from './aiToolsTopologyShared';

type Action = (typeof TOPOLOGY_TEMPLATE_ACTIONS)[number];

const WRITE_ACTIONS: ReadonlySet<Action> = new Set(['create_template', 'update_template', 'revoke_template', 'create_version', 'publish_version']);

/** A site outside the caller's site allowlist is the same indistinguishable refusal the site gate gives. */
function siteHidden(auth: AuthContext, siteId: unknown): boolean {
  return typeof siteId === 'string' && auth.canAccessSite !== undefined && !auth.canAccessSite(siteId);
}

const page = (input: Record<string, unknown>) => defined({ cursor: input.cursor as string | undefined, limit: input.limit as number | undefined });

export function registerTopologyTemplateTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_topology_templates', {
    tier: 1,
    domain: 'network',
    searchHint: 'topology monitoring templates and versions: list, draft, publish, revoke; templates a site can apply',
    deviceArgs: [],
    captureExempt: true,
    definition: {
      name: 'manage_topology_templates',
      description:
        'Topology monitoring templates. Reads: list_templates (ownerScope),list_versions (templateId),site_options (siteId). Writes: create_template,update_template,revoke_template,create_version,publish_version (needs approval; partner-wide).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...TOPOLOGY_TEMPLATE_ACTIONS], description: 'The action to perform' },
          siteId: { type: 'string', description: 'site_options: site UUID' },
          ownerScope: { type: 'string', enum: ['partner', 'organization'], description: 'list_templates/create_template: whose template (partner-wide or one organization)' },
          orgId: { type: 'string', description: 'list_templates/create_template with ownerScope organization: org UUID (default your org)' },
          templateId: { type: 'string', description: 'update/revoke/versions/publish: template UUID' },
          versionId: { type: 'string', description: 'publish_version: version UUID' },
          key: { type: 'string', description: 'create_template: stable key, lowercase letters, digits, - and _ (max 64)' },
          name: { type: 'string', description: 'create_template/update_template: display name' },
          description: { type: 'string', description: 'create_template/update_template: description (max 2048)' },
          lifecycle: { type: 'string', enum: ['active', 'archived'], description: 'update_template: lifecycle (revoking is revoke_template)' },
          payload: { type: 'object', description: 'create_version: the site configuration layer (validated server-side)' },
          expectedRevision: { type: 'string', description: 'update/revoke/create_version: the template revision you last read' },
          expectedTemplateRevision: { type: 'string', description: 'publish_version: the template revision you last read' },
          expectedVersionRevision: { type: 'string', description: 'publish_version: the version revision you last read' },
          cursor: { type: 'string', description: 'list: continuation cursor' },
          limit: { type: 'number', description: 'Max rows per list page (default 100, max 200)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!TOPOLOGY_TEMPLATE_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      if (WRITE_ACTIONS.has(action) && isAgentPrincipal(auth)) return agentRefusal(action);
      try {
        if (action === 'site_options') {
          const missing = requireFields(input, ['siteId'], action);
          if (missing) return missing;
          if (siteHidden(auth, input.siteId)) return hiddenSiteResult();
          const site = await topologySite(auth, input.siteId, 'read');
          if ('error' in site) return site.error;
          return boundedJson(await listEligibleTopologyVersions(site.ctx, page(input)));
        }
        const permissions = await topologyPermissions(auth);
        if (!permissions) return jsonError('Topology permission denied', 'topology_permission_denied');
        switch (action) {
          case 'list_templates': {
            const missing = requireFields(input, ['ownerScope'], action);
            if (missing) return missing;
            return boundedJson(await listTopologyTemplates(auth, permissions, defined({
              ownerScope: input.ownerScope as 'partner', orgId: input.orgId as string | undefined, ...page(input),
            }) as never));
          }
          case 'list_versions': {
            const missing = requireFields(input, ['templateId'], action);
            if (missing) return missing;
            return boundedJson(await listTopologyTemplateVersions(auth, permissions, String(input.templateId), page(input)));
          }
          case 'create_template': {
            const missing = requireFields(input, ['ownerScope', 'key', 'name'], action);
            if (missing) return missing;
            return committedJson(await createTopologyTemplate(auth, permissions, createTopologyTemplateSchema.parse(defined({
              ownerScope: input.ownerScope, orgId: input.orgId, key: input.key, name: input.name, description: input.description ?? undefined,
            }))));
          }
          case 'update_template': {
            const missing = requireFields(input, ['templateId', 'expectedRevision'], action);
            if (missing) return missing;
            return committedJson(await updateTopologyTemplate(auth, permissions, String(input.templateId), updateTopologyTemplateSchema.parse(defined({
              expectedRevision: input.expectedRevision, name: input.name, description: input.description, lifecycle: input.lifecycle,
            }))));
          }
          case 'revoke_template': {
            const missing = requireFields(input, ['templateId', 'expectedRevision'], action);
            if (missing) return missing;
            return committedJson(await updateTopologyTemplate(auth, permissions, String(input.templateId), updateTopologyTemplateSchema.parse({
              expectedRevision: input.expectedRevision, lifecycle: 'revoked',
            })));
          }
          case 'create_version': {
            const missing = requireFields(input, ['templateId', 'expectedRevision', 'payload'], action);
            if (missing) return missing;
            return committedJson(await createTopologyTemplateVersion(auth, permissions, String(input.templateId), createTopologyTemplateVersionSchema.parse({
              expectedRevision: input.expectedRevision, payload: input.payload, schemaVersion: 1, defaultsVersion: 1, resolverVersion: 1,
            })));
          }
          case 'publish_version': {
            const missing = requireFields(input, ['templateId', 'versionId', 'expectedTemplateRevision', 'expectedVersionRevision'], action);
            if (missing) return missing;
            return committedJson(await publishTopologyTemplateVersion(
              auth, permissions, String(input.templateId), String(input.versionId),
              publishTopologyTemplateVersionSchema.parse({
                expectedTemplateRevision: input.expectedTemplateRevision, expectedVersionRevision: input.expectedVersionRevision,
              }),
            ));
          }
        }
      } catch (error) {
        return topologyThrown('manage_topology_templates', error);
      }
    },
  });
}
