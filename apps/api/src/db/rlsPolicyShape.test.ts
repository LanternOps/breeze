import { describe, expect, it } from 'vitest';
import {
  coveredCommands,
  normalizePredicate,
  parentAliases,
  predicateCoversOrgAxis,
  predicateCoversParent,
  predicateCoversParents,
  predicateHasParentOrgCheck,
  predicateReferencesUserIdentity,
  userBranchesWithoutParentOrgCheck,
  type PolicyRow,
} from './rlsPolicyShape';

// Deparsed shapes copied from pg_policies on a migrated test DB (whitespace
// exactly as Postgres emits it, including the leading "( SELECT").
const SCRIPTS_JOIN_ORG =
  '(EXISTS ( SELECT 1 FROM scripts s WHERE ((s.id = script_versions.script_id) AND breeze_has_org_access(s.org_id))))';
const SCRIPTS_JOIN_PARTNER =
  '(EXISTS ( SELECT 1 FROM scripts s WHERE ((s.id = script_versions.script_id) AND breeze_has_partner_access(s.partner_id))))';
const BOTH_PARENTS =
  '((EXISTS ( SELECT 1 FROM scripts s WHERE ((s.id = script_to_tags.script_id) AND (breeze_has_org_access(s.org_id) OR breeze_has_partner_access(s.partner_id))))) ' +
  'AND (EXISTS ( SELECT 1 FROM script_tags t WHERE ((t.id = script_to_tags.tag_id) AND (breeze_has_org_access(t.org_id) OR breeze_has_partner_access(t.partner_id))))))';
const SCRIPTS_ONLY_PLUS_TAG_JOIN_NO_HELPER =
  '((EXISTS ( SELECT 1 FROM scripts s WHERE ((s.id = script_to_tags.script_id) AND breeze_has_org_access(s.org_id)))) ' +
  'AND (EXISTS ( SELECT 1 FROM script_tags t WHERE (t.id = script_to_tags.tag_id))))';
const HELPER_ON_OTHER_ALIAS =
  '(EXISTS ( SELECT 1 FROM scripts s, organizations o WHERE ((s.id = script_versions.script_id) AND breeze_has_org_access(o.org_id))))';
const HELPER_ON_CHILD_OWN_COLUMN =
  '(EXISTS ( SELECT 1 FROM scripts s WHERE (s.id = script_versions.script_id)) AND breeze_has_org_access(org_id))';
const UNALIASED_PARENT =
  '(EXISTS ( SELECT 1 FROM scripts WHERE ((scripts.id = script_versions.script_id) AND breeze_has_org_access(scripts.org_id))))';
const WITH_NEWLINES =
  '(EXISTS ( SELECT 1\n   FROM scripts s\n  WHERE ((s.id = script_versions.script_id)\n    AND breeze_has_org_access(s.org_id))))';

function policy(p: Partial<PolicyRow> & { cmd: string }): PolicyRow {
  return { policyname: p.policyname ?? 'p', cmd: p.cmd, permissive: p.permissive ?? 'PERMISSIVE', qual: p.qual ?? null, with_check: p.with_check ?? null };
}

const scriptsRule = (pred: string | null) => predicateCoversParents(pred, { kind: 'any-of', parents: ['scripts'] });

describe('rlsPolicyShape — parent aliases', () => {
  it('finds the alias declared after FROM <parent>', () => {
    expect(parentAliases(SCRIPTS_JOIN_ORG, 'scripts')).toEqual(['s']);
  });
  it('falls back to the bare parent name when FROM <parent> has no alias', () => {
    expect(parentAliases(UNALIASED_PARENT, 'scripts')).toEqual(['scripts']);
  });
  it('does not treat FROM script_tags as FROM scripts (word boundary)', () => {
    expect(parentAliases('(EXISTS ( SELECT 1 FROM script_tags t WHERE (t.id = x.tag_id)))', 'scripts')).toEqual([]);
  });
  it('normalises embedded newlines before matching', () => {
    expect(normalizePredicate(WITH_NEWLINES)).not.toContain('\n');
    expect(predicateCoversParent(WITH_NEWLINES, 'scripts')).toBe(true);
  });
});

describe('rlsPolicyShape — predicateCoversParent(s)', () => {
  it('accepts breeze_has_org_access on the parent alias', () => {
    expect(predicateCoversParent(SCRIPTS_JOIN_ORG, 'scripts')).toBe(true);
  });
  it('accepts breeze_has_partner_access on the parent alias (dual-axis parents)', () => {
    expect(predicateCoversParent(SCRIPTS_JOIN_PARTNER, 'scripts')).toBe(true);
  });
  it('rejects a helper applied to a non-parent alias even though FROM <parent> is present', () => {
    expect(predicateCoversParent(HELPER_ON_OTHER_ALIAS, 'scripts')).toBe(false);
  });
  it("rejects a helper applied to the child's own column", () => {
    expect(predicateCoversParent(HELPER_ON_CHILD_OWN_COLUMN, 'scripts')).toBe(false);
  });
  it('any-of: one covered parent suffices', () => {
    expect(predicateCoversParents(SCRIPTS_JOIN_ORG, { kind: 'any-of', parents: ['scripts', 'script_tags'] })).toBe(true);
  });
  it('all-of: every listed parent must carry a helper on its alias', () => {
    expect(predicateCoversParents(BOTH_PARENTS, { kind: 'all-of', parents: ['scripts', 'script_tags'] })).toBe(true);
    expect(predicateCoversParents(SCRIPTS_ONLY_PLUS_TAG_JOIN_NO_HELPER, { kind: 'all-of', parents: ['scripts', 'script_tags'] })).toBe(false);
  });
  it('null / empty predicate never covers', () => {
    expect(scriptsRule(null)).toBe(false);
    expect(scriptsRule('')).toBe(false);
  });
});

describe('rlsPolicyShape — predicateCoversOrgAxis', () => {
  it('accepts breeze_has_org_access(org_id) and breeze_has_org_access(<table>.org_id)', () => {
    expect(predicateCoversOrgAxis('breeze_has_org_access(org_id)', 'devices', false)).toBe(true);
    expect(predicateCoversOrgAxis('breeze_has_org_access(devices.org_id)', 'devices', false)).toBe(true);
  });
  it('rejects a helper on another alias or another column', () => {
    expect(predicateCoversOrgAxis('breeze_has_org_access(tf.org_id)', 'ticket_form_org_links', false)).toBe(false);
    expect(predicateCoversOrgAxis('breeze_has_org_access(partner_id)', 'devices', false)).toBe(false);
    expect(predicateCoversOrgAxis('breeze_has_partner_access(org_id)', 'devices', false)).toBe(false);
  });
  it('accepts breeze_has_org_access(id) only for id-keyed tables', () => {
    expect(predicateCoversOrgAxis('breeze_has_org_access(id)', 'organizations', true)).toBe(true);
    expect(predicateCoversOrgAxis('breeze_has_org_access(id)', 'devices', false)).toBe(false);
    expect(predicateCoversOrgAxis('breeze_has_org_access(org_id)', 'organizations', true)).toBe(false);
  });
});

describe('rlsPolicyShape — coveredCommands (command → slot)', () => {
  it('SELECT and DELETE are covered from qual only', () => {
    const covered = coveredCommands(
      [policy({ cmd: 'SELECT', qual: SCRIPTS_JOIN_ORG }), policy({ cmd: 'DELETE', qual: SCRIPTS_JOIN_ORG })],
      (pred) => scriptsRule(pred),
    );
    expect([...covered].sort()).toEqual(['DELETE', 'SELECT']);
  });
  it('a SELECT policy whose helper sits only in with_check does NOT cover SELECT (the QA-named blind spot)', () => {
    const covered = coveredCommands([policy({ cmd: 'SELECT', qual: 'true', with_check: SCRIPTS_JOIN_ORG })], (pred) => scriptsRule(pred));
    expect(covered.size).toBe(0);
  });
  it('INSERT is covered from with_check only', () => {
    expect(coveredCommands([policy({ cmd: 'INSERT', with_check: SCRIPTS_JOIN_ORG })], (pred) => scriptsRule(pred)).has('INSERT')).toBe(true);
    expect(coveredCommands([policy({ cmd: 'INSERT', qual: SCRIPTS_JOIN_ORG, with_check: 'true' })], (pred) => scriptsRule(pred)).has('INSERT')).toBe(false);
  });
  it('UPDATE needs BOTH qual and with_check', () => {
    expect(coveredCommands([policy({ cmd: 'UPDATE', qual: SCRIPTS_JOIN_ORG, with_check: 'true' })], (pred) => scriptsRule(pred)).has('UPDATE')).toBe(false);
    expect(coveredCommands([policy({ cmd: 'UPDATE', qual: 'true', with_check: SCRIPTS_JOIN_ORG })], (pred) => scriptsRule(pred)).has('UPDATE')).toBe(false);
    expect(coveredCommands([policy({ cmd: 'UPDATE', qual: SCRIPTS_JOIN_ORG, with_check: SCRIPTS_JOIN_ORG })], (pred) => scriptsRule(pred)).has('UPDATE')).toBe(true);
  });
  it('UPDATE/ALL with a NULL with_check reuses qual as the check (Postgres default); INSERT-only policies do not', () => {
    expect(coveredCommands([policy({ cmd: 'UPDATE', qual: SCRIPTS_JOIN_ORG, with_check: null })], (pred) => scriptsRule(pred)).has('UPDATE')).toBe(true);
    const all = coveredCommands([policy({ cmd: 'ALL', qual: SCRIPTS_JOIN_ORG, with_check: null })], (pred) => scriptsRule(pred));
    expect([...all].sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    expect(coveredCommands([policy({ cmd: 'INSERT', qual: SCRIPTS_JOIN_ORG, with_check: null })], (pred) => scriptsRule(pred)).has('INSERT')).toBe(false);
  });
  it('cmd=ALL with an explicit with_check expands to all four, checking the right slot for each', () => {
    const covered = coveredCommands([policy({ cmd: 'ALL', qual: SCRIPTS_JOIN_ORG, with_check: 'true' })], (pred) => scriptsRule(pred));
    expect([...covered].sort()).toEqual(['DELETE', 'SELECT']);
  });
  it('RESTRICTIVE policies never count', () => {
    expect(coveredCommands([policy({ cmd: 'ALL', permissive: 'RESTRICTIVE', qual: SCRIPTS_JOIN_ORG, with_check: SCRIPTS_JOIN_ORG })], (pred) => scriptsRule(pred)).size).toBe(0);
  });
  it('the matcher receives cmd and slot so per-command overlays can differ (script_to_tags shape)', () => {
    const seen: string[] = [];
    coveredCommands(
      [policy({ cmd: 'UPDATE', qual: SCRIPTS_JOIN_ORG, with_check: BOTH_PARENTS })],
      (pred, cmd, slot) => { seen.push(`${cmd}:${slot}`); return true; },
    );
    expect(seen).toEqual(['UPDATE:qual', 'UPDATE:with_check']);
  });
});

// Deparsed shapes copied from pg_policies on a migrated test DB.
const USER_BRANCH_ONLY =
  '((user_id = breeze_current_user_id()) OR (EXISTS ( SELECT 1\n   FROM users u\n  WHERE ((u.id = push_notifications.user_id) AND (breeze_has_partner_access(u.partner_id) OR breeze_has_org_access(u.org_id))))))';
const OWNER_ONLY = '((user_id = breeze_current_user_id()) OR (breeze_current_scope() = \'system\'::text))';
const PARENT_AND_USER =
  '((EXISTS ( SELECT 1\n   FROM tickets t\n  WHERE ((t.id = ticket_comments.ticket_id) AND breeze_has_org_access(t.org_id)))) AND ((user_id = breeze_current_user_id()) OR (EXISTS ( SELECT 1\n   FROM users u\n  WHERE ((u.id = ticket_comments.user_id) AND (breeze_has_partner_access(u.partner_id) OR breeze_has_org_access(u.org_id)))))))';
const PARENT_JOIN_NO_HELPER =
  '((user_id = breeze_current_user_id()) OR (EXISTS ( SELECT 1 FROM alerts a WHERE (a.id = push_notifications.alert_id))))';
const PARENT_ONLY = '(EXISTS ( SELECT 1 FROM tickets t WHERE ((t.id = ticket_comments.ticket_id) AND breeze_has_org_access(t.org_id))))';

describe('rlsPolicyShape — user-identity branches on child tables', () => {
  it('detects breeze_current_user_id() and joins through users', () => {
    expect(predicateReferencesUserIdentity(OWNER_ONLY)).toBe(true);
    expect(predicateReferencesUserIdentity(USER_BRANCH_ONLY)).toBe(true);
    expect(predicateReferencesUserIdentity('(EXISTS ( SELECT 1 FROM public.users u WHERE (u.id = x.user_id)))')).toBe(true);
    expect(predicateReferencesUserIdentity(PARENT_ONLY)).toBe(false);
    expect(predicateReferencesUserIdentity("(breeze_current_scope() = 'system'::text)")).toBe(false);
    // `FROM users_extra` is a different table.
    expect(predicateReferencesUserIdentity('(EXISTS ( SELECT 1 FROM users_extra e WHERE true))')).toBe(false);
    expect(predicateReferencesUserIdentity(null)).toBe(false);
  });

  it('a parent org check is an access helper on a joined non-users table alias', () => {
    expect(predicateHasParentOrgCheck(PARENT_AND_USER)).toBe(true);
    expect(predicateHasParentOrgCheck(PARENT_ONLY)).toBe(true);
    // The users join carries access helpers but describes the user, not the parent row.
    expect(predicateHasParentOrgCheck(USER_BRANCH_ONLY)).toBe(false);
    // Joining the parent without an access helper on it is not a check.
    expect(predicateHasParentOrgCheck(PARENT_JOIN_NO_HELPER)).toBe(false);
    expect(predicateHasParentOrgCheck(null)).toBe(false);
  });

  it('recognises a parent introduced by an explicit JOIN or a comma join', () => {
    expect(predicateHasParentOrgCheck(
      '(EXISTS ( SELECT 1 FROM (child c JOIN tickets t ON ((t.id = c.ticket_id))) WHERE (breeze_has_org_access(t.org_id) AND (c.user_id = breeze_current_user_id()))))',
    )).toBe(true);
    expect(predicateHasParentOrgCheck(
      '(EXISTS ( SELECT 1 FROM child c, tickets t WHERE ((t.id = c.ticket_id) AND breeze_has_org_access(t.org_id))))',
    )).toBe(true);
    // A users alias joined the same way still does not count.
    expect(predicateHasParentOrgCheck(
      '(EXISTS ( SELECT 1 FROM (child c JOIN users u ON ((u.id = c.user_id))) WHERE breeze_has_org_access(u.org_id)))',
    )).toBe(false);
  });

  it('accepts (knowingly) a parent check OR-ed beside an owner branch: co-presence, not boolean structure', () => {
    // push_notifications keeps the recipient's own rows by design, so the
    // owner branch is OR-ed with the parent-checked branch. The matcher cannot
    // tell this from an accidental OR; behavioural tests own that distinction.
    expect(userBranchesWithoutParentOrgCheck([
      policy({ cmd: 'SELECT', qual: '((user_id = breeze_current_user_id()) OR (EXISTS ( SELECT 1 FROM alerts a WHERE ((a.id = push_notifications.alert_id) AND breeze_has_org_access(a.org_id)))))' }),
    ])).toEqual([]);
  });

  it('flags each permissive slot that admits by user identity without a parent org check', () => {
    const flagged = userBranchesWithoutParentOrgCheck([
      policy({ policyname: 'sel', cmd: 'SELECT', qual: USER_BRANCH_ONLY }),
      policy({ policyname: 'ins', cmd: 'INSERT', with_check: OWNER_ONLY }),
      policy({ policyname: 'upd', cmd: 'UPDATE', qual: PARENT_AND_USER, with_check: USER_BRANCH_ONLY }),
      policy({ policyname: 'ok', cmd: 'ALL', qual: PARENT_AND_USER, with_check: PARENT_AND_USER }),
      policy({ policyname: 'parent', cmd: 'SELECT', qual: PARENT_ONLY }),
      policy({ policyname: 'restrictive', cmd: 'ALL', permissive: 'RESTRICTIVE', qual: USER_BRANCH_ONLY }),
    ]);
    expect(flagged).toEqual([
      { policyname: 'sel', cmd: 'SELECT', slot: 'qual' },
      { policyname: 'ins', cmd: 'INSERT', slot: 'with_check' },
      { policyname: 'upd', cmd: 'UPDATE', slot: 'with_check' },
    ]);
  });
});
