/**
 * Learned networks E11 (#12369, spec §8.3): saved SNMP secrets follow the fingerprints they were entered for.
 * W03a reads the grants; W03b adds the save-time rules to this file.
 */
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { ExpectedGateway } from '@breeze/shared';
import { db } from '../../db';
import { discoveryProfileSnmpGrants, learnedNetworkGateways, learnedNetworks } from '../../db/schema';
import { SNMP_SECRET_FIELD_NAMES, isMaskedSnmpSecret, storedProfileHoldsSnmpSecrets } from '../snmpSecrets';

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
