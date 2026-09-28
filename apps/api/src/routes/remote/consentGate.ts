/**
 * Remote desktop consent start gates: the refusals every desktop start path
 * (REST offer, viewer-token offer, WS fallback, VNC) returns when the device's
 * consent/notification prompt policy cannot be honored.
 *
 * Kept free of DB/service imports so route modules and their unit tests can use
 * the real error class, codes and predicates without mocking.
 */

/**
 * The only consent/notification prompt protocol version this server speaks.
 * An agent reporting exactly this value (`devices.consentPromptProtocolVersion`,
 * from the heartbeat `securityCapabilities` handshake) parses the `prompt`
 * block on a desktop-stream-start command and gates capture on it. Anything
 * else — omitted, an old pre-consent-gate build, a downgrade, or a future
 * version this server does not recognize — is capability 0: the agent
 * silently drops the unfamiliar `prompt` key (Go's JSON unmarshal into a
 * known struct drops unknown fields) and streams unconditionally, so a
 * dispatch site that resolved a policy requiring consent or notification
 * must refuse to start on such an agent rather than send a prompt block it
 * will not honor.
 */
export const CONSENT_PROMPT_PROTOCOL_VERSION = 1;

export function isConsentPromptCapable(consentPromptProtocolVersion: number): boolean {
  return consentPromptProtocolVersion === CONSENT_PROMPT_PROTOCOL_VERSION;
}

export const REMOTE_PROMPT_POLICY_UNAVAILABLE_CODE = 'REMOTE_PROMPT_POLICY_UNAVAILABLE';
export const REMOTE_PROMPT_POLICY_UNAVAILABLE_MESSAGE =
  'This device\'s remote access prompt settings could not be read, so the session was not started. '
  + 'Try again in a moment. If it keeps happening, open the device\'s remote access policy and save it again.';

/**
 * Thrown by `resolveRemoteSessionPromptConfig` (and so by
 * `buildRemoteSessionPromptPayload`) when the device's prompt policy cannot be
 * established: a lookup error, an unresolvable device, a remote_access policy
 * whose feature link or settings cannot be read, or a stored value outside the
 * known set. Every desktop start path must refuse the start on this error —
 * never substitute the `notify` defaults.
 */
export class RemoteSessionPromptPolicyError extends Error {
  readonly code = REMOTE_PROMPT_POLICY_UNAVAILABLE_CODE;
  readonly deviceId: string;

  constructor(deviceId: string, detail: string, options?: { cause?: unknown }) {
    super(`Remote session prompt policy unavailable for device ${deviceId}: ${detail}`, options);
    this.name = 'RemoteSessionPromptPolicyError';
    this.deviceId = deviceId;
  }
}

export const CONSENT_UPGRADE_REQUIRED_CODE = 'CONSENT_UPGRADE_REQUIRED';
export const CONSENT_UPGRADE_REQUIRED_MESSAGE =
  'This device requires the user\'s consent before remote access, but its agent can\'t show the '
  + 'consent prompt yet. Update the agent on this device, then try again.';

/**
 * True when a start must be refused before dispatch: the resolved policy
 * requires a consent prompt and the device's agent does not speak the consent
 * prompt protocol. Such an agent drops the `prompt` block and streams without
 * asking, so the start is refused rather than sent.
 */
export function requiresConsentCapableAgent(
  prompt: { mode?: unknown } | undefined,
  device: { consentPromptProtocolVersion?: number | null },
): boolean {
  if (prompt?.mode !== 'consent') return false;
  return !isConsentPromptCapable(Number(device.consentPromptProtocolVersion ?? 0));
}

export const CONSENT_REQUIRED_TRANSPORT_UNAVAILABLE_CODE = 'CONSENT_REQUIRED_TRANSPORT_UNAVAILABLE';
export const CONSENT_REQUIRED_TRANSPORT_UNAVAILABLE_MESSAGE =
  'This device requires the user\'s consent before remote access. VNC can\'t ask for consent — '
  + 'use the remote desktop viewer.';

export const CONSENT_REQUIRED_SCREEN_ACCESS_UNAVAILABLE_CODE = 'CONSENT_REQUIRED_SCREEN_ACCESS_UNAVAILABLE';
export const CONSENT_REQUIRED_SCREEN_ACCESS_UNAVAILABLE_MESSAGE =
  'This device requires the user\'s consent before anyone views or controls its screen. Screenshots, '
  + 'screen analysis and input control can\'t ask for consent yet, so nothing was captured or sent. '
  + 'Start a remote desktop session instead, which asks the user first.';
