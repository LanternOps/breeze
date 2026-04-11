import { describe, it, expect, vi } from 'vitest';
import { handleCtrlVPaste, type CtrlVPasteDeps } from './clipboardPaste';

function makeDC(readyState: RTCDataChannelState = 'open'): RTCDataChannel {
  return {
    readyState,
    send: vi.fn(),
  } as unknown as RTCDataChannel;
}

function makeWaitForAck(resolveImmediately = true) {
  return vi.fn((_hash: string, _timeoutMs: number) =>
    resolveImmediately ? Promise.resolve() : new Promise<void>(() => {})
  );
}

describe('handleCtrlVPaste', () => {
  it('sends clipboard text on DataChannel BEFORE calling dispatchPaste', async () => {
    const callOrder: string[] = [];
    const dc = makeDC();
    (dc.send as ReturnType<typeof vi.fn>).mockImplementation(() => callOrder.push('send'));

    const deps: CtrlVPasteDeps = {
      dc,
      readText: async () => 'hello world',
      lastHash: { current: '' },
      dispatchPaste: () => callOrder.push('dispatch'),
      waitForAck: makeWaitForAck(),
    };

    await handleCtrlVPaste(deps);

    expect(callOrder).toEqual(['send', 'dispatch']);
  });

  it('skips dc.send and waitForAck when text equals lastHash.current but still dispatches', async () => {
    const dc = makeDC();
    const dispatchPaste = vi.fn();
    const waitForAck = makeWaitForAck();

    const deps: CtrlVPasteDeps = {
      dc,
      readText: async () => 'same text',
      lastHash: { current: 'same text' },
      dispatchPaste,
      waitForAck,
    };

    await handleCtrlVPaste(deps);

    expect(dc.send).not.toHaveBeenCalled();
    expect(waitForAck).not.toHaveBeenCalled();
    expect(dispatchPaste).toHaveBeenCalledOnce();
  });

  it('dispatches paste synchronously when dc is null', async () => {
    const dispatchPaste = vi.fn();

    const deps: CtrlVPasteDeps = {
      dc: null,
      readText: async () => 'text',
      lastHash: { current: '' },
      dispatchPaste,
      waitForAck: makeWaitForAck(),
    };

    await handleCtrlVPaste(deps);

    expect(dispatchPaste).toHaveBeenCalledOnce();
  });

  it('dispatches paste synchronously when dc.readyState is not open', async () => {
    const dc = makeDC('closing');
    const dispatchPaste = vi.fn();

    const deps: CtrlVPasteDeps = {
      dc,
      readText: async () => 'text',
      lastHash: { current: '' },
      dispatchPaste,
      waitForAck: makeWaitForAck(),
    };

    await handleCtrlVPaste(deps);

    expect(dc.send).not.toHaveBeenCalled();
    expect(dispatchPaste).toHaveBeenCalledOnce();
  });

  it('still dispatches paste when dc closes after the await', async () => {
    const dc = makeDC();
    const dispatchPaste = vi.fn();

    const waitForAck = vi.fn(async () => {
      // Simulate channel closing while awaiting ack
      Object.defineProperty(dc, 'readyState', { value: 'closed', configurable: true });
    });

    const deps: CtrlVPasteDeps = {
      dc,
      readText: async () => 'fresh content',
      lastHash: { current: '' },
      dispatchPaste,
      waitForAck,
    };

    await handleCtrlVPaste(deps);

    expect(dispatchPaste).toHaveBeenCalledOnce();
  });

  it('dispatches paste and skips waitForAck when dc.send throws', async () => {
    const dc = makeDC();
    (dc.send as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new DOMException('channel closing', 'InvalidStateError'); });
    const dispatchPaste = vi.fn();
    const waitForAck = makeWaitForAck();

    const deps: CtrlVPasteDeps = {
      dc,
      readText: async () => 'new content',
      lastHash: { current: '' },
      dispatchPaste,
      waitForAck,
    };

    await handleCtrlVPaste(deps);

    expect(dc.send).toHaveBeenCalledOnce();
    expect(waitForAck).not.toHaveBeenCalled();
    expect(dispatchPaste).toHaveBeenCalledOnce();
  });

  it('dispatches paste even when readText rejects', async () => {
    const dc = makeDC();
    const dispatchPaste = vi.fn();

    const deps: CtrlVPasteDeps = {
      dc,
      readText: async () => { throw new Error('clipboard not available'); },
      lastHash: { current: '' },
      dispatchPaste,
      waitForAck: makeWaitForAck(),
    };

    await handleCtrlVPaste(deps);

    expect(dc.send).not.toHaveBeenCalled();
    expect(dispatchPaste).toHaveBeenCalledOnce();
  });

  it('waits for ack before dispatch; resolves on timeout fallback', async () => {
    const callOrder: string[] = [];
    const dc = makeDC();
    (dc.send as ReturnType<typeof vi.fn>).mockImplementation(() => callOrder.push('send'));

    // waitForAck that simulates timeout: resolves after a tick (not immediately hanging)
    const waitForAck = vi.fn((_hash: string, _timeoutMs: number) => {
      return new Promise<void>(resolve => {
        // Resolves after a microtask — simulates the timeout path firing
        Promise.resolve().then(() => {
          callOrder.push('ack-timeout');
          resolve();
        });
      });
    });

    const deps: CtrlVPasteDeps = {
      dc,
      readText: async () => 'ack test',
      lastHash: { current: '' },
      dispatchPaste: () => callOrder.push('dispatch'),
      waitForAck,
    };

    await handleCtrlVPaste(deps);

    expect(callOrder).toEqual(['send', 'ack-timeout', 'dispatch']);
    expect(waitForAck).toHaveBeenCalledOnce();
  });
});
