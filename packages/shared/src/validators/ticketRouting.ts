import { z } from 'zod';
import { ticketPrioritySchema, ticketSourceSchema } from './tickets';

// Ticket routing rules (#8883 W5, spec §5.1, §5.5). Shared by the API routes
// (zValidator), the AI tool schemas and the web Routing tab.
//
// Conditions: AND across fields, OR within a list; null / absent = any. A rule
// must set at least one action — enforced by the API service on create AND on
// the merged row after an update (400 ROUTING_RULE_NO_ACTION, Gate B13), not
// here, because a PATCH is partial.
//
// zod 4.6 notes: .max() counts code points; refinements on the object run only
// when every field parsed, so per-field limits live on the fields.

export const ROUTING_RULE_NAME_MAX = 100;
export const ROUTING_RULE_KEYWORDS_MAX = 20;
export const ROUTING_RULE_KEYWORD_MIN = 2;
export const ROUTING_RULE_KEYWORD_MAX = 100;
export const ROUTING_RULE_DOMAINS_MAX = 50;
export const ROUTING_RULE_TAGS_MAX = 20;
export const ROUTING_RULE_TAG_MAX = 50;
export const ROUTING_RULE_ORG_LINKS_MAX = 500;
export const ROUTING_RULE_REORDER_MAX = 500;

const uuid = z.string().guid();
const dedupe = <T>(list: T[]): T[] => [...new Set(list)];

const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_RE = new RegExp(`^(?:\\*\\.)?${label}(?:\\.${label})+$`);

/** An exact host (`example.com`) or a subdomain wildcard (`*.example.com`); stored lower-cased. */
export const routingRequesterDomainSchema = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.string().max(253).regex(HOST_RE, 'Use a host like example.com or *.example.com'));

const keywordSchema = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.string().min(ROUTING_RULE_KEYWORD_MIN).max(ROUTING_RULE_KEYWORD_MAX));

const tagSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(ROUTING_RULE_TAG_MAX));

const ruleFields = {
  name: z.string().trim().min(1).max(ROUTING_RULE_NAME_MAX),
  enabled: z.boolean().optional(),
  position: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  // Conditions
  matchSources: z.array(ticketSourceSchema).max(6).transform(dedupe).nullable().optional(),
  matchPriorities: z.array(ticketPrioritySchema).max(4).transform(dedupe).nullable().optional(),
  matchCategoryId: uuid.nullable().optional(),
  matchSubjectKeywords: z.array(keywordSchema).max(ROUTING_RULE_KEYWORDS_MAX).transform(dedupe).nullable().optional(),
  matchRequesterDomains: z.array(routingRequesterDomainSchema).max(ROUTING_RULE_DOMAINS_MAX).transform(dedupe).nullable().optional(),
  // Actions
  setAssigneeUserId: uuid.nullable().optional(),
  setPriority: ticketPrioritySchema.nullable().optional(),
  setCategoryId: uuid.nullable().optional(),
  // Core status must be new / open / pending / on_hold — checked by the
  // service against the partner's ticket_statuses row.
  setStatusId: uuid.nullable().optional(),
  addTags: z.array(tagSchema).max(ROUTING_RULE_TAGS_MAX).transform(dedupe).nullable().optional(),
  // Partner-wide rules only: null = every org of the partner; a non-empty list
  // = only those orgs (stored as org_scoped + ticket_routing_rule_org_links).
  orgIds: z.array(uuid).min(1, 'Pick at least one organization, or apply the rule to all organizations')
    .max(ROUTING_RULE_ORG_LINKS_MAX).transform(dedupe).nullable().optional(),
};

const ruleObject = z.object(ruleFields);

export const ticketRoutingOwnerScopeSchema = z.enum(['organization', 'partner']);
export type TicketRoutingOwnerScope = z.infer<typeof ticketRoutingOwnerScopeSchema>;

export const createTicketRoutingRuleSchema = ruleObject
  .extend({
    ownerScope: ticketRoutingOwnerScopeSchema,
    orgId: uuid.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.ownerScope === 'organization' && !v.orgId) {
      ctx.addIssue({ code: 'custom', path: ['orgId'], message: 'orgId is required for an organization rule' });
    }
    if (v.ownerScope === 'partner' && v.orgId) {
      ctx.addIssue({ code: 'custom', path: ['orgId'], message: 'A partner-wide rule has no orgId; use orgIds to limit it' });
    }
    if (v.ownerScope === 'organization' && v.orgIds != null) {
      ctx.addIssue({ code: 'custom', path: ['orgIds'], message: 'Only a partner-wide rule can be limited to organizations' });
    }
  });
export type CreateTicketRoutingRuleInput = z.infer<typeof createTicketRoutingRuleSchema>;

/** Ownership (ownerScope / orgId) is create-only. */
export const updateTicketRoutingRuleSchema = ruleObject.partial();
export type UpdateTicketRoutingRuleInput = z.infer<typeof updateTicketRoutingRuleSchema>;

/** One owner's rules in their new order (positions become 0..n-1). */
export const reorderTicketRoutingRulesSchema = z.object({
  ids: z.array(uuid).min(1).max(ROUTING_RULE_REORDER_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate rule id'),
});
export type ReorderTicketRoutingRulesInput = z.infer<typeof reorderTicketRoutingRulesSchema>;

export const listTicketRoutingRulesQuerySchema = z.object({ orgId: uuid.optional() });

/** POST /ticket-routing-rules/test — a dry run through the same evaluator; writes nothing. */
export const testTicketRoutingRuleSchema = z.object({
  orgId: uuid,
  source: ticketSourceSchema,
  subject: z.string().trim().min(1).max(255),
  requesterEmail: z.string().trim().max(320).nullable(),
  categoryId: uuid.optional(),
  priority: ticketPrioritySchema.optional(),
});
export type TestTicketRoutingRuleInput = z.infer<typeof testTicketRoutingRuleSchema>;

export const ticketRoutingSkipReasonSchema = z.enum([
  'assignee_ineligible',
  'assignee_deleted',
  'category_foreign',
  'status_foreign',
  'status_inactive',
  'status_core_not_allowed',
]);
export type TicketRoutingSkipReason = z.infer<typeof ticketRoutingSkipReasonSchema>;

/** The wire shape of a rule (GET list / POST / PATCH responses). */
export type TicketRoutingRule = {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
  enabled: boolean;
  position: number;
  matchSources: z.infer<typeof ticketSourceSchema>[] | null;
  matchPriorities: z.infer<typeof ticketPrioritySchema>[] | null;
  matchCategoryId: string | null;
  matchSubjectKeywords: string[] | null;
  matchRequesterDomains: string[] | null;
  setAssigneeUserId: string | null;
  setPriority: z.infer<typeof ticketPrioritySchema> | null;
  setCategoryId: string | null;
  setStatusId: string | null;
  addTags: string[] | null;
  /** null for an org rule and for a partner-wide rule that applies to every org. */
  orgIds: string[] | null;
  createdAt: string;
  updatedAt: string;
};

/** The wire shape of POST /ticket-routing-rules/test. */
export type TicketRoutingTestResult = {
  ruleId: string | null;
  ruleName: string | null;
  applied: Partial<{ assigneeId: string; priority: z.infer<typeof ticketPrioritySchema>; categoryId: string; statusId: string; tags: string[] }>;
  skipped: { action: 'set_assignee' | 'set_category' | 'set_status'; reason: TicketRoutingSkipReason }[];
};
