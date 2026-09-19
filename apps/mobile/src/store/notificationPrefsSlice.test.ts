import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  getTicketPushPrefs: vi.fn(),
  updateTicketPushPrefs: vi.fn(),
}));
vi.mock('../services/ticketPushPrefs', () => ({
  getTicketPushPrefs: client.getTicketPushPrefs,
  updateTicketPushPrefs: client.updateTicketPushPrefs,
  TICKET_PUSH_PREFERENCE_DEFAULTS: { assignedEnabled: true, slaScope: 'owned' },
}));

import { configureStore } from '@reduxjs/toolkit';

import reducer, {
  clearError,
  loadTicketPushPrefs,
  saveTicketPushPrefs,
  selectTicketPushPrefs,
  selectTicketPushPrefsError,
  selectTicketPushPrefsErrorKind,
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
    const state = {
      notificationPrefs: { ...initial, saving: true, error: 'boom', errorKind: 'save' as const },
    };

    expect(selectTicketPushPrefs(state)).toEqual({ assignedEnabled: true, slaScope: 'owned' });
    expect(selectTicketPushPrefsSaving(state)).toBe(true);
    expect(selectTicketPushPrefsError(state)).toBe('boom');
    expect(selectTicketPushPrefsErrorKind(state)).toBe('save');
  });

  it('distinguishes a failed LOAD from a failed SAVE', () => {
    // Both land in the same `error` field, and the Settings sheet toasts off
    // it. Without the kind, a failed sheet-open load tells the technician
    // "could not save" for a save they never made.
    const loadFailed = reducer(
      initial,
      loadTicketPushPrefs.rejected(null, 'r', undefined, 'Network down')
    );
    expect(loadFailed.errorKind).toBe('load');

    const saveFailed = reducer(
      reducer(initial, saveTicketPushPrefs.pending('r', { slaScope: 'off' })),
      saveTicketPushPrefs.rejected(null, 'r', { slaScope: 'off' }, 'Network down')
    );
    expect(saveFailed.errorKind).toBe('save');

    expect(reducer(saveFailed, clearError()).errorKind).toBeNull();
  });
});

describe('notificationPrefsSlice save serialisation (#4336)', () => {
  beforeEach(() => {
    client.getTicketPushPrefs.mockReset();
    client.updateTicketPushPrefs.mockReset();
  });

  function makeStore() {
    return configureStore({ reducer: { notificationPrefs: reducer } });
  }

  it('refuses a second save while one is in flight, so the rollback snapshot stays truthful', async () => {
    // The single rollback slot is only correct if at most one save is ever
    // outstanding. Overlapping saves would let the second snapshot the FIRST
    // one's unconfirmed optimistic value as "last known good", and a double
    // rejection would then leave a never-persisted setting on screen forever.
    // The Settings controls disable themselves while saving, but a tap landing
    // inside that render tick would otherwise still get through — so the
    // invariant is enforced here, not in the component.
    let resolveFirst: (v: unknown) => void = () => {};
    client.updateTicketPushPrefs.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; })
    );

    const store = makeStore();
    const first = store.dispatch(saveTicketPushPrefs({ assignedEnabled: false }));
    expect(store.getState().notificationPrefs.saving).toBe(true);

    await store.dispatch(saveTicketPushPrefs({ slaScope: 'any' }));

    expect(client.updateTicketPushPrefs).toHaveBeenCalledTimes(1);
    // The dropped save left no trace: the second control did NOT move
    // optimistically for a request that was never sent.
    expect(store.getState().notificationPrefs.prefs.slaScope).toBe('owned');

    resolveFirst({ assignedEnabled: false, slaScope: 'owned' });
    await first;

    expect(store.getState().notificationPrefs.saving).toBe(false);
    expect(store.getState().notificationPrefs.prefs).toEqual({
      assignedEnabled: false,
      slaScope: 'owned',
    });
  });

  it('accepts the next save once the first has settled', async () => {
    client.updateTicketPushPrefs
      .mockResolvedValueOnce({ assignedEnabled: false, slaScope: 'owned' })
      .mockResolvedValueOnce({ assignedEnabled: false, slaScope: 'any' });

    const store = makeStore();
    await store.dispatch(saveTicketPushPrefs({ assignedEnabled: false }));
    await store.dispatch(saveTicketPushPrefs({ slaScope: 'any' }));

    expect(client.updateTicketPushPrefs).toHaveBeenCalledTimes(2);
    expect(store.getState().notificationPrefs.prefs).toEqual({
      assignedEnabled: false,
      slaScope: 'any',
    });
  });
});
