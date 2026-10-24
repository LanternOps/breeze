import { beforeEach, describe, expect, it, vi } from 'vitest';

const DEFAULTS = vi.hoisted(() => ({
  channels: { inApp: true, push: true },
  quietOverride: 'never',
  digestCadenceMinutes: 240,
  briefTimeLocal: '08:00',
  briefTimezone: null,
  proactivity: 'normal',
}));
const client = vi.hoisted(() => ({
  getWispNudgePrefs: vi.fn(),
  updateWispNudgePrefs: vi.fn(),
}));
vi.mock('../services/wispNudgePrefs', () => ({
  getWispNudgePrefs: client.getWispNudgePrefs,
  updateWispNudgePrefs: client.updateWispNudgePrefs,
  WISP_NUDGE_PREFERENCE_DEFAULTS: DEFAULTS,
}));

import { configureStore } from '@reduxjs/toolkit';

import reducer, {
  clearWispPrefsError,
  loadWispNudgePrefs,
  saveWispNudgePrefs,
  selectWispNudgePrefs,
  selectWispNudgePrefsError,
  selectWispNudgePrefsErrorKind,
  selectWispNudgePrefsSaving,
} from './wispPrefsSlice';

const initial = reducer(undefined, { type: '@@init' });
const quiet = { ...DEFAULTS, proactivity: 'quiet' } as never;

describe('wispPrefsSlice', () => {
  it('starts at the server-side defaults', () => {
    expect(initial.prefs).toEqual(DEFAULTS);
    expect(initial.status).toBe('idle');
    expect(initial.saving).toBe(false);
    expect(initial.error).toBeNull();
  });

  it('load.fulfilled replaces prefs and marks ready', () => {
    const next = reducer(initial, loadWispNudgePrefs.fulfilled(quiet, 'r', undefined));
    expect(next.prefs.proactivity).toBe('quiet');
    expect(next.status).toBe('ready');
  });

  it('load.rejected records the error without clobbering prefs', () => {
    const ready = reducer(initial, loadWispNudgePrefs.fulfilled(quiet, 'r', undefined));
    const next = reducer(ready, loadWispNudgePrefs.rejected(null, 'r2', undefined, 'Network down'));
    expect(next.status).toBe('error');
    expect(next.error).toBe('Network down');
    expect(next.errorKind).toBe('load');
    expect(next.prefs.proactivity).toBe('quiet');
  });

  it('save.pending applies the patch optimistically; rejected rolls back', () => {
    const patch = { proactivity: 'chatty' } as const;
    const pending = reducer(initial, saveWispNudgePrefs.pending('r', patch));
    expect(pending.prefs.proactivity).toBe('chatty');
    expect(pending.prefs.quietOverride).toBe('never');
    expect(pending.saving).toBe(true);

    const rejected = reducer(pending, saveWispNudgePrefs.rejected(null, 'r', patch, 'Network down'));
    expect(rejected.prefs.proactivity).toBe('normal');
    expect(rejected.saving).toBe(false);
    expect(rejected.error).toBe('Network down');
    expect(rejected.errorKind).toBe('save');
  });

  it('rolls back to the value live when the save started', () => {
    const ready = reducer(initial, loadWispNudgePrefs.fulfilled(quiet, 'r', undefined));
    const patch = { proactivity: 'chatty' } as const;
    const pending = reducer(ready, saveWispNudgePrefs.pending('r2', patch));
    const rejected = reducer(pending, saveWispNudgePrefs.rejected(null, 'r2', patch, 'Nope'));
    expect(rejected.prefs.proactivity).toBe('quiet');
  });

  it('save.fulfilled adopts the server echo', () => {
    const patch = { proactivity: 'chatty' } as const;
    const pending = reducer(initial, saveWispNudgePrefs.pending('r', patch));
    const done = reducer(pending, saveWispNudgePrefs.fulfilled(DEFAULTS as never, 'r', patch));
    expect(done.prefs.proactivity).toBe('normal');
    expect(done.saving).toBe(false);
    expect(done.rollback).toBeNull();
  });

  it('clearWispPrefsError clears error and kind', () => {
    const next = reducer({ ...initial, error: 'x', errorKind: 'save' }, clearWispPrefsError());
    expect(next.error).toBeNull();
    expect(next.errorKind).toBeNull();
  });

  it('exposes selectors over the wispPrefs key', () => {
    const state = { wispPrefs: { ...initial, saving: true, error: 'boom', errorKind: 'save' as const } };
    expect(selectWispNudgePrefs(state)).toEqual(DEFAULTS);
    expect(selectWispNudgePrefsSaving(state)).toBe(true);
    expect(selectWispNudgePrefsError(state)).toBe('boom');
    expect(selectWispNudgePrefsErrorKind(state)).toBe('save');
  });
});

describe('wispPrefsSlice save serialisation', () => {
  beforeEach(() => {
    client.getWispNudgePrefs.mockReset();
    client.updateWispNudgePrefs.mockReset();
  });

  const makeStore = () => configureStore({ reducer: { wispPrefs: reducer } });

  it('refuses a second save while one is in flight', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    client.updateWispNudgePrefs.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; })
    );
    const store = makeStore();
    const first = store.dispatch(saveWispNudgePrefs({ proactivity: 'chatty' }));
    expect(store.getState().wispPrefs.saving).toBe(true);

    await store.dispatch(saveWispNudgePrefs({ quietOverride: 'urgent_only' }));
    expect(client.updateWispNudgePrefs).toHaveBeenCalledTimes(1);
    expect(store.getState().wispPrefs.prefs.quietOverride).toBe('never');

    resolveFirst({ ...DEFAULTS, proactivity: 'chatty' });
    await first;
    expect(store.getState().wispPrefs.saving).toBe(false);
    expect(store.getState().wispPrefs.prefs.proactivity).toBe('chatty');
  });

  it('accepts the next save once the first has settled', async () => {
    client.updateWispNudgePrefs
      .mockResolvedValueOnce({ ...DEFAULTS, proactivity: 'chatty' })
      .mockResolvedValueOnce({ ...DEFAULTS, proactivity: 'chatty', quietOverride: 'urgent_only' });
    const store = makeStore();
    await store.dispatch(saveWispNudgePrefs({ proactivity: 'chatty' }));
    await store.dispatch(saveWispNudgePrefs({ quietOverride: 'urgent_only' }));
    expect(client.updateWispNudgePrefs).toHaveBeenCalledTimes(2);
    expect(store.getState().wispPrefs.prefs.quietOverride).toBe('urgent_only');
  });
});
