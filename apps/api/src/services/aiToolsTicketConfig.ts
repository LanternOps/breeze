/**
 * `manage_ticket_config` (full-control W06, #6776): the AI twin of the PSA
 * ticket-configuration REST surface.
 *
 *   org ticket settings   routes/orgTicketSettings.ts   (organizations:read|write, MFA)
 *   categories            routes/ticketCategories.ts    (tickets:read|write, partner-wide)
 *   statuses/priorities   routes/ticketConfig.ts        (tickets:read|write + admin)
 *   sender domains        routes/ticketConfig.ts        (tickets:read|write + admin)
 *
 * Classes (aiGuardrails.ts, plan W06): the four reads are tier 1; every write is
 * tier 3 supervised, and `delete_domain` is four-eyes (irreversible and
 * partner-wide). The status/priority/domain surface also applies the route's
 * admin predicate in the handler (`ticketConfigAdminDenied`). Every write
 * refuses an `ai_agent` principal: an agent must never reconfigure its own
 * queue. Writes validate `data` with the SAME shared schema as the route.
 */
import { and, eq, isNull } from 'drizzle-orm';
import {
  createCustomerEmailDomainSchema,
  createTicketStatusSchema,
  orgTicketSettingsSchema,
  prioritySettingsSchema,
  reorderTicketStatusesSchema,
  updateCustomerEmailDomainSchema,
  updateTicketStatusSchema,
} from '@breeze/shared';
import { z } from 'zod';
import { db } from '../db';
import { organizations } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { TICKET_CONFIG_ACTIONS } from './aiToolSchemasTicketOps';
import { pageEnvelope, pageParamSchema, readPageArgs } from './aiToolPagination';
import {
  agentRefusal,
  isAgentPrincipal,
  isPartnerOrSystem,
  json,
  jsonError,
  LIST_PAGE,
  parseData,
  partnerIdOrError,
  partnerScopeRequiredError,
  serviceErrorJson,
  ticketConfigAdminDenied,
} from './aiToolsTicketOpsShared';
import { canManagePartnerWidePolicies } from './partnerWideAccess';
import {
  createCategory,
  deleteCategory,
  listCategoryRows,
  reorderCategories,
  updateCategory,
} from './aiToolsTicketCategories';
import {
  createCustomerEmailDomain,
  deleteCustomerEmailDomain,
  getOrgTicketSettings,
  getTicketConfig,
  listCustomerEmailDomains,
  reorderTicketStatuses,
  updateCustomerEmailDomain,
  updateTicketStatus,
  createTicketStatus,
  upsertOrgTicketSettings,
  upsertPrioritySettings,
} from './ticketConfigService';

type ConfigAction = (typeof TICKET_CONFIG_ACTIONS)[number];

const READS = new Set<ConfigAction>(['get_config', 'get_org_settings', 'list_categories', 'list_domains']);
const guid = z.string().guid();

/** An org the caller can reach and that still exists — the route's `resolveAccessibleOrg`. */
async function accessibleOrgId(auth: AuthContext, raw: unknown): Promise<{ orgId: string } | { error: string }> {
  const parsed = guid.safeParse(raw);
  if (!parsed.success) return { error: jsonError('orgId is required and must be an organization UUID', 'VALIDATION_ERROR') };
  const orgId = parsed.data;
  if (auth.scope === 'partner' && !auth.canAccessOrg(orgId)) return { error: jsonError('Organization not found', 'NOT_FOUND') };
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
    .limit(1);
  return rows[0] ? { orgId } : { error: jsonError('Organization not found', 'NOT_FOUND') };
}

export function registerTicketConfigTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_ticket_config', {
    tier: 1,
    domain: 'tickets',
    searchHint: 'ticket categories, statuses, priorities and SLA targets, org ticket settings, customer email domain routing',
    deviceArgs: [],
    definition: {
      name: 'manage_ticket_config',
      description:
        'Ticket config; writes need approval. ' + TICKET_CONFIG_ACTIONS.join(','),
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...TICKET_CONFIG_ACTIONS], description: 'The action to perform' },
          orgId: { type: 'string', description: 'Organization UUID (get_org_settings, update_org_settings)' },
          id: { type: 'string', description: 'Category, status or domain-mapping UUID (update_*/delete_*)' },
          ids: { type: 'array', items: { type: 'string' }, description: 'reorder_*: ids in the new order, each once' },
          data: {
            type: 'object',
            description: 'Write payload as in the UI form: category name/color/parentId; status name/coreStatus; set_priorities {priorities}; domain domain/orgId; org {slaOverrides}',
          },
          ...pageParamSchema(50, 200),
        },
        required: ['action'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as ConfigAction;
      const isRead = READS.has(action);
      if (!TICKET_CONFIG_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);

      // Every REST route here is requireScope('partner','system') except the category list,
      // which also serves an org token its selectable catalog.
      const orgListOk = action === 'list_categories' && auth.scope === 'organization';
      if (!isPartnerOrSystem(auth) && !orgListOk) return partnerScopeRequiredError();
      if (!isRead && isAgentPrincipal(auth)) return agentRefusal(action);

      try {
        // ── org ticket settings ───────────────────────────────────────────────
        if (action === 'get_org_settings' || action === 'update_org_settings') {
          const org = await accessibleOrgId(auth, input.orgId);
          if ('error' in org) return org.error;
          if (action === 'get_org_settings') return json({ settings: await getOrgTicketSettings(org.orgId) });
          const parsed = parseData(orgTicketSettingsSchema, input.data);
          if ('error' in parsed) return parsed.error;
          return json({ settings: await upsertOrgTicketSettings(org.orgId, parsed.value) });
        }

        // ── categories ────────────────────────────────────────────────────────
        if (action === 'list_categories') {
          const page = readPageArgs('manage_ticket_config', input, LIST_PAGE);
          if (!page.ok) return jsonError(page.error, page.code);
          const listed = await listCategoryRows(auth);
          if ('error' in listed) return listed.error;
          const items = listed.rows.slice(page.offset, page.offset + page.limit);
          return json(pageEnvelope({ key: 'categories', items, limit: page.limit, offset: page.offset, fingerprint: page.fingerprint, total: listed.rows.length }));
        }
        if (action === 'create_category') return await createCategory(auth, input.data);
        if (action === 'update_category') return await updateCategory(auth, input.id, input.data);
        if (action === 'delete_category') return await deleteCategory(auth, input.id);
        if (action === 'reorder_categories') return await reorderCategories(auth, input.ids);

        // ── statuses, priorities, sender domains: partner-keyed, admin surface ──
        // The reads of get_config mirror GET / (partner-wide access, no admin role);
        // list_domains mirrors GET /inbound-domains (admin); every write is admin.
        if (action === 'get_config') {
          if (!canManagePartnerWidePolicies(auth)) return jsonError('Full partner organization access is required to manage partner-wide ticket configuration', 'ACCESS_DENIED');
          const p = partnerIdOrError(auth);
          if ('error' in p) return p.error;
          return json(await getTicketConfig(p.partnerId));
        }
        const denied = await ticketConfigAdminDenied(auth);
        if (denied) return denied;
        const p = partnerIdOrError(auth);
        if ('error' in p) return p.error;
        const partnerId = p.partnerId;

        if (action === 'list_domains') {
          const page = readPageArgs('manage_ticket_config', input, LIST_PAGE);
          if (!page.ok) return jsonError(page.error, page.code);
          const rows = await listCustomerEmailDomains(partnerId);
          const items = rows.slice(page.offset, page.offset + page.limit);
          return json(pageEnvelope({ key: 'domains', items, limit: page.limit, offset: page.offset, fingerprint: page.fingerprint, total: rows.length }));
        }
        if (action === 'create_status') {
          const parsed = parseData(createTicketStatusSchema, input.data);
          if ('error' in parsed) return parsed.error;
          return json({ status: await createTicketStatus(partnerId, parsed.value) });
        }
        if (action === 'update_status') {
          const id = guid.safeParse(input.id);
          if (!id.success) return jsonError('id is required and must be a status UUID', 'VALIDATION_ERROR');
          const parsed = parseData(updateTicketStatusSchema, input.data);
          if ('error' in parsed) return parsed.error;
          return json({ status: await updateTicketStatus(partnerId, id.data, parsed.value) });
        }
        if (action === 'reorder_statuses') {
          const parsed = parseData(reorderTicketStatusesSchema, { ids: input.ids });
          if ('error' in parsed) return parsed.error;
          return json(await reorderTicketStatuses(partnerId, parsed.value.ids));
        }
        if (action === 'set_priorities') {
          const parsed = parseData(prioritySettingsSchema, input.data);
          if ('error' in parsed) return parsed.error;
          return json({ priorities: await upsertPrioritySettings(partnerId, parsed.value) });
        }
        if (action === 'create_domain') {
          const parsed = parseData(createCustomerEmailDomainSchema, input.data);
          if ('error' in parsed) return parsed.error;
          return json({ domain: await createCustomerEmailDomain(partnerId, parsed.value, { userId: auth.user.id }) });
        }
        if (action === 'update_domain') {
          const id = guid.safeParse(input.id);
          if (!id.success) return jsonError('id is required and must be a domain-mapping UUID', 'VALIDATION_ERROR');
          const parsed = parseData(updateCustomerEmailDomainSchema, input.data);
          if ('error' in parsed) return parsed.error;
          return json({ domain: await updateCustomerEmailDomain(partnerId, id.data, parsed.value) });
        }
        // delete_domain
        const id = guid.safeParse(input.id);
        if (!id.success) return jsonError('id is required and must be a domain-mapping UUID', 'VALIDATION_ERROR');
        await deleteCustomerEmailDomain(partnerId, id.data);
        return json({ deleted: true, id: id.data });
      } catch (err) {
        const mapped = serviceErrorJson(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  });
}
