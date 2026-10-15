/**
 * Tracks whether a system biometric sheet that WE raised is on screen.
 *
 * iOS flips the app to `inactive` while a Face ID / LocalAuthentication sheet
 * (or a biometric-gated keychain signature) is showing. The app lock's privacy
 * cover treats `inactive` as "the user is switching away" and raises the
 * full-screen wordmark — so without this, our own Approve and Unlock prompts
 * flashed that cover. `AppLockGate` subscribes here and forwards the edges into
 * `appLockMachine` as `biometricPromptStarted` / `biometricPromptEnded`; the
 * decision of what to cover stays in the machine.
 *
 * EVERY call site that can show a system biometric sheet must go through
 * {@link withBiometricPrompt}. A site that does not just keeps the old flash;
 * it cannot weaken the cover. Deliberately free of React Native imports so it
 * stays reachable from the node-only vitest runtime.
 */

type Listener = (active: boolean) => void;

let inFlight = 0;
const listeners = new Set<Listener>();

function notify(active: boolean): void {
  for (const listener of [...listeners]) listener(active);
}

/** Whether at least one of our biometric prompts is currently in flight. */
export function isBiometricPromptActive(): boolean {
  return inFlight > 0;
}

/**
 * Called on the idle -> active and active -> idle edges only; overlapping
 * prompts are counted, not reported individually. Returns an unsubscribe.
 */
export function subscribeBiometricPrompt(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Run `prompt` (anything that shows a system biometric / passcode sheet) with
 * the registry marked active. The mark is released however `prompt` settles —
 * resolve, reject, or a synchronous throw — so a failed prompt can never leave
 * the cover suppressed.
 */
export async function withBiometricPrompt<T>(prompt: () => Promise<T>): Promise<T> {
  inFlight += 1;
  if (inFlight === 1) notify(true);
  try {
    return await prompt();
  } finally {
    inFlight -= 1;
    if (inFlight === 0) notify(false);
  }
}
