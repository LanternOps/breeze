/**
 * Ticket routing rules (#8883 W5, spec §5.1, §5.4, §5.5) — the service behind
 * routes/tickets/routingRules.ts and the routing-rule AI tools.
 *
 * Everything runs in the CALLER's DB context: RLS (ticket_routing_rules_isolation
 * FOR ALL) decides which rows a statement can target, so an org token that
 * reads a partner-wide rule through a SELECT-only branch can never change it.
 * On top of that:
 *   - writes are partner/system only (an organization-scope caller writes
 *     nothing; the route also refuses it);
 *   - every write to a PARTNER-WIDE rule — create, update, delete, reorder,
 *     org links — is gated HERE, in the service, on
 *     canManagePartnerWidePolicies, so the AI tool path cannot skip it (a
 *     selected-access partner user can reach the row through RLS but must not
 *     administer it);
 *   - an org-owned rule needs canAccessOrg on its org;
 *   - "at least one action" is checked on create and on the merged row of an
 *     update (Gate B13, 400 ROUTING_RULE_NO_ACTION) — never a DB CHECK;
 *   - references (categories, status, assignee) must belong to the rule's
 *     partner (the DB guard trigger is the backstop, Gate B4), and a status
 *     must have a core a new ticket may start in.
 *
 * The dry run (`testRoutingRules`) calls the same evaluator as createTicket
 * and writes nothing.
 */
import type { TicketRoutingRule, CreateTicketRoutingRuleInput, UpdateTicketRoutingRuleInput, TestTicketRoutingRuleInput, TicketRoutingTestResult } from '@breeze/shared';
import { db } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from '../partnerWideAccess';
import { assertCategoryInPartner, getAssigneeForValidation } from '../ticketService';
import { getTicketStatusById } from '../ticketConfigService';
import { evaluateRoutingRules, ROUTABLE_STATUS_CORES } from './evaluate';
import { ruleHasAction } from './match';
import * as repo from './repository';
import type { Owner, RuleInsert, RuleRow } from './repository';

export class TicketRoutingError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409, readonly code: string) {
    super(message);
    this.name = 'TicketRoutingError';
  }
}

export type RoutingAuth = Pick<AuthContext, 'scope' | 'partnerId' | 'orgId' | 'partnerOrgAccess' | 'accessibleOrgIds' | 'canAccessOrg'> & {
  user: { id: string; email?: string };
};

const notFound = () => new TicketRoutingError('Routing rule not found', 404, 'NOT_FOUND');
const orgNotFound = () => new TicketRoutingError('Organization not found', 404, 'NOT_FOUND');

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

function assertWriter(auth: RoutingAuth): void {
  if (auth.scope !== 'partner' && auth.scope !== 'system') {
    throw new TicketRoutingError('Routing rules are managed by partner staff', 403, 'ACCESS_DENIED');
  }
}

/** The write gate on an existing row. Rows outside the caller's reach read as missing. */
function assertCanWriteRow(auth: RoutingAuth, row: Pick<RuleRow, 'orgId' | 'partnerId'>): void {
  assertWriter(auth);
  if (row.orgId === null) {
    if (auth.scope === 'partner' && row.partnerId !== auth.partnerId) throw notFound();
    if (!canManagePartnerWidePolicies(auth)) throw new PartnerWideWriteDeniedError();
    return;
  }
  if (auth.scope === 'partner' && !auth.canAccessOrg(row.orgId)) throw notFound();
}

async function loadForWrite(auth: RoutingAuth, id: string): Promise<RuleRow> {
  assertWriter(auth);
  const row = await repo.findRule(id, { forUpdate: true });
  if (!row) throw notFound();
  assertCanWriteRow(auth, row);
  return row;
}

async function resolveCreateOwner(auth: RoutingAuth, input: Pick<CreateTicketRoutingRuleInput, 'ownerScope' | 'orgId'>): Promise<{ owner: Owner; partnerId: string }> {
  assertWriter(auth);
  if (input.ownerScope === 'partner') {
    if (input.orgId) throw new TicketRoutingError('orgId cannot be combined with ownerScope "partner"', 400, 'VALIDATION_ERROR');
    if (!auth.partnerId) throw new TicketRoutingError('A partner-wide rule needs a partner context', 400, 'PARTNER_REQUIRED');
    if (!canManagePartnerWidePolicies(auth)) throw new PartnerWideWriteDeniedError();
    return { owner: { orgId: null, partnerId: auth.partnerId }, partnerId: auth.partnerId };
  }
  if (!input.orgId) throw new TicketRoutingError('orgId is required for an organization rule', 400, 'VALIDATION_ERROR');
  if (auth.scope === 'partner' && !auth.canAccessOrg(input.orgId)) throw orgNotFound();
  const org = await repo.findOrg(input.orgId);
  if (!org) throw orgNotFound();
  return { owner: { orgId: org.id, partnerId: null }, partnerId: org.partnerId };
}

/** The partner a rule's references must belong to. */
async function partnerOfRow(row: Pick<RuleRow, 'orgId' | 'partnerId'>): Promise<string> {
  if (row.partnerId) return row.partnerId;
  const org = row.orgId ? await repo.findOrg(row.orgId) : null;
  if (!org) throw notFound();
  return org.partnerId;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const errorCode = (err: unknown): string | undefined =>
  err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
    ? (err as { code: string }).code : undefined;

const invalidRef = (what: string) =>
  new TicketRoutingError(`The ${what} does not belong to this partner`, 400, 'ROUTING_RULE_REFERENCE_INVALID');

type RefFields = Pick<RuleInsert, 'matchCategoryId' | 'setCategoryId' | 'setStatusId' | 'setAssigneeUserId'>;

/** Only the references the write sets are checked (an unchanged one was checked when it was written). */
async function assertReferences(partnerId: string, refs: RefFields): Promise<void> {
  for (const [field, id] of [['category', refs.matchCategoryId], ['category', refs.setCategoryId]] as const) {
    if (!id) continue;
    try {
      await assertCategoryInPartner(id, partnerId);
    } catch (err) {
      const code = errorCode(err);
      if (code === 'CATEGORY_NOT_FOUND' || code === 'CATEGORY_WRONG_PARTNER') throw invalidRef(field);
      throw err;
    }
  }
  if (refs.setStatusId) {
    const status = await getTicketStatusById(refs.setStatusId);
    if (!status || status.partnerId !== partnerId) throw invalidRef('status');
    if (!status.isActive) throw new TicketRoutingError('The status is inactive', 400, 'ROUTING_RULE_STATUS_NOT_ALLOWED');
    if (!(ROUTABLE_STATUS_CORES as readonly string[]).includes(status.coreStatus)) {
      throw new TicketRoutingError('A new ticket can start only in a New, Open, Pending or On hold status', 400, 'ROUTING_RULE_STATUS_NOT_ALLOWED');
    }
  }
  if (refs.setAssigneeUserId) {
    // Per-org eligibility (role, site) is re-checked on every create; here the
    // user must exist and belong to the rule's partner.
    const user = await getAssigneeForValidation(refs.setAssigneeUserId);
    if (!user || user.partnerId !== partnerId) throw invalidRef('assignee');
  }
}

function assertHasAction(row: Parameters<typeof ruleHasAction>[0]): void {
  if (!ruleHasAction(row)) {
    throw new TicketRoutingError('A routing rule must set at least one action', 400, 'ROUTING_RULE_NO_ACTION');
  }
}

async function assertOrgLinks(partnerId: string, orgIds: string[]): Promise<void> {
  const found = new Set(await repo.orgIdsOfPartner(orgIds, partnerId));
  if (orgIds.some((id) => !found.has(id))) {
    throw new TicketRoutingError('Every listed organization must belong to this partner', 400, 'ROUTING_RULE_ORG_INVALID');
  }
}

/** The writable rule fields of a create/update input (ownership and org links excluded). */
function ruleFieldsOf(input: UpdateTicketRoutingRuleInput): Partial<RuleInsert> {
  const out: Partial<RuleInsert> = {};
  const keys = [
    'name', 'enabled', 'position', 'matchSources', 'matchPriorities', 'matchCategoryId', 'matchSubjectKeywords',
    'matchRequesterDomains', 'setAssigneeUserId', 'setPriority', 'setCategoryId', 'setStatusId', 'addTags',
  ] as const;
  for (const key of keys) {
    if (input[key] !== undefined) (out as Record<string, unknown>)[key] = input[key];
  }
  return out;
}

function toDto(row: RuleRow, orgIds: string[] | null): TicketRoutingRule {
  return {
    id: row.id,
    orgId: row.orgId,
    partnerId: row.partnerId,
    name: row.name,
    enabled: row.enabled,
    position: row.position,
    matchSources: row.matchSources ?? null,
    matchPriorities: row.matchPriorities ?? null,
    matchCategoryId: row.matchCategoryId,
    matchSubjectKeywords: row.matchSubjectKeywords ?? null,
    matchRequesterDomains: row.matchRequesterDomains ?? null,
    setAssigneeUserId: row.setAssigneeUserId,
    setPriority: row.setPriority,
    setCategoryId: row.setCategoryId,
    setStatusId: row.setStatusId,
    addTags: row.addTags ?? null,
    orgIds: row.orgId === null && row.orgScoped ? orgIds ?? [] : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Org rules first, then partner-wide, each by (position, id) — evaluation
 * order. App-layer dual-axis conditions only for partner callers (their
 * partner-wide rows + the orgs they can reach); an org caller reads through
 * RLS for its own org, and an org_scoped partner-wide rule that does not list
 * its org is not shown (it never applies to it).
 */
export async function listRoutingRules(auth: RoutingAuth, opts: { orgId?: string }): Promise<TicketRoutingRule[]> {
  let orgIds: string[] | 'all' | null;
  let partnerId: string | null;
  if (auth.scope === 'organization') {
    if (!auth.orgId || (opts.orgId && opts.orgId !== auth.orgId)) throw orgNotFound();
    const org = await repo.findOrg(auth.orgId);
    if (!org) throw orgNotFound();
    orgIds = [org.id];
    partnerId = org.partnerId;
  } else if (opts.orgId) {
    if (auth.scope === 'partner' && !auth.canAccessOrg(opts.orgId)) throw orgNotFound();
    const org = await repo.findOrg(opts.orgId);
    if (!org) throw orgNotFound();
    orgIds = [org.id];
    partnerId = org.partnerId;
  } else if (auth.scope === 'partner') {
    orgIds = auth.accessibleOrgIds ?? 'all';
    partnerId = auth.partnerId;
  } else {
    orgIds = 'all';
    partnerId = auth.partnerId;
  }

  const rows = await repo.listRuleRows({ orgIds, partnerId });
  const links = await repo.linksFor(rows.filter((r) => r.orgId === null && r.orgScoped).map((r) => r.id));
  const viewerOrgId = auth.scope === 'organization' ? auth.orgId : null;
  return rows
    .filter((r) => !(viewerOrgId && r.orgId === null && r.orgScoped && !(links.get(r.id) ?? []).includes(viewerOrgId)))
    .map((r) => toDto(r, links.get(r.id) ?? null));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createRoutingRule(auth: RoutingAuth, input: CreateTicketRoutingRuleInput): Promise<TicketRoutingRule> {
  const { owner, partnerId } = await resolveCreateOwner(auth, input);
  if (owner.orgId && input.orgIds != null) {
    throw new TicketRoutingError('Only a partner-wide rule can be limited to organizations', 400, 'ROUTING_RULE_ORG_LINKS_NOT_ALLOWED');
  }
  const fields = ruleFieldsOf(input);
  assertHasAction(fields as Parameters<typeof ruleHasAction>[0]);
  await assertReferences(partnerId, fields);
  const orgIds = input.orgIds ?? null;
  if (orgIds) await assertOrgLinks(partnerId, orgIds);

  const row = await repo.insertRule({
    ...fields,
    name: input.name,
    ...owner,
    position: input.position ?? (await repo.nextPosition(owner)),
    orgScoped: orgIds !== null,
    createdByUserId: auth.scope === 'system' ? null : auth.user.id,
  });
  if (orgIds) await repo.replaceLinks(row.id, orgIds);
  return toDto(row, orgIds);
}

export async function updateRoutingRule(auth: RoutingAuth, id: string, input: UpdateTicketRoutingRuleInput): Promise<TicketRoutingRule> {
  const current = await loadForWrite(auth, id);
  if (current.orgId && input.orgIds !== undefined) {
    throw new TicketRoutingError('Only a partner-wide rule can be limited to organizations', 400, 'ROUTING_RULE_ORG_LINKS_NOT_ALLOWED');
  }
  const fields = ruleFieldsOf(input);
  assertHasAction({ ...current, ...fields } as Parameters<typeof ruleHasAction>[0]);
  const partnerId = await partnerOfRow(current);
  await assertReferences(partnerId, fields);

  const set: Partial<RuleInsert> = { ...fields };
  if (input.orgIds !== undefined) {
    if (input.orgIds) await assertOrgLinks(partnerId, input.orgIds);
    set.orgScoped = input.orgIds !== null;
  }
  const row = await repo.updateRule(id, set);
  if (input.orgIds !== undefined) await repo.replaceLinks(id, input.orgIds ?? []);
  const links = row.orgId === null && row.orgScoped ? (await repo.linksFor([row.id])).get(row.id) ?? [] : null;
  return toDto(row, links);
}

export async function deleteRoutingRule(auth: RoutingAuth, id: string): Promise<{ id: string; name: string; orgId: string | null; partnerId: string | null }> {
  const current = await loadForWrite(auth, id);
  if (!(await repo.deleteRule(id))) throw notFound();
  return { id: current.id, name: current.name, orgId: current.orgId, partnerId: current.partnerId };
}

/** One owner's rules in their new order (positions 0..n-1). */
export async function reorderRoutingRules(auth: RoutingAuth, ids: string[]): Promise<{ updated: number }> {
  assertWriter(auth);
  const rows = await repo.findRules(ids, { forUpdate: true });
  if (rows.length !== new Set(ids).size) throw notFound();
  const first = rows[0]!;
  if (rows.some((r) => r.orgId !== first.orgId || r.partnerId !== first.partnerId)) {
    throw new TicketRoutingError('Reorder the rules of one owner at a time', 400, 'ROUTING_RULE_REORDER_MIXED_OWNERS');
  }
  assertCanWriteRow(auth, first);
  return { updated: await repo.setPositions(ids) };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

/** POST /ticket-routing-rules/test — the same evaluator as createTicket; writes nothing. */
export async function testRoutingRules(auth: RoutingAuth, input: TestTicketRoutingRuleInput): Promise<TicketRoutingTestResult> {
  if (auth.scope === 'organization' && auth.orgId !== input.orgId) throw orgNotFound();
  if (auth.scope === 'partner' && !auth.canAccessOrg(input.orgId)) throw orgNotFound();
  const org = await repo.findOrg(input.orgId);
  if (!org) throw orgNotFound();
  const outcome = await evaluateRoutingRules(
    db,
    { partnerId: org.partnerId, orgId: org.id, deviceId: null },
    {
      source: input.source,
      priority: input.priority ?? null,
      categoryId: input.categoryId ?? null,
      subject: input.subject,
      requesterEmail: input.requesterEmail,
    },
    { priority: input.priority !== undefined, categoryId: input.categoryId !== undefined, assigneeId: false, statusId: false },
  );
  return { ruleId: outcome.ruleId, ruleName: outcome.ruleName, applied: outcome.applied, skipped: outcome.skipped };
}
