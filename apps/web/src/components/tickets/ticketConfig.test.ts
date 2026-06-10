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
