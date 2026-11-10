import { describe, it, expect } from 'vitest';
import type { StandingInstructionContent } from '@breeze/shared';
import {
  standingInstructionClauseHash,
  standingInstructionSubjectKey,
  isEnforceableDeny,
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
