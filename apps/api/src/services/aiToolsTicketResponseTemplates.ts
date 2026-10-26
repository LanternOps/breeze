/**
 * `manage_ticket_response_templates` (full-control W06, #6776): the AI twin of
 * routes/tickets/ticketResponseTemplates.ts — the partner's canned replies.
 *
 * The route has no service layer and keys everything on the caller's
 * `partner_id` (never input): partner/system scope, full partner access
 * (`requirePartnerGlobalAccess`, on reads too), `tickets:read|write`. The route
 * validators are local Zod schemas, mirrored here. Writes also carry
 * `requireMfa()` on the route, which is why they are supervised; `delete` is a
 * hard delete on a partner-wide table, so four-eyes. Writes refuse an
 * `ai_agent` principal.
 */
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { ticketResponseTemplates } from '../db/schema';
import type { AiTool } from './aiTools';
import { RESPONSE_TEMPLATE_ACTIONS } from './aiToolSchemasTicketOps';
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
  partnerWideDeniedError,
} from './aiToolsTicketOpsShared';
import { canManagePartnerWidePolicies } from './partnerWideAccess';

type TemplateAction = (typeof RESPONSE_TEMPLATE_ACTIONS)[number];

// Same bounds as the route's local schemas.
const createSchema = z.object({
  name: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  category: z.string().max(100).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});
const updateSchema = createSchema.partial();
const guid = z.string().guid();

export function registerTicketResponseTemplateTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_ticket_response_templates', {
    tier: 1,
    domain: 'tickets',
    searchHint: 'canned ticket reply templates for the whole partner: list, create, edit, delete',
    deviceArgs: [],
    definition: {
      name: 'manage_ticket_response_templates',
      description:
        'Partner-wide canned ticket replies. Actions: list,create,update,delete. Writes need approval; delete needs a second approver and is permanent.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...RESPONSE_TEMPLATE_ACTIONS], description: 'The action to perform' },
          id: { type: 'string', description: 'Template UUID (update/delete)' },
          data: {
            type: 'object',
            description: 'create/update payload: name (max 200), body (max 5000), category, sortOrder, isActive',
          },
          ...pageParamSchema(50, 200),
        },
        required: ['action'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as TemplateAction;
      if (!RESPONSE_TEMPLATE_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      // requireScope('partner','system') + requirePartnerGlobalAccess, on every route including the list.
      if (!isPartnerOrSystem(auth)) return partnerScopeRequiredError();
      if (!canManagePartnerWidePolicies(auth)) return partnerWideDeniedError();
      if (action !== 'list' && isAgentPrincipal(auth)) return agentRefusal(action);
      const p = partnerIdOrError(auth);
      if ('error' in p) return p.error;
      const partnerId = p.partnerId;

      if (action === 'list') {
        const page = readPageArgs('manage_ticket_response_templates', input, LIST_PAGE);
        if (!page.ok) return jsonError(page.error, page.code);
        const rows = await db
          .select()
          .from(ticketResponseTemplates)
          .where(and(eq(ticketResponseTemplates.partnerId, partnerId), eq(ticketResponseTemplates.isActive, true)))
          .orderBy(asc(ticketResponseTemplates.category), asc(ticketResponseTemplates.sortOrder), asc(ticketResponseTemplates.name));
        const items = rows.slice(page.offset, page.offset + page.limit);
        return json(pageEnvelope({ key: 'templates', items, limit: page.limit, offset: page.offset, fingerprint: page.fingerprint, total: rows.length }));
      }

      if (action === 'create') {
        const parsed = parseData(createSchema, input.data);
        if ('error' in parsed) return parsed.error;
        const data = parsed.value;
        const [row] = await db
          .insert(ticketResponseTemplates)
          .values({
            partnerId,
            name: data.name.trim(),
            body: data.body,
            category: data.category ?? null,
            sortOrder: data.sortOrder ?? 0,
            isActive: data.isActive ?? true,
            createdBy: auth.user.id ?? null,
          })
          .returning();
        if (!row) return jsonError('Failed to create template');
        return json({ template: row });
      }

      const id = guid.safeParse(input.id);
      if (!id.success) return jsonError(`id (template UUID) is required for ${action}`, 'VALIDATION_ERROR');

      if (action === 'update') {
        const parsed = parseData(updateSchema, input.data);
        if ('error' in parsed) return parsed.error;
        const data = parsed.value;
        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if (data.name !== undefined) patch.name = data.name.trim();
        if (data.body !== undefined) patch.body = data.body;
        if (data.category !== undefined) patch.category = data.category;
        if (data.sortOrder !== undefined) patch.sortOrder = data.sortOrder;
        if (data.isActive !== undefined) patch.isActive = data.isActive;
        if (Object.keys(patch).length === 1) return jsonError('update needs at least one field in data', 'VALIDATION_ERROR');
        const [row] = await db
          .update(ticketResponseTemplates)
          .set(patch)
          .where(and(eq(ticketResponseTemplates.id, id.data), eq(ticketResponseTemplates.partnerId, partnerId)))
          .returning();
        return row ? json({ template: row }) : jsonError('Template not found', 'NOT_FOUND');
      }

      // delete
      const [row] = await db
        .delete(ticketResponseTemplates)
        .where(and(eq(ticketResponseTemplates.id, id.data), eq(ticketResponseTemplates.partnerId, partnerId)))
        .returning();
      return row ? json({ deleted: true, id: id.data }) : jsonError('Template not found', 'NOT_FOUND');
    },
  });
}
