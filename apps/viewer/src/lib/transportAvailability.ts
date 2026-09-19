/**
 * Whether the WebRTC transport can be *offered* to the operator right now.
 *
 * Kept out of the components on purpose: the same two facts gate a dropdown
 * option, a call-to-action pill and the `switchTransport` guard, and when those
 * drifted apart the toolbar happily invited a click that silently did nothing
 * (issue #3410). Pure predicates keep the three in step and testable without a
 * DOM — same shape as `autoHandoff.ts`.
 */

/**
 * Shown when this WebView cannot do WebRTC at all. Unlike the login-window
 * case, this never resolves while the app is running — no amount of waiting or
 * logging in on the remote machine changes it.
 */
export const WEBRTC_UNSUPPORTED_HINT =
  "WebRTC unavailable: this system's WebView has no WebRTC support";

export const WEBRTC_LOGIN_WINDOW_HINT = 'WebRTC unavailable: device is at login window';

/**
 * Why a switch to WebRTC is unavailable, or `null` when it can be offered.
 *
 * The returned string doubles as the control's tooltip, so a disabled option
 * always carries its reason rather than being inertly greyed out.
 */
export function webrtcSwitchUnavailableReason(params: {
  /**
   * Whether THIS WebView can actually do WebRTC — the up-front `typeof` probe
   * AND the runtime discovery, since a build can expose RTCPeerConnection and
   * still throw on use. Callers pass the combined value.
   */
  webrtcSupported: boolean;
  /** Remote macOS session state, when known. */
  desktopState: string | null | undefined;
}): string | null {
  // Ordered deliberately: the WebView gap is permanent, so it is the more
  // useful thing to report when both apply.
  if (!params.webrtcSupported) return WEBRTC_UNSUPPORTED_HINT;
  if (params.desktopState === 'loginwindow') return WEBRTC_LOGIN_WINDOW_HINT;
  return null;
}

/**
 * Whether to show the "user logged in — switch to WebRTC" pill.
 *
 * `webRTCAvailable` describes the *remote* macOS device, so on its own it will
 * happily advertise a switch that this WebView could never perform.
 */
export function shouldShowWebRTCSwitchPill(params: {
  transport: string | null;
  remoteOs: string | null;
  /** Remote device is in a state where WebRTC capture works. */
  webRTCAvailable: boolean;
  /** This WebView can actually do WebRTC (probe AND runtime discovery). */
  webrtcSupported: boolean;
  pillDismissed: boolean;
}): boolean {
  return (
    params.transport === 'vnc' &&
    params.remoteOs === 'macos' &&
    params.webRTCAvailable &&
    params.webrtcSupported &&
    !params.pillDismissed
  );
}
