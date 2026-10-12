/**
 * Channel lifecycle for the reliable input protocol (viewer W03, #8239).
 *
 * Owns the viewer-opened `input-r` data channel: opens it once the agent
 * advertises `reliableInput`, sends the opening `input_reset` when it opens,
 * answers the agent's epoch changes, and falls back to legacy input on `input`
 * when it closes. InputSequencer decides what each event looks like; this
 * decides where it goes.
 *
 * No queue of its own. Until the opening `input_reset` is sent the agent still
 * accepts legacy events, so input keeps flowing on `input` meanwhile. After
 * that, every event is handed to its channel at once; the only buffer is
 * `input-r`'s own, which is capped (MAX_RELIABLE_BUFFERED_BYTES).
 */

import { InputSequencer, type RoutedInput } from './inputSequencer';
import type { InputCapabilitiesSnapshot } from './inputCapabilities';

/** The parts of RTCDataChannel the router uses. */
export interface InputChannelLike {
  readonly readyState: string;
  readonly bufferedAmount: number;
  send(data: string): void;
  addEventListener(type: 'open' | 'close' | 'error', cb: () => void): void;
  removeEventListener(type: 'open' | 'close' | 'error', cb: () => void): void;
}

/**
 * Above this much unsent data on `input-r`, discrete input is dropped with a
 * notice instead of queued: the channel is not draining, and a growing backlog
 * would replay stale keystrokes once it does.
 */
export const MAX_RELIABLE_BUFFERED_BYTES = 256 * 1024;

export type HeldReconcileReason = 'handshake' | 'epoch' | 'fallback';

export interface ReliableInputDeps {
  /** The lossy `input` channel of the current transport, if any. */
  lossyChannel(): InputChannelLike | null;
  /**
   * Open `input-r` on the current transport: ordered, fully reliable (no
   * maxRetransmits, no maxPacketLifeTime). Null when it cannot.
   */
  openReliableChannel(): InputChannelLike | null;
  /**
   * The agent has released (or is about to release) everything it holds.
   * Forget the viewer's held keys and buttons so nothing sends a release for a
   * press the agent no longer knows about.
   */
  reconcileHeld(reason: HeldReconcileReason): void;
  onNotice(message: string): void;
  now?: () => number;
}

export type SendResult = 'sent' | 'dropped' | 'unavailable';

export class ReliableInputRouter {
  private channel: InputChannelLike | null = null;
  private unbind: (() => void) | null = null;
  private readonly now: () => number;

  constructor(
    private readonly sequencer: InputSequencer,
    private readonly deps: ReliableInputDeps,
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  isReliable(): boolean {
    return this.sequencer.isReliable();
  }

  /** Extended fields the viewer may add right now (W2c; reliable mode only). */
  extended() {
    return this.sequencer.extended();
  }

  /** The agent's `input_capabilities` reply for the current transport. */
  onCapabilities(caps: InputCapabilitiesSnapshot): void {
    this.sequencer.setExtendedInput(caps.extended);
    if (!caps.reliableInput) return;
    this.sequencer.noteEpochs(caps.inputEpoch, caps.geoEpoch);
    if (this.channel) return;
    const ch = this.deps.openReliableChannel();
    if (!ch) return;
    this.channel = ch;

    const onOpen = () => {
      if (this.channel !== ch) return;
      this.deps.reconcileHeld('handshake');
      const { inputEpoch, geoEpoch } = this.sequencer.latestEpochs();
      const reset = this.sequencer.enter(inputEpoch, geoEpoch, this.now());
      if (reset) this.sendOn(ch, reset);
    };
    const onGone = () => {
      if (this.channel !== ch) return;
      this.fallback();
    };
    ch.addEventListener('open', onOpen);
    ch.addEventListener('close', onGone);
    ch.addEventListener('error', onGone);
    this.unbind = () => {
      ch.removeEventListener('open', onOpen);
      ch.removeEventListener('close', onGone);
      ch.removeEventListener('error', onGone);
    };
    if (ch.readyState === 'open') onOpen();
  }

  /** A message from the agent on `control`. Only epoch-bearing ones matter here. */
  onControlMessage(msg: Record<string, unknown>): void {
    if (msg.type === 'input_epoch') {
      this.applyEpoch(msg.epoch, typeof msg.reason === 'string' ? msg.reason : undefined);
    } else if (msg.type === 'monitor_switched') {
      this.sequencer.setGeoEpoch(msg.geoEpoch);
      if (!this.sequencer.isReliable()) {
        this.sequencer.noteEpochs(msg.inputEpoch, undefined);
      } else if (this.sequencer.isNewEpoch(msg.inputEpoch)) {
        this.applyEpoch(msg.inputEpoch, 'monitor_switched');
      }
    }
  }

  /** Send one input event on whichever channel the protocol puts it. */
  send(event: Record<string, unknown>): SendResult {
    const lossy = this.deps.lossyChannel();
    if (!lossy || lossy.readyState !== 'open') return 'unavailable';
    const routed = this.sequencer.route(event);
    if (!routed) {
      console.debug('[input] dropped an event outside the agent protocol:', event.type);
      return 'dropped';
    }
    if (routed.channel === 'input') {
      lossy.send(JSON.stringify(routed.payload));
      return 'sent';
    }
    const ch = this.channel;
    if (!ch || ch.readyState !== 'open') {
      // input-r is going away; the agent will release everything and accept
      // legacy input again once it sees the close.
      this.fallback();
      return this.send(event);
    }
    if (ch.bufferedAmount > MAX_RELIABLE_BUFFERED_BYTES) {
      this.deps.onNotice('Input not delivered — the connection to the remote is backed up.');
      return 'dropped';
    }
    ch.send(JSON.stringify(routed.payload));
    return 'sent';
  }

  /**
   * Ask the agent to release everything it holds, at the current epoch
   * (focus loss). Sent after the caller's own releases. No-op unless reliable.
   */
  resetHeld(): void {
    const ch = this.channel;
    if (!ch || ch.readyState !== 'open' || !this.sequencer.isReliable()) return;
    const reset = this.sequencer.resetCurrent(this.now());
    if (reset) this.sendOn(ch, reset);
  }

  /**
   * The transport is being replaced. Forget `input-r` without a notice (the
   * caller releases held input itself) and route legacy until the next
   * transport's own handshake. The old channel closes with its peer connection.
   */
  detach(): void {
    this.unbind?.();
    this.unbind = null;
    this.channel = null;
    this.sequencer.leave();
  }

  private applyEpoch(epoch: unknown, reason: string | undefined): void {
    const ch = this.channel;
    if (!ch || !this.sequencer.isReliable()) {
      this.sequencer.noteEpochs(epoch, undefined);
      return;
    }
    const reset = this.sequencer.onInputEpoch(epoch, this.now(), reason);
    if (!reset) return;
    this.deps.reconcileHeld('epoch');
    this.sendOn(ch, reset);
  }

  private fallback(): void {
    const wasReliable = this.sequencer.isReliable();
    this.detach();
    if (!wasReliable) return;
    this.deps.reconcileHeld('fallback');
    this.deps.onNotice('Reliable input channel closed — using the standard input channel.');
  }

  private sendOn(ch: InputChannelLike, routed: RoutedInput): void {
    if (ch.readyState !== 'open') {
      this.fallback();
      return;
    }
    ch.send(JSON.stringify(routed.payload));
  }
}
