import { beforeEach, describe, expect, it } from 'vitest';

import {
  appliesToState,
  formatAppliesToTargets,
  notAppliedTone,
  parseAppliesTo,
  TARGET_LEVEL_ORDER,
  type ConfigPolicyAppliesToSummary,
} from './appliesToSummary';
import { i18n } from '../../lib/i18n';

const summary = (over: Partial<ConfigPolicyAppliesToSummary> = {}): ConfigPolicyAppliesToSummary => ({
  assignmentCount: 0,
  allOrganizations: false,
  targets: [],
  childPolicyCount: 0,
  ...over,
});

const target = (id: string, level: 'partner' | 'organization' | 'site', name: string | null) => ({
  assignmentId: id,
  level,
  targetId: `t-${id}`,
  name,
  roleFilter: null,
  osFilter: null,
});

describe('appliesToSummary (#12306)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('parseAppliesTo returns null for a missing or malformed field', () => {
    expect(parseAppliesTo(undefined)).toBeNull();
    expect(parseAppliesTo(null)).toBeNull();
    expect(parseAppliesTo('applied')).toBeNull();
    expect(parseAppliesTo({})).toBeNull();
    expect(parseAppliesTo({ ...summary(), assignmentCount: '2' })).toBeNull();
    expect(parseAppliesTo({ ...summary(), assignmentCount: -1 })).toBeNull();
    expect(parseAppliesTo({ ...summary(), targets: 'none' })).toBeNull();
    expect(parseAppliesTo({ ...summary(), childPolicyCount: undefined })).toBeNull();
  });

  it('parseAppliesTo drops a malformed target but keeps the counts, so it still reads as +N', () => {
    const parsed = parseAppliesTo({
      ...summary({ assignmentCount: 3 }),
      targets: [
        { assignmentId: 'a', level: 'planet' },
        target('s', 'site', null), // only a partner row may be unnamed
        target('o', 'organization', 'Acme'),
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.assignmentCount).toBe(3);
    expect(parsed!.targets.map((t) => t.assignmentId)).toEqual(['o']);
    expect(formatAppliesToTargets(parsed!).more).toBe(2);
  });

  it('parseAppliesTo accepts a partner row whose name is omitted', () => {
    const { name: _omit, ...partnerRow } = target('p', 'partner', null);
    const parsed = parseAppliesTo({ ...summary({ assignmentCount: 1, allOrganizations: true }), targets: [partnerRow] });
    expect(parsed!.targets).toHaveLength(1);
    expect(parsed!.targets[0]!.name).toBeNull();
  });

  it('parseAppliesTo keeps a well-formed summary', () => {
    const raw = summary({ assignmentCount: 2, targets: [target('a', 'organization', 'Acme')] });
    expect(parseAppliesTo(raw)).toEqual(raw);
  });

  it('formatAppliesToTargets names partner rows All organizations and counts the rest as more', () => {
    const out = formatAppliesToTargets(
      summary({
        assignmentCount: 4,
        allOrganizations: true,
        targets: [target('p', 'partner', null), target('o', 'organization', 'Acme')],
      }),
    );
    expect(out.shown.map((s) => s.text)).toEqual(['All organizations', 'Acme']);
    expect(out.shown.map((s) => s.key)).toEqual(['p', 'o']);
    expect(out.more).toBe(2);
  });

  it('formatAppliesToTargets never reports a negative more', () => {
    const out = formatAppliesToTargets(summary({ assignmentCount: 0, targets: [target('o', 'organization', 'Acme')] }));
    expect(out.more).toBe(0);
  });

  it('notAppliedTone warns only for an active policy, is neutral when inactive and silent when archived', () => {
    expect(notAppliedTone('active', 'not_applied')).toBe('warning');
    expect(notAppliedTone('inactive', 'not_applied')).toBe('neutral');
    expect(notAppliedTone('archived', 'not_applied')).toBeNull();
    expect(notAppliedTone('active', 'in_use_through_children')).toBeNull();
    expect(notAppliedTone('active', 'applied')).toBeNull();
  });

  it('appliesToState follows the unfiltered count, then children', () => {
    expect(appliesToState(summary({ assignmentCount: 1, childPolicyCount: 3 }))).toBe('applied');
    expect(appliesToState(summary({ childPolicyCount: 2 }))).toBe('in_use_through_children');
    expect(appliesToState(summary())).toBe('not_applied');
  });

  it('TARGET_LEVEL_ORDER runs from most general to most specific', () => {
    expect(TARGET_LEVEL_ORDER).toEqual(['partner', 'organization', 'site', 'device_group', 'device']);
  });
});
