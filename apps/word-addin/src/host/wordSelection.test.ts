import { describe, expect, it, vi } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { captureWordSelectionLabel, subscribeWordSelectionChanged } from './wordSelection';

describe('wordSelection — host-bound Word wiring', () => {
  it('captureWordSelectionLabel returns a snippet of the selected text', async () => {
    const mock = getOfficeMock();
    mock.setBody('Hello selected world');
    const a = 'Hello '.length;
    mock.select(a, a + 'selected'.length);
    expect(await captureWordSelectionLabel()).toBe('selected');
  });

  it('returns undefined when nothing is selected', async () => {
    const mock = getOfficeMock();
    mock.setBody('Body');
    mock.select(2, 2);
    expect(await captureWordSelectionLabel()).toBeUndefined();
  });

  it('fires the callback on every DocumentSelectionChanged', () => {
    const cb = vi.fn();
    subscribeWordSelectionChanged(cb);
    getOfficeMock().select(0, 1);
    getOfficeMock().select(1, 2);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('registers the handler under the DocumentSelectionChanged event type', () => {
    const before = getOfficeMock().selectionHandlers.length;
    subscribeWordSelectionChanged(() => undefined);
    expect(getOfficeMock().selectionHandlers.length).toBe(before + 1);
  });

  it('returns a callable no-op unsubscribe', () => {
    const unsubscribe = subscribeWordSelectionChanged(() => undefined);
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });
});
