/**
 * Learned networks E5 (#12369, spec §8.2): the one decision every discovery scan producer goes through.
 *
 * Rows 1..6 of spec 8.2, in that order; the first row that applies decides, and decides the failure code. Each
 * row reads lazily, so no row reads what an earlier row made unnecessary. The caller holds the shared site lock
 * (`lockSitesForNetworkGate`) inside a DB context.
 */
import { eq } from 'drizzle-orm';
import type { DiscoveryJobError, ExpectedGateway } from '@breeze/shared';
import { db } from '../../db';
import { discoveryProfiles } from '../../db/schema';
import { storedProfileHoldsSnmpSecrets } from '../snmpSecrets';
import { GATE_FAILURE_MESSAGES } from './messages';
import { loadNetworkGateways, loadNetworkSiteId, loadSiteGateState } from './siteNetworks';
import { loadUsableGrantGateways } from './snmpGrants';

export type GateProfile = {
  id: string; orgId: string; siteId: string; networkId: string | null;
  snmpGrantMode: 'unrestricted' | 'bound'; hasSavedSnmpSecrets: boolean;
};  // hasSavedSnmpSecrets comes from storedProfileHoldsSnmpSecrets; W03b's profileWillHoldSnmpSecrets must agree with it

export type GateDecision =
  | { kind: 'fail'; error: DiscoveryJobError }
  | { kind: 'unrestricted' }
  | { kind: 'guarded'; allowed: ExpectedGateway[] };          // every allowed fingerprint, not yet cut to 64

function fail(code: keyof typeof GATE_FAILURE_MESSAGES): GateDecision {
  return { kind: 'fail', error: { code, message: GATE_FAILURE_MESSAGES[code] } };
}

export async function evaluateDiscoveryGate(input: {
  orgId: string; siteId: string;
  profile: GateProfile | null;                                 // null: the AI tool
  job?: { orgId: string; siteId: string };                     // row 1
}): Promise<GateDecision> {
  const { orgId, siteId, profile, job } = input;

  // Row 1: checked before any credential is decrypted.
  if (profile && job && (job.orgId !== profile.orgId || job.siteId !== profile.siteId)) return fail('profile_moved');

  // Row 2: on a gated site and on one that is not.
  if (profile?.networkId) {
    const networkSiteId = await loadNetworkSiteId(orgId, profile.networkId);
    if (networkSiteId !== siteId) return fail('network_not_assigned');
  }

  // Row 3: bound saved secrets are always guarded, whether or not the site is gated.
  if (profile?.hasSavedSnmpSecrets && profile.snmpGrantMode === 'bound') {
    const allowed = await loadUsableGrantGateways({ orgId, profileId: profile.id, siteId, networkId: profile.networkId });
    return allowed.length === 0 ? fail('credentials_need_reentry') : { kind: 'guarded', allowed };
  }

  const state = await loadSiteGateState(orgId, siteId);

  // Row 3a: cannot arise (8.3 rule 2); if it does, fail closed and never fall through to row 6.
  if (profile?.hasSavedSnmpSecrets && state.gated) return fail('credentials_need_reentry');

  // Row 4.
  if (!state.gated) return { kind: 'unrestricted' };

  // Row 5.
  if (state.assignedNetworkIds.length === 0) return fail('no_network_assigned');

  // Row 6: row 2 already proved profile.networkId is assigned to this site. A network with no fingerprints
  // allows nothing; the caller's eligibility then finds no agent.
  const networkIds = profile?.networkId ? [profile.networkId] : state.assignedNetworkIds;
  return { kind: 'guarded', allowed: await loadNetworkGateways(orgId, networkIds) };
}

export function gateProfileFromRow(row: typeof discoveryProfiles.$inferSelect): GateProfile {
  return {
    id: row.id,
    orgId: row.orgId,
    siteId: row.siteId,
    networkId: row.networkId ?? null,
    snmpGrantMode: row.snmpGrantMode === 'bound' ? 'bound' : 'unrestricted',
    hasSavedSnmpSecrets: storedProfileHoldsSnmpSecrets(row),
  };
}

export async function loadGateProfile(profileId: string): Promise<GateProfile | null> {
  const [row] = await db.select().from(discoveryProfiles).where(eq(discoveryProfiles.id, profileId)).limit(1);
  return row ? gateProfileFromRow(row) : null;
}
