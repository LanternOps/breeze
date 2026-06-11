// Pure state machine for the Composer's voice input. Kept independent of
// React / RN / expo-speech-recognition so vitest can exercise the
// transitions without pulling native modules into the node test runtime.
//
// States:
//  - idle:          mic button shows; tapping starts a recognition session
//  - requesting:    permissions requested or recognition is starting up
//  - listening:     recognition is active; pulse animation runs
//  - transcribing:  user tapped stop; waiting for the final result event
//  - error:         a permission denial or runtime failure (carries reason)
//
// The `transcribed` outcome is not a state — once we receive the final
// result we hand the text back to the caller (which writes it into the
// composer input) and reset to idle. The user reviews and presses send;
// we never auto-send.

export type VoicePermission = 'unknown' | 'granted' | 'denied';

export type VoiceErrorReason =
  | 'permission-denied'
  | 'unavailable'
  | 'offline'
  | 'recognition-failed';

export type VoiceState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'listening' }
  | { kind: 'transcribing' }
  | { kind: 'error'; reason: VoiceErrorReason };

export type VoiceEvent =
  | { type: 'press'; offline: boolean; permission: VoicePermission }
  | { type: 'permission-resolved'; granted: boolean }
  | { type: 'started' }
  | { type: 'stop-requested' }
  | { type: 'final-result' }
  | { type: 'failed'; reason: VoiceErrorReason }
  | { type: 'reset' };

export const initialVoiceState: VoiceState = { kind: 'idle' };

export function reduceVoice(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case 'press': {
      // Offline guard: surface the "needs network" error UI.
      if (event.offline) return { kind: 'error', reason: 'offline' };

      // If actively listening, treat this press as a stop signal.
      if (state.kind === 'listening') return { kind: 'transcribing' };

      // If we're already mid-flight, ignore the press.
      if (state.kind === 'requesting' || state.kind === 'transcribing') {
        return state;
      }

      if (event.permission === 'granted') return { kind: 'requesting' };
      if (event.permission === 'denied') {
        return { kind: 'error', reason: 'permission-denied' };
      }
      // unknown — we'll trigger a permission request and wait for resolution.
      return { kind: 'requesting' };
    }

    case 'permission-resolved': {
      if (state.kind !== 'requesting') return state;
      return event.granted
        ? state // stay in requesting until 'started' fires
        : { kind: 'error', reason: 'permission-denied' };
    }

    case 'started': {
      if (state.kind !== 'requesting') return state;
      return { kind: 'listening' };
    }

    case 'stop-requested': {
      if (state.kind !== 'listening') return state;
      return { kind: 'transcribing' };
    }

    case 'final-result': {
      // Final result can arrive from listening (timeout/end-of-speech) or
      // from transcribing (user-initiated stop). Both reset to idle.
      if (state.kind === 'listening' || state.kind === 'transcribing') {
        return { kind: 'idle' };
      }
      return state;
    }

    case 'failed': {
      return { kind: 'error', reason: event.reason };
    }

    case 'reset': {
      return { kind: 'idle' };
    }

    default:
      return state;
  }
}

// Tiny presentation helpers consumed by the Composer + tests so neither has
// to re-derive UI booleans from the discriminated union.
export function isListening(state: VoiceState): boolean {
  return state.kind === 'listening';
}

export function isBusy(state: VoiceState): boolean {
  return state.kind === 'requesting' || state.kind === 'transcribing';
}

export function errorMessage(state: VoiceState): string | null {
  if (state.kind !== 'error') return null;
  switch (state.reason) {
    case 'permission-denied':
      return 'Microphone or speech permission needed.';
    case 'offline':
      return 'Connect to use voice.';
    case 'unavailable':
      return 'Voice input unavailable on this device.';
    case 'recognition-failed':
      return 'Could not understand audio. Try again.';
    default:
      return null;
  }
}
