/**
 * Prompt resolution and capability gate for a WebSocket-fallback desktop start.
 *
 * Resolves the device's notify/consent prompt exactly as the WebRTC start
 * paths do, and refuses the start when a prompt is required but the device's
 * agent does not speak the consent prompt protocol: an agent that predates
 * it drops the `prompt` block and would stream with no notice at all.
 *
 * The capability is read from the device row here, not taken from the caller:
 * the relay's onOpen holds a device record built from the remote-WS
 * authorization context, which carries identity only. Reading the field off
 * that record refused every notify (the default) and consent start, however
 * current the agent.
 *
 * Throws RemoteSessionPromptPolicyError when the prompt policy cannot be read;
 * the caller refuses the start.
 */
import { buildRemoteSessionPromptPayload } from '../routes/remote/helpers';
import { isConsentPromptCapable } from '../routes/remote/consentGate';
import { loadDeviceConsentPromptProtocolVersion } from './deviceConsentPromptCapability';

export type DesktopStreamPromptDecision =
  | { ok: true; prompt: Awaited<ReturnType<typeof buildRemoteSessionPromptPayload>> }
  | { ok: false; reason: 'consent_upgrade_required' };

export async function resolveDesktopStreamPrompt(
  device: { id: string; orgId: string },
  technicianUserId: string,
): Promise<DesktopStreamPromptDecision> {
  const prompt = await buildRemoteSessionPromptPayload(device, technicianUserId);
  // `off` ships no prompt block and needs no capability.
  if (!prompt) return { ok: true, prompt };
  const version = await loadDeviceConsentPromptProtocolVersion(device.id);
  return isConsentPromptCapable(version)
    ? { ok: true, prompt }
    : { ok: false, reason: 'consent_upgrade_required' };
}
