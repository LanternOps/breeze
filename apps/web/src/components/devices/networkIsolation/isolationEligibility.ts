import { isActiveIsolationState, type IsolationStartRefusal } from '@breeze/shared';
import type { IsolationListResponse, IsolationEpisode } from './types';

// Include dispatch/allowlist refusals as well as the shared start gate vocabulary.
export const START_REFUSAL_KEYS = {
  feature_disabled: 'networkIsolation.refusal.feature_disabled',
  partner_not_enabled: 'networkIsolation.refusal.partner_not_enabled',
  agent_below_gate: 'networkIsolation.refusal.agent_below_gate',
  agent_not_ready: 'networkIsolation.refusal.agent_not_ready',
  device_lifecycle: 'networkIsolation.refusal.device_lifecycle',
  unsupported_platform: 'networkIsolation.refusal.unsupported_platform',
  trust_restricted: 'networkIsolation.refusal.trust_restricted',
  isolation_already_active: 'networkIsolation.refusal.isolation_already_active',
  isolation_unacknowledged: 'networkIsolation.refusal.isolation_unacknowledged',
  incident_mismatch: 'networkIsolation.refusal.incident_mismatch',
  site_forbidden: 'networkIsolation.refusal.site_forbidden',
  device_not_found: 'networkIsolation.refusal.device_not_found',
  isolation_not_found: 'networkIsolation.refusal.isolation_not_found',
  relay_unavailable: 'networkIsolation.refusal.relay_unavailable',
  invalid_allowlist: 'networkIsolation.refusal.invalid_allowlist',
  isolation_conflict: 'networkIsolation.refusal.isolation_conflict',
  isolation_secret_unavailable: 'networkIsolation.refusal.isolation_secret_unavailable',
  approval_mismatch: 'networkIsolation.refusal.approval_mismatch',
  device_offline: 'networkIsolation.refusal.device_offline',
  device_decommissioned: 'networkIsolation.refusal.device_decommissioned',
  device_pending_assignment: 'networkIsolation.refusal.device_pending_assignment',
  backup_helper_update_required: 'networkIsolation.refusal.backup_helper_update_required',
 } as const satisfies Record<IsolationStartRefusal, string> & Record<string, string>;
export type StartBlockReason = keyof typeof START_REFUSAL_KEYS | 'unavailable';
export function refusalKey(reason: string): string {
  return Object.hasOwn(START_REFUSAL_KEYS, reason)
    ? START_REFUSAL_KEYS[reason as keyof typeof START_REFUSAL_KEYS]
    : 'networkIsolation.unavailable';
}
/** Server refusal copy for a mutation error; undefined lets runAction fall back to the generic/`errors:<CODE>` copy. */
export function isolationRefusalCopy(code: string, t: (key: string) => string): string | undefined {
  return Object.hasOwn(START_REFUSAL_KEYS, code) ? t(/* i18n-dynamic */ refusalKey(code)) : undefined;
}
export function startEligibility(response: Pick<IsolationListResponse, 'startEligibility'> | null | undefined): { enabled: boolean; reason?: StartBlockReason } {
  if (response?.startEligibility.allowed) return { enabled: true };
  const reason = response?.startEligibility.reason;
  return { enabled: false, reason: reason && Object.hasOwn(START_REFUSAL_KEYS, reason) ? reason as StartBlockReason : 'unavailable' };
}

/** Recovery never consults flags, version, capabilities, trust, incident or start eligibility. */
export function releaseEligibility(episode: Pick<IsolationEpisode, 'state'>): { visible: boolean; label: 'release' | 'release_queued' } {
  return { visible: isActiveIsolationState(episode.state), label: 'release' };
}
