import { describe, it, expect, vi } from 'vitest';
import { ReliableInputRouter, MAX_RELIABLE_BUFFERED_BYTES, type InputChannelLike } from './reliableInput';
import { InputSequencer } from './inputSequencer';
import type { InputCapabilitiesSnapshot } from './inputCapabilities';

class FakeChannel implements InputChannelLike {
  readyState = 'connecting';
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  raw: string[] = [];
  private listeners: Record<string, Array<() => void>> = {};
  send(data: string) {
    this.raw.push(data);
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 'closed';
    this.fire('close');
  }
  addEventListener(type: string, cb: () => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener(type: string, cb: () => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== cb);
  }
  open() {
    this.readyState = 'open';
    this.fire('open');
  }
  fire(type: string) {
    for (const cb of [...(this.listeners[type] ?? [])]) cb();
  }
}

const CAPS: InputCapabilitiesSnapshot = {
  typeText: true,
  releasesHeldInput: true,
  reliableInput: true,
  inputEpoch: 4,
  geoEpoch: 2,
  extended: { keyCodes: false, extraButtons: false, horizontalWheel: false },
};

function setup(opts: { reliableChannel?: FakeChannel | null } = {}) {
  const lossy = new FakeChannel();
  lossy.readyState = 'open';
  const reliable = opts.reliableChannel === undefined ? new FakeChannel() : opts.reliableChannel;
  const openReliableChannel = vi.fn(() => reliable);
  const reconcileHeld = vi.fn();
  const onNotice = vi.fn();
  let now = 0;
  const router = new ReliableInputRouter(new InputSequencer(), {
    lossyChannel: () => lossy,
    openReliableChannel,
    reconcileHeld,
    onNotice,
    now: () => now,
  });
  return { router, lossy, reliable, openReliableChannel, reconcileHeld, onNotice, tick: (ms: number) => { now += ms; } };
}

describe('ReliableInputRouter — legacy agent', () => {
  it('never opens input-r without reliableInput and sends byte-for-byte legacy JSON', () => {
    const { router, lossy, openReliableChannel } = setup();
    router.onCapabilities({ ...CAPS, reliableInput: false, inputEpoch: null, geoEpoch: null });
    const events = [
      { type: 'mouse_move', x: 1, y: 2 },
      { type: 'mouse_down', x: 1, y: 2, button: 'left' },
      { type: 'key_down', key: 'a', capsLock: false },
    ];
    for (const ev of events) expect(router.send(ev)).toBe('sent');
    expect(openReliableChannel).not.toHaveBeenCalled();
    expect(lossy.raw).toEqual(events.map((e) => JSON.stringify(e)));
  });

  it('stays legacy when no capabilities reply ever arrives', () => {
    const { router, lossy, openReliableChannel } = setup();
    router.send({ type: 'key_down', key: 'a' });
    expect(openReliableChannel).not.toHaveBeenCalled();
    expect(lossy.sent).toEqual([{ type: 'key_down', key: 'a' }]);
  });

  it('ignores input_epoch and monitor_switched epochs while legacy', () => {
    const { router, lossy, reliable } = setup();
    router.onControlMessage({ type: 'input_epoch', epoch: 9, reason: 'resync' });
    router.onControlMessage({ type: 'monitor_switched', index: 1, inputEpoch: 9, geoEpoch: 9 });
    router.send({ type: 'key_down', key: 'a' });
    expect(lossy.sent).toEqual([{ type: 'key_down', key: 'a' }]);
    expect(reliable!.sent).toEqual([]);
  });

  it('reports unavailable when the lossy channel is not open', () => {
    const { router, lossy } = setup();
    lossy.readyState = 'closed';
    expect(router.send({ type: 'key_down', key: 'a' })).toBe('unavailable');
  });
});

describe('ReliableInputRouter — handshake', () => {
  it('opens input-r on reliableInput but keeps sending legacy until it opens', () => {
    const { router, lossy, reliable, openReliableChannel } = setup();
    router.onCapabilities(CAPS);
    expect(openReliableChannel).toHaveBeenCalledTimes(1);
    router.send({ type: 'key_down', key: 'a' });
    expect(lossy.sent).toEqual([{ type: 'key_down', key: 'a' }]);
    expect(reliable!.sent).toEqual([]);
    expect(router.isReliable()).toBe(false);
  });

  it('on open: reconciles held state, sends input_reset with the advertised epoch, then sequences', () => {
    const { router, lossy, reliable, reconcileHeld } = setup();
    router.onCapabilities(CAPS);
    reliable!.open();
    expect(reconcileHeld).toHaveBeenCalledWith('handshake');
    expect(reliable!.sent).toEqual([{ type: 'input_reset', seq: 1, epoch: 4 }]);
    expect(router.isReliable()).toBe(true);
    router.send({ type: 'key_down', key: 'a' });
    router.send({ type: 'mouse_move', x: 3, y: 4 });
    expect(reliable!.sent[1]).toEqual({ type: 'key_down', key: 'a', seq: 2, epoch: 4 });
    expect(lossy.sent).toEqual([{ type: 'mouse_move', x: 3, y: 4, seq: 3, after: 2, epoch: 4, geoEpoch: 2 }]);
  });

  it('uses the newest epochs heard before input-r opened', () => {
    const { router, reliable } = setup();
    router.onCapabilities(CAPS);
    router.onControlMessage({ type: 'monitor_switched', index: 1, inputEpoch: 5, geoEpoch: 3 });
    reliable!.open();
    expect(reliable!.sent[0]).toEqual({ type: 'input_reset', seq: 1, epoch: 5 });
    router.send({ type: 'mouse_move', x: 0, y: 0 });
  });

  it('does not open a second input-r on a repeated reply', () => {
    const { router, openReliableChannel } = setup();
    router.onCapabilities(CAPS);
    router.onCapabilities(CAPS);
    expect(openReliableChannel).toHaveBeenCalledTimes(1);
  });

  it('stays legacy when the transport cannot open input-r', () => {
    const { router, lossy } = setup({ reliableChannel: null });
    router.onCapabilities(CAPS);
    router.send({ type: 'key_down', key: 'a' });
    expect(lossy.sent).toEqual([{ type: 'key_down', key: 'a' }]);
  });
});

describe('ReliableInputRouter — epochs', () => {
  function reliableSetup() {
    const s = setup();
    s.router.onCapabilities(CAPS);
    s.reliable!.open();
    s.reconcileHeld.mockClear();
    return s;
  }

  it('input_epoch: reconciles held state, then sends input_reset — no releases', () => {
    const { router, reliable, reconcileHeld } = reliableSetup();
    const order: string[] = [];
    reconcileHeld.mockImplementation(() => order.push('reconcile'));
    const origSend = reliable!.send.bind(reliable);
    reliable!.send = (d: string) => { order.push(JSON.parse(d).type); origSend(d); };
    router.onControlMessage({ type: 'input_epoch', epoch: 7, reason: 'monitor_switch' });
    expect(order).toEqual(['reconcile', 'input_reset']);
    expect(reliable!.sent.at(-1)).toEqual({ type: 'input_reset', seq: 2, epoch: 7 });
  });

  it('input_epoch with an invalid epoch is ignored', () => {
    const { router, reliable, reconcileHeld } = reliableSetup();
    router.onControlMessage({ type: 'input_epoch', epoch: 0 });
    router.onControlMessage({ type: 'input_epoch', epoch: 2 ** 32 });
    router.onControlMessage({ type: 'input_epoch', epoch: '7' });
    expect(reconcileHeld).not.toHaveBeenCalled();
    expect(reliable!.sent).toHaveLength(1);
  });

  it('monitor_switched + input_epoch for one agent reset produce one input_reset', () => {
    const { router, reliable, lossy } = reliableSetup();
    router.onControlMessage({ type: 'monitor_switched', index: 1, inputEpoch: 5, geoEpoch: 3 });
    router.onControlMessage({ type: 'input_epoch', epoch: 5, reason: 'monitor_switch' });
    expect(reliable!.sent.filter((e) => e.type === 'input_reset')).toHaveLength(2); // handshake + one
    router.send({ type: 'mouse_move', x: 0, y: 0 });
    expect(lossy.sent.at(-1)).toMatchObject({ epoch: 5, geoEpoch: 3 });
  });

  it('monitor_switched with the current inputEpoch only updates geometry', () => {
    const { router, reliable, lossy, reconcileHeld } = reliableSetup();
    router.onControlMessage({ type: 'monitor_switched', index: 0, inputEpoch: 4, geoEpoch: 8 });
    expect(reconcileHeld).not.toHaveBeenCalled();
    expect(reliable!.sent).toHaveLength(1);
    router.send({ type: 'mouse_move', x: 0, y: 0 });
    expect(lossy.sent.at(-1)).toMatchObject({ epoch: 4, geoEpoch: 8 });
  });

  it('resetHeld sends input_reset at the current epoch (focus loss)', () => {
    const { router, reliable } = reliableSetup();
    router.resetHeld();
    expect(reliable!.sent.at(-1)).toEqual({ type: 'input_reset', seq: 2, epoch: 4 });
  });

  it('resetHeld is a no-op in legacy mode', () => {
    const { router, lossy } = setup();
    router.resetHeld();
    expect(lossy.sent).toEqual([]);
  });
});

describe('ReliableInputRouter — fallback and bounds', () => {
  function reliableSetup() {
    const s = setup();
    s.router.onCapabilities(CAPS);
    s.reliable!.open();
    s.reconcileHeld.mockClear();
    return s;
  }

  it('input-r closing returns to legacy, reconciles held state and shows a notice', () => {
    const { router, reliable, lossy, reconcileHeld, onNotice } = reliableSetup();
    reliable!.close();
    expect(router.isReliable()).toBe(false);
    expect(reconcileHeld).toHaveBeenCalledWith('fallback');
    expect(onNotice).toHaveBeenCalledTimes(1);
    router.send({ type: 'key_down', key: 'a' });
    expect(lossy.sent.at(-1)).toEqual({ type: 'key_down', key: 'a' });
  });

  it('input-r error is treated like a close', () => {
    const { router, reliable } = reliableSetup();
    reliable!.fire('error');
    expect(router.isReliable()).toBe(false);
  });

  it('a discrete event finding input-r not open falls back and goes out as legacy', () => {
    const { router, reliable, lossy } = reliableSetup();
    reliable!.readyState = 'closing';
    expect(router.send({ type: 'key_up', key: 'a' })).toBe('sent');
    expect(lossy.sent.at(-1)).toEqual({ type: 'key_up', key: 'a' });
    expect(router.isReliable()).toBe(false);
  });

  it('drops discrete input with a notice when input-r is backed up, instead of growing the buffer', () => {
    const { router, reliable, onNotice } = reliableSetup();
    reliable!.bufferedAmount = MAX_RELIABLE_BUFFERED_BYTES + 1;
    expect(router.send({ type: 'key_down', key: 'a' })).toBe('dropped');
    expect(reliable!.sent).toHaveLength(1);
    expect(onNotice).toHaveBeenCalledTimes(1);
  });

  it('drops an event the sequencer refuses (back button without the W2c flag)', () => {
    const { router, reliable, lossy } = reliableSetup();
    expect(router.send({ type: 'mouse_down', x: 0, y: 0, button: 'back' })).toBe('dropped');
    expect(reliable!.sent).toHaveLength(1);
    expect(lossy.sent).toHaveLength(0);
  });

  it('detach() forgets input-r silently; a late close of the old channel is ignored', () => {
    const { router, reliable, lossy, reconcileHeld, onNotice } = reliableSetup();
    router.detach();
    expect(router.isReliable()).toBe(false);
    reliable!.close();
    expect(reconcileHeld).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
    router.send({ type: 'key_down', key: 'a' });
    expect(lossy.sent.at(-1)).toEqual({ type: 'key_down', key: 'a' });
  });

  it('an input-r that opens after detach never sends a reset', () => {
    const { router, reliable } = setup();
    router.onCapabilities(CAPS);
    router.detach();
    reliable!.open();
    expect(reliable!.sent).toEqual([]);
    expect(router.isReliable()).toBe(false);
  });

  it('seq keeps increasing across detach and a new handshake', () => {
    const { router, reliable, openReliableChannel } = reliableSetup();
    router.send({ type: 'key_down', key: 'a' }); // seq 2
    router.detach();
    const next = new FakeChannel();
    openReliableChannel.mockReturnValue(next);
    router.onCapabilities(CAPS);
    next.open();
    expect(next.sent[0]).toEqual({ type: 'input_reset', seq: 3, epoch: 4 });
    expect(reliable!.sent).toHaveLength(2);
  });
});
