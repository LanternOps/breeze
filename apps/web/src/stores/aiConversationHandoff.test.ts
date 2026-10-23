import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HANDOFF_TIMEOUT_MS, abortHandoff, beginHandoff, completeHandoff, takeHandoff, useHandoffStore,
} from './aiConversationHandoff';

describe('aiConversationHandoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useHandoffStore.setState({ pending: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('complete releases the origin once and resolves completed', async () => {
    const onRelease = vi.fn();
    const p = beginHandoff({ sessionId: 's1', origin: 'panel' }, onRelease);
    expect(useHandoffStore.getState().pending).toMatchObject({ sessionId: 's1', origin: 'panel' });
    completeHandoff('s1');
    completeHandoff('s1');
    await expect(p).resolves.toBe('completed');
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(useHandoffStore.getState().pending).toBeNull();
  });

  it('a throwing onRelease resolves aborted (the origin was not released), logs, and does not throw', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = beginHandoff({ sessionId: 's1', origin: 'panel' }, () => { throw new Error('boom'); });
    expect(() => completeHandoff('s1')).not.toThrow();
    await expect(p).resolves.toBe('aborted');
    expect(useHandoffStore.getState().pending).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('abort never releases and resolves aborted', async () => {
    const onRelease = vi.fn();
    const p = beginHandoff({ sessionId: 's1', origin: 'panel' }, onRelease);
    const taken = takeHandoff('s1')!;
    abortHandoff('s1');
    await expect(p).resolves.toBe('aborted');
    expect(onRelease).not.toHaveBeenCalled();
    expect(taken.signal.aborted).toBe(true);
    expect(useHandoffStore.getState().pending).toBeNull();
  });

  it('pending hand-off aborts after timeout', async () => {
    const onRelease = vi.fn();
    const p = beginHandoff({ sessionId: 's1', origin: 'panel' }, onRelease);
    const { signal } = takeHandoff('s1')!;
    await vi.advanceTimersByTimeAsync(HANDOFF_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('aborted');
    expect(signal.aborted).toBe(true);
    expect(onRelease).not.toHaveBeenCalled();
    expect(useHandoffStore.getState().pending).toBeNull();
  });

  it('complete clears the timeout (no late abort)', async () => {
    const p = beginHandoff({ sessionId: 's1', origin: 'panel' }, vi.fn());
    const { signal } = takeHandoff('s1')!;
    completeHandoff('s1');
    await p;
    await vi.advanceTimersByTimeAsync(HANDOFF_TIMEOUT_MS * 2);
    expect(signal.aborted).toBe(false);
  });

  it('ignores complete/abort for a different session id', async () => {
    const onRelease = vi.fn();
    const p = beginHandoff({ sessionId: 's1', origin: 'panel' }, onRelease);
    completeHandoff('other');
    abortHandoff('other');
    expect(useHandoffStore.getState().pending?.sessionId).toBe('s1');
    expect(onRelease).not.toHaveBeenCalled();
    completeHandoff('s1');
    await expect(p).resolves.toBe('completed');
  });

  it('a second begin aborts the first', async () => {
    const r1 = vi.fn();
    const r2 = vi.fn();
    const p1 = beginHandoff({ sessionId: 's1', origin: 'panel' }, r1);
    const first = takeHandoff('s1')!;
    const p2 = beginHandoff({ sessionId: 's2', origin: 'workspace', originTabId: 't' }, r2);
    await expect(p1).resolves.toBe('aborted');
    expect(first.signal.aborted).toBe(true);
    expect(useHandoffStore.getState().pending?.sessionId).toBe('s2');
    completeHandoff('s2');
    await expect(p2).resolves.toBe('completed');
    expect(r1).not.toHaveBeenCalled();
    expect(r2).toHaveBeenCalledTimes(1);
  });

  it('takeHandoff returns the draft once and undefined for unknown ids', () => {
    void beginHandoff({ sessionId: 's1', origin: 'panel', draft: 'hello' }, vi.fn());
    expect(takeHandoff('nope')).toBeUndefined();
    expect(takeHandoff('s1')?.draft).toBe('hello');
    const again = takeHandoff('s1');
    expect(again).toBeDefined();
    expect(again?.draft).toBeUndefined();
    abortHandoff('s1');
  });
});
