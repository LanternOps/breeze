import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSelectionAddress } from './useSelectionAddress';

/**
 * The hook is host-NEUTRAL: it takes injected `captureSelectionAddress` /
 * `subscribeSelectionChanged` fns (the Excel impl lives in host/excelSelection.ts)
 * and owns only the React rhythm — read once on mount, then re-read on every
 * selection-change callback (the live-refresh that keeps the chip from freezing).
 */
describe('useSelectionAddress', () => {
  it('reads the selection address once on mount', async () => {
    const captureSelectionAddress = vi.fn(async () => 'Sheet1!B2');
    const subscribeSelectionChanged = vi.fn(() => () => undefined);

    const { result } = renderHook(() =>
      useSelectionAddress({ captureSelectionAddress, subscribeSelectionChanged }),
    );

    await waitFor(() => expect(result.current).toBe('Sheet1!B2'));
    expect(captureSelectionAddress).toHaveBeenCalledTimes(1);
    expect(subscribeSelectionChanged).toHaveBeenCalledTimes(1);
  });

  it('re-reads when a simulated selection-change callback fires', async () => {
    const captureSelectionAddress = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce('Sheet1!B2')
      .mockResolvedValueOnce('Sheet1!C9');
    let fireSelectionChanged: (() => void) | undefined;
    const subscribeSelectionChanged = vi.fn((cb: () => void) => {
      fireSelectionChanged = cb;
      return () => undefined;
    });

    const { result } = renderHook(() =>
      useSelectionAddress({ captureSelectionAddress, subscribeSelectionChanged }),
    );

    await waitFor(() => expect(result.current).toBe('Sheet1!B2'));

    // Simulate the host firing DocumentSelectionChanged.
    await act(async () => {
      fireSelectionChanged?.();
    });

    await waitFor(() => expect(result.current).toBe('Sheet1!C9'));
    expect(captureSelectionAddress).toHaveBeenCalledTimes(2);
  });

  it('tolerates a capture that resolves undefined (no selection)', async () => {
    const captureSelectionAddress = vi.fn(async () => undefined);
    const subscribeSelectionChanged = vi.fn(() => () => undefined);

    const { result } = renderHook(() =>
      useSelectionAddress({ captureSelectionAddress, subscribeSelectionChanged }),
    );

    // Give the mount read a chance to resolve; address stays null.
    await waitFor(() => expect(captureSelectionAddress).toHaveBeenCalledTimes(1));
    expect(result.current).toBeNull();
  });

  it('unsubscribes on unmount', async () => {
    const captureSelectionAddress = vi.fn(async () => 'Sheet1!A1');
    const unsubscribe = vi.fn();
    const subscribeSelectionChanged = vi.fn(() => unsubscribe);

    const { unmount } = renderHook(() =>
      useSelectionAddress({ captureSelectionAddress, subscribeSelectionChanged }),
    );

    await waitFor(() => expect(subscribeSelectionChanged).toHaveBeenCalledTimes(1));
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
