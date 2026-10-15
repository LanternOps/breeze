import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getVerification } from '@/lib/api/callerVerification';
import { useVerification } from './useVerification';
import { ORG, row } from './testFixtures';

vi.mock('@/lib/api/callerVerification', () => ({ getVerification: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('polls every 2 s without overlap, keeps refreshing a verified row, stops after unmount', async () => {
  vi.useFakeTimers();
  vi.mocked(getVerification)
    .mockResolvedValueOnce({ ...row, status: 'verified', usableUntil: '2026-09-19T12:30:00Z' })
    .mockResolvedValueOnce({ ...row, status: 'rejected_by_user', incidentId: row.id });
  const { result, unmount } = renderHook(() => useVerification(ORG, row));
  await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
  expect(getVerification).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(result.current.row?.status).toBe('verified');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(result.current.row?.status).toBe('rejected_by_user');
  unmount();
  await vi.advanceTimersByTimeAsync(10000);
  expect(getVerification).toHaveBeenCalledTimes(2);
});

it('reports a failed poll without fabricating a terminal status, and recovers', async () => {
  vi.useFakeTimers();
  vi.mocked(getVerification).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ...row, status: 'expired' });
  const { result } = renderHook(() => useVerification(ORG, row));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(result.current.error).toBe(true);
  expect(result.current.row?.status).toBe('pending');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(result.current.error).toBe(false);
  expect(result.current.row?.status).toBe('expired');
});

it('does nothing without a row', async () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useVerification(ORG, null));
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(result.current.row).toBeNull();
  expect(getVerification).not.toHaveBeenCalled();
});
