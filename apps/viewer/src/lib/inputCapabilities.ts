/**
 * Tracks what the connected agent said it can do with injected input.
 *
 * Extracted from DesktopViewer so the state machine — arm on channel open,
 * settle on reply, release on channel death, and the bounded wait a paste does
 * before choosing a path — is unit-testable. See issue #4089.
 *
 * It also records the reliable-input protocol (W2b agent #8246, viewer W03
 * #8239) and the extended key/pointer fields (W2c agent #8247), which the
 * input router reads when the reply lands.
 */

import { parseEpoch, type ExtendedInput } from './inputSequencer';

/**
 * Reply flag that unlocks each W2c (#8247) field. W2c had not shipped when the
 * viewer side was written; spec §3 names only `keyCodes`, so all three are
 * keyed off it until the agent's final names are known. Renaming one is a
 * one-line change here.
 */
export const EXTENDED_INPUT_FLAGS: Record<keyof ExtendedInput, string> = {
  keyCodes: 'keyCodes',        // `code` + `numLock` on key events
  extraButtons: 'keyCodes',    // mouse button 'back' / 'forward'
  horizontalWheel: 'keyCodes', // `deltaX` on mouse_scroll
};

export interface InputCapabilitiesSnapshot {
  typeText: boolean;
  releasesHeldInput: boolean;
  /** True only with valid inputEpoch and geoEpoch alongside it. */
  reliableInput: boolean;
  inputEpoch: number | null;
  geoEpoch: number | null;
  extended: ExtendedInput;
}

const EMPTY: InputCapabilitiesSnapshot = {
  typeText: false,
  releasesHeldInput: false,
  reliableInput: false,
  inputEpoch: null,
  geoEpoch: null,
  extended: { keyCodes: false, extraButtons: false, horizontalWheel: false },
};

function readSnapshot(message: Record<string, unknown>): InputCapabilitiesSnapshot {
  const inputEpoch = parseEpoch(message.inputEpoch);
  const geoEpoch = parseEpoch(message.geoEpoch);
  const flag = (name: string) => message[name] === true;
  return {
    typeText: message.typeText === true,
    releasesHeldInput: message.releasesHeldInput === true,
    reliableInput: message.reliableInput === true && inputEpoch !== null && geoEpoch !== null,
    inputEpoch,
    geoEpoch,
    extended: {
      keyCodes: flag(EXTENDED_INPUT_FLAGS.keyCodes),
      extraButtons: flag(EXTENDED_INPUT_FLAGS.extraButtons),
      horizontalWheel: flag(EXTENDED_INPUT_FLAGS.horizontalWheel),
    },
  };
}

export interface InputCapabilitiesGate {
  /** Arm a fresh wait. Call when a control channel opens and the request is sent. */
  arm(): void;
  /** Record an `input_capabilities` reply from the agent. */
  apply(message: Record<string, unknown>): void;
  /**
   * Release anything waiting. Call when the control channel goes away, so a
   * paste in flight falls back immediately instead of waiting out its timeout
   * on a dead channel.
   */
  release(): void;
  /** True once an agent has answered that it understands `type_text`. */
  supportsTypeText(): boolean;
  /** Everything the last reply said; all false/null before one arrives. */
  snapshot(): InputCapabilitiesSnapshot;
  /**
   * Resolves when the agent answers, when the channel is released, or after
   * `timeoutMs` — whichever comes first. Bounded so a paste can never hang on an
   * agent that predates the handshake and will never reply.
   */
  settled(timeoutMs: number): Promise<void>;
}

export function createInputCapabilitiesGate(): InputCapabilitiesGate {
  let caps: InputCapabilitiesSnapshot = EMPTY;
  let resolve: (() => void) | null = null;
  // Starts resolved: before any channel opens there is nothing to wait for.
  let ready: Promise<void> = Promise.resolve();

  const settle = () => {
    const pending = resolve;
    resolve = null;
    pending?.();
  };

  return {
    arm() {
      // A re-arm abandons the previous wait rather than stranding it — the
      // channel it belonged to is gone.
      settle();
      caps = EMPTY;
      ready = new Promise<void>(r => {
        resolve = r;
      });
    },

    apply(message) {
      caps = readSnapshot(message);
      settle();
    },

    release() {
      caps = EMPTY;
      settle();
    },

    supportsTypeText() {
      return caps.typeText;
    },

    snapshot() {
      return { ...caps, extended: { ...caps.extended } };
    },

    settled(timeoutMs) {
      if (resolve === null) return ready;
      return new Promise<void>(done => {
        const timer = setTimeout(done, timeoutMs);
        void ready.then(() => {
          clearTimeout(timer);
          done();
        });
      });
    },
  };
}
