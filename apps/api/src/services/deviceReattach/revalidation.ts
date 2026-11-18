/**
 * The §6.4 revalidation every protocol step repeats under its locks (#8318
 * wave 1b). Phase 1 runs it without liveness; confirm runs it, then the §6.5
 * liveness rule, and is the authoritative one. Any failure cancels the intent
 * with the returned reason and answers 409.
 *
 *  - one partner: both orgs' `partner_id` = the intent's, read in this
 *    transaction after the device locks (`partner_mismatch`);
 *  - both orgs still live: `active` or `trial` and not soft-deleted, the
 *    request's own refusal (`org_draining`);
 *  - the requester is still an active member of the partner who satisfies the
 *    §8 access rule for both devices (`requester_revoked`);
 *  - row versions, as the human authorized them: target agent_id,
 *    incarnation and org (`target_changed`); source agent_id and org
 *    (`source_changed`);
 *  - the source is not quarantined, suspended or decommissioned
 *    (`source_changed`);
 *  - the target is not quarantined, suspended or ephemeral, decommissioned
 *    only with `restore_decommissioned`, and was never the source of a
 *    confirmed reattach (`target_changed`).
 */
import type { DeviceReattachIntent } from '../../db/schema';
import { canActorReattach, loadReattachActor, REACHABLE_ORG_STATUSES } from './access';
import { wasRetiredReattachSource, type LockedReattachDevice, type ReattachTx } from './intentStore';
import type { ReattachCancelReason } from './protocol';

/** The device's org is one a reattach may touch: active or trial, not soft-deleted. */
export function isLiveOrg(device: Pick<LockedReattachDevice, 'orgStatus' | 'orgDeletedAt'>): boolean {
  return (REACHABLE_ORG_STATUSES as readonly string[]).includes(device.orgStatus) && device.orgDeletedAt === null;
}

export async function revalidateLockedIntent(
  tx: ReattachTx,
  intent: DeviceReattachIntent,
  source: LockedReattachDevice,
  target: LockedReattachDevice,
): Promise<ReattachCancelReason | null> {
  if (source.orgPartnerId !== intent.partnerId || target.orgPartnerId !== intent.partnerId) {
    return 'partner_mismatch';
  }
  // Either org suspended, churned, deleted, offboarding… since the request:
  // the request's own `org_draining` refusal, now cancelling the intent.
  if (!isLiveOrg(source) || !isLiveOrg(target)) return 'org_draining';

  const actor = intent.requestedBy ? await loadReattachActor(tx, intent.requestedBy, intent.partnerId) : null;
  const access = canActorReattach(actor, {
    partnerId: intent.partnerId,
    sourceOrgId: source.orgId,
    sourceParked: intent.sourceParked,
    targetOrgId: target.orgId,
  });
  if (!access.allowed) return 'requester_revoked';

  if (
    source.agentId !== intent.sourceAgentId
    || source.orgId !== intent.sourceOrgId
    || source.status === 'quarantined'
    || source.status === 'decommissioned'
    || source.agentTokenSuspendedAt !== null
  ) {
    return 'source_changed';
  }

  if (
    target.agentId !== intent.targetAgentId
    || target.installIncarnation !== intent.targetIncarnation
    || target.orgId !== intent.targetOrgId
    || target.status === 'quarantined'
    || target.agentTokenSuspendedAt !== null
    || target.isEphemeral
    || (target.status === 'decommissioned' && !intent.restoreDecommissioned)
  ) {
    return 'target_changed';
  }
  if (await wasRetiredReattachSource(tx, target.id)) return 'target_changed';
  return null;
}
