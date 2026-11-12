import { describe, it, expect } from 'vitest';
import type { StandingInstructionContent } from '@breeze/shared';
import {
  standingInstructionClauseHash,
  standingInstructionSubjectKey,
  isEnforceableDeny,
  isStandingInstructionLapsed,
  isMemoryBlockLapsed,
  standingInstructionRuleKey,
} from './standingInstructions';

const DEV = '22222222-2222-4222-8222-222222222222';
const base: StandingInstructionContent = {
  instructionId: '11111111-1111-4111-8111-111111111111',
  effect: 'deny',
  verb: 'reboot',
  deviceId: DEV,
  condition: null,
  until: null,
  text: 'Never reboot PC-01',
  targetLabels: ['PC-01'],
  sourceMessageId: null,
  captureId: null,
};
const now = new Date('2026-11-08T12:00:00Z');

describe('standingInstructionSubjectKey', () => {
  it('same clause gives same key, well-formed', () => {
    const a = standingInstructionSubjectKey(base);
    expect(a).toBe(
      standingInstructionSubjectKey({ ...base, instructionId: '33333333-3333-4333-8333-333333333333' }),
    );
    expect(a).toMatch(new RegExp(`^device:${DEV}:reboot:[0-9a-f]{16}$`));
  });
  it('Review Focus 2: different condition or until gives different key', () => {
    const k = standingInstructionSubjectKey(base);
    expect(standingInstructionSubjectKey({ ...base, condition: 'during business hours' })).not.toBe(k);
    expect(standingInstructionSubjectKey({ ...base, until: '2026-11-14T00:00:00Z' })).not.toBe(k);
  });
  it('case and NFKC differences hash the same', () => {
    expect(standingInstructionClauseHash(base)).toBe(
      standingInstructionClauseHash({ ...base, text: 'never reboot pc-01' }),
    );
    expect(standingInstructionClauseHash({ ...base, text: 'Don’t' })).toBe(
      standingInstructionClauseHash({ ...base, text: 'Ｄon’t' }),
    );
  });
  it('free text uses instruction: prefix', () => {
    expect(standingInstructionSubjectKey({ ...base, deviceId: null })).toMatch(/^instruction:[0-9a-f]{16}$/);
  });
  it('null verb uses none', () => {
    expect(standingInstructionSubjectKey({ ...base, verb: null })).toMatch(
      new RegExp(`^device:${DEV}:none:[0-9a-f]{16}$`),
    );
  });
});

describe('isEnforceableDeny', () => {
  it('matrix', () => {
    expect(isEnforceableDeny(base, now)).toBe(true);
    expect(isEnforceableDeny({ ...base, effect: 'prefer' }, now)).toBe(false);
    expect(isEnforceableDeny({ ...base, effect: 'require' }, now)).toBe(false);
    expect(isEnforceableDeny({ ...base, condition: 'at night' }, now)).toBe(false);
    expect(isEnforceableDeny({ ...base, until: '2026-11-01T00:00:00Z' }, now)).toBe(false);
    expect(isEnforceableDeny({ ...base, until: '2026-11-20T00:00:00Z' }, now)).toBe(true);
    expect(isEnforceableDeny({ ...base, until: null }, now)).toBe(true);
    expect(isEnforceableDeny({ ...base, verb: null }, now)).toBe(false);
    expect(isEnforceableDeny({ ...base, deviceId: null }, now)).toBe(false);
    expect(isEnforceableDeny({ ...base, until: 'garbage' }, now)).toBe(false);
  });
});

describe('isMemoryBlockLapsed (#11630)', () => {
  const sb = (content: Record<string, unknown>, blockType = 'standing_instruction') => ({ blockType, content });
  it('lapses only a standing instruction whose string until has passed', () => {
    expect(isMemoryBlockLapsed(sb({ until: '2026-11-01T00:00:00Z' }), now)).toBe(true);
    expect(isMemoryBlockLapsed(sb({ until: '2026-11-20T00:00:00Z' }), now)).toBe(false);
    expect(isMemoryBlockLapsed(sb({ until: '2026-11-01T00:00:00Z' }, 'fact'), now)).toBe(false);
  });
  it('fails visible: missing, non-string or unparseable until is never lapsed', () => {
    expect(isMemoryBlockLapsed(sb({}), now)).toBe(false);
    expect(isMemoryBlockLapsed(sb({ until: null }), now)).toBe(false);
    expect(isMemoryBlockLapsed(sb({ until: 12345 }), now)).toBe(false);
    expect(isMemoryBlockLapsed(sb({ until: 'next friday' }), now)).toBe(false);
  });
});

describe('isStandingInstructionLapsed (#11630)', () => {
  it('null until never lapses', () => {
    expect(isStandingInstructionLapsed({ until: null }, now)).toBe(false);
  });
  it('a future until is live; a past or exactly-now until is lapsed', () => {
    expect(isStandingInstructionLapsed({ until: '2026-11-07T00:00:00Z' }, now)).toBe(true);
    expect(isStandingInstructionLapsed({ until: '2026-11-08T12:00:00Z' }, now)).toBe(true);
    expect(isStandingInstructionLapsed({ until: '2026-11-08T12:00:01Z' }, now)).toBe(false);
  });
  it('an unparseable until counts as lapsed, as the gate always did', () => {
    expect(isStandingInstructionLapsed({ until: 'someday' }, now)).toBe(true);
  });
});

describe('standingInstructionRuleKey (#11614)', () => {
  it('ignores the wording, the instruction id and the capture ids', () => {
    const reworded: StandingInstructionContent = {
      ...base, text: 'leave PC-01 up', instructionId: '33333333-3333-4333-8333-333333333333',
    };
    expect(standingInstructionRuleKey(reworded)).toBe(standingInstructionRuleKey(base));
  });

  it('normalises the condition and the end time instant', () => {
    const a = { ...base, condition: 'During  business hours', until: '2026-11-13T23:59:00Z' };
    const b = { ...base, condition: 'during business hours ', until: '2026-11-13T18:59:00-05:00' };
    expect(standingInstructionRuleKey(a)).toBe(standingInstructionRuleKey(b));
  });

  it('a note matches on its named targets, in any order or case', () => {
    const note = { ...base, deviceId: null, targetLabels: ['PC-02', 'pc-01'] };
    expect(standingInstructionRuleKey(note)).toBe(standingInstructionRuleKey({ ...note, targetLabels: ['PC-01', 'PC-02'] }));
    expect(standingInstructionRuleKey(note)).not.toBe(standingInstructionRuleKey(base));
  });

  it('device, effect, verb, condition and end time each make a different rule', () => {
    const keys = [
      base,
      { ...base, deviceId: '44444444-4444-4444-8444-444444444444' },
      { ...base, effect: 'require' as const },
      { ...base, verb: 'shutdown' as const },
      { ...base, condition: 'after hours' },
      { ...base, until: '2026-11-13T23:59:00Z' },
    ].map(standingInstructionRuleKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is null when the rule cannot be compared safely: no verb, or a note naming nothing', () => {
    expect(standingInstructionRuleKey({ ...base, verb: null })).toBeNull();
    expect(standingInstructionRuleKey({ ...base, deviceId: null, targetLabels: [] })).toBeNull();
    expect(standingInstructionRuleKey({ ...base, deviceId: null, targetLabels: ['  '] })).toBeNull();
  });
});
