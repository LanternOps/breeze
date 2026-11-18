import type {
  CreateTicketRoutingRuleInput,
  TicketRoutingRule,
  UpdateTicketRoutingRuleInput,
} from '@breeze/shared';

// Limits mirror packages/shared/src/validators/ticketRouting.ts. They are
// restated here (rather than imported) because that module pulls zod into the
// browser bundle; the server re-validates every value regardless.
export const KEYWORDS_MAX = 20;
export const KEYWORD_MIN_LEN = 2;
export const KEYWORD_MAX_LEN = 100;
export const DOMAINS_MAX = 50;
export const TAGS_MAX = 20;
export const TAG_MAX_LEN = 50;
export const NAME_MAX_LEN = 100;

export const ROUTING_SOURCES = ['portal', 'email', 'alert', 'manual', 'api', 'ai'] as const;
export const ROUTING_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type RoutingSource = (typeof ROUTING_SOURCES)[number];
export type RoutingPriority = (typeof ROUTING_PRIORITIES)[number];

/** Core statuses a routing rule may set (the service rejects the rest). */
export const ROUTING_SETTABLE_CORE_STATUSES = ['new', 'open', 'pending', 'on_hold'];

export type OwnerScope = 'organization' | 'partner';

export interface RuleFormState {
  name: string;
  enabled: boolean;
  ownerScope: OwnerScope;
  orgId: string;
  orgLinksMode: 'all' | 'selected';
  orgIds: string[];
  matchSources: string[];
  matchPriorities: string[];
  matchCategoryId: string;
  keywords: string[];
  domains: string[];
  setAssigneeUserId: string;
  setPriority: string;
  setCategoryId: string;
  setStatusId: string;
  addTags: string[];
}

export function emptyForm(ownerScope: OwnerScope, orgId: string): RuleFormState {
  return {
    name: '',
    enabled: true,
    ownerScope,
    orgId,
    orgLinksMode: 'all',
    orgIds: [],
    matchSources: [],
    matchPriorities: [],
    matchCategoryId: '',
    keywords: [],
    domains: [],
    setAssigneeUserId: '',
    setPriority: '',
    setCategoryId: '',
    setStatusId: '',
    addTags: [],
  };
}

export function formFromRule(rule: TicketRoutingRule): RuleFormState {
  return {
    name: rule.name,
    enabled: rule.enabled,
    ownerScope: rule.orgId ? 'organization' : 'partner',
    orgId: rule.orgId ?? '',
    orgLinksMode: rule.orgIds ? 'selected' : 'all',
    orgIds: rule.orgIds ?? [],
    matchSources: rule.matchSources ?? [],
    matchPriorities: rule.matchPriorities ?? [],
    matchCategoryId: rule.matchCategoryId ?? '',
    keywords: rule.matchSubjectKeywords ?? [],
    domains: rule.matchRequesterDomains ?? [],
    setAssigneeUserId: rule.setAssigneeUserId ?? '',
    setPriority: rule.setPriority ?? '',
    setCategoryId: rule.setCategoryId ?? '',
    setStatusId: rule.setStatusId ?? '',
    addTags: rule.addTags ?? [],
  };
}

const orNull = <T>(list: T[]): T[] | null => (list.length > 0 ? list : null);
const strOrNull = (v: string): string | null => (v ? v : null);

type RuleFields = Omit<UpdateTicketRoutingRuleInput, "orgIds" | "name"> & { name: string };

function ruleFields(f: RuleFormState): RuleFields {
  return {
    name: f.name.trim(),
    enabled: f.enabled,
    matchSources: orNull(f.matchSources) as RuleFields['matchSources'],
    matchPriorities: orNull(f.matchPriorities) as RuleFields['matchPriorities'],
    matchCategoryId: strOrNull(f.matchCategoryId),
    matchSubjectKeywords: orNull(f.keywords),
    matchRequesterDomains: orNull(f.domains),
    setAssigneeUserId: strOrNull(f.setAssigneeUserId),
    setPriority: strOrNull(f.setPriority) as RuleFields['setPriority'],
    setCategoryId: strOrNull(f.setCategoryId),
    setStatusId: strOrNull(f.setStatusId),
    addTags: orNull(f.addTags),
  };
}

export function buildCreateBody(f: RuleFormState): CreateTicketRoutingRuleInput {
  if (f.ownerScope === 'organization') {
    // orgIds is partner-wide only — the API rejects it on an organization rule.
    return { ...ruleFields(f), ownerScope: 'organization', orgId: f.orgId };
  }
  return {
    ...ruleFields(f),
    ownerScope: 'partner',
    orgIds: f.orgLinksMode === 'selected' ? f.orgIds : null,
  };
}

/** Ownership is create-only: never ownerScope / orgId. */
export function buildUpdateBody(f: RuleFormState, partnerWide: boolean): UpdateTicketRoutingRuleInput {
  return partnerWide
    ? { ...ruleFields(f), orgIds: f.orgLinksMode === 'selected' ? f.orgIds : null }
    : ruleFields(f);
}

export function hasConditions(r: TicketRoutingRule): boolean {
  return Boolean(
    r.matchSources?.length ||
      r.matchPriorities?.length ||
      r.matchCategoryId ||
      r.matchSubjectKeywords?.length ||
      r.matchRequesterDomains?.length,
  );
}

export function hasActions(r: TicketRoutingRule): boolean {
  return Boolean(
    r.setAssigneeUserId || r.setPriority || r.setCategoryId || r.setStatusId || r.addTags?.length,
  );
}

// --- chip validators: return the normalized value, or an error token the UI translates ---

export type ChipResult = { ok: true; value: string } | { ok: false; error: string };

export function normalizeKeyword(raw: string): ChipResult {
  const value = raw.trim().toLowerCase();
  if (value.length < KEYWORD_MIN_LEN) return { ok: false, error: 'keywordShort' };
  if ([...value].length > KEYWORD_MAX_LEN) return { ok: false, error: 'keywordLong' };
  return { ok: true, value };
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_RE = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+$`);

export function normalizeDomain(raw: string): ChipResult {
  const value = raw.trim().toLowerCase();
  if (value.length > 253 || !HOST_RE.test(value)) return { ok: false, error: 'domainInvalid' };
  return { ok: true, value };
}

export function normalizeTag(raw: string): ChipResult {
  const value = raw.trim();
  if (value.length < 1) return { ok: false, error: 'tagEmpty' };
  if ([...value].length > TAG_MAX_LEN) return { ok: false, error: 'tagLong' };
  return { ok: true, value };
}

// --- grouping / ordering ---

export interface RuleGroup {
  key: string; // org id, or 'partner'
  orgId: string | null;
  rules: TicketRoutingRule[];
}

const byPosition = (a: TicketRoutingRule, b: TicketRoutingRule) =>
  a.position - b.position || a.id.localeCompare(b.id);

/** Org-owned groups first (in first-seen order), the partner-wide group last. Each group by (position, id). */
export function groupRules(rules: TicketRoutingRule[]): RuleGroup[] {
  const map = new Map<string, RuleGroup>();
  for (const r of rules) {
    const key = r.orgId ?? 'partner';
    let g = map.get(key);
    if (!g) {
      g = { key, orgId: r.orgId, rules: [] };
      map.set(key, g);
    }
    g.rules.push(r);
  }
  const groups = [...map.values()];
  for (const g of groups) g.rules.sort(byPosition);
  return [...groups.filter((g) => g.orgId !== null), ...groups.filter((g) => g.orgId === null)];
}

/** Move `id` to the index currently held by `targetId`; null when nothing changes. */
export function moveBefore(ids: string[], id: string, targetId: string): string[] | null {
  const from = ids.indexOf(id);
  const to = ids.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return null;
  const next = ids.filter((x) => x !== id);
  next.splice(to, 0, id);
  return next;
}

/** One-step move; null at either edge. */
export function moveStep(ids: string[], id: string, dir: -1 | 1): string[] | null {
  const from = ids.indexOf(id);
  const to = from + dir;
  if (from === -1 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
