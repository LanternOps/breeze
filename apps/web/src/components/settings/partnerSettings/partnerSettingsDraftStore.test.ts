import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { showToast } from '../../shared/Toast';
import { ActionError } from '@/lib/runAction';
import {
  usePartnerSettingsDraftStore,
  useDraftSlice,
  isSliceDirty,
  saveSlice,
  stableStringify,
} from './partnerSettingsDraftStore';

vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
const showToastMock = vi.mocked(showToast);

const store = () => usePartnerSettingsDraftStore.getState();

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  store().reset();
  store().setPartner('p1');
});
afterEach(() => { store().reset(); });

describe('partnerSettingsDraftStore', () => {
  it('ensureLoaded runs the loader once across remounts and concurrent callers', async () => {
    const loader = vi.fn(async () => ({ value: { a: 1 } }));
    const first = renderHook(() => useDraftSlice('loginBranding', loader));
    const second = renderHook(() => useDraftSlice('loginBranding', loader));
    await act(async () => { await Promise.resolve(); });
    first.unmount();
    renderHook(() => useDraftSlice('loginBranding', loader));
    await act(async () => { await Promise.resolve(); });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(second.result.current.slice.status).toBe('ready');
    expect(second.result.current.slice.draft).toEqual({ a: 1 });
  });

  it('draft survives a consumer unmount', async () => {
    const loader = async () => ({ value: { title: 'old' } });
    const first = renderHook(() => useDraftSlice<{ title: string }>('trustCenter', loader));
    await act(async () => { await Promise.resolve(); });
    act(() => first.result.current.setDraft(prev => ({ ...prev, title: 'new' })));
    first.unmount();
    const again = renderHook(() => useDraftSlice<{ title: string }>('trustCenter', loader));
    expect(again.result.current.slice.draft).toEqual({ title: 'new' });
    expect(isSliceDirty(store().slices.trustCenter)).toBe(true);
  });

  it('rebaseline clears dirty', async () => {
    await store().ensureLoaded('aiDataPolicy', async () => ({ value: { mode: 'a' } }));
    store().setDraft('aiDataPolicy', { mode: 'b' });
    expect(isSliceDirty(store().slices.aiDataPolicy)).toBe(true);
    store().rebaseline('aiDataPolicy', { mode: 'b' });
    expect(isSliceDirty(store().slices.aiDataPolicy)).toBe(false);
  });

  it('dirty compare ignores key order', async () => {
    await store().ensureLoaded('aiDataPolicy', async () => ({ value: { a: 1, b: 2 } }));
    store().setDraft('aiDataPolicy', { b: 2, a: 1 });
    expect(isSliceDirty(store().slices.aiDataPolicy)).toBe(false);
    expect(stableStringify({ b: [1, { d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[1,{"c":2,"d":1}]}');
  });

  it('an edit made while saving stays dirty after success (re-baseline to the sent snapshot)', async () => {
    await store().ensureLoaded('loginBranding', async () => ({ value: { title: 'a' } }));
    store().setDraft('loginBranding', { title: 'b' });
    const gate = deferred<{ revision?: number }>();
    const send = vi.fn(() => gate.promise);
    const pending = saveSlice('loginBranding', send);
    expect(send).toHaveBeenCalledWith({ title: 'b' }, undefined);
    store().setDraft('loginBranding', { title: 'c' });
    gate.resolve({});
    expect(await pending).toEqual({ status: 'saved', savedAt: expect.any(Number) });
    const slice = store().slices.loginBranding;
    expect(slice.baseline).toEqual({ title: 'b' });
    expect(slice.draft).toEqual({ title: 'c' });
    expect(isSliceDirty(slice)).toBe(true);
    expect(slice.lastOutcome?.status).toBe('saved');
  });

  it('a successful save stores the returned revision', async () => {
    await store().ensureLoaded('trustCenter', async () => ({ value: { x: 1 }, revision: 3 }));
    store().setDraft('trustCenter', { x: 2 });
    const send = vi.fn(async () => ({ revision: 4 }));
    await saveSlice('trustCenter', send);
    expect(send).toHaveBeenCalledWith({ x: 2 }, 3);
    expect(store().slices.trustCenter.revision).toBe(4);
    expect(isSliceDirty(store().slices.trustCenter)).toBe(false);
  });

  it('a failed save keeps the draft and the baseline and reports the classified outcome', async () => {
    await store().ensureLoaded('trustCenter', async () => ({ value: { x: 1 }, revision: 3 }));
    store().setDraft('trustCenter', { x: 2 });
    const failed = await saveSlice('trustCenter', async () => { throw new Error('nope'); });
    expect(failed).toEqual({ status: 'failed' });
    const conflict = await saveSlice('trustCenter', async () => { throw new Error('rev'); }, { classifyError: () => 'conflict' });
    expect(conflict).toEqual({ status: 'conflict' });
    const slice = store().slices.trustCenter;
    expect(slice.draft).toEqual({ x: 2 });
    expect(slice.baseline).toEqual({ x: 1 });
    expect(slice.revision).toBe(3);
    expect(slice.lastOutcome).toEqual({ status: 'conflict' });
  });

  it('a non-ActionError failure is toasted with the fallback; an ActionError is not toasted again', async () => {
    await store().ensureLoaded('loginBranding', async () => ({ value: { t: 1 } }));
    store().setDraft('loginBranding', { t: 2 });
    await saveSlice('loginBranding', async () => { throw new TypeError('bug'); }, { errorFallback: 'Could not save' });
    expect(showToastMock).toHaveBeenCalledWith({ type: 'error', message: 'Could not save' });
    showToastMock.mockClear();
    await saveSlice('loginBranding', async () => { throw new ActionError('server said no', 500); }, { errorFallback: 'Could not save' });
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('a save after the draft settles to the server copy re-baselines to that copy', async () => {
    await store().ensureLoaded('loginBranding', async () => ({ value: { t: ' a ' } }));
    store().setDraft('loginBranding', { t: ' b ' });
    await saveSlice('loginBranding', async () => ({ value: { t: 'b' } }));
    expect(store().slices.loginBranding.draft).toEqual({ t: 'b' });
    expect(isSliceDirty(store().slices.loginBranding)).toBe(false);
  });

  it('a stale load for a previous partner is ignored', async () => {
    const gate = deferred<{ value: unknown }>();
    const pending = store().ensureLoaded('callerVerification', () => gate.promise);
    store().setPartner('p2');
    gate.resolve({ value: { from: 'p1' } });
    await pending;
    expect(store().slices.callerVerification.status).toBe('idle');
    expect(store().slices.callerVerification.draft).toBeNull();
    await store().ensureLoaded('callerVerification', async () => ({ value: { from: 'p2' } }));
    expect(store().slices.callerVerification.draft).toEqual({ from: 'p2' });
  });

  it('a save response after a partner switch is dropped', async () => {
    await store().ensureLoaded('loginBranding', async () => ({ value: { title: 'a' } }));
    store().setDraft('loginBranding', { title: 'b' });
    const gate = deferred<{ revision?: number }>();
    const pending = saveSlice('loginBranding', () => gate.promise);
    store().setPartner('p2');
    gate.resolve({});
    await pending;
    expect(store().slices.loginBranding.status).toBe('idle');
    expect(store().slices.loginBranding.baseline).toBeNull();
  });

  it('an older load that resolves after a newer reload is ignored', async () => {
    const slow = deferred<{ value: unknown }>();
    const first = store().ensureLoaded('aiDataPolicy', () => slow.promise);
    const reload = store().reloadFromServer('aiDataPolicy', async () => ({ value: { v: 'new' } }));
    await reload;
    slow.resolve({ value: { v: 'old' } });
    await first;
    expect(store().slices.aiDataPolicy.draft).toEqual({ v: 'new' });
  });

  it('ensureLoaded retries after an error', async () => {
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ value: { ok: true } });
    await store().ensureLoaded('aiFeatureDefaults', loader);
    expect(store().slices.aiFeatureDefaults.status).toBe('error');
    await store().ensureLoaded('aiFeatureDefaults', loader);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(store().slices.aiFeatureDefaults.status).toBe('ready');
  });

  it('reloadFromServer replaces the draft with the server copy and clears dirty', async () => {
    await store().ensureLoaded('trustCenter', async () => ({ value: { t: 'mine' }, revision: 1 }));
    store().setDraft('trustCenter', { t: 'edited' });
    await store().reloadFromServer('trustCenter', async () => ({ value: { t: 'theirs' }, revision: 2 }));
    const slice = store().slices.trustCenter;
    expect(slice.draft).toEqual({ t: 'theirs' });
    expect(slice.revision).toBe(2);
    expect(isSliceDirty(slice)).toBe(false);
  });

  it('invalidate makes the next ensureLoaded refetch', async () => {
    const loader = vi.fn(async () => ({ value: { n: 1 } }));
    await store().ensureLoaded('aiFeatureDefaults', loader);
    await store().ensureLoaded('aiFeatureDefaults', loader);
    expect(loader).toHaveBeenCalledTimes(1);
    store().invalidate('aiFeatureDefaults');
    await store().ensureLoaded('aiFeatureDefaults', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('setDraft before the slice is loaded is ignored', () => {
    store().setDraft('loginBranding', { title: 'x' });
    expect(store().slices.loginBranding.draft).toBeNull();
  });

  it('reset clears all slices', async () => {
    await store().ensureLoaded('loginBranding', async () => ({ value: { a: 1 } }));
    store().setValidity('loginBranding', { isValid: false, invalidCount: 1, firstInvalidFieldId: 'f' });
    store().reset();
    expect(store().slices.loginBranding).toMatchObject({ status: 'idle', draft: null, baseline: null });
    expect(store().slices.loginBranding.validity.isValid).toBe(true);
  });

  it('partner switch resets; the same partner does not', async () => {
    await store().ensureLoaded('loginBranding', async () => ({ value: { a: 1 } }));
    store().setPartner('p1');
    expect(store().slices.loginBranding.status).toBe('ready');
    store().setPartner('p2');
    expect(store().slices.loginBranding.status).toBe('idle');
  });
});
