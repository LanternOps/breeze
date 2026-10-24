/**
 * Ticket routing rule AI tools (#8883 W5, spec §5.1, §5.4, §5.5).
 *
 *  - list_ticket_routing_rules (Tier 1, tickets.read): the rules the caller can
 *    see (an org's own plus its partner's partner-wide ones), in evaluation order.
 *  - test_ticket_routing_rule (Tier 1, tickets.read): dry run through the SAME
 *    evaluator createTicket uses; writes nothing.
 *  - manage_ticket_routing_rules (Tier 3 supervised, tickets.write):
 *    create / update / reorder / delete. One approver; not four-eyes.
 *
 * Every write goes through services/ticketRouting/service.ts, which enforces
 * the partner-wide capability gate (canManagePartnerWidePolicies →
 * PartnerWideWriteDeniedError) and the org-access checks, so a tool cannot skip
 * them. The service (and the shared validators) are imported lazily: they
 * import the db graph, which the tool hub must not pull in at module load.
 */
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { captureException } from './sentry';

const json = (v: unknown) => JSON.stringify(v);

const UUID = { type: 'string', description: 'UUID' } as const;
const STRING_LIST = (description: string) => ({ type: 'array', items: { type: 'string' }, description });
const SOURCES = ['portal', 'email', 'alert', 'manual', 'api', 'ai'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

export function registerTicketRoutingTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_ticket_routing_rules', {
    tier: 1,
    domain: 'tickets',
    searchHint: 'ticket routing rules, auto-assign tickets, set priority category status tags on new tickets, inbound email routing',
    deviceArgs: [],
    definition: {
      name: 'list_ticket_routing_rules',
      description: "List ticket routing rules (conditions and actions applied to new tickets), in evaluation order, including the partner's all-organizations rules.",
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: "Only this organization's rules plus the partner-wide ones that apply to it (UUID)." },
          limit: { type: 'integer', description: 'Max rules (default 100, max 200)' },
        },
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext): Promise<string> => {
      const { listRoutingRules } = await import('./ticketRouting/service');
      return run('list_ticket_routing_rules', async () => {
        const orgId = typeof input.orgId === 'string' && input.orgId.length > 0 ? input.orgId : undefined;
        const limit = typeof input.limit === 'number' ? Math.min(Math.max(0, Math.floor(input.limit)), 200) : 100;
        return { rules: (await listRoutingRules(auth, { orgId })).slice(0, limit) };
      });
    },
  });

  aiTools.set('test_ticket_routing_rule', {
    tier: 1,
    domain: 'tickets',
    searchHint: 'dry run ticket routing, which routing rule would match, test routing rules against a sample ticket',
    deviceArgs: [],
    definition: {
      name: 'test_ticket_routing_rule',
      description: 'Dry run: report which routing rule would match a sample new ticket and what it would set. Writes nothing.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Organization the sample ticket belongs to (UUID)' },
          source: { type: 'string', enum: SOURCES, description: 'Ticket source' },
          subject: { type: 'string', description: 'Sample ticket subject (max 255)' },
          requesterEmail: { type: ['string', 'null'], description: 'Requester email, or null when unknown' },
          categoryId: { type: 'string', description: 'Category already on the ticket (UUID, optional)' },
          priority: { type: 'string', enum: PRIORITIES, description: 'Priority already on the ticket (optional)' },
        },
        required: ['orgId', 'source', 'subject', 'requesterEmail'],
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext): Promise<string> => {
      const { testRoutingRules } = await import('./ticketRouting/service');
      const { testTicketRoutingRuleSchema } = await import('@breeze/shared');
      return run('test_ticket_routing_rule', async () => {
        const parsed = testTicketRoutingRuleSchema.safeParse(input);
        if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input', code: 'VALIDATION_ERROR' };
        return testRoutingRules(auth, parsed.data);
      });
    },
  });

  aiTools.set('manage_ticket_routing_rules', {
    tier: 3,
    domain: 'tickets',
    searchHint: 'create update reorder delete ticket routing rules, auto-assign tickets by sender domain or keyword, partner-wide routing',
    deviceArgs: [],
    definition: {
      name: 'manage_ticket_routing_rules',
      description: 'Manage ticket routing rules; needs approval. Actions: create (ownerScope organization|partner), update (ruleId + changed fields), reorder (ids of one owner), delete (ruleId). Partner-wide writes need full partner access.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'reorder', 'delete'], description: 'Operation to perform' },
          ruleId: { ...UUID, description: 'Rule UUID (update, delete)' },
          ids: { ...STRING_LIST('Rule UUIDs of ONE owner in the new evaluation order (reorder)') },
          ownerScope: { type: 'string', enum: ['organization', 'partner'], description: 'create only: organization rule, or partner-wide rule' },
          orgId: { ...UUID, description: 'create only: owning organization (ownerScope organization)' },
          orgIds: { type: ['array', 'null'], items: { type: 'string' }, description: 'Partner-wide rule only: limit to these organization UUIDs; null = all organizations' },
          name: { type: 'string', description: 'Rule name (max 100)' },
          enabled: { type: 'boolean', description: 'Whether the rule is evaluated' },
          position: { type: 'integer', description: 'Evaluation order (lower first)' },
          matchSources: { type: ['array', 'null'], items: { type: 'string', enum: SOURCES }, description: 'Match any of these ticket sources; null = any' },
          matchPriorities: { type: ['array', 'null'], items: { type: 'string', enum: PRIORITIES }, description: 'Match any of these priorities; null = any' },
          matchCategoryId: { type: ['string', 'null'], description: 'Match this category (UUID); null = any' },
          matchSubjectKeywords: { type: ['array', 'null'], items: { type: 'string' }, description: 'Match subjects containing any keyword (2-100 chars each); null = any' },
          matchRequesterDomains: { type: ['array', 'null'], items: { type: 'string' }, description: 'Match requester domains: example.com or *.example.com; null = any' },
          setAssigneeUserId: { type: ['string', 'null'], description: 'Action: assign to this user (UUID)' },
          setPriority: { type: ['string', 'null'], enum: [...PRIORITIES, null], description: 'Action: set this priority' },
          setCategoryId: { type: ['string', 'null'], description: 'Action: set this category (UUID)' },
          setStatusId: { type: ['string', 'null'], description: 'Action: start in this status (UUID; New/Open/Pending/On hold core)' },
          addTags: { type: ['array', 'null'], items: { type: 'string' }, description: 'Action: add these tags (max 20)' },
        },
        required: ['action'],
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext): Promise<string> => {
      const svc = await import('./ticketRouting/service');
      const v = await import('@breeze/shared');
      return run('manage_ticket_routing_rules', async () => {
        const { action, ruleId, ...rest } = input;
        const fail = (message: string) => ({ error: message, code: 'VALIDATION_ERROR' });
        const issue = (e: { issues: { message: string }[] }) => fail(e.issues[0]?.message ?? 'Invalid input');
        switch (action) {
          case 'create': {
            const { ids: _ids, ...fields } = rest;
            const parsed = v.createTicketRoutingRuleSchema.safeParse(fields);
            return parsed.success ? svc.createRoutingRule(auth, parsed.data) : issue(parsed.error);
          }
          case 'update': {
            if (typeof ruleId !== 'string') return fail('ruleId is required for update');
            if (rest.ownerScope !== undefined || rest.orgId !== undefined) return fail('ownerScope and orgId cannot be changed after create');
            const { ids: _ids, ownerScope: _s, orgId: _o, ...fields } = rest;
            const parsed = v.updateTicketRoutingRuleSchema.safeParse(fields);
            return parsed.success ? svc.updateRoutingRule(auth, ruleId, parsed.data) : issue(parsed.error);
          }
          case 'reorder': {
            const parsed = v.reorderTicketRoutingRulesSchema.safeParse({ ids: rest.ids });
            return parsed.success ? svc.reorderRoutingRules(auth, parsed.data.ids) : issue(parsed.error);
          }
          case 'delete': {
            if (typeof ruleId !== 'string') return fail('ruleId is required for delete');
            return svc.deleteRoutingRule(auth, ruleId);
          }
          default:
            return fail(`Unknown action: ${String(action)}`);
        }
      });
    },
  });
}

/** Run a service call and map the service's refusals to a tool error result (never a raw throw). */
async function run(tool: string, fn: () => Promise<unknown>): Promise<string> {
  try {
    return json(await fn());
  } catch (err) {
    const { TicketRoutingError } = await import('./ticketRouting/service');
    const { PartnerWideWriteDeniedError } = await import('./partnerWideAccess');
    if (err instanceof TicketRoutingError) return json({ error: err.message, code: err.code });
    if (err instanceof PartnerWideWriteDeniedError) return json({ error: err.message, code: 'ACCESS_DENIED' });
    console.error(`[${tool}]`, err);
    captureException(err, undefined, { tool });
    return json({ error: 'Operation failed. Check server logs for details.' });
  }
}
