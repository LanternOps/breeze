import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InheritanceTabDto } from '@breeze/shared';

const fetchTabInheritance = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/partnerSettingsInheritance', () => ({ fetchTabInheritance }));

const authUser = vi.hoisted(() => ({ current: { canManagePartnerWide: true } as { canManagePartnerWide?: boolean } | null }));
vi.mock('../../../stores/auth', () => ({
  useAuthStore: (selector: (s: { user: unknown }) => unknown) => selector({ user: authUser.current }),
}));

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../shared/Toast', () => ({ showToast }));

import { inheritanceTabFor, invalidateInheritance, useInheritanceStore, useTabInheritance } from './useTabInheritance';

const dto = (tab: InheritanceTabDto['tab']): InheritanceTabDto => ({ tab, orgCount: 3, fields: [] });

beforeEach(() => {
  vi.clearAllMocks();
  authUser.current = { canManagePartnerWide: true };
  useInheritanceStore.getState().reset();
  fetchTabInheritance.mockImplementation(async (tab: InheritanceTabDto['tab']) => ({ status: 'ok', data: dto(tab) }));
});

describe('useTabInheritance', () => {
  it('caches per tab for the page session', async () => {
    const { result, rerender } = renderHook(({ tab }) => useTabInheritance(tab), { initialProps: { tab: 'defaults' as const } as { tab: 'defaults' | 'security' } });
    await waitFor(() => expect(result.current).toEqual({ status: 'ok', data: dto('defaults') }));
    rerender({ tab: 'security' });
    await waitFor(() => expect(result.current).toEqual({ status: 'ok', data: dto('security') }));
    rerender({ tab: 'defaults' });
    expect(result.current).toEqual({ status: 'ok', data: dto('defaults') });
    expect(fetchTabInheritance).toHaveBeenCalledTimes(2);
    expect(fetchTabInheritance.mock.calls.map(c => c[0])).toEqual(['defaults', 'security']);
  });

  it('invalidate refetches only the named catalog tabs, keeping the old counts until the new ones land', async () => {
    const { result, rerender } = renderHook(({ tab }) => useTabInheritance(tab), { initialProps: { tab: 'security' } as { tab: 'defaults' | 'security' } });
    await waitFor(() => expect(result.current?.status).toBe('ok'));
    rerender({ tab: 'defaults' });
    await waitFor(() => expect(result.current).toEqual({ status: 'ok', data: dto('defaults') }));
    expect(fetchTabInheritance).toHaveBeenCalledTimes(2);

    let release!: (v: unknown) => void;
    fetchTabInheritance.mockImplementationOnce(() => new Promise(r => { release = r; }));
    act(() => { invalidateInheritance(['company', 'defaults']); });
    await waitFor(() => expect(fetchTabInheritance).toHaveBeenCalledTimes(3));
    // Stale-while-refetching: the previous answer stays.
    expect(result.current).toEqual({ status: 'ok', data: dto('defaults') });
    await act(async () => { release({ status: 'ok', data: { ...dto('defaults'), orgCount: 7 } }); });
    await waitFor(() => expect(result.current).toEqual({ status: 'ok', data: { ...dto('defaults'), orgCount: 7 } }));

    // 'security' was not named: still cached, never refetched.
    rerender({ tab: 'security' });
    expect(result.current).toEqual({ status: 'ok', data: dto('security') });
    expect(fetchTabInheritance.mock.calls.map(c => c[0])).toEqual(['security', 'defaults', 'defaults']);
  });

  it('a failed read is retried only after dropUnavailable (a tab change), never in a loop', async () => {
    fetchTabInheritance.mockResolvedValueOnce({ status: 'unavailable' });
    const { result, rerender } = renderHook(() => useTabInheritance('defaults'));
    await waitFor(() => expect(result.current).toEqual({ status: 'unavailable' }));
    rerender();
    expect(fetchTabInheritance).toHaveBeenCalledTimes(1);
    act(() => { useInheritanceStore.getState().dropUnavailable(); });
    await waitFor(() => expect(result.current).toEqual({ status: 'ok', data: dto('defaults') }));
    expect(fetchTabInheritance).toHaveBeenCalledTimes(2);
  });

  it('a response that lands after an invalidate is dropped', async () => {
    let release!: (v: unknown) => void;
    fetchTabInheritance.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const { result } = renderHook(() => useTabInheritance('defaults'));
    await waitFor(() => expect(result.current).toEqual({ status: 'loading' }));
    act(() => { invalidateInheritance(['defaults']); });
    await waitFor(() => expect(fetchTabInheritance).toHaveBeenCalledTimes(2));
    await act(async () => { release({ status: 'ok', data: { ...dto('defaults'), orgCount: 99 } }); });
    await waitFor(() => expect(result.current).toEqual({ status: 'ok', data: dto('defaults') }));
  });

  it('unavailable does not toast', async () => {
    fetchTabInheritance.mockResolvedValue({ status: 'unavailable' });
    const { result } = renderHook(() => useTabInheritance('defaults'));
    await waitFor(() => expect(result.current).toEqual({ status: 'unavailable' }));
    expect(showToast).not.toHaveBeenCalled();
  });

  it('selected-access user never fetches and reads restricted', () => {
    authUser.current = { canManagePartnerWide: false };
    const { result } = renderHook(() => useTabInheritance('defaults'));
    expect(result.current).toEqual({ status: 'restricted' });
    expect(fetchTabInheritance).not.toHaveBeenCalled();
  });

  it('no tab, no fetch', () => {
    const { result } = renderHook(() => useTabInheritance(null));
    expect(result.current).toBeNull();
    expect(fetchTabInheritance).not.toHaveBeenCalled();
  });

  it('a partner switch drops every cached tab', async () => {
    useInheritanceStore.getState().setPartner('p-1');
    const { result } = renderHook(() => useTabInheritance('defaults'));
    await waitFor(() => expect(result.current?.status).toBe('ok'));
    act(() => { useInheritanceStore.getState().setPartner('p-2'); });
    await waitFor(() => expect(fetchTabInheritance).toHaveBeenCalledTimes(2));
  });
});

describe('inheritanceTabFor', () => {
  it('only page tabs with classified catalog fields fetch', () => {
    expect(inheritanceTabFor('defaults')).toBe('defaults');
    expect(inheritanceTabFor('aiBudgets')).toBe('aiBudgets');
    expect(inheritanceTabFor('company')).toBeNull();
    expect(inheritanceTabFor('modules')).toBeNull();
    expect(inheritanceTabFor('knownGuests')).toBeNull();
    // Every Branding field is unclassified today: nothing to count.
    expect(inheritanceTabFor('branding')).toBeNull();
  });
});
