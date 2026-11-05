import { describe, expect, it } from 'vitest';
import { cancelCheckInSchema, listCheckInsToolSchema, scheduleCheckInSchema } from './wispCheckIns';
import { WISP_CHECK_IN_INSTRUCTION_MAX, WISP_CHECK_IN_MAX_DELAY_MINUTES } from '../types/wispCheckIns';

const id = '6f1c2b1e-4a7d-4c55-9a35-2d8f5f0e1a01';
const instruction = 'Verify no msiexec processes remain on the device.';

function issuePaths(input: unknown): string[] {
  const r = scheduleCheckInSchema.safeParse(input);
  expect(r.success).toBe(false);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
}

describe('scheduleCheckInSchema (schedule_check_in)', () => {
  it('accepts delayMinutes 1 and 10080, rejects 0, 10081 and a fraction', () => {
    expect(WISP_CHECK_IN_MAX_DELAY_MINUTES).toBe(10_080);
    for (const delayMinutes of [1, 10_080]) {
      expect(scheduleCheckInSchema.safeParse({ delayMinutes, instruction }).success, String(delayMinutes)).toBe(true);
    }
    for (const delayMinutes of [0, 10_081, 1.5, -5]) {
      expect(scheduleCheckInSchema.safeParse({ delayMinutes, instruction }).success, String(delayMinutes)).toBe(false);
    }
  });

  it('accepts an at with an offset or Z', () => {
    for (const at of ['2026-11-04T14:30:00Z', '2026-11-04T14:30:00+02:00', '2026-11-04T14:30:00.123-05:00']) {
      expect(scheduleCheckInSchema.safeParse({ at, instruction }).success, at).toBe(true);
    }
  });

  it('rejects an at with no offset (never read in the server time zone), and a bare date', () => {
    for (const at of ['2026-11-04T14:30:00', '2026-11-04', 'tomorrow at 9']) {
      expect(issuePaths({ at, instruction }), at).toContain('at');
    }
  });

  it('rejects both delayMinutes and at, and neither, with the issue on the timing keys', () => {
    expect(issuePaths({ delayMinutes: 10, at: '2026-11-04T14:30:00Z', instruction })).toEqual(['delayMinutes']);
    expect(issuePaths({ instruction })).toEqual(['delayMinutes']);
  });

  it('instruction is 1..1000 code points after trimming (1000 emoji pass, 1001 fail, blank fails)', () => {
    expect(WISP_CHECK_IN_INSTRUCTION_MAX).toBe(1000);
    expect(scheduleCheckInSchema.safeParse({ delayMinutes: 5, instruction: '😀'.repeat(1000) }).success).toBe(true);
    expect(issuePaths({ delayMinutes: 5, instruction: '😀'.repeat(1001) })).toEqual(['instruction']);
    expect(issuePaths({ delayMinutes: 5, instruction: '   ' })).toEqual(['instruction']);
    expect(issuePaths({ delayMinutes: 5 })).toEqual(['instruction']);
    const parsed = scheduleCheckInSchema.parse({ delayMinutes: 5, instruction: `  ${instruction}  ` });
    expect(parsed.instruction).toBe(instruction);
  });

  it('subject is an optional { kind, id } with a known kind and a guid', () => {
    expect(scheduleCheckInSchema.safeParse({ delayMinutes: 5, instruction, subject: { kind: 'device', id } }).success).toBe(true);
    expect(issuePaths({ delayMinutes: 5, instruction, subject: { kind: 'printer', id } })).toEqual(['subject.kind']);
    expect(issuePaths({ delayMinutes: 5, instruction, subject: { kind: 'device', id: 'WS-01' } })).toEqual(['subject.id']);
  });

  it('strips unknown keys (a grantId or threadId the model adds never reaches the handler)', () => {
    const parsed = scheduleCheckInSchema.parse({ delayMinutes: 5, instruction, grantId: id, threadId: id });
    expect(parsed).toEqual({ delayMinutes: 5, instruction });
  });
});

describe('cancelCheckInSchema / listCheckInsToolSchema', () => {
  it('cancel takes one guid checkInId', () => {
    expect(cancelCheckInSchema.safeParse({ checkInId: id }).success).toBe(true);
    expect(cancelCheckInSchema.safeParse({ checkInId: 'abc' }).success).toBe(false);
    expect(cancelCheckInSchema.safeParse({}).success).toBe(false);
  });

  it('list is a strict empty object (never z.undefined(), which breaks MCP tools/list)', () => {
    expect(listCheckInsToolSchema.safeParse({}).success).toBe(true);
    expect(listCheckInsToolSchema.safeParse({ threadId: id }).success).toBe(false);
    expect(Object.keys(listCheckInsToolSchema.shape)).toEqual([]);
  });
});
