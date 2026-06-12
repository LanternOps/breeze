import { describe, it, expect } from 'vitest';
import { slaState, formatRelative, statusConfig, priorityConfig } from './ticketConfig';

describe('slaState', () => {
  const ticket = (over: Record<string, unknown>) => ({
    slaBreachedAt: null, dueDate: null, createdAt: '2026-06-09T00:00:00Z',
    resolutionSlaMinutes: null, status: 'open', ...over
  });

  it('is breached when slaBreachedAt is set', () => {
    expect(slaState(ticket({ slaBreachedAt: '2026-06-09T02:00:00Z' }) as never, new Date('2026-06-09T03:00:00Z')).kind).toBe('breached');
  });

  it('is at-risk at >=80% of resolution SLA elapsed', () => {
    // 100 min SLA, 85 min elapsed
    const s = slaState(ticket({ resolutionSlaMinutes: 100 }) as never, new Date('2026-06-09T01:25:00Z'));
    expect(s.kind).toBe('at-risk');
  });

  it('is quiet when healthy or when no SLA is configured', () => {
    expect(slaState(ticket({ resolutionSlaMinutes: 100 }) as never, new Date('2026-06-09T00:30:00Z')).kind).toBe('ok');
    expect(slaState(ticket({}) as never, new Date('2026-06-09T00:30:00Z')).kind).toBe('none');
  });

  it('closed/resolved tickets are never at-risk', () => {
    expect(slaState(ticket({ resolutionSlaMinutes: 10, status: 'resolved' }) as never, new Date('2026-06-10T00:00:00Z')).kind).toBe('none');
  });

  describe('pause- and response-aware rules', () => {
    const base = { status: 'open' as const, slaBreachedAt: null, createdAt: new Date(Date.now() - 60 * 60_000).toISOString(), firstResponseAt: null };

    it('uses the response target when first response is outstanding', () => {
      // 60m elapsed, response target 90m (66% — ok), resolution 480m
      const s = slaState({ ...base, responseSlaMinutes: 90, resolutionSlaMinutes: 480 });
      expect(s.kind).toBe('ok');
      // 60m elapsed, response target 70m (86% — at-risk)
      expect(slaState({ ...base, responseSlaMinutes: 70, resolutionSlaMinutes: 480 }).kind).toBe('at-risk');
    });

    it('ignores the response target once firstResponseAt is set', () => {
      const s = slaState({ ...base, firstResponseAt: new Date().toISOString(), responseSlaMinutes: 10, resolutionSlaMinutes: 480 });
      expect(s.kind).toBe('ok');
    });

    it('freezes the clock while paused and reports paused', () => {
      const s = slaState({ ...base, slaPausedAt: new Date().toISOString(), resolutionSlaMinutes: 90, slaPausedMinutes: 0 });
      expect(s.kind).toBe('paused');
    });

    it('subtracts accumulated pause minutes', () => {
      // 60m wall elapsed, 30m paused → 30m active; target 90m → ok with 60m left
      const s = slaState({ ...base, resolutionSlaMinutes: 90, slaPausedMinutes: 30 });
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
