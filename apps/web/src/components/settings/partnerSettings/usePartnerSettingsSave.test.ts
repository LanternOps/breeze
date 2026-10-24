import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { showToast } from '../../shared/Toast';
import { usePartnerSettingsSave } from './usePartnerSettingsSave';
import { UNIT_TABS, type SaveOutcome, type SaveUnit, type SaveUnitId } from './saveUnits';

vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

type Fake = SaveUnit & { dirty: boolean; calls: number; respond: () => Promise<SaveOutcome> };

function fake(id: SaveUnitId, respond: () => Promise<SaveOutcome> = async () => ({ status: 'saved', savedAt: 10 })): Fake {
  const unit: Fake = {
    id,
    tabs: UNIT_TABS[id],
    dirty: true,
    calls: 0,
    respond,
    isDirty: () => unit.dirty,
    validity: () => ({}),
    save: async () => {
      unit.calls += 1;
      const outcome = await unit.respond();
      // A unit re-baselines itself on success.
      if (outcome.status === 'saved') unit.dirty = false;
      return outcome;
    },
  };
  return unit;
}

const successToasts = () => vi.mocked(showToast).mock.calls.filter(([a]) => (a as { type: string }).type === 'success');

beforeEach(() => { vi.clearAllMocks(); });

describe('usePartnerSettingsSave', () => {
  it('partial success: only saved units re-baseline, the failed unit is reported', async () => {
    const me = fake('partnersMe');
    const login = fake('loginBranding', async () => ({ status: 'failed' }));
    const { result } = renderHook(() => usePartnerSettingsSave([me, login]));
    await act(async () => { await result.current.save(); });
    expect(me.dirty).toBe(false);
    expect(login.dirty).toBe(true);
    expect(result.current.failedUnits).toEqual(['loginBranding']);
    expect(result.current.otherUnitsSaved).toBe(true);
    expect(successToasts()).toHaveLength(0);
  });

  it('one aggregate success toast when every run unit saved', async () => {
    const units = [fake('partnersMe'), fake('loginBranding'), fake('trustCenter')];
    const { result } = renderHook(() => usePartnerSettingsSave(units));
    await act(async () => { await result.current.save(); });
    expect(successToasts()).toEqual([[{ type: 'success', message: 'Partner settings saved' }]]);
    expect(result.current.failedUnits).toEqual([]);
    expect(result.current.savedAt).toBe(10);
  });

  it('a conflict counts as a failure and suppresses the aggregate toast', async () => {
    const units = [fake('partnersMe'), fake('trustCenter', async () => ({ status: 'conflict' }))];
    const { result } = renderHook(() => usePartnerSettingsSave(units));
    await act(async () => { await result.current.save(); });
    expect(result.current.failedUnits).toEqual(['trustCenter']);
    expect(successToasts()).toHaveLength(0);
  });

  it('a declined preflight is neither a failure nor a success', async () => {
    const units = [fake('partnersMe', async () => ({ status: 'cancelled' }))];
    const { result } = renderHook(() => usePartnerSettingsSave(units));
    await act(async () => { await result.current.save(); });
    expect(result.current.failedUnits).toEqual([]);
    expect(successToasts()).toHaveLength(0);
  });

  it('retry sends only the failed unit', async () => {
    const me = fake('partnersMe');
    let fail = true;
    const login = fake('loginBranding', async () => (fail ? { status: 'failed' } : { status: 'saved', savedAt: 20 }));
    const { result } = renderHook(() => usePartnerSettingsSave([me, login]));
    await act(async () => { await result.current.save(); });
    fail = false;
    await act(async () => { await result.current.save(); });
    expect([me.calls, login.calls]).toEqual([1, 2]);
    expect(result.current.failedUnits).toEqual([]);
    expect(successToasts()).toHaveLength(1);
  });

  it('reports saving while units run and ignores a second click', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const me = fake('partnersMe', async () => { await gate; return { status: 'saved', savedAt: 1 }; });
    const { result } = renderHook(() => usePartnerSettingsSave([me]));
    let first!: Promise<void>;
    act(() => { first = result.current.save(); });
    expect(result.current.saving).toBe(true);
    await act(async () => { await result.current.save(); });
    expect(me.calls).toBe(1);
    release();
    await act(async () => { await first; });
    expect(result.current.saving).toBe(false);
  });
});
