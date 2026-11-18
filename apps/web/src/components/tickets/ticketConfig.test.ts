import { describe, it, expect } from 'vitest';
import { slaState, formatRelative, statusConfig, priorityConfig } from './ticketConfig';

describe('slaState', () => {
  // Stored-deadline fixtures (#8973): the client reads *DueAt/*WarnAt only.
  const T0 = new Date('2026-06-09T00:00:00Z');
  const at = (min: number) => new Date(T0.getTime() + min * 60_000).toISOString();
  const ticket = (over: Record<string, unknown>) => ({
    slaBreachedAt: null, dueDate: null, createdAt: at(0),
    resolutionDueAt: null, resolutionWarnAt: null, responseDueAt: null, responseWarnAt: null,
    status: 'open', firstResponseAt: null, ...over
  });
  const res100 = { resolutionDueAt: at(100), resolutionWarnAt: at(80) };

  it('is breached when slaBreachedAt is set', () => {
    expect(slaState(ticket({ slaBreachedAt: '2026-06-09T02:00:00Z' }) as never, new Date('2026-06-09T03:00:00Z')).kind).toBe('breached');
  });

  it('is at-risk once now passes the stored warn point', () => {
    const s = slaState(ticket(res100) as never, new Date('2026-06-09T01:25:00Z'));
    expect(s.kind).toBe('at-risk');
  });

  it('is quiet when healthy or when no stored deadline exists', () => {
    expect(slaState(ticket(res100) as never, new Date('2026-06-09T00:30:00Z')).kind).toBe('ok');
    expect(slaState(ticket({}) as never, new Date('2026-06-09T00:30:00Z')).kind).toBe('none');
  });

  it('closed/resolved tickets are never at-risk', () => {
    expect(slaState(ticket({ resolutionDueAt: at(10), resolutionWarnAt: at(8), status: 'resolved' }) as never, new Date('2026-06-10T00:00:00Z')).kind).toBe('none');
  });

  it('does no target arithmetic: a target without stored deadlines is none', () => {
    expect(slaState(ticket({ resolutionSlaMinutes: 100 }) as never, new Date('2026-06-09T01:25:00Z')).kind).toBe('none');
  });

  it('at-risk follows the stored warn even when it is not 80% of the window', () => {
    // calendar-shaped: warn at +50m, due at +100m, now +55m
    const s = slaState(ticket({ resolutionDueAt: at(100), resolutionWarnAt: at(50) }) as never, new Date(at(55)));
    expect(s.kind).toBe('at-risk');
  });

  it('is breached when now is past the stored due', () => {
    const s = slaState(ticket(res100) as never, new Date(at(110)));
    expect(s.kind).toBe('breached');
    if (s.kind === 'breached') expect(Math.round(s.minutesAgo)).toBe(10);
  });

  it('prefers business minutes remaining when provided', () => {
    const s = slaState(ticket({ ...res100, slaBusinessMinutesRemaining: { response: null, resolution: 42 } }) as never, new Date(at(30)));
    expect(s.kind).toBe('ok');
    if (s.kind === 'ok') expect(s.minutesLeft).toBe(42);
  });

  describe('pause- and response-aware rules', () => {
    const now = new Date(at(60));
    const base = { status: 'open' as const, slaBreachedAt: null, createdAt: at(0), firstResponseAt: null };

    it('uses the response deadline when first response is outstanding', () => {
      // response due +90 (ok at +60), resolution due +480
      const s = slaState({ ...base, responseDueAt: at(90), responseWarnAt: at(72), resolutionDueAt: at(480), resolutionWarnAt: at(384) }, now);
      expect(s.kind).toBe('ok');
      if (s.kind === 'ok') expect(Math.round(s.minutesLeft)).toBe(30);
      // response due +70, warn +56 (at-risk at +60)
      expect(slaState({ ...base, responseDueAt: at(70), responseWarnAt: at(56), resolutionDueAt: at(480), resolutionWarnAt: at(384) }, now).kind).toBe('at-risk');
    });

    it('ignores the response deadline once firstResponseAt is set', () => {
      const s = slaState({ ...base, firstResponseAt: at(5), responseDueAt: at(10), responseWarnAt: at(8), resolutionDueAt: at(480), resolutionWarnAt: at(384) }, now);
      expect(s.kind).toBe('ok');
    });

    it('freezes the clock at slaPausedAt and reports paused', () => {
      // paused at +40; due +90 → 50m left regardless of now (+60)
      const s = slaState({ ...base, slaPausedAt: at(40), resolutionDueAt: at(90), resolutionWarnAt: at(72) }, now);
      expect(s.kind).toBe('paused');
      if (s.kind === 'paused') expect(Math.round(s.minutesLeft)).toBe(50);
    });

    it('shows stored due (pause minutes already included) as remaining', () => {
      // 60m wall elapsed, 30m paused already folded into due +120
      const s = slaState({ ...base, resolutionDueAt: at(120), resolutionWarnAt: at(96) }, now);
      expect(s.kind).toBe('ok');
      if (s.kind === 'ok') expect(Math.round(s.minutesLeft)).toBe(60);
    });
  });
});

describe('config completeness', () => {
  it('covers every status and priority', () => {
    expect(Object.keys(statusConfig).sort()).toEqual(['closed', 'new', 'on_hold', 'open', 'pending', 'resolved']);
    expect(Object.keys(priorityConfig).sort()).toEqual(['high', 'low', 'normal', 'urgent']);
  });
});

describe('formatRelative', () => {
  it('renders compact durations', () => {
    expect(formatRelative(95)).toBe('1h 35m');
    expect(formatRelative(60 * 24 * 2 + 60 * 4)).toBe('2d 4h');
    expect(formatRelative(40)).toBe('40m');
  });
});
