import { describe, expect, it } from 'vitest';
import {
  coveredCommands,
  normalizePredicate,
  parentAliases,
  predicateCoversOrgAxis,
  predicateCoversParent,
  predicateCoversParents,
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
