/**
 * Learned networks E10 (#12369, spec §8.4): one verifier for every discovery result path, run before any host
 * is stored or returned: the direct result branch (`routes/agentWs.ts`), `handleDiscoveryResult`
 * (`services/commandResultHandlers.ts`), `processResults` (again, in the storing transaction), the adjacency
 * admission and the AI tool's response.
 *
 * - Guarded attempt: the result's `verifiedNetwork` must name a fingerprint in the attempt record AND one the gate
 *   evaluated now still allows for the job's site and profile, with the same address and MAC.
 * - Unrestricted attempt (or none: a job dispatched before this shipped): accepted only while the site is still
 *   not gated.
 *
 * Callers hold the shared site lock (`lockSitesForNetworkGate`) inside a DB context, and call this outside any
 * catch, so a failed read fails their transaction.
 */
import { verifiedNetworkSchema, type DiscoveryJobError } from '@breeze/shared';
import { evaluateDiscoveryGate, loadGateProfile, type GateProfile } from './gate';
import { GATE_FAILURE_MESSAGES } from './messages';
import { loadSiteGateState } from './siteNetworks';
import { parseNetworkDispatchRecord } from './attempt';

export type VerifyOutcome =
  | { ok: true; networkId: string | null }                     // null: an accepted unrestricted result
  | { ok: false; error: DiscoveryJobError };                   // code 'network_unverified'

type Attempt = { mode: 'unrestricted' | 'guarded'; allowedGatewayIds: readonly string[] };

const UNVERIFIED: VerifyOutcome = {
  ok: false,
  error: { code: 'network_unverified', message: GATE_FAILURE_MESSAGES.network_unverified },
};

/**
 * Every rejection reads the same to the user; the specific cause is logged so an agent-contract mismatch can be
 * told apart from a real network change.
 */
function unverified(cause: string, input: { orgId: string; siteId: string; profileId: string | null }): VerifyOutcome {
  console.warn(`[learnedNetworks] discovery result unverified (${cause}): org=${input.orgId} site=${input.siteId} profile=${input.profileId ?? 'none'}`);
  return UNVERIFIED;
}

/** A job's `network_dispatch` as a verifier attempt. An unreadable record fails closed (guarded, nothing allowed). */
export function attemptFromRecord(value: unknown): Attempt | null {
  const record = parseNetworkDispatchRecord(value);
  if (record === null) return null;
  if (record === 'invalid') return { mode: 'guarded', allowedGatewayIds: [] };
  return { mode: record.mode, allowedGatewayIds: record.allowedGatewayIds };
}

export async function verifyDiscoveryResult(input: {
  orgId: string; siteId: string; profileId: string | null;
  attempt: Attempt | null;
  verifiedNetwork: unknown;
}): Promise<VerifyOutcome> {
  const { orgId, siteId, profileId, attempt } = input;

  if (!attempt || attempt.mode === 'unrestricted') {
    const { gated } = await loadSiteGateState(orgId, siteId);
    return gated ? unverified('site_gated_since_unrestricted_dispatch', input) : { ok: true, networkId: null };
  }

  const parsed = verifiedNetworkSchema.safeParse(input.verifiedNetwork);
  if (!parsed.success) return unverified('no_valid_verified_network', input);
  const uploaded = parsed.data;
  // The allowed fingerprints come from the attempt the server recorded, never from the upload.
  if (!attempt.allowedGatewayIds.includes(uploaded.gatewayId)) return unverified('gateway_not_in_attempt', input);

  let profile: GateProfile | null = null;
  if (profileId) {
    profile = await loadGateProfile(profileId);
    if (!profile) return unverified('profile_missing', input);
  }
  const decision = await evaluateDiscoveryGate(
    profile ? { orgId, siteId, profile, job: { orgId, siteId } } : { orgId, siteId, profile: null },
  );
  if (decision.kind !== 'guarded') return unverified(`gate_now_${decision.kind}`, input);

  const current = decision.allowed.find((g) =>
    g.gatewayId === uploaded.gatewayId && g.address === uploaded.gatewayAddress && g.mac === uploaded.gatewayMac);
  return current ? { ok: true, networkId: current.networkId } : unverified('fingerprint_not_allowed_now', input);
}
