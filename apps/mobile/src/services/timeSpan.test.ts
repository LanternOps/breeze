import { describe, it, expect } from 'vitest';

import { closeLocalSpan, shiftIntoPast } from './timeSpan';

const EPOCH = 'launch-1';

describe('closeLocalSpan', () => {
  it('measures the span from the monotonic anchors when they are comparable', () => {
    const span = closeLocalSpan(
      { startedAtWall: '2026-08-30T09:00:00.000Z', startedAtMono: 1_000, monoEpochId: EPOCH },
      { wallMs: Date.parse('2026-08-30T09:40:00.000Z'), monoMs: 1_000 + 40 * 60_000, monoEpochId: EPOCH }
    );
    expect(span).toEqual({
      startedAt: '2026-08-30T09:00:00.000Z',
      endedAt: '2026-08-30T09:40:00.000Z',
      clockUnverified: false,
    });
  });

  it('ignores a wall-clock jump mid-span when the monotonic epoch is intact', () => {
    // The phone picked up a +3h correction while the technician was in a
    // basement. Wall-to-wall this reads as 3h40m of billable work.
    const span = closeLocalSpan(
      { startedAtWall: '2026-08-30T09:00:00.000Z', startedAtMono: 1_000, monoEpochId: EPOCH },
      {
        wallMs: Date.parse('2026-08-30T12:40:00.000Z'),
        monoMs: 1_000 + 40 * 60_000,
        monoEpochId: EPOCH,
      }
    );
    expect(span).toMatchObject({ endedAt: '2026-08-30T09:40:00.000Z', clockUnverified: false });
  });

  it('falls back to the wall clock across a relaunch and says the duration is unverified', () => {
    const span = closeLocalSpan(
      { startedAtWall: '2026-08-30T09:00:00.000Z', startedAtMono: 1_000, monoEpochId: 'launch-1' },
      { wallMs: Date.parse('2026-08-30T09:40:00.000Z'), monoMs: 5, monoEpochId: 'launch-2' }
    );
    expect(span).toEqual({
      startedAt: '2026-08-30T09:00:00.000Z',
      endedAt: '2026-08-30T09:40:00.000Z',
      clockUnverified: true,
    });
  });

  it('refuses to invent a span when the clock ran backwards', () => {
    expect(
      closeLocalSpan(
        { startedAtWall: '2026-08-30T09:00:00.000Z', startedAtMono: null, monoEpochId: null },
        { wallMs: Date.parse('2026-08-30T08:00:00.000Z'), monoMs: null, monoEpochId: null }
      )
    ).toEqual({ unusable: 'clock-went-backwards' });
  });

  it('floors a mis-tap to one second so endedAt > startedAt still holds', () => {
    // Not a clock error — a double tap. The server rejects endedAt <= startedAt
    // outright, and 1s invoices as 0 minutes, which is the honest answer.
    const span = closeLocalSpan(
      { startedAtWall: '2026-08-30T09:00:00.000Z', startedAtMono: 10, monoEpochId: EPOCH },
      { wallMs: Date.parse('2026-08-30T09:00:00.100Z'), monoMs: 110, monoEpochId: EPOCH }
    );
    expect(span).toMatchObject({
      startedAt: '2026-08-30T09:00:00.000Z',
      endedAt: '2026-08-30T09:00:01.000Z',
    });
  });
});

describe('shiftIntoPast', () => {
  const serverNow = Date.parse('2026-08-30T09:00:00.000Z');

  it('leaves a span that already ended in the past alone', () => {
    expect(shiftIntoPast('2026-08-30T08:00:00.000Z', '2026-08-30T08:40:00.000Z', serverNow)).toEqual({
      startedAt: '2026-08-30T08:00:00.000Z',
      endedAt: '2026-08-30T08:40:00.000Z',
    });
  });

  it('translates BOTH bounds when the device clock is ahead of the server', () => {
    // A phone three hours fast. `createTimeEntrySchema` refines startedAt with
    // notFarFuture (5 minutes), so an unshifted span is a permanent 400.
    const shifted = shiftIntoPast('2026-08-30T11:20:00.000Z', '2026-08-30T12:00:00.000Z', serverNow);
    expect(shifted).toEqual({
      startedAt: '2026-08-30T08:20:00.000Z',
      endedAt: '2026-08-30T09:00:00.000Z',
    });
    expect(Date.parse(shifted.startedAt)).toBeLessThanOrEqual(serverNow);
  });

  it('is duration-invariant for arbitrary inputs', () => {
    // The whole point: the technician's minutes must survive the correction.
    const cases: Array<[string, string, number]> = [
      ['2026-08-30T11:20:00.000Z', '2026-08-30T12:00:00.000Z', serverNow],
      ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', Date.parse('2025-12-31T00:00:00Z')],
      ['2026-08-30T08:00:00.000Z', '2026-08-30T08:40:00.000Z', serverNow],
      ['2026-08-30T09:00:00.000Z', '2026-08-30T17:30:00.000Z', Date.parse('2026-08-30T09:00:00Z')],
    ];
    for (const [start, end, now] of cases) {
      const shifted = shiftIntoPast(start, end, now);
      expect(Date.parse(shifted.endedAt) - Date.parse(shifted.startedAt)).toBe(
        Date.parse(end) - Date.parse(start)
      );
    }
  });
});
