import { describe, expect, it } from 'vitest';
import type { CalendarRevision } from '@breeze/shared';
import {
  accruePauseEnd,
  computeSlaDeadlines,
  freezeResponse,
  isResolutionFrozen,
  isResponseFrozen,
  loadTicketCalendar,
  slaClockRowOf,
  type SlaClockRow,
  type TicketCalendar,
} from './ticketSlaDeadlines';

// #8973 W3 — spec §4.3: due = add(created, target + paused_business),
// warn = add(created, 0.8 * target + paused_business); frozen arms never move.

const created = new Date('2026-03-02T09:00:00Z');
const min = (n: number) => n * 60_000;
const after = (ms: number) => new Date(created.getTime() + ms);

function row(over: Partial<SlaClockRow> = {}): SlaClockRow {
  return {
    createdAt: created,
    responseSlaMinutes: 60,
    resolutionSlaMinutes: 480,
    slaPausedAt: null,
    slaPausedBusinessMinutes: 0,
    firstResponseAt: null,
    resolvedAt: null,
    slaBreachReason: null,
    ...over,
  };
}

describe('computeSlaDeadlines (null calendar = wall clock)', () => {
  it('computes due and warn for both targets', () => {
    expect(computeSlaDeadlines(row(), null)).toEqual({
      responseDueAt: after(min(60)),
      responseWarnAt: after(min(48)),
      resolutionDueAt: after(min(480)),
      resolutionWarnAt: after(min(384)),
    });
  });

  it('keeps the 0.8 fraction (7 min → warn 5 min 36 s)', () => {
    expect(computeSlaDeadlines(row({ responseSlaMinutes: 7 }), null).responseWarnAt).toEqual(after(336_000));
  });

  it('adds paused business minutes to both due and warn', () => {
    expect(computeSlaDeadlines(row({ slaPausedBusinessMinutes: 30 }), null)).toMatchObject({
      responseDueAt: after(min(90)),
      responseWarnAt: after(min(78)),
    });
  });

  it('a null target yields null due and warn', () => {
    expect(computeSlaDeadlines(row({ responseSlaMinutes: null, resolutionSlaMinutes: null }), null)).toEqual({
      responseDueAt: null, responseWarnAt: null, resolutionDueAt: null, resolutionWarnAt: null,
    });
  });

  it('runs the business calendar when one applies', () => {
    const cal: TicketCalendar = {
      revision: { timezone: 'UTC', intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })) } as CalendarRevision,
      holidays: [],
    };
    // Mon 09:00 + 480 business minutes = Mon 17:00; + 600 → Tue 11:00.
    expect(computeSlaDeadlines(row({ responseSlaMinutes: 480, resolutionSlaMinutes: 600 }), cal)).toMatchObject({
      responseDueAt: new Date('2026-03-02T17:00:00Z'),
      resolutionDueAt: new Date('2026-03-03T11:00:00Z'),
    });
  });
});

describe('freeze rule', () => {
  it('response is frozen by first_response_at or a response breach', () => {
    expect(isResponseFrozen(row({ firstResponseAt: after(min(5)) }))).toBe(true);
    expect(isResponseFrozen(row({ slaBreachReason: 'response' }))).toBe(true);
    expect(isResponseFrozen(row({ slaBreachReason: 'resolution' }))).toBe(false);
    expect(isResponseFrozen(row())).toBe(false);
  });

  it('resolution is frozen by resolved_at or a resolution breach', () => {
    expect(isResolutionFrozen(row({ resolvedAt: after(min(5)) }))).toBe(true);
    expect(isResolutionFrozen(row({ slaBreachReason: 'response,resolution' }))).toBe(true);
    expect(isResolutionFrozen(row({ slaBreachReason: 'response' }))).toBe(false);
  });

  it('computeSlaDeadlines leaves frozen arms out of the patch', () => {
    expect(computeSlaDeadlines(row({ firstResponseAt: after(min(5)) }), null)).toEqual({
      resolutionDueAt: after(min(480)),
      resolutionWarnAt: after(min(384)),
    });
    expect(computeSlaDeadlines(row({ firstResponseAt: after(min(5)), resolvedAt: after(min(9)) }), null)).toEqual({});
    expect(computeSlaDeadlines(row({ slaBreachReason: 'resolution' }), null)).toEqual({
      responseDueAt: after(min(60)),
      responseWarnAt: after(min(48)),
    });
  });

  it('reopen (resolved_at cleared) unfreezes resolution with the same formula', () => {
    const resolved = row({ firstResponseAt: after(min(5)), resolvedAt: after(min(100)), slaPausedBusinessMinutes: 20 });
    expect(computeSlaDeadlines(resolved, null)).toEqual({});
    expect(computeSlaDeadlines({ ...resolved, resolvedAt: null }, null)).toEqual({
      resolutionDueAt: after(min(500)),
      resolutionWarnAt: after(min(404)),
    });
  });
});

describe('accruePauseEnd', () => {
  it('adds the whole business minutes of the pause (floored, like sla_paused_minutes)', () => {
    const r = row({ slaPausedAt: after(min(10)), slaPausedBusinessMinutes: 4 });
    expect(accruePauseEnd(r, null, after(min(10) + 30 * 60_000 + 59_000))).toEqual({ slaPausedBusinessMinutes: 34 });
  });

  it('is a no-op when the ticket is not paused', () => {
    expect(accruePauseEnd(row({ slaPausedBusinessMinutes: 7 }), null, after(min(90)))).toEqual({ slaPausedBusinessMinutes: 7 });
  });

  it('never goes negative on a clock skew', () => {
    const r = row({ slaPausedAt: after(min(10)), slaPausedBusinessMinutes: 4 });
    expect(accruePauseEnd(r, null, after(min(5)))).toEqual({ slaPausedBusinessMinutes: 4 });
  });

  it('pause end then resolve does not double count', () => {
    // Paused 10 → 40 (30 min), resumed, then resolved at 200.
    const paused = row({ slaPausedAt: after(min(10)), firstResponseAt: after(min(2)) });
    const accrued = accruePauseEnd(paused, null, after(min(40)));
    const resumed: SlaClockRow = { ...paused, slaPausedAt: null, ...accrued };
    expect(computeSlaDeadlines(resumed, null).resolutionDueAt).toEqual(after(min(510)));
    // The resolve itself: not paused, so nothing more accrues.
    expect(accruePauseEnd(resumed, null, after(min(200)))).toEqual({ slaPausedBusinessMinutes: 30 });
    expect(computeSlaDeadlines({ ...resumed, ...accruePauseEnd(resumed, null, after(min(200))) }, null).resolutionDueAt)
      .toEqual(after(min(510)));
  });
});

describe('freezeResponse', () => {
  it('stamps the current response deadline when not paused', () => {
    expect(freezeResponse(row({ slaPausedBusinessMinutes: 15 }), null, after(min(20)))).toEqual({
      responseDueAt: after(min(75)),
      responseWarnAt: after(min(63)),
    });
  });

  it('first response while paused uses a transient accrual and persists none of it', () => {
    const paused = row({ slaPausedAt: after(min(30)), slaPausedBusinessMinutes: 5 });
    const patch = freezeResponse(paused, null, after(min(50)));
    // 5 persisted + 20 transient.
    expect(patch).toEqual({ responseDueAt: after(min(85)), responseWarnAt: after(min(73)) });
    expect(patch).not.toHaveProperty('slaPausedBusinessMinutes');
    // When the pause later ends the whole span accrues exactly once.
    expect(accruePauseEnd(paused, null, after(min(90)))).toEqual({ slaPausedBusinessMinutes: 65 });
  });

  it('is empty once response is frozen', () => {
    expect(freezeResponse(row({ firstResponseAt: after(min(1)) }), null, after(min(20)))).toEqual({});
    expect(freezeResponse(row({ slaBreachReason: 'response' }), null, after(min(90)))).toEqual({});
  });

  it('a null response target freezes to null', () => {
    expect(freezeResponse(row({ responseSlaMinutes: null }), null, after(min(20)))).toEqual({ responseDueAt: null, responseWarnAt: null });
  });
});

describe('slaClockRowOf', () => {
  it('reads a tickets row, defaulting legacy nulls', () => {
    expect(slaClockRowOf({
      createdAt: created, responseSlaMinutes: 60, resolutionSlaMinutes: null, slaPausedAt: null,
      slaPausedBusinessMinutes: null, firstResponseAt: null, resolvedAt: null, slaBreachReason: null,
    })).toEqual(row({ resolutionSlaMinutes: null }));
  });
});

describe('loadTicketCalendar', () => {
  it('is null in W3 (no calendars yet)', async () => {
    await expect(loadTicketCalendar({} as never, null)).resolves.toBeNull();
    await expect(loadTicketCalendar({} as never, 'rev-1')).resolves.toBeNull();
  });
});
