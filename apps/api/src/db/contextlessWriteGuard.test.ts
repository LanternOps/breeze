import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the sentry service so the proxy guard's captureMessage call is
// observable and never touches a real (uninitialized) SDK.
vi.mock('../services/sentry', () => ({
  captureMessage: vi.fn(),
}));

import { captureMessage } from '../services/sentry';
import { db, hasDbAccessContext } from './index';

describe('contextless-write guard on proxiedDb (#1375/#1379)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('precondition: no active DB access context in a bare test', () => {
    expect(hasDbAccessContext()).toBe(false);
  });

  it('warns + reports when accessing .update outside a context', () => {
    // Merely accessing the proxy getter fires the guard (we never execute
    // the query, so no DB connection is required).
    void db.update;

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledTimes(1);

    const firstCall = (captureMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const [message, level, extra] = firstCall;
    expect(message).toContain('.update()');
    expect(message).toContain('#1375');
    expect(level).toBe('warning');
    expect(extra).toHaveProperty('stack');
  });

  it('warns + reports for .insert and .delete too', () => {
    void db.insert;
    void db.delete;

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(captureMessage).toHaveBeenCalledTimes(2);
    const calls = (captureMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toContain('.insert()');
    expect(calls[1]![0]).toContain('.delete()');
  });

  it('does NOT warn for read methods like .select', () => {
    void db.select;

    expect(warnSpy).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });
});
