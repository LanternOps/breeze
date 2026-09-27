import { decryptForColumn, decryptSecret, encryptSecret } from './secretCrypto';
import { destinationSetGainedMembers } from './credentialOriginBinding';

export const MASKED_SNMP_SECRET = '********';

const SECRET_FIELD_NAMES = new Set([
  'community',
  'communities',
  'password',
  'authPassword',
  'privPassword',
  'authPassphrase',
  'privacyPassphrase',
  'secret',
  'token',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isMaskedSnmpSecret(value: unknown): boolean {
  return typeof value === 'string' && /^\*{3,}$/.test(value.trim());
}

export function encryptSnmpSecret(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  if (isMaskedSnmpSecret(value)) return null;
  return encryptSecret(value);
}

// AAD pair used when reading snmp_devices.<column> ciphertext. The wrapper
// takes the column name so the same helper covers community / auth_password /
// priv_password without callers duplicating the AAD string. The fallback to
// the unbound decryptSecret path is for snmp credentials nested inside
// discovery_profiles.snmp_credentials JSON, where the registry binds at the
// JSON-column level (passed via aad parameter).
export function decryptSnmpSecret(value: string | null | undefined, aad?: { table: string; column: string }): string | null {
  if (aad) {
    return decryptForColumn(aad.table, aad.column, value);
  }
  return decryptSecret(value);
}

export function maskSnmpSecret(value: unknown): string | null {
  return value ? MASKED_SNMP_SECRET : null;
}

export function encryptSnmpCommunities(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  return values.map((value) => encryptSnmpSecret(value)).filter((value): value is string => Boolean(value));
}

export function mergeEncryptSnmpCommunities(values: string[] | undefined, existing: string[] | null | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  return values
    .map((value, index) => isMaskedSnmpSecret(value) ? existing?.[index] ?? null : encryptSnmpSecret(value))
    .filter((value): value is string => Boolean(value));
}

export function decryptSnmpCommunities(values: string[] | null | undefined): string[] {
  // Communities live in discovery_profiles.snmp_communities (text[]).
  return (values ?? [])
    .map((value) => decryptSnmpSecret(value, { table: 'discovery_profiles', column: 'snmp_communities' }))
    .filter((value): value is string => Boolean(value));
}

export function maskSnmpCommunities(values: string[] | null | undefined): string[] {
  return (values ?? []).map(() => MASKED_SNMP_SECRET);
}

export function encryptSnmpCredentials(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => encryptSnmpCredentials(entry));
  }
  if (!isRecord(value)) return value;

  const encrypted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_FIELD_NAMES.has(key)) {
      if (Array.isArray(entry)) encrypted[key] = entry.map((item) => typeof item === 'string' ? encryptSnmpSecret(item) : item);
      else encrypted[key] = typeof entry === 'string' ? encryptSnmpSecret(entry) : entry;
    } else {
      encrypted[key] = encryptSnmpCredentials(entry);
    }
  }
  return encrypted;
}

export function mergeEncryptSnmpCredentials(update: unknown, existing: unknown): unknown {
  if (Array.isArray(update)) return update.map((entry, index) => mergeEncryptSnmpCredentials(entry, Array.isArray(existing) ? existing[index] : undefined));
  if (!isRecord(update)) return update;

  const existingRecord = isRecord(existing) ? existing : {};
  const merged: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(update)) {
    const existingEntry = existingRecord[key];
    if (SECRET_FIELD_NAMES.has(key)) {
      if (Array.isArray(entry)) {
        const existingArray = Array.isArray(existingEntry) ? existingEntry : [];
        merged[key] = entry.map((item, index) => isMaskedSnmpSecret(item) ? existingArray[index] ?? null : (typeof item === 'string' ? encryptSnmpSecret(item) : item));
      } else {
        merged[key] = isMaskedSnmpSecret(entry) ? existingEntry ?? null : (typeof entry === 'string' ? encryptSnmpSecret(entry) : entry);
      }
    } else {
      merged[key] = mergeEncryptSnmpCredentials(entry, existingEntry);
    }
  }
  return merged;
}

export function decryptSnmpCredentials(value: unknown): unknown {
  // Credentials are nested inside discovery_profiles.snmp_credentials (JSON).
  // The registry walker uses the column-level AAD, so we match it here.
  const credAad = { table: 'discovery_profiles', column: 'snmp_credentials' } as const;
  if (Array.isArray(value)) return value.map((entry) => decryptSnmpCredentials(entry));
  if (!isRecord(value)) return value;

  const decrypted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_FIELD_NAMES.has(key)) {
      if (Array.isArray(entry)) decrypted[key] = entry.map((item) => typeof item === 'string' ? decryptSnmpSecret(item, credAad) : item);
      else decrypted[key] = typeof entry === 'string' ? decryptSnmpSecret(entry, credAad) : entry;
    } else {
      decrypted[key] = decryptSnmpCredentials(entry);
    }
  }
  return decrypted;
}

export function maskSnmpCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => maskSnmpCredentials(entry));
  if (!isRecord(value)) return value;

  const masked: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_FIELD_NAMES.has(key)) {
      if (Array.isArray(entry)) masked[key] = entry.map((item) => item ? MASKED_SNMP_SECRET : item);
      else masked[key] = entry ? MASKED_SNMP_SECRET : entry;
    } else {
      masked[key] = maskSnmpCredentials(entry);
    }
  }
  return masked;
}

function collectSecretLeaves(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(collectSecretLeaves);
  if (!isRecord(value)) return [];
  const leaves: unknown[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_FIELD_NAMES.has(key)) {
      if (Array.isArray(entry)) leaves.push(...entry);
      else leaves.push(entry);
    } else {
      leaves.push(...collectSecretLeaves(entry));
    }
  }
  return leaves;
}

/**
 * Same origin-binding contract as credentialOriginBinding.ts, applied to a discovery profile's
 * effective probe destination instead of a single HTTP origin. A masked or
 * simply omitted `snmpCommunities`/`snmpCredentials` field must not carry the
 * org's live SNMP secrets forward when the destination changes in any of
 * three ways this route allows in one PATCH:
 *
 *  - `subnets` WIDENS (an added or changed subnet is a host the caller has
 *    never proven it should receive those secrets on);
 *  - `excludeIps` NARROWS (removing — or clearing — a previously-excluded
 *    entry un-walls a host that already sits inside an approved subnet, the
 *    same effective widening as adding a subnet, just from the other side);
 *  - `siteId` changes at all (the stored subnets are relative, private-range
 *    strings with no site binding of their own; the site picks which
 *    physical LAN an agent probes them on, so ANY site move sends the same
 *    secrets to a different network, not just a widened one).
 *
 * `destinationSetGainedMembers` treats a subnets update that only removes
 * entries as unchanged, since it sends the secret nowhere new; for
 * `excludeIps` the "gained" direction is inverted — the arguments are swapped
 * so a member present in the OLD exclusion list but missing from the NEW one
 * counts as a gain (a host the destination now reaches that it didn't
 * before), while adding more exclusions is a narrowing, mirroring the
 * `subnets` treatment.
 *
 * `mergeEncryptSnmpCommunities` retains a stored value positionally for any
 * masked array entry; leaving the field out of the patch entirely leaves the
 * stored column untouched. `mergeEncryptSnmpCredentials` retains a stored
 * leaf only for a KEY present in the patch and masked — a key the patch omits
 * is dropped, not retained, so an omitted `snmpCredentials` field is unsafe
 * (the whole column is untouched) while an omitted leaf WITHIN a provided
 * object is not (that leaf clears). Both are covered below by comparing
 * "was a stored secret retained" against "column untouched or masked-echoed".
 */
export function subnetChangeWouldRetainSnmpSecrets(params: {
  existingSubnets: readonly string[] | null | undefined;
  nextSubnets: readonly string[] | undefined;
  existingExcludeIps: readonly string[] | null | undefined;
  nextExcludeIps: readonly string[] | undefined;
  siteChanged: boolean;
  existingCommunities: readonly string[] | null | undefined;
  nextCommunities: readonly string[] | undefined;
  existingCredentials: unknown;
  nextCredentials: unknown;
}): boolean {
  const {
    existingSubnets, nextSubnets, existingExcludeIps, nextExcludeIps, siteChanged,
    existingCommunities, nextCommunities, existingCredentials, nextCredentials,
  } = params;

  const subnetsWidened = nextSubnets !== undefined
    && destinationSetGainedMembers(existingSubnets ?? [], nextSubnets);
  const excludeIpsNarrowed = nextExcludeIps !== undefined
    && destinationSetGainedMembers(nextExcludeIps, existingExcludeIps ?? []);

  if (!subnetsWidened && !excludeIpsNarrowed && !siteChanged) return false;

  const hasStoredCommunities = (existingCommunities ?? []).some((value) => Boolean(value));
  const communitiesRetained = hasStoredCommunities
    && (nextCommunities === undefined || nextCommunities.some(isMaskedSnmpSecret));

  const hasStoredCredentials = collectSecretLeaves(existingCredentials).some((leaf) => typeof leaf === 'string' && leaf.length > 0);
  const credentialsRetained = hasStoredCredentials
    && (nextCredentials === undefined || collectSecretLeaves(nextCredentials).some((leaf) => isMaskedSnmpSecret(leaf)));

  return communitiesRetained || credentialsRetained;
}
