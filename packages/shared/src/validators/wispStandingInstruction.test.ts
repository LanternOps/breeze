import { describe, it, expect } from 'vitest';
import { standingInstructionContentSchema } from './wispStandingInstruction';

const valid = {
  instructionId: '11111111-1111-4111-8111-111111111111',
  effect: 'deny',
  verb: 'reboot',
  deviceId: '22222222-2222-4222-8222-222222222222',
  condition: null,
  until: '2026-12-01T10:00:00Z',
  text: 'Never reboot PC-01',
  targetLabels: ['PC-01'],
  sourceMessageId: null,
  captureId: null,
};

describe('standingInstructionContentSchema', () => {
  it('parses a valid object', () => {
    expect(standingInstructionContentSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects unknown keys (strict)', () => {
    expect(standingInstructionContentSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });
  it('rejects until without offset', () => {
    expect(standingInstructionContentSchema.safeParse({ ...valid, until: '2026-12-01T10:00:00' }).success).toBe(false);
  });
  it('rejects text over 500', () => {
    expect(standingInstructionContentSchema.safeParse({ ...valid, text: 'x'.repeat(501) }).success).toBe(false);
  });
  it('rejects more than 20 targetLabels', () => {
    expect(standingInstructionContentSchema.safeParse({ ...valid, targetLabels: Array(21).fill('a') }).success).toBe(false);
  });
  it('rejects a bad verb', () => {
    expect(standingInstructionContentSchema.safeParse({ ...valid, verb: 'format_disk' }).success).toBe(false);
  });
});
