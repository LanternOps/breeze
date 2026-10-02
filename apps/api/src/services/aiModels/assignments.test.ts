import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {} }));

import { EFFORT_LEVELS, type OfferingOptions } from '@breeze/shared';
import {
  clampOrgOptions,
  isPermitted,
  mergeEffectiveAssignment,
  type AssignmentRowInput,
} from './assignments';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'aaaaaaaa-0000-4000-8000-000000000002';
const C = 'aaaaaaaa-0000-4000-8000-000000000003';

function row(over: Partial<AssignmentRowInput> = {}): AssignmentRowInput {
  return {
    id: over.id ?? 'row',
    role: over.role ?? 'default',
    defaultOfferingId: over.defaultOfferingId ?? null,
    permittedOfferingIds: over.permittedOfferingIds ?? null,
    allowUserChoice: over.allowUserChoice ?? null,
    options: over.options ?? null,
    fallbackOfferingIds: over.fallbackOfferingIds ?? null,
    fallbackMayCrossFunding: over.fallbackMayCrossFunding ?? null,
  };
}
const merge = (partner: AssignmentRowInput | null, org: AssignmentRowInput | null) =>
  mergeEffectiveAssignment({ surface: 'chat', role: 'default', partner, org });

describe('permitted set: partner ∩ org, org can only narrow', () => {
  it.each([
    ['partner all, org inherit', null, null, { kind: 'all' }],
    ['partner all, org list', null, [B, A], { kind: 'list', offeringIds: [B, A] }],
    ['partner list, org inherit', [A, B], null, { kind: 'list', offeringIds: [A, B] }],
    ['partner list, org narrower', [A, B], [B], { kind: 'list', offeringIds: [B] }],
    ['partner list, org tries to widen', [A], [A, C], { kind: 'list', offeringIds: [A] }],
    ['disjoint ⇒ empty', [A], [C], { kind: 'list', offeringIds: [] }],
  ] as const)('%s', (_l, partnerIds, orgIds, expected) => {
    const eff = merge(row({ permittedOfferingIds: partnerIds as string[] | null }), orgIds === null ? row() : row({ permittedOfferingIds: [...orgIds] }));
    expect(eff.permitted).toEqual(expected);
  });

  it('isPermitted honours both shapes', () => {
    expect(isPermitted({ kind: 'all' }, A)).toBe(true);
    expect(isPermitted({ kind: 'list', offeringIds: [A] }, A)).toBe(true);
    expect(isPermitted({ kind: 'list', offeringIds: [A] }, B)).toBe(false);
    expect(isPermitted({ kind: 'list', offeringIds: [] }, A)).toBe(false);
  });
});

describe('default: the org default only inside the effective permitted set', () => {
  it.each([
    ['org default permitted', { defaultOfferingId: A }, { defaultOfferingId: B }, B, 'org', []],
    ['org default outside partner permitted', { defaultOfferingId: A, permittedOfferingIds: [A] }, { defaultOfferingId: B }, A, 'partner', ['org_default_not_permitted']],
    ['org default outside its own narrowing', { defaultOfferingId: A }, { defaultOfferingId: B, permittedOfferingIds: [C] }, A, 'partner', ['org_default_not_permitted']],
    ['org silent', { defaultOfferingId: A }, {}, A, 'partner', []],
    ['nobody sets one', {}, {}, null, 'none', []],
    ['partner default survives an org narrowing that excludes it (spec, literal)', { defaultOfferingId: A }, { permittedOfferingIds: [B] }, A, 'partner', []],
  ] as const)('%s', (_l, partner, org, expectedDefault, source, warnings) => {
    const eff = merge(row(partner as Partial<AssignmentRowInput>), row(org as Partial<AssignmentRowInput>));
    expect(eff.defaultOfferingId).toBe(expectedDefault);
    expect(eff.defaultSource).toBe(source);
    expect(eff.warnings).toEqual(warnings);
  });
});

describe('allow_user_choice = partner ∧ org (NULL partner = true, NULL org = inherit)', () => {
  const values = [true, false, null] as const;
  it.each(values.flatMap((p) => values.map((o) => [p, o] as const)))('partner %s, org %s', (p, o) => {
    const eff = merge(row({ allowUserChoice: p }), row({ allowUserChoice: o }));
    expect(eff.allowUserChoice).toBe((p ?? true) && (o ?? true));
  });
});

describe('options clamp: an org can only lower cost', () => {
  const levels = [undefined, ...EFFORT_LEVELS] as const;
  it.each(levels.flatMap((p) => levels.map((o) => [p, o] as const)))('effort partner=%s org=%s', (p, o) => {
    const { options, warnings } = clampOrgOptions(p ? { effort: p } : {}, o ? { effort: o } : null);
    const idx = (e: string) => EFFORT_LEVELS.indexOf(e as (typeof EFFORT_LEVELS)[number]);
    const expected = o === undefined ? p : p === undefined ? o : (idx(o) <= idx(p) ? o : p);
    expect(options.effort).toBe(expected);
    expect(warnings.includes('org_effort_clamped')).toBe(!!(o && p && idx(o) > idx(p)));
  });

  const speeds = [undefined, 'standard', 'fast'] as const;
  it.each(speeds.flatMap((p) => speeds.map((o) => [p, o] as const)))('speed partner=%s org=%s', (p, o) => {
    const { options, warnings } = clampOrgOptions(p ? { speed: p } : {}, o ? { speed: o } : null);
    const expected = o === undefined ? p : o === 'fast' ? (p === 'fast' ? 'fast' : (p ?? undefined)) : 'standard';
    expect(options.speed).toBe(expected);
    expect(warnings.includes('org_speed_clamped')).toBe(o === 'fast' && p !== 'fast');
  });

  it('thinkingDisplay: org ?? partner', () => {
    expect(clampOrgOptions({ thinkingDisplay: 'summarized' }, { thinkingDisplay: 'updates' }).options.thinkingDisplay).toBe('updates');
    expect(clampOrgOptions({ thinkingDisplay: 'summarized' }, {}).options.thinkingDisplay).toBe('summarized');
    expect(clampOrgOptions({}, null).options).toEqual({});
  });

  it('an invalid stored options object is ignored with a warning, never thrown', () => {
    const eff = merge(row({ options: { effort: 'ludicrous' } as unknown as Record<string, unknown> }), row({ options: { speed: 'warp' } as unknown as Record<string, unknown> }));
    expect(eff.options).toEqual({});
    expect(eff.warnings).toEqual(expect.arrayContaining(['invalid_partner_options', 'invalid_org_options']));
  });
});

describe('fallbacks: the org list only when it is a subset of the PARTNER permitted set', () => {
  it.each([
    ['org subset of partner list', { permittedOfferingIds: [A, B], fallbackOfferingIds: [A] }, { fallbackOfferingIds: [B, A] }, [B, A], []],
    ['org outside partner list', { permittedOfferingIds: [A], fallbackOfferingIds: [A] }, { fallbackOfferingIds: [C] }, [A], ['org_fallbacks_not_permitted']],
    ['partner permits all', { fallbackOfferingIds: [A] }, { fallbackOfferingIds: [C] }, [C], []],
    ['org inherits', { fallbackOfferingIds: [A] }, {}, [A], []],
    ['nobody sets any', {}, {}, [], []],
  ] as const)('%s', (_l, partner, org, expected, warnings) => {
    const eff = merge(row(partner as Partial<AssignmentRowInput>), row(org as Partial<AssignmentRowInput>));
    expect(eff.fallbackOfferingIds).toEqual(expected);
    expect(eff.warnings).toEqual(warnings);
  });

  const flags = [true, false, null] as const;
  it.each(flags.flatMap((p) => flags.map((o) => [p, o] as const)))('cross-funding partner %s org %s', (p, o) => {
    const eff = merge(row({ fallbackMayCrossFunding: p }), row({ fallbackMayCrossFunding: o }));
    expect(eff.fallbackMayCrossFunding).toBe((p ?? false) && (o ?? true));
  });
});

describe('missing rows', () => {
  it('no partner row: permissive partner, org choices stand inside it', () => {
    const eff = merge(null, row({ defaultOfferingId: A, permittedOfferingIds: [A] }));
    expect(eff).toMatchObject({ defaultOfferingId: A, defaultSource: 'org', permitted: { kind: 'list', offeringIds: [A] }, allowUserChoice: true });
  });
  it('no rows at all: nothing chosen, everything enabled permitted', () => {
    expect(merge(null, null)).toMatchObject({ defaultOfferingId: null, defaultSource: 'none', permitted: { kind: 'all' }, allowUserChoice: true, fallbackOfferingIds: [], fallbackMayCrossFunding: false, options: {} });
  });
});

describe('tighten-only property: no org row can widen any partner choice', () => {
  const ids = [[A], [A, B], null] as const;
  const choice = [true, false, null] as const;
  const efforts = [undefined, 'low', 'max'] as const;
  const cases = ids.flatMap((pp) => ids.flatMap((op) => choice.flatMap((pc) => choice.flatMap((oc) => efforts.flatMap((pe) => efforts.map((oe) => [pp, op, pc, oc, pe, oe] as const))))));
  it.each(cases)('partner %j / org %j / choice %s,%s / effort %s,%s', (pp, op, pc, oc, pe, oe) => {
    const partner = row({ permittedOfferingIds: pp as string[] | null, allowUserChoice: pc, options: pe ? { effort: pe } : null, defaultOfferingId: A });
    const org = row({ permittedOfferingIds: op as string[] | null, allowUserChoice: oc, options: oe ? { effort: oe } : null, defaultOfferingId: B });
    const eff = merge(partner, org);
    if (pp !== null && eff.permitted.kind === 'list') for (const id of eff.permitted.offeringIds) expect(pp).toContain(id);
    if (pp !== null) expect(eff.permitted.kind).toBe('list');
    if ((pc ?? true) === false) expect(eff.allowUserChoice).toBe(false);
    if (pe && eff.options.effort) expect(EFFORT_LEVELS.indexOf(eff.options.effort)).toBeLessThanOrEqual(EFFORT_LEVELS.indexOf(pe));
    if (eff.defaultSource === 'org') expect(isPermitted(eff.permitted, eff.defaultOfferingId!)).toBe(true);
  });
});

describe('clampOrgOptions: budgetThinking (W05)', () => {
  it.each([
    [{}, { budgetThinking: 'off' }, 'off', []],
    [{ budgetThinking: 'on' }, { budgetThinking: 'off' }, 'off', []],
    [{ budgetThinking: 'on' }, { budgetThinking: 'on' }, 'on', []],
    [{}, { budgetThinking: 'on' }, undefined, ['org_budget_thinking_clamped']],
    [{ budgetThinking: 'off' }, { budgetThinking: 'on' }, 'off', ['org_budget_thinking_clamped']],
    [{ budgetThinking: 'on' }, null, 'on', []],
  ] as const)('partner %j + org %j → %s', (partner, org, expected, warnings) => {
    const r = clampOrgOptions(partner, org);
    expect(r.options.budgetThinking).toBe(expected);
    expect(r.warnings).toEqual(warnings);
  });
});
