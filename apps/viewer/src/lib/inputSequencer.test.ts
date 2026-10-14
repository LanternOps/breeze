import { describe, it, expect } from 'vitest';
import {
  InputSequencer,
  MAX_INPUT_SEQ,
  parseEpoch,
  clampInputEvent,
} from './inputSequencer';

const LEGACY_EVENTS: Array<Record<string, unknown>> = [
  { type: 'mouse_move', x: 10, y: 20 },
  { type: 'mouse_down', x: 10, y: 20, button: 'left' },
  { type: 'mouse_up', x: 10, y: 20, button: 'left' },
  { type: 'mouse_scroll', x: 1, y: 2, delta: 3 },
  { type: 'key_down', key: 'a', capsLock: false },
  { type: 'key_up', key: 'a', capsLock: false },
  { type: 'key_press', key: 'c', modifiers: ['ctrl'], capsLock: false },
];

describe('parseEpoch', () => {
  it.each([
    [1, 1],
    [7, 7],
    [2 ** 32 - 1, 2 ** 32 - 1],
  ])('accepts %s', (input, expected) => {
    expect(parseEpoch(input)).toBe(expected);
  });

  it.each([[0], [-1], [2 ** 32], [1.5], ['7'], [null], [undefined], [NaN], [Infinity], [{}]])(
    'rejects %s',
    (input) => {
      expect(parseEpoch(input)).toBeNull();
    },
  );
});

describe('InputSequencer — legacy mode', () => {
  it('passes every event through untouched on the lossy channel (byte-for-byte W2a)', () => {
    const s = new InputSequencer();
    for (const ev of LEGACY_EVENTS) {
      const before = JSON.stringify(ev);
      const routed = s.route(ev);
      expect(routed).not.toBeNull();
      expect(routed!.channel).toBe('input');
      expect(routed!.payload).toBe(ev);
      expect(JSON.stringify(routed!.payload)).toBe(before);
    }
    expect(s.isReliable()).toBe(false);
  });

  it('does not strip or clamp anything in legacy mode', () => {
    const s = new InputSequencer();
    const ev = { type: 'mouse_scroll', x: 1, y: 2, delta: 500 };
    expect(s.route(ev)!.payload).toEqual({ type: 'mouse_scroll', x: 1, y: 2, delta: 500 });
  });
});

describe('InputSequencer — reliable mode', () => {
  function reliable(epoch = 5, geo = 9) {
    const s = new InputSequencer();
    const reset = s.enter(epoch, geo, 0);
    return { s, reset: reset! };
  }

  it('enter() emits input_reset with seq and the advertised epoch, then goes reliable', () => {
    const { s, reset } = reliable(5, 9);
    expect(reset.channel).toBe('input-r');
    expect(reset.payload).toEqual({ type: 'input_reset', seq: 1, epoch: 5 });
    expect(s.isReliable()).toBe(true);
  });

  it('enter() refuses invalid epochs and stays legacy', () => {
    const s = new InputSequencer();
    expect(s.enter(0, 1, 0)).toBeNull();
    expect(s.enter(1, 2 ** 32, 0)).toBeNull();
    expect(s.isReliable()).toBe(false);
  });

  it('routes discrete events to input-r with seq + epoch, and geoEpoch only on pointer events', () => {
    const { s } = reliable(5, 9);
    expect(s.route({ type: 'key_down', key: 'a' })).toEqual({
      channel: 'input-r',
      payload: { type: 'key_down', key: 'a', seq: 2, epoch: 5 },
    });
    expect(s.route({ type: 'mouse_down', x: 1, y: 2, button: 'left' })).toEqual({
      channel: 'input-r',
      payload: { type: 'mouse_down', x: 1, y: 2, button: 'left', seq: 3, epoch: 5, geoEpoch: 9 },
    });
    expect(s.route({ type: 'mouse_scroll', x: 1, y: 2, delta: 1 })!.payload).toMatchObject({ geoEpoch: 9 });
  });

  it('keeps mouse_move on the lossy channel with after = last discrete seq (the reset counts)', () => {
    const { s } = reliable(5, 9);
    expect(s.route({ type: 'mouse_move', x: 1, y: 1 })).toEqual({
      channel: 'input',
      payload: { type: 'mouse_move', x: 1, y: 1, seq: 2, after: 1, epoch: 5, geoEpoch: 9 },
    });
    s.route({ type: 'key_down', key: 'a' }); // seq 3
    const move = s.route({ type: 'mouse_move', x: 2, y: 2 })!;
    expect(move.payload).toMatchObject({ seq: 4, after: 3 });
  });

  it('seq strictly increases across both channels and is never reset by an epoch change', () => {
    const { s } = reliable(5, 9);
    const seqs: number[] = [];
    const push = (ev: Record<string, unknown>) => {
      const r = s.route(ev);
      seqs.push(r!.payload.seq as number);
    };
    push({ type: 'mouse_move', x: 1, y: 1 });
    push({ type: 'key_down', key: 'a' });
    const reset = s.onInputEpoch(6, 1000)!;
    seqs.push(reset.payload.seq as number);
    push({ type: 'mouse_move', x: 1, y: 1 });
    s.leave();
    const again = s.enter(7, 10, 2000)!;
    seqs.push(again.payload.seq as number);
    push({ type: 'key_up', key: 'a' });
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });

  it('stamps the new epoch after input_epoch and the new geoEpoch after setGeoEpoch', () => {
    const { s } = reliable(5, 9);
    const reset = s.onInputEpoch(6, 1000)!;
    expect(reset).toEqual({ channel: 'input-r', payload: { type: 'input_reset', seq: 2, epoch: 6 } });
    s.setGeoEpoch(11);
    expect(s.route({ type: 'mouse_move', x: 1, y: 1 })!.payload).toMatchObject({ epoch: 6, geoEpoch: 11, after: 2 });
  });

  it('ignores invalid inbound epochs', () => {
    const { s } = reliable(5, 9);
    expect(s.onInputEpoch(0, 1000)).toBeNull();
    expect(s.onInputEpoch('6', 1000)).toBeNull();
    s.setGeoEpoch(-3);
    expect(s.route({ type: 'mouse_move', x: 1, y: 1 })!.payload).toMatchObject({ epoch: 5, geoEpoch: 9 });
  });

  it('accepts a wrapped epoch (2^32-1 → 1) without assuming monotonic order', () => {
    const { s } = reliable(2 ** 32 - 1, 9);
    expect(s.onInputEpoch(1, 1000)!.payload).toMatchObject({ epoch: 1 });
  });

  it('dedupes a reset for the epoch it already reset to, but re-sends a resync after the window', () => {
    const { s } = reliable(5, 9);
    expect(s.onInputEpoch(5, 100)).toBeNull();
    expect(s.onInputEpoch(5, 100, 'resync')).toBeNull();
    expect(s.onInputEpoch(5, 5000, 'resync')).not.toBeNull();
    expect(s.onInputEpoch(5, 5001, 'resync')).toBeNull();
  });

  it('resetCurrent() emits input_reset at the current epoch without changing it', () => {
    const { s } = reliable(5, 9);
    expect(s.resetCurrent()!.payload).toEqual({ type: 'input_reset', seq: 2, epoch: 5 });
    expect(s.route({ type: 'key_down', key: 'a' })!.payload).toMatchObject({ epoch: 5 });
  });

  it('resetCurrent() is a no-op in legacy mode', () => {
    expect(new InputSequencer().resetCurrent()).toBeNull();
  });

  it('leave() returns to byte-for-byte legacy routing', () => {
    const { s } = reliable();
    s.leave();
    const ev = { type: 'key_down', key: 'a' };
    expect(s.route(ev)).toEqual({ channel: 'input', payload: ev });
    expect(s.route(ev)!.payload).toBe(ev);
  });

  it('remembers epochs learned while legacy so a later enter can use the latest', () => {
    const s = new InputSequencer();
    s.noteEpochs(8, 12);
    expect(s.latestEpochs()).toEqual({ inputEpoch: 8, geoEpoch: 12 });
    s.noteEpochs(0, 13); // invalid input epoch ignored, geo still taken
    expect(s.latestEpochs()).toEqual({ inputEpoch: 8, geoEpoch: 13 });
  });

  it('falls back to legacy instead of overflowing seq', () => {
    const s = new InputSequencer(MAX_INPUT_SEQ - 2);
    s.enter(1, 1, 0); // seq MAX-1
    expect(s.route({ type: 'key_down', key: 'a' })!.payload).toMatchObject({ seq: MAX_INPUT_SEQ });
    const ev = { type: 'key_up', key: 'a' };
    const r = s.route(ev);
    expect(r).toEqual({ channel: 'input', payload: ev });
    expect(s.isReliable()).toBe(false);
    expect(s.enter(1, 1, 0)).toBeNull();
  });
});

describe('InputSequencer — extended fields (W08 capability gate)', () => {
  it('strips code / numLock / deltaX and drops back/forward when extended input is off', () => {
    const s = new InputSequencer();
    s.enter(1, 1, 0);
    expect(s.route({ type: 'key_down', key: 'a', code: 'KeyA', numLock: true })!.payload).not.toHaveProperty('code');
    expect(s.route({ type: 'key_down', key: 'a', code: 'KeyA', numLock: true })!.payload).not.toHaveProperty('numLock');
    expect(s.route({ type: 'mouse_scroll', x: 0, y: 0, delta: 1, deltaX: 2 })!.payload).not.toHaveProperty('deltaX');
    expect(s.route({ type: 'mouse_down', x: 0, y: 0, button: 'back' })).toBeNull();
    expect(s.route({ type: 'mouse_up', x: 0, y: 0, button: 'forward' })).toBeNull();
  });

  it('keeps them when extended input is on', () => {
    const s = new InputSequencer();
    s.enter(1, 1, 0);
    s.setExtendedInput({ keyCodes: true, extraButtons: true, horizontalWheel: true });
    expect(s.route({ type: 'key_down', key: 'a', code: 'KeyA', numLock: true })!.payload).toMatchObject({ code: 'KeyA', numLock: true });
    expect(s.route({ type: 'mouse_scroll', x: 0, y: 0, delta: 0, deltaX: 2 })!.payload).toMatchObject({ deltaX: 2 });
    expect(s.route({ type: 'mouse_down', x: 0, y: 0, button: 'back' })!.payload).toMatchObject({ button: 'back' });
  });

  it('never adds extended fields in legacy mode even if the capability is on', () => {
    const s = new InputSequencer();
    s.setExtendedInput({ keyCodes: true, extraButtons: true, horizontalWheel: true });
    expect(s.extended()).toEqual({ keyCodes: false, extraButtons: false, horizontalWheel: false });
  });
});

describe('clampInputEvent', () => {
  it('clamps coordinates, scroll deltas, and drops oversized keys / modifier lists', () => {
    expect(clampInputEvent({ type: 'mouse_move', x: 200000, y: -200000 })).toEqual({ type: 'mouse_move', x: 100000, y: -100000 });
    expect(clampInputEvent({ type: 'mouse_scroll', x: 0, y: 0, delta: 500, deltaX: -500 })).toEqual({ type: 'mouse_scroll', x: 0, y: 0, delta: 120, deltaX: -120 });
    expect(clampInputEvent({ type: 'key_down', key: 'x'.repeat(65) })).toBeNull();
    expect(clampInputEvent({ type: 'key_down', key: '' })).toBeNull();
    expect(clampInputEvent({ type: 'key_down', key: ' ' })).toEqual({ type: 'key_down', key: ' ' });
    expect(clampInputEvent({ type: 'key_press', key: 'a', modifiers: Array(9).fill('ctrl') })).toBeNull();
    expect(clampInputEvent({ type: 'key_down', key: 'a', code: 'x'.repeat(65) })).toEqual({ type: 'key_down', key: 'a' });
    expect(clampInputEvent({ type: 'bogus' })).toBeNull();
    expect(clampInputEvent({ type: 'mouse_down', x: 0, y: 0, button: 'side' })).toBeNull();
  });

  it('counts key length in UTF-8 bytes, not UTF-16 units', () => {
    // 22 × 3-byte chars = 66 bytes
    expect(clampInputEvent({ type: 'key_down', key: '€'.repeat(22) })).toBeNull();
    expect(clampInputEvent({ type: 'key_down', key: '€'.repeat(21) })).not.toBeNull();
  });
});
