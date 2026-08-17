import { describe, expect, it, vi } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { captureOutlookSelectionLabel, subscribeOutlookItemChanged } from './outlookSelection';

describe('outlookSelection — host-bound mailbox wiring', () => {
  it('captureOutlookSelectionLabel returns the open message subject', async () => {
    getOfficeMock().setItem({ subject: 'Weekly sync' }, 'read');
    expect(await captureOutlookSelectionLabel()).toBe('Weekly sync');
  });

  it('returns undefined when there is no subject', async () => {
    getOfficeMock().setItem({ subject: '' }, 'read');
    expect(await captureOutlookSelectionLabel()).toBeUndefined();
  });

  it('fires the callback on every ItemChanged', () => {
    const cb = vi.fn();
    subscribeOutlookItemChanged(cb);
    getOfficeMock().switchItem({ subject: 'A' });
    getOfficeMock().switchItem({ subject: 'B' });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('registers the handler under the ItemChanged event type', () => {
    const before = getOfficeMock().itemChangedHandlers.length;
    subscribeOutlookItemChanged(() => undefined);
    expect(getOfficeMock().itemChangedHandlers.length).toBe(before + 1);
  });

  it('returns a callable unsubscribe', () => {
    const unsubscribe = subscribeOutlookItemChanged(() => undefined);
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });

  it('unsubscribe stops further callbacks for that subscriber only', () => {
    const cb = vi.fn();
    const unsubscribe = subscribeOutlookItemChanged(cb);
    getOfficeMock().switchItem({ subject: 'A' });
    expect(cb).toHaveBeenCalledTimes(1);

    unsubscribe();
    getOfficeMock().switchItem({ subject: 'B' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber does not stop a later subscriber from being notified', () => {
    const throwing = vi.fn(() => {
      throw new Error('subscriber A blew up');
    });
    const healthy = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    subscribeOutlookItemChanged(throwing);
    subscribeOutlookItemChanged(healthy);
    getOfficeMock().switchItem({ subject: 'A' });

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
