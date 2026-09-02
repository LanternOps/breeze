import { describe, it, expect } from 'vitest';
import {
  rowSummary,
  precisionChip,
  ticketChipLabel,
  confirmToast,
  bannerLabel,
  alreadyLoggedNote,
  entryPointVisible,
} from './timeSuggestionCopy';
import type { TimeSuggestion } from '../../services/timeSuggestions';

// 14:02–14:40 UTC. Every assertion below pins tz to UTC explicitly: the copy
// helpers take the zone as an argument precisely so a test is not at the mercy
// of the runner's TZ (which a vitest worker does not re-read from process.env).
const TZ = 'UTC';

function sug(overrides: Partial<TimeSuggestion> = {}): TimeSuggestion {
  return {
    key: 'k',
    signals: [{ kind: 'remote_session', id: 's1', type: 'desktop', startedAt: '2026-08-29T14:02:00.000Z', endedAt: '2026-08-29T14:40:00.000Z', precision: 'exact' }],
    startedAt: '2026-08-29T14:02:00.000Z',
    endedAt: '2026-08-29T14:40:00.000Z',
    durationMinutes: 38,
    device: { id: 'd1', hostname: 'ACME-DC01' },
    org: { id: 'o1', name: 'Acme' },
    quickSupport: null,
    candidateTicket: null,
    otherTickets: [],
    suggestedSource: 'remote_session',
    alreadyLoggedOverlapMinutes: 0,
    ...overrides,
  };
}

describe('rowSummary', () => {
  it('formats a recorded desktop session row', () => {
    expect(rowSummary(sug(), TZ)).toBe('38 min · desktop · ACME-DC01 · 14:02–14:40');
  });

  it('an unreliable session shows no duration and no end time', () => {
    const unreliable = sug({
      endedAt: null,
      durationMinutes: null,
      signals: [{ kind: 'remote_session', id: 's1', type: 'terminal', startedAt: '2026-08-29T14:02:00.000Z', endedAt: '2026-08-29T14:02:00.000Z', precision: 'unreliable' }],
    });
    const summary = rowSummary(unreliable, TZ);
    expect(summary).toBe('terminal · ACME-DC01 · from 14:02');
    expect(summary).not.toMatch(/\d+ min/); // 'terminal' contains 'min' — anchor on the digits
    expect(summary).not.toContain('–');
  });

  it('a purged Quick Support device falls back to the attribution label, never a blank (F12)', () => {
    const purged = sug({
      device: null,
      quickSupport: { attributionLabel: 'Quick Support · Dana', attributedOrgName: 'Northwind' },
    });
    expect(rowSummary(purged, TZ)).toBe('38 min · desktop · Quick Support · Dana · 14:02–14:40');
  });

  it('falls back to the org name when there is neither a device nor an attribution label', () => {
    expect(rowSummary(sug({ device: null, quickSupport: null }), TZ))
      .toBe('38 min · desktop · Acme · 14:02–14:40');
  });

  it('never renders an empty segment when device, quickSupport and org are all absent', () => {
    const bare = rowSummary(sug({ device: null, quickSupport: null, org: null }), TZ);
    expect(bare).toBe('38 min · desktop · 14:02–14:40');
    expect(bare).not.toContain('·  ·');
  });

  it('renders in the caller-supplied zone, not UTC', () => {
    expect(rowSummary(sug(), 'America/New_York')).toContain('10:02–10:40');
  });

  it('labels a multi-signal window by its session count rather than one type', () => {
    const merged = sug({
      signals: [
        { kind: 'remote_session', id: 's1', type: 'desktop', startedAt: '2026-08-29T14:02:00.000Z', endedAt: '2026-08-29T14:20:00.000Z', precision: 'exact' },
        { kind: 'remote_session', id: 's2', type: 'terminal', startedAt: '2026-08-29T14:25:00.000Z', endedAt: '2026-08-29T14:40:00.000Z', precision: 'exact' },
      ],
    });
    expect(rowSummary(merged, TZ)).toBe('38 min · 2 sessions · ACME-DC01 · 14:02–14:40');
  });
});

describe('precisionChip', () => {
  it('names each precision in the technician’s language, not the schema’s', () => {
    expect(precisionChip('exact')).toBe('Recorded');
    expect(precisionChip('approximate')).toBe('Approximate');
    expect(precisionChip('unreliable')).toBe('Needs a time');
  });
  it('returns null for an unknown precision rather than rendering the raw token', () => {
    expect(precisionChip('something_new')).toBeNull();
  });
});

describe('ticketChipLabel', () => {
  it('states WHY it was picked', () => {
    const withTicket = sug({ candidateTicket: { id: 't1', ticketNumber: 'TKT-1041', subject: 'VPN', status: 'closed', reason: 'closed_by_you' } });
    expect(ticketChipLabel(withTicket)).toBe('TKT-1041 · closed by you');
  });
  it('renders the assigned reason', () => {
    const withTicket = sug({ candidateTicket: { id: 't1', ticketNumber: 'TKT-9', subject: 'x', status: 'open', reason: 'assigned_to_you' } });
    expect(ticketChipLabel(withTicket)).toBe('TKT-9 · assigned to you');
  });
  it('prompts to choose when there is no candidate', () => {
    expect(ticketChipLabel(sug())).toBe('Add a ticket');
  });
});

describe('alreadyLoggedNote (F19)', () => {
  it('shows the note only for a non-zero residual', () => {
    expect(alreadyLoggedNote(0)).toBeNull();
    expect(alreadyLoggedNote(10)).toBe('10 min of this window is already on your timesheet');
  });
  it('never renders a negative residual', () => {
    expect(alreadyLoggedNote(-5)).toBeNull();
  });
});

describe('entryPointVisible', () => {
  it('hides the entry points when disabled or the count is 0', () => {
    expect(entryPointVisible({ enabled: false, count: 3 })).toBe(false);
    expect(entryPointVisible({ enabled: true, count: 0 })).toBe(false);
    expect(entryPointVisible({ enabled: true, count: 3 })).toBe(true);
  });
});

describe('bannerLabel / confirmToast', () => {
  it('pluralises the banner', () => {
    expect(bannerLabel(1)).toBe('1 unlogged session today');
    expect(bannerLabel(3)).toBe('3 unlogged sessions today');
  });
  it('names the ticket in the confirm toast when there is one', () => {
    const withTicket = sug({ candidateTicket: { id: 't1', ticketNumber: 'TKT-1041', subject: 'VPN', status: 'closed', reason: 'closed_by_you' } });
    expect(confirmToast(withTicket)).toBe('Logged 38 min to TKT-1041');
  });
  it('omits the ticket clause when the entry is unlinked', () => {
    expect(confirmToast(sug())).toBe('Logged 38 min');
  });
  it('does not claim a duration for an unreliable session', () => {
    expect(confirmToast(sug({ durationMinutes: null }))).toBe('Logged this session');
  });
});
