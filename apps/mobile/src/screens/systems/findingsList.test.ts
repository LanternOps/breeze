import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findingRowSubtitle,
  findingsListEmptyCopy,
  findingsListReducer,
  initialFindingsListState,
  sortFindings,
  toFindingListItem,
  type FindingListItem,
  type FindingsListState,
} from './findingsList';
import type { FleetFinding } from '../../services/findings';

function item(overrides: Partial<FindingListItem> = {}): FindingListItem {
  return {
    id: 'f-1',
    title: 'VSS writers failing',
    status: 'open',
    severity: 'warning',
    deviceCount: 3,
    lastSeenAt: '2026-09-09T12:00:00.000Z',
    ...overrides,
  };
}

describe('sortFindings', () => {
  it('puts the worst severity first', () => {
    const sorted = sortFindings([
      item({ id: 'info', severity: 'info' }),
      item({ id: 'critical', severity: 'critical' }),
      item({ id: 'warning', severity: 'warning' }),
      item({ id: 'error', severity: 'error' }),
    ]);
    expect(sorted.map((f) => f.id)).toEqual(['critical', 'error', 'warning', 'info']);
  });

  it('breaks a severity tie with the most recently seen', () => {
    const sorted = sortFindings([
      item({ id: 'older', lastSeenAt: '2026-09-01T00:00:00.000Z' }),
      item({ id: 'newer', lastSeenAt: '2026-09-08T00:00:00.000Z' }),
    ]);
    expect(sorted.map((f) => f.id)).toEqual(['newer', 'older']);
  });

  it('breaks a full tie on title so the order does not flicker between refreshes', () => {
    const sorted = sortFindings([
      item({ id: 'b', title: 'Zeta' }),
      item({ id: 'a', title: 'Alpha' }),
    ]);
    expect(sorted.map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('does not mutate the input', () => {
    const input = [item({ id: 'info', severity: 'info' }), item({ id: 'crit', severity: 'critical' })];
    sortFindings(input);
    expect(input.map((f) => f.id)).toEqual(['info', 'crit']);
  });

  it('sorts a finding with an unparseable lastSeenAt last within its severity', () => {
    const sorted = sortFindings([
      item({ id: 'bad', lastSeenAt: 'not-a-date' }),
      item({ id: 'good', lastSeenAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(sorted.map((f) => f.id)).toEqual(['good', 'bad']);
  });
});

describe('findingsListReducer', () => {
  it('starts loading with nothing to show', () => {
    expect(initialFindingsListState).toEqual({
      phase: 'loading',
      findings: [],
      total: 0,
      refreshing: false,
      errorMessage: null,
    });
  });

  it('shows the skeleton on the first load and the refresh control on later ones', () => {
    const first = findingsListReducer(initialFindingsListState, { type: 'load' });
    expect(first.phase).toBe('loading');
    expect(first.refreshing).toBe(false);

    const ready = findingsListReducer(first, { type: 'loaded', findings: [item()], total: 1 });
    const second = findingsListReducer(ready, { type: 'load' });
    expect(second.phase).toBe('ready');
    expect(second.refreshing).toBe(true);
    expect(second.findings).toHaveLength(1);
  });

  it('sorts on load so the screen never has to', () => {
    const state = findingsListReducer(initialFindingsListState, {
      type: 'loaded',
      findings: [item({ id: 'low', severity: 'info' }), item({ id: 'high', severity: 'critical' })],
      total: 2,
    });
    expect(state.phase).toBe('ready');
    expect(state.findings.map((f) => f.id)).toEqual(['high', 'low']);
    expect(state.total).toBe(2);
    expect(state.refreshing).toBe(false);
    expect(state.errorMessage).toBeNull();
  });

  it('treats a 404 as an empty list, not an error', () => {
    const state = findingsListReducer(initialFindingsListState, { type: 'empty' });
    expect(state).toEqual({
      phase: 'ready',
      findings: [],
      total: 0,
      refreshing: false,
      errorMessage: null,
    });
  });

  it('errors only when there is nothing already on screen', () => {
    const state = findingsListReducer(initialFindingsListState, {
      type: 'failed',
      message: 'Network request failed',
    });
    expect(state.phase).toBe('error');
    expect(state.errorMessage).toBe('Network request failed');
    expect(state.refreshing).toBe(false);
  });

  it('keeps the rows and surfaces a banner when a refresh fails', () => {
    const ready = findingsListReducer(initialFindingsListState, {
      type: 'loaded',
      findings: [item()],
      total: 1,
    });
    const refreshing = findingsListReducer(ready, { type: 'load' });
    const failed = findingsListReducer(refreshing, { type: 'failed', message: 'Offline' });
    expect(failed.phase).toBe('ready');
    expect(failed.findings).toHaveLength(1);
    expect(failed.refreshing).toBe(false);
    expect(failed.errorMessage).toBe('Offline');
  });

  it('clears a previous error when a load starts', () => {
    const errored: FindingsListState = {
      phase: 'error',
      findings: [],
      total: 0,
      refreshing: false,
      errorMessage: 'Offline',
    };
    expect(findingsListReducer(errored, { type: 'load' }).errorMessage).toBeNull();
  });

  it('recovers from an error state on a successful reload', () => {
    const errored = findingsListReducer(initialFindingsListState, {
      type: 'failed',
      message: 'Offline',
    });
    const recovered = findingsListReducer(errored, {
      type: 'loaded',
      findings: [item()],
      total: 1,
    });
    expect(recovered.phase).toBe('ready');
    expect(recovered.errorMessage).toBeNull();
  });
});

describe('copy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T14:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads status, device count and recency', () => {
    expect(findingRowSubtitle(item({ status: 'open', deviceCount: 3 }))).toBe(
      'Open · 3 devices · 2h ago',
    );
  });

  it('singularises one device', () => {
    expect(findingRowSubtitle(item({ deviceCount: 1 }))).toBe('Open · 1 device · 2h ago');
  });

  it('omits the device segment when the finding has no members', () => {
    expect(findingRowSubtitle(item({ deviceCount: 0 }))).toBe('Open · 2h ago');
  });

  it('omits the time segment when lastSeenAt is unusable', () => {
    expect(findingRowSubtitle(item({ lastSeenAt: 'not-a-date' }))).toBe('Open · 3 devices');
  });

  it('names the org in the empty state so the tech knows what was checked', () => {
    expect(findingsListEmptyCopy('Berthoud Vet Care')).toEqual({
      title: 'No open findings',
      body: 'Berthoud Vet Care has no open or acknowledged findings right now.',
    });
  });

  it('falls back to a generic empty state when the org name is unknown', () => {
    expect(findingsListEmptyCopy('').body).toBe(
      'This organization has no open or acknowledged findings right now.',
    );
  });
});

describe('toFindingListItem', () => {
  it('narrows an API finding row to only the fields the list renders', () => {
    const row: FleetFinding = {
      id: 'f-9',
      orgId: 'org-1',
      orgName: 'Berthoud Vet Care',
      kind: 'reliability_offenders',
      status: 'acknowledged',
      severity: 'error',
      title: 'Repeated unexpected reboots',
      summary: 'Three devices rebooted unexpectedly',
      deviceCount: 3,
      firstSeenAt: '2026-09-01T00:00:00.000Z',
      lastSeenAt: '2026-09-09T12:00:00.000Z',
      acknowledgedAt: '2026-09-09T13:00:00.000Z',
      dismissedAt: null,
      dismissNotes: null,
      resolvedAt: null,
    };
    expect(toFindingListItem(row)).toEqual({
      id: 'f-9',
      title: 'Repeated unexpected reboots',
      status: 'acknowledged',
      severity: 'error',
      deviceCount: 3,
      lastSeenAt: '2026-09-09T12:00:00.000Z',
    });
  });
});
