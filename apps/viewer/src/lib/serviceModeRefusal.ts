/**
 * An agent running as a service (Windows Session 0 / headless) always refuses
 * the WebSocket-relay desktop path: `serviceUnavailable()` in
 * agent/internal/heartbeat/handlers_desktop.go answers "<command> unavailable
 * in headless/service mode; use WebRTC instead". The API relays that text to the
 * viewer inside an AGENT_START_FAILED error (the agent sends no machine-readable
 * code), so the marker substring is the only stable signal (#7415).
 */
const SERVICE_MODE_REFUSAL_MARKER = 'unavailable in headless/service mode';

export function isServiceModeRefusal(message: string | null | undefined): boolean {
  return !!message && message.includes(SERVICE_MODE_REFUSAL_MARKER);
}

/**
 * User-facing replacement for the agent's terse refusal. `webrtcUsable` is
 * whether THIS viewer could do WebRTC: when it can't, that is the actionable
 * cause; when it can, the refusal is unexpected and we shouldn't blame the viewer.
 */
export function serviceModeRefusalMessage(webrtcUsable: boolean): string {
  if (!webrtcUsable) {
    return (
      'This device needs WebRTC for remote desktop (it runs as a service), but ' +
      'this viewer build does not support WebRTC. Connect from a viewer or ' +
      'browser that supports WebRTC instead.'
    );
  }
  return (
    'This device needs WebRTC for remote desktop (it runs as a service), and ' +
    'the WebSocket fallback is not available for it. Retry the connection.'
  );
}
