/**
 * Input schemas for the W06 PSA configuration + ticket-ops tools (full-control
 * W06, #6776). Plain strict `z.object`s with an `action` enum (not unions or
 * refined schemas) so `toolActionEnum` can read `.shape.action.options` and the
 * chat SDK `tool()` declarations can take `.shape` directly (`inputShape()` in
 * aiAgentSdkTools.ts). Per-action required fields and the field bounds are
 * enforced in the handlers through the SAME shared validators the REST routes
 * use (`parseData`), which is why `data` is an open record here. No
 * `z.undefined()` anywhere: it empties the model's tool list.
 *
 * The keys, enums and page parameters mirror each tool's registry
 * `input_schema` one-for-one; aiToolSchemas.ticketOps.test.ts pins that.
 */
import { z } from 'zod';
import { pageZodShape } from './aiToolPagination';


// The action vocabularies live here (a light module) and the handler files import
// them, so the schema graph never pulls in the db-bound handlers.
export const TICKET_CONFIG_ACTIONS = [
  'get_config', 'get_org_settings', 'list_categories', 'list_domains',
  'update_org_settings', 'create_category', 'update_category', 'delete_category', 'reorder_categories',
  'create_status', 'update_status', 'reorder_statuses', 'set_priorities',
  'create_domain', 'update_domain', 'delete_domain',
] as const;
export const CHECKLIST_TEMPLATE_ACTIONS = [
  'list', 'get', 'create', 'update', 'delete', 'add_item', 'update_item', 'remove_item', 'reorder_items',
] as const;
export const TICKET_INBOX_ACTIONS = ['list', 'convert', 'dismiss'] as const;
export const TICKET_ATTACHMENT_ACTIONS = ['list', 'read_content', 'attach_from_artifact', 'delete'] as const;
export const TICKET_FORM_ACTIONS = ['list', 'available', 'create', 'update', 'delete'] as const;
export const RESPONSE_TEMPLATE_ACTIONS = ['list', 'create', 'update', 'delete'] as const;
export const TIME_SUGGESTION_ACTIONS = ['list', 'confirm', 'dismiss', 'undo'] as const;

const uuid = z.string().guid();
const data = z.record(z.string(), z.unknown());

export const ticketOpsToolShapes = {
  manage_ticket_config: {
    action: z.enum(TICKET_CONFIG_ACTIONS),
    orgId: uuid.optional(),
    id: uuid.optional(),
    ids: z.array(uuid).min(1).max(200).optional(),
    data: data.optional(),
    ...pageZodShape(50, 200),
  },
  manage_ticket_checklist_templates: {
    action: z.enum(CHECKLIST_TEMPLATE_ACTIONS),
    id: uuid.optional(),
    itemId: uuid.optional(),
    itemIds: z.array(uuid).min(1).max(500).optional(),
    orgId: uuid.optional(),
    includeInactive: z.boolean().optional(),
    data: data.optional(),
    ...pageZodShape(50, 200),
  },
  manage_ticket_inbox: {
    action: z.enum(TICKET_INBOX_ACTIONS),
    id: uuid.optional(),
    orgId: uuid.optional(),
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  manage_ticket_attachments: {
    action: z.enum(TICKET_ATTACHMENT_ACTIONS),
    ticketId: uuid,
    attachmentId: uuid.optional(),
    artifactId: uuid.optional(),
    ...pageZodShape(50, 200),
  },
  manage_ticket_forms: {
    action: z.enum(TICKET_FORM_ACTIONS),
    id: uuid.optional(),
    orgId: uuid.optional(),
    data: data.optional(),
    ...pageZodShape(50, 200),
  },
  manage_ticket_response_templates: {
    action: z.enum(RESPONSE_TEMPLATE_ACTIONS),
    id: uuid.optional(),
    data: data.optional(),
    ...pageZodShape(50, 200),
  },
  manage_time_suggestions: {
    action: z.enum(TIME_SUGGESTION_ACTIONS),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').optional(),
    tz: z.string().min(1).max(64).optional(),
    signals: z.array(data).min(1).max(100).optional(),
    data: data.optional(),
  },
} as const;

export const ticketOpsToolSchemas: Record<string, z.ZodType> = Object.fromEntries(
  Object.entries(ticketOpsToolShapes).map(([name, shape]) => [name, z.object(shape).strict()]),
);
