import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/ticketPushPrefs', () => ({
  getTicketPushPrefs: vi.fn(),
  updateTicketPushPrefs: vi.fn(),
  TICKET_PUSH_PREFERENCE_DEFAULTS: { assignedEnabled: true, slaScope: 'owned' },
}));

import reducer, {
  clearError,
  loadTicketPushPrefs,
  saveTicketPushPrefs,
  selectTicketPushPrefs,
  selectTicketPushPrefsError,
  selectTicketPushPrefsSaving,
} from './notificationPrefsSlice';

const initial = reducer(undefined, { type: '@@init' });

describe('notificationPrefsSlice (#4336)', () => {
  it('starts at the server-side defaults, so the sheet renders correctly before the first load', () => {
    expect(initial.prefs).toEqual({ assignedEnabled: true, slaScope: 'owned' });
    expect(initial.status).toBe('idle');
    expect(initial.saving).toBe(false);
    expect(initial.error).toBeNull();
  });

  it('load.fulfilled replaces prefs and marks the slice ready', () => {
    const next = reducer(
      initial,
      loadTicketPushPrefs.fulfilled({ assignedEnabled: false, slaScope: 'any' }, 'r', undefined)
    );

    expect(next.prefs).toEqual({ assignedEnabled: false, slaScope: 'any' });
    expect(next.status).toBe('ready');
  });

  it('load.rejected records the error without clobbering the current prefs', () => {
    const ready = reducer(
      initial,
      loadTicketPushPrefs.fulfilled({ assignedEnabled: false, slaScope: 'any' }, 'r', undefined)
    );

    const next = reducer(
      ready,
      loadTicketPushPrefs.rejected(null, 'r2', undefined, 'Network down')
    );

    expect(next.status).toBe('error');
    expect(next.error).toBe('Network down');
    expect(next.prefs).toEqual({ assignedEnabled: false, slaScope: 'any' });
  });

  it('save.pending applies the patch optimistically; save.rejected rolls back and records the error', () => {
    const pending = reducer(initial, saveTicketPushPrefs.pending('r', { slaScope: 'any' }));
    expect(pending.prefs.slaScope).toBe('any');
    expect(pending.prefs.assignedEnabled).toBe(true); // untouched key survives
    expect(pending.saving).toBe(true);

    const rejected = reducer(
      pending,
      saveTicketPushPrefs.rejected(null, 'r', { slaScope: 'any' }, 'Network down')
    );

    // Leaving the optimistic value on screen would tell the technician they had
    // turned SLA pushes on for every ticket when the server still has 'owned'.
    expect(rejected.prefs.slaScope).toBe('owned');
    expect(rejected.saving).toBe(false);
    expect(rejected.error).toBe('Network down');
  });

  it('rolls back to the value that was live when the save started, not to the defaults', () => {
    const ready = reducer(
      initial,
      loadTicketPushPrefs.fulfilled({ assignedEnabled: false, slaScope: 'any' }, 'r', undefined)
    );
    const pending = reducer(ready, saveTicketPushPrefs.pending('r2', { slaScope: 'off' }));

    const rejected = reducer(
      pending,
      saveTicketPushPrefs.rejected(null, 'r2', { slaScope: 'off' }, 'Nope')
    );

    expect(rejected.prefs).toEqual({ assignedEnabled: false, slaScope: 'any' });
  });

  it('save.fulfilled adopts the server echo, even when it disagrees with the optimistic patch', () => {
    const pending = reducer(initial, saveTicketPushPrefs.pending('r', { assignedEnabled: false }));

    const done = reducer(
      pending,
      saveTicketPushPrefs.fulfilled(
        { assignedEnabled: false, slaScope: 'owned' },
        'r',
        { assignedEnabled: false }
      )
    );

    expect(done.prefs).toEqual({ assignedEnabled: false, slaScope: 'owned' });
    expect(done.saving).toBe(false);
  });

  it('clearError clears, so the Settings sheet does not re-toast the same failure', () => {
    expect(reducer({ ...initial, error: 'x' }, clearError()).error).toBeNull();
  });

  it('exposes selectors over the mounted slice key', () => {
    const state = { notificationPrefs: { ...initial, saving: true, error: 'boom' } };

    expect(selectTicketPushPrefs(state)).toEqual({ assignedEnabled: true, slaScope: 'owned' });
    expect(selectTicketPushPrefsSaving(state)).toBe(true);
    expect(selectTicketPushPrefsError(state)).toBe('boom');
  });
});
