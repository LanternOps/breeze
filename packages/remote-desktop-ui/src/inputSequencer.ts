/**
 * Viewer side of the reliable input protocol (W2b agent, #8246; viewer W03, #8239).
 *
 * Pure state: which channel an input event goes on, and the `seq` / `after` /
 * `epoch` / `geoEpoch` fields it carries. Every wire field name of the protocol
 * lives here. The channel lifecycle that drives it is in reliableInput.ts.
 *
 * Wire contract: docs/superpowers/plans/remote-desktop/2026-10-08-viewer-input-clipboard.md,
 * section "W2b shipped wire contract (#8246)". The parts that shape this file:
 *  - Legacy (no `reliableInput` from the agent, or `input-r` gone): events go
 *    on `input` exactly as before, with no new fields.
 *  - Reliable: every event carries `seq`, strictly increasing across both
 *    channels. The agent drops a seq at or below one it already handled and
 *    does NOT ask for a resync, so seq never restarts, not even on a new epoch
 *    or after a fallback to legacy.
 *  - `mouse_move` stays on `input` and carries `after`: the seq of the last
 *    discrete event sent, `input_reset` included (the agent's barrier counts it).
 *  - Every sequenced event carries `epoch`; pointer events also carry `geoEpoch`.
 *  - A viewer `input_reset` does not change the epoch; only the agent does
 *    (`input_epoch`, `monitor_switched`).
 */

export type InputRoute = 'input' | 'input-r';

export interface RoutedInput {
  channel: InputRoute;
  payload: Record<string, unknown>;
}

/** Largest seq the agent accepts (2^53 − 1). */
export const MAX_INPUT_SEQ = Number.MAX_SAFE_INTEGER;
const MAX_EPOCH = 2 ** 32 - 1;

// Agent validation bounds (agent/internal/remote/desktop/input_validate.go).
// An event outside them is dropped by the agent with a warning, so it is
// clamped (or not sent) here.
export const MAX_INPUT_COORDINATE_ABS = 100_000;
export const MAX_INPUT_SCROLL_DELTA = 120;
export const MAX_INPUT_KEY_BYTES = 64;
export const MAX_INPUT_MODIFIERS = 8;

const ALLOWED_TYPES = new Set([
  'mouse_move', 'mouse_click', 'mouse_down', 'mouse_up', 'mouse_scroll',
  'key_press', 'key_down', 'key_up', 'input_reset',
]);
const BASE_BUTTONS = new Set(['', 'left', 'right', 'middle']);
const EXTRA_BUTTONS = new Set(['back', 'forward']);
const KEY_EVENTS = new Set(['key_press', 'key_down', 'key_up']);

/**
 * A resync for the epoch we already reset to is normally an event that left
 * before our reset arrived. Re-send only if it keeps coming after this long.
 */
export const RESYNC_RESEND_AFTER_MS = 2000;

/** Optional fields that need W2c (#8247) agent support. See inputCapabilities.ts. */
export interface ExtendedInput {
  keyCodes: boolean;       // `code` + `numLock` on key events
  extraButtons: boolean;   // button 'back' / 'forward'
  horizontalWheel: boolean; // `deltaX` on mouse_scroll
}

const NO_EXTENDED: ExtendedInput = { keyCodes: false, extraButtons: false, horizontalWheel: false };

/** An inbound epoch is untrusted: an integer in 1 … 2^32 − 1, or nothing. */
export function parseEpoch(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 1 || value > MAX_EPOCH) return null;
  return value;
}

export function isPointerEvent(type: unknown): boolean {
  return typeof type === 'string' && type.startsWith('mouse_');
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function clampAbs(v: unknown, max: number): unknown {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  return Math.max(-max, Math.min(max, Math.trunc(v)));
}

/**
 * Keep an outgoing event inside the agent's validation bounds. Returns null
 * for an event the agent would drop and that cannot be fixed by clamping
 * (unknown type, unknown button, a key that is empty or too long, too many
 * modifiers). An oversized `code` is removed rather than dropping the key: the
 * agent still has `key`.
 */
export function clampInputEvent(event: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof event.type !== 'string' || !ALLOWED_TYPES.has(event.type)) return null;
  const out: Record<string, unknown> = { ...event };
  if ('x' in out) out.x = clampAbs(out.x, MAX_INPUT_COORDINATE_ABS);
  if ('y' in out) out.y = clampAbs(out.y, MAX_INPUT_COORDINATE_ABS);
  if ('delta' in out) out.delta = clampAbs(out.delta, MAX_INPUT_SCROLL_DELTA);
  if ('deltaX' in out) out.deltaX = clampAbs(out.deltaX, MAX_INPUT_SCROLL_DELTA);
  if ('button' in out) {
    const b = out.button;
    if (typeof b !== 'string' || !(BASE_BUTTONS.has(b) || EXTRA_BUTTONS.has(b))) return null;
  }
  if (KEY_EVENTS.has(out.type as string)) {
    const key = out.key;
    if (typeof key !== 'string' || key.length === 0 || utf8Bytes(key) > MAX_INPUT_KEY_BYTES) return null;
  }
  if ('modifiers' in out && Array.isArray(out.modifiers) && out.modifiers.length > MAX_INPUT_MODIFIERS) return null;
  if ('code' in out && (typeof out.code !== 'string' || out.code.length === 0 || utf8Bytes(out.code) > MAX_INPUT_KEY_BYTES)) {
    delete out.code;
  }
  return out;
}

export class InputSequencer {
  private seq: number;
  private reliable = false;
  private exhausted = false;
  private epoch = 0;
  private geoEpoch = 0;
  private lastDiscrete = 0;
  // Latest epochs heard from the agent, in either mode, so entering reliable
  // mode uses the newest known values rather than the discovery reply's.
  private knownEpoch = 0;
  private knownGeoEpoch = 0;
  private lastResetEpoch = 0;
  private lastResetAt = 0;
  private extendedCaps: ExtendedInput = NO_EXTENDED;

  /** `startSeq` is the seq already used; tests set it near the cap. */
  constructor(startSeq = 0) {
    this.seq = startSeq;
  }

  isReliable(): boolean {
    return this.reliable;
  }

  /** Extended fields actually allowed now: only in reliable mode. */
  extended(): ExtendedInput {
    return this.reliable ? this.extendedCaps : NO_EXTENDED;
  }

  setExtendedInput(caps: ExtendedInput): void {
    this.extendedCaps = { ...caps };
  }

  /** Record epochs from discovery or monitor_switched. Invalid values are ignored. */
  noteEpochs(inputEpoch: unknown, geoEpoch: unknown): void {
    const e = parseEpoch(inputEpoch);
    const g = parseEpoch(geoEpoch);
    if (e !== null) this.knownEpoch = e;
    if (g !== null) {
      this.knownGeoEpoch = g;
      if (this.reliable) this.geoEpoch = g;
    }
  }

  latestEpochs(): { inputEpoch: number; geoEpoch: number } {
    return { inputEpoch: this.knownEpoch, geoEpoch: this.knownGeoEpoch };
  }

  /**
   * Switch to reliable mode. Returns the opening `input_reset` (to send on
   * `input-r`), or null when an epoch is invalid or seq is exhausted; the
   * sequencer then stays legacy.
   */
  enter(inputEpoch: unknown, geoEpoch: unknown, now: number): RoutedInput | null {
    const e = parseEpoch(inputEpoch);
    const g = parseEpoch(geoEpoch);
    if (e === null || g === null || this.exhausted) return null;
    this.knownEpoch = e;
    this.knownGeoEpoch = g;
    this.epoch = e;
    this.geoEpoch = g;
    this.reliable = true;
    return this.makeReset(now);
  }

  /** Back to legacy routing. The seq counter keeps its value. */
  leave(): void {
    this.reliable = false;
  }

  setGeoEpoch(geoEpoch: unknown): void {
    this.noteEpochs(undefined, geoEpoch);
  }

  /**
   * The agent reset its input (it has already released everything) and moved
   * to `epoch`. Returns the `input_reset` to send after the caller reconciled
   * its held state, or null when there is nothing to send: invalid epoch,
   * legacy mode, or a repeat for the epoch already reset to.
   */
  onInputEpoch(epoch: unknown, now: number, reason?: string): RoutedInput | null {
    const e = parseEpoch(epoch);
    if (e === null) return null;
    this.knownEpoch = e;
    if (!this.reliable) return null;
    if (e === this.lastResetEpoch) {
      if (reason !== 'resync' || now - this.lastResetAt < RESYNC_RESEND_AFTER_MS) return null;
    }
    this.epoch = e;
    return this.makeReset(now);
  }

  /** True when `epoch` differs from the one this session last reset to. */
  isNewEpoch(epoch: unknown): boolean {
    const e = parseEpoch(epoch);
    return e !== null && e !== this.lastResetEpoch;
  }

  /** An `input_reset` at the current epoch (focus loss). Null in legacy mode. */
  resetCurrent(now = Date.now()): RoutedInput | null {
    if (!this.reliable) return null;
    return this.makeReset(now);
  }

  /**
   * Route an outgoing event. Legacy mode returns the same object on `input`,
   * so the JSON on the wire is unchanged. Reliable mode returns a stamped
   * copy, or null when the event must not be sent (outside the agent's
   * bounds, or an extended field the agent did not advertise).
   */
  route(event: Record<string, unknown>): RoutedInput | null {
    if (!this.reliable) return { channel: 'input', payload: event };
    const ext = this.extendedCaps;
    if (!ext.extraButtons && typeof event.button === 'string' && EXTRA_BUTTONS.has(event.button)) return null;
    const clamped = clampInputEvent(event);
    if (!clamped) return null;
    if (!ext.keyCodes) {
      delete clamped.code;
      delete clamped.numLock;
    }
    if (!ext.horizontalWheel) delete clamped.deltaX;

    const seq = this.nextSeq();
    if (seq === null) return { channel: 'input', payload: event };
    clamped.seq = seq;
    clamped.epoch = this.epoch;
    if (isPointerEvent(clamped.type)) clamped.geoEpoch = this.geoEpoch;
    if (clamped.type === 'mouse_move') {
      clamped.after = this.lastDiscrete;
      return { channel: 'input', payload: clamped };
    }
    this.lastDiscrete = seq;
    return { channel: 'input-r', payload: clamped };
  }

  private makeReset(now: number): RoutedInput | null {
    const seq = this.nextSeq();
    if (seq === null) return null;
    this.lastDiscrete = seq;
    this.lastResetEpoch = this.epoch;
    this.lastResetAt = now;
    return { channel: 'input-r', payload: { type: 'input_reset', seq, epoch: this.epoch } };
  }

  // Null once the agent's seq range is used up: the session falls back to
  // legacy for good rather than wrapping (which the agent would drop silently).
  private nextSeq(): number | null {
    if (this.seq >= MAX_INPUT_SEQ) {
      this.exhausted = true;
      this.reliable = false;
      return null;
    }
    this.seq += 1;
    return this.seq;
  }
}
