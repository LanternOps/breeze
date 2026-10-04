/**
 * Pure predicate-shape matchers for the RLS coverage contract
 * (src/__tests__/integration/rls-coverage.integration.test.ts).
 *
 * Why this exists (RMM-QA-220): the contract used to accept a helper NAME
 * appearing anywhere in `qual OR with_check` as coverage for every DML
 * command. Postgres evaluates SELECT/DELETE against USING (`qual`), INSERT
 * against WITH CHECK (`with_check`), and UPDATE against BOTH — so a helper in
 * the wrong slot proves nothing for the command the policy governs. These
 * matchers are command-specific and argument-specific.
 *
 * Lives under src/db/ rather than src/__tests__/integration/ on purpose: the
 * unit runner (vitest.config.ts) excludes that directory wholesale and the
 * integration runner includes every *.test.ts in it, so a pure function's
 * unit test has to sit where the Test API job sees it and the real-DB setup
 * does not.
 *
 * Input is the deparsed text of pg_policies.qual / with_check. Postgres drops
 * the `public.` prefix on helper calls and may emit newlines, so callers get
 * whitespace-normalised matching for free.
 */
export type Cmd = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
export const RLS_CMDS: readonly Cmd[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
export type PredicateSlot = 'qual' | 'with_check';

export interface PolicyRow {
  policyname: string;
  /** 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL' (pg_policies.cmd). */
  cmd: string;
  /** 'PERMISSIVE' | 'RESTRICTIVE' (pg_policies.permissive). */
  permissive: string;
  qual: string | null;
  with_check: string | null;
}

export type ParentRule =
  /** Default parent-FK rule: a covering helper on ANY one declared parent alias. */
  | { kind: 'any-of'; parents: readonly string[] }
  /** Overlay: a covering helper on EVERY listed parent alias (script_to_tags). */
  | { kind: 'all-of'; parents: readonly string[] };

export type PredicateMatcher = (pred: string | null, cmd: Cmd, slot: PredicateSlot) => boolean;

// Tokens that can legally follow `FROM <parent>` and must not be mistaken
// for an alias when the join is unaliased.
const NOT_AN_ALIAS = new Set([
  'where', 'join', 'on', 'left', 'right', 'inner', 'cross', 'full', 'natural',
  'using', 'and', 'or', 'group', 'order', 'limit', 'union', 'except', 'intersect',
]);

export function normalizePredicate(pred: string | null): string {
  return (pred ?? '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every alias under which `parent` is joined in `pred` via
 * `FROM [public.]<parent> [AS] <alias>`; the bare parent name when the join
 * is unaliased. `\b` after the parent name keeps `FROM scripts` from matching
 * `FROM script_tags`.
 */
export function parentAliases(pred: string | null, parent: string): string[] {
  const text = normalizePredicate(pred);
  const re = new RegExp(
    `\\bFROM\\s+(?:public\\.)?${escapeRegExp(parent)}\\b(?:\\s+(?:AS\\s+)?([A-Za-z_][A-Za-z0-9_]*))?`,
    'gi',
  );
  const aliases: string[] = [];
  for (const m of text.matchAll(re)) {
    const candidate = m[1];
    aliases.push(candidate && !NOT_AN_ALIAS.has(candidate.toLowerCase()) ? candidate : parent);
  }
  return aliases;
}

function helperOnAlias(text: string, alias: string): boolean {
  const re = new RegExp(
    `\\bbreeze_has_(?:org|partner)_access\\(\\s*${escapeRegExp(alias)}\\.(?:org_id|partner_id)\\s*\\)`,
    'i',
  );
  return re.test(text);
}

/**
 * True when `pred` joins `parent` and applies breeze_has_org_access(<alias>.org_id)
 * or breeze_has_partner_access(<alias>.partner_id) to THAT alias. A helper on
 * the child's own column or on a non-parent alias does not count.
 */
export function predicateCoversParent(pred: string | null, parent: string): boolean {
  const text = normalizePredicate(pred);
  if (text === '') return false;
  return parentAliases(text, parent).some((alias) => helperOnAlias(text, alias));
}

export function predicateCoversParents(pred: string | null, rule: ParentRule): boolean {
  if (rule.parents.length === 0) return false;
  const covered = rule.parents.map((parent) => predicateCoversParent(pred, parent));
  return rule.kind === 'all-of' ? covered.every(Boolean) : covered.some(Boolean);
}

/**
 * Org-axis shape: breeze_has_org_access([<table>.]org_id) — or
 * breeze_has_org_access([<table>.]id) when `idKeyed` (organizations). Any
 * other alias or column is NOT this table's tenant expression.
 */
export function predicateCoversOrgAxis(pred: string | null, table: string, idKeyed: boolean): boolean {
  const text = normalizePredicate(pred);
  if (text === '') return false;
  const column = idKeyed ? 'id' : 'org_id';
  const re = new RegExp(
    `\\bbreeze_has_org_access\\(\\s*(?:(?:public\\.)?${escapeRegExp(table)}\\.)?${column}\\s*\\)`,
    'i',
  );
  return re.test(text);
}

/**
 * Commands covered by `policies` under `matches`:
 *   SELECT / DELETE ← qual; INSERT ← with_check; UPDATE ← qual AND with_check.
 * cmd='ALL' expands to all four. Only PERMISSIVE rows count. A FOR UPDATE or
 * FOR ALL policy that omitted WITH CHECK reuses USING as its check (Postgres
 * semantics; pg_policies then reports with_check = NULL) — a FOR INSERT policy
 * never gets that fallback, because Postgres requires WITH CHECK for it.
 */
export function coveredCommands(policies: readonly PolicyRow[], matches: PredicateMatcher): Set<Cmd> {
  const covered = new Set<Cmd>();
  for (const p of policies) {
    if (p.permissive !== 'PERMISSIVE') continue;
    const cmds: Cmd[] = p.cmd === 'ALL' ? [...RLS_CMDS] : RLS_CMDS.includes(p.cmd as Cmd) ? [p.cmd as Cmd] : [];
    const reusesQualAsCheck = p.cmd === 'ALL' || p.cmd === 'UPDATE';
    const check = p.with_check ?? (reusesQualAsCheck ? p.qual : null);
    for (const cmd of cmds) {
      let ok: boolean;
      if (cmd === 'SELECT' || cmd === 'DELETE') ok = matches(p.qual, cmd, 'qual');
      else if (cmd === 'INSERT') ok = matches(check, cmd, 'with_check');
      else ok = matches(p.qual, cmd, 'qual') && matches(check, cmd, 'with_check');
      if (ok) covered.add(cmd);
    }
  }
  return covered;
}

/**
 * True when `pred` admits rows by the caller's identity: it calls
 * breeze_current_user_id(), or joins through `users` (the "an admin of the
 * row's user can see it" branch, EXISTS (SELECT 1 FROM users u WHERE
 * u.id = <t>.user_id AND (breeze_has_partner_access(u.partner_id) OR ...))).
 */
export function predicateReferencesUserIdentity(pred: string | null): boolean {
  const text = normalizePredicate(pred);
  if (text === '') return false;
  return /\bbreeze_current_user_id\s*\(/i.test(text) || /\b(?:FROM|JOIN)\s+(?:public\.)?users\b/i.test(text);
}

/**
 * True when `pred` joins some table OTHER than `users` and applies
 * breeze_has_org_access(<alias>.org_id) / breeze_has_partner_access(<alias>.partner_id)
 * to that join's alias — i.e. it checks the owner of the row's parent.
 * A helper on the `users` alias describes the row's user, not its parent.
 */
export function predicateHasParentOrgCheck(pred: string | null): boolean {
  const text = normalizePredicate(pred);
  if (text === '') return false;
  // Every relation introduced by FROM, JOIN or a comma join (Postgres deparses
  // explicit joins as `FROM (a x JOIN b y ON ...)`), mapped alias -> table.
  const aliasToTable = new Map<string, string>();
  const relation = /(?:\bFROM|\bJOIN|,)\s*\(*\s*(?:public\.)?([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  for (const m of text.matchAll(relation)) {
    const table = m[1]!.toLowerCase();
    const alias = m[2] && !NOT_AN_ALIAS.has(m[2].toLowerCase()) ? m[2].toLowerCase() : table;
    aliasToTable.set(alias, table);
  }
  for (const m of text.matchAll(/\bbreeze_has_(?:org|partner)_access\(\s*([A-Za-z_][A-Za-z0-9_]*)\.(?:org_id|partner_id)\s*\)/gi)) {
    const table = aliasToTable.get(m[1]!.toLowerCase());
    if (table !== undefined && table !== 'users') return true;
  }
  return false;
}

export interface UserBranchOffence {
  policyname: string;
  cmd: string;
  slot: PredicateSlot;
}

/**
 * Every (permissive policy, slot) whose predicate admits by user identity but
 * never checks a parent row's owner. Postgres ORs permissive policies, so one
 * such slot on a child table without its own org_id is enough to reach rows
 * whose parent belongs to an org the caller cannot access.
 *
 * Co-presence only: a slot that mentions both a user branch and a parent check
 * passes even if the two are OR'd rather than AND'd. The behavioural proof for
 * each table lives in its own *Rls.integration.test.ts.
 */
export function userBranchesWithoutParentOrgCheck(policies: readonly PolicyRow[]): UserBranchOffence[] {
  const out: UserBranchOffence[] = [];
  for (const p of policies) {
    if (p.permissive !== 'PERMISSIVE') continue;
    for (const slot of ['qual', 'with_check'] as const) {
      const pred = p[slot];
      if (predicateReferencesUserIdentity(pred) && !predicateHasParentOrgCheck(pred)) {
        out.push({ policyname: p.policyname, cmd: p.cmd, slot });
      }
    }
  }
  return out;
}
