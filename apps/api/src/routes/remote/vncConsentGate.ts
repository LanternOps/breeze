import { resolveRemoteSessionPromptConfig } from './helpers';
import {
  CONSENT_REQUIRED_TRANSPORT_UNAVAILABLE_CODE,
  CONSENT_REQUIRED_TRANSPORT_UNAVAILABLE_MESSAGE,
  REMOTE_PROMPT_POLICY_UNAVAILABLE_CODE,
  REMOTE_PROMPT_POLICY_UNAVAILABLE_MESSAGE,
  RemoteSessionPromptPolicyError,
} from './consentGate';

export type VncConsentGateResult =
  | { ok: true }
  | { ok: false; status: 409 | 503; body: { error: string; code: string } };

/**
 * VNC relay has no end-user consent prompt. On a device whose resolved remote
 * access prompt mode is `consent`, every route that opens a VNC tunnel or hands
 * out access to one refuses, so the technician uses the remote desktop viewer
 * (which asks) instead. An unreadable prompt policy refuses too, exactly as the
 * WebRTC start paths do.
 */
export async function checkVncConsentGate(deviceId: string): Promise<VncConsentGateResult> {
  let mode: string;
  try {
    ({ mode } = await resolveRemoteSessionPromptConfig(deviceId));
  } catch (error) {
    if (error instanceof RemoteSessionPromptPolicyError) {
      return {
        ok: false,
        status: 503,
        body: { error: REMOTE_PROMPT_POLICY_UNAVAILABLE_MESSAGE, code: REMOTE_PROMPT_POLICY_UNAVAILABLE_CODE },
      };
    }
    throw error;
  }
  if (mode === 'consent') {
    return {
      ok: false,
      status: 409,
      body: {
        error: CONSENT_REQUIRED_TRANSPORT_UNAVAILABLE_MESSAGE,
        code: CONSENT_REQUIRED_TRANSPORT_UNAVAILABLE_CODE,
      },
    };
  }
  return { ok: true };
}
