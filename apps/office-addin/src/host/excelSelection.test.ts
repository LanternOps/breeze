import { describe, expect, it, vi } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { captureExcelSelectionAddress, subscribeExcelSelectionChanged } from './excelSelection';

/**
 * The ONE host-bound seam for the selection chip — exercised against the
 * Office.js mock so a regression in the real Excel.run / addHandlerAsync wiring
 * (wrong range field, missing sync, swapped args, wrong EventType) fails a test
 * instead of silently freezing the chip in production Excel. The host-NEUTRAL
 * React rhythm is covered separately in hooks/useSelectionAddress.test.ts.
 */
describe('excelSelection — host-bound Excel wiring', () => {
  it('captureExcelSelectionAddress reads the current selection address', async () => {
    getOfficeMock().select('Sheet1!D7');
    expect(await captureExcelSelectionAddress()).toBe('Sheet1!D7');
  });

  it('qualifies an unqualified selection with the active sheet', async () => {
    getOfficeMock().select('B2');
    expect(await captureExcelSelectionAddress()).toBe('Sheet1!B2');
  });

  it('fires the callback on every DocumentSelectionChanged (the live refresh)', () => {
    const cb = vi.fn();
    subscribeExcelSelectionChanged(cb);
    getOfficeMock().select('Sheet1!A1');
    getOfficeMock().select('Sheet1!Z9');
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('registers the handler under the DocumentSelectionChanged event type', () => {
    // The mock only retains handlers registered for the real event type, so a
    // wrong EventType wiring would register nothing (and never fire above).
    const before = getOfficeMock().selectionHandlers.length;
    subscribeExcelSelectionChanged(() => undefined);
    expect(getOfficeMock().selectionHandlers.length).toBe(before + 1);
  });

  it('returns a callable no-op unsubscribe that intentionally keeps the handler', () => {
    const cb = vi.fn();
    const unsubscribe = subscribeExcelSelectionChanged(cb);
    expect(typeof unsubscribe).toBe('function');
    const after = getOfficeMock().selectionHandlers.length;
    unsubscribe(); // documented no-op — the always-mounted subscriber guards updates
    expect(getOfficeMock().selectionHandlers.length).toBe(after);
    getOfficeMock().select('Sheet1!C3');
    expect(cb).toHaveBeenCalled(); // still live after "unsubscribe"
  });
});
