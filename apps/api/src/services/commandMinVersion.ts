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
  ENDPOINT_CHAT_MIN_AGENT_VERSION,
  agentSupportsEndpointChat,
  ENDPOINT_MESSAGE_RETRACT_MIN_AGENT_VERSION,
  ENDPOINT_MESSAGING_MIN_AGENT_VERSION,
  agentSupportsEndpointMessageRetract,
  agentSupportsEndpointMessaging,
  OEM_UPDATE_MIN_AGENT_VERSION,
  OEM_UPDATE_RELEASE_MIN_AGENT_VERSION,
  OEM_OBSERVE_MIN_AGENT_VERSION,
  GUARDED_COMMAND_TYPES,
  semverCompare,
} from '@breeze/shared';

/**
 * Learned networks (#12369 E7): the first agent release with the guarded discovery scan handler.
 * `999.0.0` is a placeholder no agent reaches, so nothing can be sent guarded until W03c sets the
 * real release. Kept in this file so that change is one line.
 */
export const GUARDED_DISCOVERY_MIN_AGENT_VERSION = '999.0.0';

export const COMMAND_MIN_AGENT_VERSION: Readonly<Record<string, string>> = Object.freeze({
  notify_user_messaging: ENDPOINT_MESSAGING_MIN_AGENT_VERSION,
  retract_message: ENDPOINT_MESSAGE_RETRACT_MIN_AGENT_VERSION,
  // Endpoint live chat (#8743 W03): chat_open / chat_message / chat_close.
  chat: ENDPOINT_CHAT_MIN_AGENT_VERSION,
  // Vendor updates (#11065): checked fail-closed by the dispatch seam
  // (services/oemUpdates/dispatch.ts, agentSupportsOemUpdates) before queueing.
  oem_update_run: OEM_UPDATE_MIN_AGENT_VERSION,
  oem_update_release: OEM_UPDATE_RELEASE_MIN_AGENT_VERSION,
  oem_observe: OEM_OBSERVE_MIN_AGENT_VERSION,
  // Learned networks (#12369 E7). Computed key: this file names no discovery command literal
  // (services/learnedNetworks/scanCommand.contract.test.ts).
  [GUARDED_COMMAND_TYPES.network_discovery]: GUARDED_DISCOVERY_MIN_AGENT_VERSION,
});

/** Fails closed: null, unparseable and older versions are all false. */
export function agentSupportsMessaging(agentVersion: string | null | undefined): boolean {
  return agentSupportsEndpointMessaging(agentVersion);
}

/** Fails closed, like agentSupportsMessaging. */
export function agentSupportsRetract(agentVersion: string | null | undefined): boolean {
  return agentSupportsEndpointMessageRetract(agentVersion);
}

/** Fails closed, like agentSupportsMessaging. Gates every chat command (#8743). */
export function agentSupportsChat(agentVersion: string | null | undefined): boolean {
  return agentSupportsEndpointChat(agentVersion);
}

/**
 * Fails closed: null, blank, unparseable and older versions are all false; a prerelease of the
 * minimum counts. Same rule as the endpoint-messaging gates in `@breeze/shared`.
 */
export function agentSupportsGuardedCommand(
  commandType: keyof typeof GUARDED_COMMAND_TYPES,
  agentVersion: string | null | undefined,
): boolean {
  const min = COMMAND_MIN_AGENT_VERSION[GUARDED_COMMAND_TYPES[commandType]];
  if (!min) return false;
  if (typeof agentVersion !== 'string' || agentVersion.trim() === '') return false;
  const cmp = semverCompare(agentVersion.trim(), min);
  return cmp !== null && cmp >= 0;
}
