import { describe, expect, it, vi } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { createItemGenerationStore } from './itemGeneration';

describe('createItemGenerationStore', () => {
  it('starts at generation 0', () => {
    const store = createItemGenerationStore();
    expect(store.current()).toBe(0);
  });

  it('bumps the generation and notifies subscribers on ItemChanged', () => {
    const store = createItemGenerationStore();
    const cb = vi.fn();
    store.subscribe(cb);

    getOfficeMock().switchItem({ subject: 'A' });

    expect(store.current()).toBe(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(1);

    getOfficeMock().switchItem({ subject: 'B' });

    expect(store.current()).toBe(2);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith(2);
  });

  it('stops calling a subscriber once unsubscribed', () => {
    const store = createItemGenerationStore();
    const cb = vi.fn();
    const unsubscribe = store.subscribe(cb);

    getOfficeMock().switchItem({ subject: 'A' });
    expect(cb).toHaveBeenCalledTimes(1);

    unsubscribe();

    getOfficeMock().switchItem({ subject: 'B' });
    getOfficeMock().switchItem({ subject: 'C' });

    // The unsubscribed callback got no further notifications, but the
    // store's own generation counter (fed by the underlying Office handler,
    // which stays attached) still advances.
    expect(cb).toHaveBeenCalledTimes(1);
    expect(store.current()).toBe(3);
  });

  it('a throwing subscriber does not stop a later subscriber from being notified', () => {
    const store = createItemGenerationStore();
    const throwing = vi.fn(() => {
      throw new Error('subscriber A blew up');
    });
    const healthy = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    store.subscribe(throwing);
    store.subscribe(healthy);
    getOfficeMock().switchItem({ subject: 'A' });

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledWith(1);
    expect(store.current()).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('supports multiple independent subscribers', () => {
    const store = createItemGenerationStore();
    const cbA = vi.fn();
    const cbB = vi.fn();
    store.subscribe(cbA);
    const unsubscribeB = store.subscribe(cbB);

    getOfficeMock().switchItem({ subject: 'A' });
    expect(cbA).toHaveBeenCalledTimes(1);
    expect(cbB).toHaveBeenCalledTimes(1);

    unsubscribeB();

    getOfficeMock().switchItem({ subject: 'B' });
    expect(cbA).toHaveBeenCalledTimes(2);
    expect(cbB).toHaveBeenCalledTimes(1);
  });
});
