/**
 * Learned networks (#12369): every sentence a gated discovery job or AI scan fails with. All job error text for
 * the gate lives here. Copy never says "verified location": the guarantee is a fingerprint match (spec §3).
 *
 * The agent reports every guard failure that is not a mismatch as `network_changed` (a move during the scan, and
 * also a network it could not read or prove at the start), so that sentence is true in both cases.
 */
import type { DiscoveryGateFailureCode, IneligibleReason, NoAgentReason } from '@breeze/shared';

export const GATE_FAILURE_MESSAGES: Record<Exclude<DiscoveryGateFailureCode, 'no_agent_on_network' | 'agent_not_eligible'>, string> = {
  profile_moved: 'The profile moved to another site or organization after this scan was queued. The scan was not sent.',
  network_not_assigned: 'The network this profile is limited to is not assigned to its site. The scan was not sent.',
  credentials_need_reentry: 'The profile\'s saved SNMP credentials are not granted on any network assigned to this site. Re-enter them on the profile. The scan was not sent.',
  no_network_assigned: 'This site requires an assigned network and has none. The scan was not sent.',
  network_mismatch: 'The scan agent is not behind a gateway assigned to this site. Nothing was scanned.',
  network_changed: 'The scan agent could not confirm that it stayed behind a gateway assigned to this site: its network changed or could not be checked. Nothing from this scan was kept.',
  network_unverified: 'The scan result could not be matched to a network assigned to this site now. Its results were discarded.',
};

export const NO_AGENT_MESSAGES: Record<NoAgentReason, string> = {
  none_online: 'No agent at this site is online. The scan was not sent.',
  none_on_network: 'Agents at this site are online, but none is on an assigned network right now. The scan was not sent.',
  agents_need_update: 'Agents at this site need an update before they can scan an assigned network. The scan was not sent.',
};

const INELIGIBLE_TEXT: Record<IneligibleReason, string> = {
  not_found: 'not found',
  parked: 'parked in the partner\'s holding organization',
  ephemeral: 'a Quick Support device',
  other_site: 'assigned to another site',
  offline: 'offline',
  not_on_network: 'not on an assigned network right now',
  needs_update: 'needs an agent update',
};

export function agentNotEligibleMessage(label: string, reason: IneligibleReason): string {
  return `Scan agent "${label}" cannot run this scan: ${INELIGIBLE_TEXT[reason]}. The scan was not run from any other agent.`;
}
