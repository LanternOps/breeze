import { describe, it, expect } from 'vitest';
import { compareEvidence, isAfterCursor, maxEvidence, type EvidenceCursor } from './evidenceCursor';

const base: EvidenceCursor = {
  ts: '2026-10-29T10:00:00Z',
  createdAt: '2026-10-29T11:00:00Z',
  id: 'a',
};

function expectOrder(earlier: EvidenceCursor, later: EvidenceCursor) {
  expect(compareEvidence(earlier, later)).toBe(-1);
  expect(compareEvidence(later, earlier)).toBe(1);
}

describe('evidence cursor', () => {
  it('orders same-log rows by recordId even when ts disagrees', () => {
    expectOrder(
      { ...base, logName: 'System', recordId: 10 },
      { ...base, ts: '2026-10-29T09:00:00Z', logName: 'System', recordId: 11 },
    );
  });

  it('falls back to ts then createdAt then id across logs', () => {
    const earlier = { ...base, logName: 'System', recordId: 100 };
    const other = { ...base, logName: 'Application', recordId: 1 };
    expectOrder(earlier, { ...other, ts: '2026-10-29T10:01:00Z', id: '0' });
    expectOrder(earlier, { ...other, createdAt: '2026-10-29T11:01:00Z', id: '0' });
    expectOrder(earlier, { ...other, id: 'b' });
    expect(compareEvidence(earlier, other)).toBe(0);
  });

  it('falls through the timestamp chain when same-log record ids tie', () => {
    const row = { ...base, logName: 'System', recordId: 0 };
    expectOrder(row, { ...row, ts: '2026-10-29T10:01:00Z' });
    expectOrder(row, { ...row, createdAt: '2026-10-29T11:01:00Z' });
    expectOrder(row, { ...row, id: 'b' });
    expect(compareEvidence(row, { ...row })).toBe(0);
  });

  it('falls back when log names or finite record ids are missing', () => {
    expectOrder({ ...base, recordId: 100 }, { ...base, recordId: 1, id: 'b' });
    expectOrder(
      { ...base, recordId: 100 },
      { ...base, logName: 'System', recordId: 1, id: 'b' },
    );
    for (const recordId of [undefined, NaN, Infinity, -Infinity]) {
      expectOrder(
        { ...base, logName: 'System', recordId },
        { ...base, logName: 'System', recordId: 1, id: 'b' },
      );
    }
  });

  it('compares offsets and fractional seconds by instant, not string', () => {
    for (const key of ['ts', 'createdAt'] as const) {
      expectOrder(
        { ...base, [key]: '2026-10-29T12:00:00+02:00' },
        { ...base, [key]: '2026-10-29T10:30:00Z' },
      );
      expectOrder(
        { ...base, [key]: '2026-10-29T10:00:00Z' },
        { ...base, [key]: '2026-10-29T10:00:00.1Z' },
      );
      expect(compareEvidence(
        { ...base, [key]: '2026-10-29T12:00:00.100+02:00' },
        { ...base, [key]: '2026-10-29T10:00:00.1Z' },
      )).toBe(0);
    }
  });

  it('treats unparseable dates as negative infinity', () => {
    for (const key of ['ts', 'createdAt'] as const) {
      expectOrder({ ...base, [key]: 'invalid' }, base);
      expectOrder({ ...base, [key]: 'invalid' }, { ...base, [key]: '', id: 'b' });
      expect(compareEvidence({ ...base, [key]: 'invalid' }, { ...base, [key]: '' })).toBe(0);
    }
  });

  it('isAfterCursor treats a full tie as consumed on the trigger side', () => {
    expect(isAfterCursor({ ...base }, base, 'trigger')).toBe(false);
  });

  it('isAfterCursor treats a full tie as after on the resolve side', () => {
    expect(isAfterCursor({ ...base }, base, 'resolve')).toBe(true);
  });

  it('isAfterCursor ignores row id: same ts and createdAt is a tie whatever the ids', () => {
    // Trigger + recovery uploaded in one batch with clamped timestamps share ts and
    // createdAt; random UUID order must not decide the outcome.
    const cursor = { ...base, id: 'ffff' };
    const row = { ...base, id: '0000' };
    expect(isAfterCursor(row, cursor, 'resolve')).toBe(true);
    expect(isAfterCursor(row, cursor, 'trigger')).toBe(false);
    expect(isAfterCursor(cursor, row, 'trigger')).toBe(false);
  });

  it('undefined cursor admits every row', () => {
    for (const side of ['trigger', 'resolve'] as const) {
      expect(isAfterCursor(base, undefined, side)).toBe(true);
      expect(isAfterCursor({ ...base, ts: 'invalid' }, undefined, side)).toBe(true);
    }
  });

  it('admits later rows and rejects earlier rows on both sides', () => {
    for (const side of ['trigger', 'resolve'] as const) {
      expect(isAfterCursor({ ...base, ts: '2026-10-29T10:00:01Z', id: '0' }, base, side)).toBe(true);
      expect(isAfterCursor({ ...base, ts: '2026-10-29T09:59:59Z', id: 'z' }, base, side)).toBe(false);
    }
  });

  it('maxEvidence ignores undefined', () => {
    expect(maxEvidence()).toBeUndefined();
    expect(maxEvidence(base, undefined)).toBe(base);
    expect(maxEvidence(undefined, base)).toBe(base);
  });

  it('maxEvidence returns the later row and retains the first on a tie', () => {
    const later = { ...base, id: 'b' };
    expect(maxEvidence(base, later)).toBe(later);
    expect(maxEvidence(later, base)).toBe(later);
    expect(maxEvidence(base, { ...base })).toBe(base);
  });
});
