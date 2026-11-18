/**
 * evaluateRoutingRules (#8883 W5, spec §5.2) — the ONLY reader of "which
 * routing rule applies to a ticket created in this org now, and what it does".
 * Called once per live create from createTicket (never for import mode or a
 * continuation, Gate B14) and read-only from POST /ticket-routing-rules/test
 * and the test_ticket_routing_rule AI tool.
 *
 * Which rules (D7): the ticket org's own enabled rules, then the enabled
 * partner-wide rules of the ticket org's PARTNER (playbook step 5 — never
 * `org_id = ticket.orgId` alone), each by (position, id); first match wins.
 * An `org_scoped` partner-wide rule applies only when THIS org is linked; one
 * with no links matches nothing (fail closed).
 *
 * Gate B1: the rule read runs on the CALLER's connection with explicit owner
 * filters — no nested system-context read for the XOR config table. Every
 * create context reaches the partner-wide rows through RLS: partner tokens via
 * breeze_has_partner_access, org-scope tokens and the portal create via
 * `_partner_wide_select`, org sessions via `_org_member_select`, inbound email
 * and workers via system scope. ticketCreateCallerContexts.integration.test.ts
 * proves each one.
 *
 * Actions fill only fields the caller did not choose (ExplicitChoices; the
 * caller folds an intake form's configured category/priority in — precedence
 * explicit > intake form > rule > category default / SLA chain). Each
 * reference is re-validated here; a failing action is SKIPPED with a reason
 * and the rest of the rule still applies. Category / status / assignee
 * re-validation uses the existing createTicket helpers, which read those
 * partner-scoped reference rows the way createTicket always has.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../../db';
import { assertAssigneeEligible, assertCategoryInPartner } from '../ticketService';
import { getTicketStatusById } from '../ticketConfigService';
import { matchRule, orderRoutingRules, type RoutingFacts, type RoutingRuleRow, type TicketPriority, type TicketSource } from './match';

export type ExplicitChoices = { priority: boolean; categoryId: boolean; assigneeId: boolean; statusId: boolean };

export const NO_EXPLICIT_CHOICES: ExplicitChoices = Object.freeze({
  priority: false, categoryId: false, assigneeId: false, statusId: false,
});

export type RoutingSkipReason =
  | 'assignee_ineligible'
  | 'assignee_deleted'
  | 'category_foreign'
  | 'status_foreign'
  | 'status_inactive'
  | 'status_core_not_allowed';

export type RoutingAction = 'set_assignee' | 'set_category' | 'set_status';

/** Core statuses a rule may start a ticket in (spec §5.1). */
export const ROUTABLE_STATUS_CORES = ['new', 'open', 'pending', 'on_hold'] as const;
export type RoutableStatusCore = (typeof ROUTABLE_STATUS_CORES)[number];

export type RoutingOutcome = {
  ruleId: string | null;
  ruleName: string | null;
  applied: Partial<{ assigneeId: string; priority: TicketPriority; categoryId: string; statusId: string; tags: string[] }>;
  skipped: { action: RoutingAction; reason: RoutingSkipReason }[];
  /** The core of `applied.statusId` (null when no status was applied). */
  appliedStatusCore: RoutableStatusCore | null;
};

export const NO_ROUTING: RoutingOutcome = Object.freeze({
  ruleId: null, ruleName: null, applied: Object.freeze({}), skipped: Object.freeze([]) as unknown as RoutingOutcome['skipped'], appliedStatusCore: null,
}) as RoutingOutcome;

type RawRuleRow = {
  id: string;
  org_id: string | null;
  partner_id: string | null;
  name: string;
  enabled: boolean;
  position: number;
  match_sources: string[] | string | null;
  match_priorities: string[] | string | null;
  match_category_id: string | null;
  match_subject_keywords: string[] | string | null;
  match_requester_domains: string[] | string | null;
  set_assignee_user_id: string | null;
  set_priority: TicketPriority | null;
  set_category_id: string | null;
  set_status_id: string | null;
  add_tags: string[] | string | null;
  org_scoped: boolean;
  org_listed: boolean;
};

/**
 * The arrays are cast to text[] in SQL so the driver parses them; a raw
 * `{a,b}` literal (custom enum arrays are not parsed by postgres-js) is still
 * handled for robustness. Elements are plain tokens (enum labels, keywords,
 * hosts, tags) validated at write time, so no quoting edge cases arise beyond
 * the double-quoted form Postgres uses for values with commas or spaces.
 */
function parseArray(value: string[] | string | null): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  const inner = value.replace(/^\{|\}$/g, '');
  if (inner.length === 0) return [];
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g;
  for (let m = re.exec(inner); m; m = re.exec(inner)) {
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]!);
  }
  return out;
}

function toRule(r: RawRuleRow): RoutingRuleRow & { orgListed: boolean } {
  return {
    id: r.id,
    orgId: r.org_id,
    partnerId: r.partner_id,
    name: r.name,
    enabled: r.enabled,
    position: Number(r.position),
    matchSources: parseArray(r.match_sources) as TicketSource[] | null,
    matchPriorities: parseArray(r.match_priorities) as TicketPriority[] | null,
    matchCategoryId: r.match_category_id,
    matchSubjectKeywords: parseArray(r.match_subject_keywords),
    matchRequesterDomains: parseArray(r.match_requester_domains),
    setAssigneeUserId: r.set_assignee_user_id,
    setPriority: r.set_priority,
    setCategoryId: r.set_category_id,
    setStatusId: r.set_status_id,
    addTags: parseArray(r.add_tags),
    orgScoped: r.org_scoped,
    orgListed: r.org_listed,
  };
}

const errorCode = (err: unknown): string | undefined =>
  err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
    ? (err as { code: string }).code
    : undefined;

const ASSIGNEE_GONE = new Set(['ASSIGNEE_NOT_FOUND']);
const ASSIGNEE_INELIGIBLE = new Set(['ASSIGNEE_NOT_ELIGIBLE', 'ASSIGNEE_WRONG_PARTNER']);
const CATEGORY_FOREIGN = new Set(['CATEGORY_NOT_FOUND', 'CATEGORY_WRONG_PARTNER']);

export async function evaluateRoutingRules(
  db: Pick<Database, 'execute'>,
  owner: { partnerId: string; orgId: string; deviceId?: string | null },
  facts: RoutingFacts,
  explicit: ExplicitChoices,
): Promise<RoutingOutcome> {
  const result = await db.execute<RawRuleRow>(sql`
    SELECT r.id, r.org_id, r.partner_id, r.name, r.enabled, r.position,
           r.match_sources::text[] AS match_sources,
           r.match_priorities::text[] AS match_priorities,
           r.match_category_id,
           r.match_subject_keywords,
           r.match_requester_domains,
           r.set_assignee_user_id, r.set_priority::text AS set_priority,
           r.set_category_id, r.set_status_id, r.add_tags, r.org_scoped,
           EXISTS (
             SELECT 1 FROM ticket_routing_rule_org_links l
              WHERE l.rule_id = r.id AND l.org_id = ${owner.orgId}
           ) AS org_listed
      FROM ticket_routing_rules r
     WHERE r.enabled
       AND (r.org_id = ${owner.orgId} OR (r.org_id IS NULL AND r.partner_id = ${owner.partnerId}))
     ORDER BY (r.org_id IS NULL), r.position, r.id
  `);
  const rows = (result as unknown as { rows?: RawRuleRow[] }).rows ?? (result as unknown as RawRuleRow[]);
  const candidates = orderRoutingRules(rows.map(toRule));

  const rule = candidates.find((r) =>
    r.enabled
    && (r.orgId === owner.orgId || (r.orgId === null && r.partnerId === owner.partnerId))
    && (!r.orgScoped || r.orgListed)
    && matchRule(r, facts));
  if (!rule) return { ...NO_ROUTING, applied: {}, skipped: [] };

  const applied: RoutingOutcome['applied'] = {};
  const skipped: RoutingOutcome['skipped'] = [];
  let appliedStatusCore: RoutableStatusCore | null = null;

  if (rule.setAssigneeUserId && !explicit.assigneeId) {
    try {
      await assertAssigneeEligible(rule.setAssigneeUserId, owner.partnerId, owner.orgId, owner.deviceId ?? undefined);
      applied.assigneeId = rule.setAssigneeUserId;
    } catch (err) {
      const code = errorCode(err);
      if (code && ASSIGNEE_GONE.has(code)) skipped.push({ action: 'set_assignee', reason: 'assignee_deleted' });
      else if (code && ASSIGNEE_INELIGIBLE.has(code)) skipped.push({ action: 'set_assignee', reason: 'assignee_ineligible' });
      else throw err;
    }
  }

  if (rule.setPriority && !explicit.priority) applied.priority = rule.setPriority;

  if (rule.setCategoryId && !explicit.categoryId) {
    try {
      await assertCategoryInPartner(rule.setCategoryId, owner.partnerId);
      applied.categoryId = rule.setCategoryId;
    } catch (err) {
      const code = errorCode(err);
      if (code && CATEGORY_FOREIGN.has(code)) skipped.push({ action: 'set_category', reason: 'category_foreign' });
      else throw err;
    }
  }

  if (rule.setStatusId && !explicit.statusId) {
    const status = await getTicketStatusById(rule.setStatusId);
    if (!status || status.partnerId !== owner.partnerId) {
      skipped.push({ action: 'set_status', reason: 'status_foreign' });
    } else if (!status.isActive) {
      skipped.push({ action: 'set_status', reason: 'status_inactive' });
    } else if (!(ROUTABLE_STATUS_CORES as readonly string[]).includes(status.coreStatus)) {
      skipped.push({ action: 'set_status', reason: 'status_core_not_allowed' });
    } else {
      applied.statusId = status.id;
      appliedStatusCore = status.coreStatus as RoutableStatusCore;
    }
  }

  const tags = [...new Set((rule.addTags ?? []).map((t) => t.trim()).filter((t) => t.length > 0))];
  if (tags.length > 0) applied.tags = tags;

  return { ruleId: rule.id, ruleName: rule.name, applied, skipped, appliedStatusCore };
}
