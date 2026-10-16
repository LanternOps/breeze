// Keyboard mode (W06, #8242): how the viewer turns local keystrokes into
// remote input, chosen per session from the toolbar.
//
//  - 'text' ("Type what I see", default): key events go by key name, without
//    the physical `code`, so the remote types what the local layout shows.
//    Composed text (IME commits, dead-key results) that no single key can
//    express is captured by a hidden input and sent as `type_text`
//    (see compositionCapture.ts) when the agent advertises typeText.
//  - 'physical' ("Physical keys"): key events carry `code` and the remote
//    layout interprets them (games, raw-key apps, VMs). No composition capture.
//
// What each transport can carry decides what is offered: VNC (noVNC sends its
// own keysyms) has neither `code` nor `type_text`, WebSocket has no control
// channel for `type_text`, and Physical needs an agent with keyCodes (W08).

export type KeyboardMode = 'text' | 'physical';

export const DEFAULT_KEYBOARD_MODE: KeyboardMode = 'text';

export function isKeyboardMode(value: unknown): value is KeyboardMode {
  return value === 'text' || value === 'physical';
}

export interface KeyboardModeSupport {
  /** False for VNC and before a transport exists: the control is shown disabled. */
  applies: boolean;
  /** "Physical keys" can be chosen. */
  physical: boolean;
  /** Tooltip for a disabled Physical option; null when it is available. */
  physicalUnavailableReason: string | null;
  /** IME / dead-key capture can deliver composed text (WebRTC + typeText). */
  composition: boolean;
}

export function keyboardModeSupport(input: {
  transport: 'webrtc' | 'websocket' | 'vnc' | null;
  keyCodes: boolean;
  typeText: boolean;
}): KeyboardModeSupport {
  const { transport, keyCodes, typeText } = input;
  if (transport === null) {
    return { applies: false, physical: false, physicalUnavailableReason: 'Not connected', composition: false };
  }
  if (transport === 'vnc') {
    return {
      applies: false,
      physical: false,
      physicalUnavailableReason: 'Keyboard mode does not apply to VNC sessions: VNC sends keys its own way.',
      composition: false,
    };
  }
  if (transport === 'websocket') {
    // The capabilities handshake (keyCodes, typeText) rides the WebRTC control channel.
    return {
      applies: true,
      physical: false,
      physicalUnavailableReason: 'Physical keys needs a WebRTC session.',
      composition: false,
    };
  }
  return {
    applies: true,
    physical: keyCodes,
    physicalUnavailableReason: keyCodes
      ? null
      : 'The remote agent does not support physical key codes yet. Update the agent to use this mode.',
    composition: typeText,
  };
}

/** The mode in force: Physical falls back to "Type what I see" where unsupported. */
export function effectiveKeyboardMode(preferred: KeyboardMode, support: KeyboardModeSupport): KeyboardMode {
  return preferred === 'physical' && support.physical ? 'physical' : 'text';
}
