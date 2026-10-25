/**
 * `manage_ticket_checklist_templates` (full-control W06, #6776, #6141 P1): the
 * AI twin of routes/ticketChecklistTemplates.ts — template and item CRUD.
 *
 * Applying a template to a ticket, saving a ticket as a template and
 * duplicating one stay on `manage_ticket_checklist` (#6930); this tool is the
 * authoring side. Same service (`ticketChecklistTemplateService`), so the
 * dual-axis visibility, the partner-wide write gate (`canManagePartnerWidePolicies`
 * → `PartnerWideWriteDeniedError`) and the in-use delete guard are the route's.
 *
 * Classes (aiGuardrails.ts): list/get tier 1; create is input-aware
 * (`ownerScope:'partner'` supervised, an org-owned template tier 2); update and
 * the four item actions are supervised (ownership is DB state); delete is
 * four-eyes (irreversible, possibly partner-wide). Writes refuse an `ai_agent`
 * principal: the service stamps created_by with a users FK.
 */
import {
  checklistTemplateItemReorderSchema,
  createChecklistTemplateItemSchema,
  createChecklistTemplateSchema,
  updateChecklistTemplateItemSchema,
  updateChecklistTemplateSchema,
} from '@breeze/shared';
import { z } from 'zod';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { CHECKLIST_TEMPLATE_ACTIONS } from './aiToolSchemasTicketOps';
import { pageEnvelope, pageParamSchema, readPageArgs } from './aiToolPagination';
import {
  addChecklistTemplateItem,
  createChecklistTemplate,
  deleteChecklistTemplate,
  getChecklistTemplate,
  listChecklistTemplates,
  removeChecklistTemplateItem,
  reorderChecklistTemplateItems,
  updateChecklistTemplate,
  updateChecklistTemplateItem,
  type ChecklistTemplateActor,
} from './ticketChecklistTemplateService';
import {
  agentRefusal,
  isAgentPrincipal,
  isPartnerOrSystem,
  json,
  jsonError,
  LIST_PAGE,
  parseData,
  partnerScopeRequiredError,
  serviceErrorJson,
} from './aiToolsTicketOpsShared';

type TemplateAction = (typeof CHECKLIST_TEMPLATE_ACTIONS)[number];
const READS = new Set<TemplateAction>(['list', 'get']);
const guid = z.string().guid();

/** Carries `scope` and `partnerOrgAccess` through — the service needs BOTH (templateActorFrom in the route). */
function templateActor(auth: AuthContext): ChecklistTemplateActor {
  return {
    userId: auth.user?.id ?? null,
    scope: auth.scope,
    partnerId: auth.partnerId ?? null,
    partnerOrgAccess: auth.partnerOrgAccess ?? null,
    accessibleOrgIds: auth.accessibleOrgIds,
  };
}

export function registerTicketChecklistTemplateTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_ticket_checklist_templates', {
    tier: 1,
    domain: 'tickets',
    searchHint: 'author ticket checklist templates and steps: create, edit, reorder, delete (apply one: manage_ticket_checklist)',
    deviceArgs: [],
    definition: {
      name: 'manage_ticket_checklist_templates',
      description:
        'Checklist template authoring; writes need approval. Actions: ' + CHECKLIST_TEMPLATE_ACTIONS.join(',') +
        '. Apply to a ticket with manage_ticket_checklist.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...CHECKLIST_TEMPLATE_ACTIONS], description: 'The action to perform' },
          id: { type: 'string', description: 'Template UUID (get/update/delete/add_item/reorder_items)' },
          itemId: { type: 'string', description: 'Template item UUID (update_item/remove_item)' },
          itemIds: { type: 'array', items: { type: 'string' }, description: "reorder_items: the template's COMPLETE item id list in the new order" },
          orgId: { type: 'string', description: 'list: only templates usable for this organization' },
          includeInactive: { type: 'boolean', description: 'list: include inactive templates (default false)' },
          data: {
            type: 'object',
            description: 'Write payload as in the UI. create: name, ownerScope organization|partner, orgId, items[{label}]. update: name, isActive. items: label, detail',
          },
          ...pageParamSchema(50, 200),
        },
        required: ['action'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as TemplateAction;
      if (!CHECKLIST_TEMPLATE_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      // routes/ticketChecklistTemplates.ts is requireScope('partner','system').
      if (!isPartnerOrSystem(auth)) return partnerScopeRequiredError();
      if (!READS.has(action) && isAgentPrincipal(auth)) return agentRefusal(action);
      const actor = templateActor(auth);

      try {
        if (action === 'list') {
          const page = readPageArgs('manage_ticket_checklist_templates', input, LIST_PAGE);
          if (!page.ok) return jsonError(page.error, page.code);
          const orgId = input.orgId === undefined ? undefined : guid.safeParse(input.orgId);
          if (orgId && !orgId.success) return jsonError('orgId must be an organization UUID', 'VALIDATION_ERROR');
          const rows = await listChecklistTemplates(actor, {
            orgId: orgId?.success ? orgId.data : undefined,
            includeInactive: input.includeInactive === true,
          });
          const items = rows.slice(page.offset, page.offset + page.limit);
          return json(pageEnvelope({ key: 'templates', items, limit: page.limit, offset: page.offset, fingerprint: page.fingerprint, total: rows.length }));
        }
        if (action === 'create') {
          const parsed = parseData(createChecklistTemplateSchema, input.data);
          if ('error' in parsed) return parsed.error;
          return json({ template: await createChecklistTemplate(parsed.value, actor) });
        }

        const id = guid.safeParse(input.id);
        const itemId = guid.safeParse(input.itemId);
        if (action === 'update_item' || action === 'remove_item') {
          if (!itemId.success) return jsonError(`itemId is required for ${action}`, 'VALIDATION_ERROR');
          if (action === 'remove_item') {
            await removeChecklistTemplateItem(itemId.data, actor);
            return json({ removed: true, itemId: itemId.data });
          }
          const parsed = parseData(updateChecklistTemplateItemSchema, input.data);
          if ('error' in parsed) return parsed.error;
          return json({ item: await updateChecklistTemplateItem(itemId.data, parsed.value, actor) });
        }

        if (!id.success) return jsonError(`id (template UUID) is required for ${action}`, 'VALIDATION_ERROR');
        if (action === 'get') return json({ template: await getChecklistTemplate(id.data, actor) });
        if (action === 'delete') {
          await deleteChecklistTemplate(id.data, actor);
          return json({ deleted: true, id: id.data });
        }
        if (action === 'update') {
          const parsed = parseData(updateChecklistTemplateSchema, input.data);
          if ('error' in parsed) return parsed.error;
          return json({ template: await updateChecklistTemplate(id.data, parsed.value, actor) });
        }
        if (action === 'add_item') {
          const parsed = parseData(createChecklistTemplateItemSchema, input.data);
          if ('error' in parsed) return parsed.error;
          return json({ item: await addChecklistTemplateItem(id.data, parsed.value, actor) });
        }
        // reorder_items
        const parsed = parseData(checklistTemplateItemReorderSchema, { itemIds: input.itemIds });
        if ('error' in parsed) return parsed.error;
        return json({ items: await reorderChecklistTemplateItems(id.data, parsed.value.itemIds, actor) });
      } catch (err) {
        const mapped = serviceErrorJson(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  });
}
