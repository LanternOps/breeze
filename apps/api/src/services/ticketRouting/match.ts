/**
 * Ticket routing rule matching (#8883 W5, spec §5.1–5.2) — pure, no I/O.
 *
 * Conditions AND across columns and OR within a list; a NULL or empty column
 * means "any". A rule with no condition at all is an explicit catch-all (the
 * UI warns about it). Order (D7): the ticket org's own rules, then the
 * partner-wide rules, each by (position, id); first match wins.
 */
import type { TicketRoutingRuleRow } from '../../db/schema/ticketRoutingRules';

export type TicketSource = 'portal' | 'email' | 'alert' | 'manual' | 'api' | 'ai';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

/** What a ticket is known to be BEFORE routing runs. */
export type RoutingFacts = {
  source: TicketSource;
  /** The caller's or intake form's priority; null = not chosen (never matches a priority condition). */
  priority: TicketPriority | null;
  /** The caller's or intake form's category; null = none (never matches a category condition). */
  categoryId: string | null;
  subject: string;
  /** The resolved requester address (createTicket's resolvedSubmitterEmail). */
  requesterEmail: string | null;
};

/** The columns matching and ordering read (a subset of the table row). */
export type RoutingRuleRow = Pick<
  TicketRoutingRuleRow,
  | 'id' | 'orgId' | 'partnerId' | 'name' | 'enabled' | 'position'
  | 'matchSources' | 'matchPriorities' | 'matchCategoryId' | 'matchSubjectKeywords' | 'matchRequesterDomains'
  | 'setAssigneeUserId' | 'setPriority' | 'setCategoryId' | 'setStatusId' | 'addTags' | 'orgScoped'
>;

const nonEmpty = <T>(list: readonly T[] | null | undefined): list is readonly T[] => !!list && list.length > 0;

/** The lower-cased host after the LAST `@`, without a trailing dot; null when there is none. */
export function requesterDomainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const host = email.slice(at + 1).trim().toLowerCase().replace(/\.+$/, '');
  return host.length > 0 ? host : null;
}

/**
 * `example.com` matches only `example.com`; `*.example.com` matches any
 * subdomain (`a.example.com`, `a.b.example.com`) but never `example.com`
 * itself, `badexample.com` or `example.com.evil`.
 */
export function domainMatches(pattern: string, domain: string): boolean {
  const p = pattern.trim().toLowerCase();
  const d = domain.toLowerCase();
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return d.length > suffix.length && d.endsWith(suffix);
  }
  return d === p;
}

export function isCatchAllRule(rule: Pick<RoutingRuleRow,
  'matchSources' | 'matchPriorities' | 'matchCategoryId' | 'matchSubjectKeywords' | 'matchRequesterDomains'>): boolean {
  return !nonEmpty(rule.matchSources)
    && !nonEmpty(rule.matchPriorities)
    && !rule.matchCategoryId
    && !nonEmpty(rule.matchSubjectKeywords)
    && !nonEmpty(rule.matchRequesterDomains);
}

/** Gate B13: "at least one action" — enforced by the service at create/update, not by a CHECK. */
export function ruleHasAction(rule: Pick<RoutingRuleRow,
  'setAssigneeUserId' | 'setPriority' | 'setCategoryId' | 'setStatusId' | 'addTags'>): boolean {
  return !!rule.setAssigneeUserId || !!rule.setPriority || !!rule.setCategoryId || !!rule.setStatusId || nonEmpty(rule.addTags);
}

export function matchRule(rule: RoutingRuleRow, facts: RoutingFacts): boolean {
  if (nonEmpty(rule.matchSources) && !rule.matchSources.includes(facts.source)) return false;
  if (nonEmpty(rule.matchPriorities) && (facts.priority === null || !rule.matchPriorities.includes(facts.priority))) return false;
  if (rule.matchCategoryId && rule.matchCategoryId !== facts.categoryId) return false;
  if (nonEmpty(rule.matchSubjectKeywords)) {
    const subject = facts.subject.toLowerCase();
    if (!rule.matchSubjectKeywords.some((kw) => subject.includes(kw.toLowerCase()))) return false;
  }
  if (nonEmpty(rule.matchRequesterDomains)) {
    const domain = requesterDomainOf(facts.requesterEmail);
    if (!domain || !rule.matchRequesterDomains.some((p) => domainMatches(p, domain))) return false;
  }
  return true;
}

const byPositionThenId = (a: RoutingRuleRow, b: RoutingRuleRow) =>
  a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** D7: org-owned rules first, then partner-wide rules; each by (position, id). */
export function orderRoutingRules<T extends RoutingRuleRow>(rules: readonly T[]): T[] {
  const org = rules.filter((r) => r.orgId !== null).sort(byPositionThenId);
  const wide = rules.filter((r) => r.orgId === null).sort(byPositionThenId);
  return [...org, ...wide];
}
