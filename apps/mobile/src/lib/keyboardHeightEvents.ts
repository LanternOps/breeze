/**
 * Which RN `Keyboard` event pair to subscribe to per platform.
 *
 * Pure so it's testable under this project's vitest runtime (no RN test
 * renderer — see `useKeyboardHeight.ts`'s comment for why the subscription
 * itself lives in a hook this file's tests never touch).
 *
 * iOS fires `keyboardWill*` ahead of the slide animation, carrying the
 * keyboard's FINAL frame — using it keeps a tracked height in step with the
 * keyboard as it moves. Android has no "will" pair; `keyboardDid*` is the
 * only option there; it fires once the keyboard has already finished
 * animating, but that's Android's own show/hide timing, no worse than
 * `KeyboardAvoidingView`'s.
 */
export function keyboardShowEventName(platformOS: string): 'keyboardWillShow' | 'keyboardDidShow' {
  return platformOS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
}

export function keyboardHideEventName(platformOS: string): 'keyboardWillHide' | 'keyboardDidHide' {
  return platformOS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
}
