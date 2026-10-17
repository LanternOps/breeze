/**
 * Minimum agent versions for command payload shapes that an older agent would
 * mishandle silently.
 *
 * `notify_user_messaging` (#8293 W1): an agent below this ignores the
 * endpoint-message keys of a `notify_user` payload, shows a transient toast and
 * reports success. The send route never queues to such an agent; it marks the
 * device `failed:agent_unsupported` instead. The value lives in
 * `@breeze/shared` so the web compose dialog's capability column reads the
 * same gate.
 *
 * `retract_message` (#8742 W2): a W1-era agent has no retract handler, so the
 * retract route refuses it (`agent_unsupported`) rather than queueing a
 * command that would only fail as an unknown type.
 */
import {
  ENDPOINT_MESSAGE_RETRACT_MIN_AGENT_VERSION,
  ENDPOINT_MESSAGING_MIN_AGENT_VERSION,
  agentSupportsEndpointMessageRetract,
  agentSupportsEndpointMessaging,
} from '@breeze/shared';

export const COMMAND_MIN_AGENT_VERSION: Readonly<Record<string, string>> = Object.freeze({
  notify_user_messaging: ENDPOINT_MESSAGING_MIN_AGENT_VERSION,
  retract_message: ENDPOINT_MESSAGE_RETRACT_MIN_AGENT_VERSION,
});

/** Fails closed: null, unparseable and older versions are all false. */
export function agentSupportsMessaging(agentVersion: string | null | undefined): boolean {
  return agentSupportsEndpointMessaging(agentVersion);
}

/** Fails closed, like agentSupportsMessaging. */
export function agentSupportsRetract(agentVersion: string | null | undefined): boolean {
  return agentSupportsEndpointMessageRetract(agentVersion);
}
