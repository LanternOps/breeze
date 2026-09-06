/**
 * Tracks what the connected agent said it can do with injected input.
 *
 * Extracted from DesktopViewer so the state machine — arm on channel open,
 * settle on reply, release on channel death, and the bounded wait a paste does
 * before choosing a path — is unit-testable. See issue #4089.
 */

export interface InputCapabilitiesGate {
  /** Arm a fresh wait. Call when a control channel opens and the request is sent. */
  arm(): void;
  /** Record an `input_capabilities` reply from the agent. */
  apply(message: { typeText?: unknown }): void;
  /**
   * Release anything waiting. Call when the control channel goes away, so a
   * paste in flight falls back immediately instead of waiting out its timeout
   * on a dead channel.
   */
  release(): void;
  /** True once an agent has answered that it understands `type_text`. */
  supportsTypeText(): boolean;
  /**
   * Resolves when the agent answers, when the channel is released, or after
   * `timeoutMs` — whichever comes first. Bounded so a paste can never hang on an
   * agent that predates the handshake and will never reply.
   */
  settled(timeoutMs: number): Promise<void>;
}

export function createInputCapabilitiesGate(): InputCapabilitiesGate {
  let typeText = false;
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
      typeText = false;
      ready = new Promise<void>(r => {
        resolve = r;
      });
    },

    apply(message) {
      typeText = message.typeText === true;
      settle();
    },

    release() {
      typeText = false;
      settle();
    },

    supportsTypeText() {
      return typeText;
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
