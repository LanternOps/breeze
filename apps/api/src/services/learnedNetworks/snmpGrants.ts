/**
 * Learned networks E11 (#12369, spec §8.3): saved SNMP secrets follow the fingerprints they were entered for.
 * W03a reads the grants; W03b adds the secret-state model and the save-time rules (rules 1, 2 and 4).
 */
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { ExpectedGateway } from '@breeze/shared';
import { assertInTransaction, db } from '../../db';
import { discoveryProfileSnmpGrants, discoveryProfiles, learnedNetworkGateways, learnedNetworks } from '../../db/schema';
import { SNMP_SECRET_FIELD_NAMES, isMaskedSnmpSecret, storedProfileHoldsSnmpSecrets } from '../snmpSecrets';
import { loadNetworkGateways, loadSiteGateState } from './siteNetworks';

// ---------------------------------------------------------------------------------------------------------------
// The secret-state model (pure). Nothing here encrypts or decrypts.
// ---------------------------------------------------------------------------------------------------------------

/** What a profile stores. Communities: discovery_profiles.snmp_communities (ciphertexts, positional).
 *  Credentials: discovery_profiles.snmp_credentials (jsonb; secret leaves are ciphertexts under
 *  SNMP_SECRET_FIELD_NAMES keys, at any depth, possibly in arrays). A secret is HELD when its
 *  stored value is a non-empty string. */
export type SnmpSecretState = { communities: readonly string[]; credentials: unknown };

/** The request body. undefined = field omitted (column untouched, every stored secret in it retained).
 *  credentials null = cleared. Entry/leaf semantics are exactly mergeEncryptSnmpCommunities and
 *  mergeEncryptSnmpCredentials: a masked entry retains the stored value at the same index/key (or
 *  nothing, if none is stored there); a non-empty plaintext is fresh; '' is dropped; a leaf key
 *  omitted inside a supplied credentials object is dropped, not retained. */
export type SnmpSecretPatch = { communities?: readonly string[]; credentials?: unknown };

export const EMPTY_SNMP_SECRET_STATE: SnmpSecretState = Object.freeze({ communities: Object.freeze([]), credentials: null });

/** One definition of "holds secrets": the gate's `hasSavedSnmpSecrets` uses the same function. */
export function profileWillHoldSnmpSecrets(next: SnmpSecretState): boolean {
  return storedProfileHoldsSnmpSecrets({ snmpCommunities: [...next.communities], snmpCredentials: next.credentials });
}

type SecretTally = { fresh: number; retained: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const isHeld = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

/** A stored value kept as is under a secret key: each held string in it is a retained secret. */
function tallyStoredSecretValue(value: unknown, tally: SecretTally): void {
  if (Array.isArray(value)) {
    for (const item of value) if (isHeld(item)) tally.retained += 1;
  } else if (isHeld(value)) {
    tally.retained += 1;
  }
}

/** Every held secret leaf of a stored credentials value (the column is untouched by the save). */
function tallyStoredCredentials(value: unknown, tally: SecretTally): void {
  if (Array.isArray(value)) { for (const entry of value) tallyStoredCredentials(entry, tally); return; }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (SNMP_SECRET_FIELD_NAMES.has(key)) tallyStoredSecretValue(entry, tally);
    else tallyStoredCredentials(entry, tally);
  }
}

/** One incoming value under a secret key, against what is stored at the same key or index. */
function tallyIncomingSecretItem(item: unknown, stored: unknown, tally: SecretTally): void {
  if (isMaskedSnmpSecret(item)) { tallyStoredSecretValue(stored, tally); return; }
  // A non-masked string: '' is dropped, anything else is fresh plaintext. A non-string is stored raw and is
  // never held.
  if (isHeld(item)) tally.fresh += 1;
}

/** Mirrors mergeEncryptSnmpCredentials shape for shape: what the column holds after the save, split into
 *  secrets that arrived fresh and secrets retained from `existing`. */
function tallyIncomingCredentials(update: unknown, existing: unknown, tally: SecretTally): void {
  if (Array.isArray(update)) {
    update.forEach((entry, index) => tallyIncomingCredentials(entry, Array.isArray(existing) ? existing[index] : undefined, tally));
    return;
  }
  if (!isRecord(update)) return;
  const existingRecord = isRecord(existing) ? existing : {};
  for (const [key, entry] of Object.entries(update)) {
    const existingEntry = existingRecord[key];
    if (SNMP_SECRET_FIELD_NAMES.has(key)) {
      if (Array.isArray(entry)) {
        const existingArray = Array.isArray(existingEntry) ? existingEntry : [];
        entry.forEach((item, index) => tallyIncomingSecretItem(item, existingArray[index], tally));
      } else {
        tallyIncomingSecretItem(entry, existingEntry, tally);
      }
    } else {
      tallyIncomingCredentials(entry, existingEntry, tally);
    }
  }
}

function tallySave(existing: SnmpSecretState, incoming: SnmpSecretPatch): SecretTally {
  const tally: SecretTally = { fresh: 0, retained: 0 };
  if (incoming.communities === undefined) {
    for (const value of existing.communities) if (isHeld(value)) tally.retained += 1;
  } else {
    incoming.communities.forEach((value, index) => tallyIncomingSecretItem(value, existing.communities[index], tally));
  }
  if (incoming.credentials === undefined) tallyStoredCredentials(existing.credentials, tally);
  else tallyIncomingCredentials(incoming.credentials, existing.credentials, tally);
  return tally;
}

/**
 * Spec 8.3 rule 1: every secret the profile will hold after the save arrived as fresh plaintext in this request,
 * across communities and credentials. False when the save leaves nothing held (it re-entered nothing). Its own
 * predicate: not `subnetChangeWouldRetainSnmpSecrets`, which answers a different question and returns early.
 */
export function isFullSnmpReentry(input: { existing: SnmpSecretState; incoming: SnmpSecretPatch }): boolean {
  const tally = tallySave(input.existing, input.incoming);
  return tally.fresh > 0 && tally.retained === 0;
}

/** Whether the request carries at least one fresh plaintext secret. */
export function snmpPatchSuppliesSecret(incoming: SnmpSecretPatch): boolean {
  return tallySave(EMPTY_SNMP_SECRET_STATE, incoming).fresh > 0;
}

/**
 * The profile's granted fingerprints that belong to a network assigned to this site (and to `networkId` when
 * set), by network id then gateway id. Caller holds the shared site lock.
 */
export async function loadUsableGrantGateways(input: {
  orgId: string; profileId: string; siteId: string; networkId: string | null;
}): Promise<ExpectedGateway[]> {
  const conditions: SQL[] = [
    eq(discoveryProfileSnmpGrants.orgId, input.orgId),
    eq(discoveryProfileSnmpGrants.profileId, input.profileId),
    eq(learnedNetworks.siteId, input.siteId),
  ];
  if (input.networkId) conditions.push(eq(learnedNetworks.id, input.networkId));
  return db
    .select({
      networkId: learnedNetworks.id,
      gatewayId: learnedNetworkGateways.id,
      address: sql<string>`host(${learnedNetworkGateways.gatewayAddress})`,
      mac: sql<string>`lower(${learnedNetworkGateways.gatewayMac}::text)`,
    })
    .from(discoveryProfileSnmpGrants)
    .innerJoin(learnedNetworkGateways, and(
      eq(learnedNetworkGateways.id, discoveryProfileSnmpGrants.gatewayId),
      eq(learnedNetworkGateways.orgId, discoveryProfileSnmpGrants.orgId),
    ))
    .innerJoin(learnedNetworks, and(
      eq(learnedNetworks.id, learnedNetworkGateways.networkId),
      eq(learnedNetworks.orgId, learnedNetworkGateways.orgId),
    ))
    .where(and(...conditions))
    .orderBy(asc(learnedNetworks.id), asc(learnedNetworkGateways.id));
}

// ---------------------------------------------------------------------------------------------------------------
// Save-time rules (spec 8.3). Every writer uses the ambient `db` inside the caller's held context and opens no
// savepoint. The caller holds the shared site lock and, on an update, the profile row lock (`lockProfileForSave`).
// ---------------------------------------------------------------------------------------------------------------

/** Rule 1's fresh set, from the profile as saved: not gated -> unrestricted with none; gated -> bound with the
 *  fingerprints of the networks assigned to the site (only `networkId`'s when set; none when it is not one of them). */
export async function freshGrantSet(input: { orgId: string; siteId: string; networkId: string | null }):
  Promise<{ mode: 'unrestricted' | 'bound'; gatewayIds: string[] }> {
  assertInTransaction('freshGrantSet');
  const state = await loadSiteGateState(input.orgId, input.siteId);
  if (!state.gated) return { mode: 'unrestricted', gatewayIds: [] };
  const networkIds = input.networkId === null
    ? state.assignedNetworkIds
    : state.assignedNetworkIds.filter((id) => id === input.networkId);
  const gateways = await loadNetworkGateways(input.orgId, networkIds);
  return { mode: 'bound', gatewayIds: gateways.map((g) => g.gatewayId).sort() };
}

async function insertGrants(orgId: string, profileId: string, gatewayIds: readonly string[], actorUserId: string): Promise<void> {
  if (gatewayIds.length === 0) return;
  const grantedAt = new Date();
  await db.insert(discoveryProfileSnmpGrants)
    .values(gatewayIds.map((gatewayId) => ({ orgId, profileId, gatewayId, grantedBy: actorUserId, grantedAt })))
    .onConflictDoNothing({ target: [discoveryProfileSnmpGrants.profileId, discoveryProfileSnmpGrants.gatewayId] });
}

async function deleteAllGrants(orgId: string, profileId: string): Promise<void> {
  await db.delete(discoveryProfileSnmpGrants).where(and(
    eq(discoveryProfileSnmpGrants.orgId, orgId),
    eq(discoveryProfileSnmpGrants.profileId, profileId),
  ));
}

/**
 * Called by the profile create and update handlers after the profile row is written, in the same transaction.
 * - Holds no secret after the save: no write (it can only gain secrets through a full re-entry, which replaces).
 * - Rule 1 (full re-entry): grants replaced by `freshGrantSet`, mode set to its mode.
 * - Otherwise (rule 4, or a save that supplies no secret): nothing added, mode unchanged, grants shrunk to those
 *   effective for the profile as saved (a fingerprint of a network on its site, and of its network when set).
 *
 * A full re-entry that supplies no secret is a caller bug. It is logged and handled as rule 4 (shrink, never add)
 * rather than thrown: the profile row is already written, and a non-DB throw from a route handler does not roll the
 * request transaction back, so throwing here would commit the new secrets beside grants that were never shrunk.
 */
export async function applySnmpGrantRulesOnSave(input: {
  orgId: string; profileId: string; siteId: string; networkId: string | null;
  fullReentry: boolean; suppliedAnySecret: boolean; willHoldSecrets: boolean; actorUserId: string;
}): Promise<void> {
  assertInTransaction('applySnmpGrantRulesOnSave');
  if (!input.willHoldSecrets) return;

  const fullReentry = input.fullReentry && input.suppliedAnySecret;
  if (input.fullReentry && !input.suppliedAnySecret) {
    console.error('[learnedNetworks] applySnmpGrantRulesOnSave: full re-entry without a supplied secret; shrinking instead', {
      profileId: input.profileId,
    });
  }

  if (fullReentry) {
    const fresh = await freshGrantSet({ orgId: input.orgId, siteId: input.siteId, networkId: input.networkId });
    await deleteAllGrants(input.orgId, input.profileId);
    await insertGrants(input.orgId, input.profileId, fresh.gatewayIds, input.actorUserId);
    await db.update(discoveryProfiles)
      .set({ snmpGrantMode: fresh.mode })
      .where(and(eq(discoveryProfiles.id, input.profileId), eq(discoveryProfiles.orgId, input.orgId)));
    return;
  }

  await db.execute(sql`
    DELETE FROM discovery_profile_snmp_grants g
     WHERE g.org_id = ${input.orgId}::uuid AND g.profile_id = ${input.profileId}::uuid
       AND NOT EXISTS (
         SELECT 1 FROM learned_network_gateways lg
           JOIN learned_networks ln ON ln.id = lg.network_id AND ln.org_id = lg.org_id
          WHERE lg.id = g.gateway_id AND lg.org_id = g.org_id
            AND ln.site_id = ${input.siteId}::uuid
            AND (${input.networkId}::uuid IS NULL OR ln.id = ${input.networkId}::uuid))`);
}

export const PROFILE_NETWORK_NOT_ASSIGNABLE_MESSAGE = "Choose a network that is assigned to this profile's site.";

export class ProfileNetworkNotAssignableError extends Error {
  readonly code = 'NETWORK_NOT_ASSIGNABLE' as const;
  constructor(message: string = PROFILE_NETWORK_NOT_ASSIGNABLE_MESSAGE) {
    super(message);
    this.name = 'ProfileNetworkNotAssignableError';
  }
}

/** Spec 8.3: `network_id` may only point at a network assigned to the profile's site (as saved). The query cannot
 *  fail on a well-formed id, so the throw is an application error and the caller's catch needs no savepoint. */
export async function assertProfileNetworkAssignable(input: { orgId: string; siteId: string; networkId: string | null }): Promise<void> {
  if (input.networkId === null) return;
  assertInTransaction('assertProfileNetworkAssignable');
  const [row] = await db
    .select({ id: learnedNetworks.id })
    .from(learnedNetworks)
    .where(and(
      eq(learnedNetworks.id, input.networkId),
      eq(learnedNetworks.orgId, input.orgId),
      eq(learnedNetworks.siteId, input.siteId),
    ))
    .limit(1);
  if (!row) throw new ProfileNetworkNotAssignableError();
}

/**
 * Rule 2, on every false -> true transition of a site's flag (W03c calls it). The caller holds the EXCLUSIVE site
 * lock and has already set the flag and assigned `networkId`. Each of the site's `unrestricted` profiles that holds
 * saved secrets becomes `bound`, with grants for `networkId`'s fingerprints when its `network_id` is null or equal to
 * `networkId` (a profile pointed at another network gets none). Profiles without secrets, and `bound` profiles, are
 * untouched. Returns the number of profiles changed.
 */
export async function bindUnrestrictedProfilesOnGating(input: {
  orgId: string; siteId: string; networkId: string; actorUserId: string;
}): Promise<number> {
  assertInTransaction('bindUnrestrictedProfilesOnGating');
  const candidates = await db
    .select({
      id: discoveryProfiles.id,
      networkId: discoveryProfiles.networkId,
      snmpCommunities: discoveryProfiles.snmpCommunities,
      snmpCredentials: discoveryProfiles.snmpCredentials,
    })
    .from(discoveryProfiles)
    .where(and(
      eq(discoveryProfiles.orgId, input.orgId),
      eq(discoveryProfiles.siteId, input.siteId),
      eq(discoveryProfiles.snmpGrantMode, 'unrestricted'),
    ))
    .orderBy(asc(discoveryProfiles.id))
    .for('update');
  const credentialed = candidates.filter((p) => profileWillHoldSnmpSecrets({
    communities: p.snmpCommunities ?? [], credentials: p.snmpCredentials,
  }));
  if (credentialed.length === 0) return 0;

  const gatewayIds = (await loadNetworkGateways(input.orgId, [input.networkId])).map((g) => g.gatewayId);
  for (const profile of credentialed) {
    await db.update(discoveryProfiles)
      .set({ snmpGrantMode: 'bound' })
      .where(and(eq(discoveryProfiles.id, profile.id), eq(discoveryProfiles.orgId, input.orgId)));
    // An unrestricted profile holds no grants (rule 1 on a site that is not gated replaces them with none); clear any
    // so the bound set is exactly what this rule grants.
    await deleteAllGrants(input.orgId, profile.id);
    if (profile.networkId === null || profile.networkId === input.networkId) {
      await insertGrants(input.orgId, profile.id, gatewayIds, input.actorUserId);
    }
  }
  return credentialed.length;
}
