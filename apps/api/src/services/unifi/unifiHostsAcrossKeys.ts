/**
 * The live host and site list across every enabled key of a cloud connection
 * (#11808 W2), for the mapping UI (`GET /unifi/hosts`) and the AI `hosts` view.
 *
 * The caller must hold no DB context: this makes UniFi HTTP calls. Keys are
 * used to build clients only; nothing returned here carries a key.
 */
import { createUnifiClient } from './unifiClient';
import type { UnifiSyncKey } from './unifiKeyService';
import { mergeKeyReads, readKeys } from './unifiKeyMerge';
import { buildMappingHostList, type MappingHostList, type MappingHostRow } from './unifiMappingHosts';

export type MappingHostRowWithKeys = MappingHostRow & {
  keyIds: string[];
  sites: Array<MappingHostRow['sites'][number] & { keyIds: string[] }>;
};

export interface HostsKeyOutcome {
  id: string;
  label: string;
  ok: boolean;
  /** The failure's own message; callers decide whether to show it (the AI view never does). */
  error?: string;
  authFailure: boolean;
  httpStatus: number | null;
}

export interface HostsAcrossKeys {
  hosts: MappingHostRowWithKeys[];
  omitted: MappingHostList['omitted'];
  keys: HostsKeyOutcome[];
  /** false when any key failed: the list may be missing what that key sees. */
  complete: boolean;
}

/**
 * Reads hosts and sites with every key (`mapping` mode), merges them, and tags
 * each host and site with the keys that list it. When every key fails, the
 * first key's own error is thrown, so a caller keeps its single-key error path.
 */
export async function readHostsAcrossKeys(keys: UnifiSyncKey[], baseUrl: string): Promise<HostsAcrossKeys> {
  const reads = await readKeys(
    keys.map((key) => ({
      id: key.id,
      label: key.label,
      client: key.apiKey === null ? null : createUnifiClient({ baseUrl, apiKey: key.apiKey }),
      decryptError: key.apiKey === null ? key.decryptError : undefined,
    })),
    { mode: 'mapping' },
  );
  const firstFailure = reads.find((r) => !r.ok);
  if (firstFailure && !firstFailure.ok && reads.every((r) => !r.ok)) {
    throw firstFailure.cause instanceof Error ? firstFailure.cause : new Error(firstFailure.error);
  }
  const merged = mergeKeyReads(reads);
  const list = buildMappingHostList(merged.hosts, merged.siteRead?.sites ?? [], {
    hostKeyIds: merged.hostKeyIds,
    siteKeyIds: merged.siteKeyIds,
  });
  return {
    hosts: list.hosts as MappingHostRowWithKeys[],
    omitted: list.omitted,
    keys: reads.map((r) => (r.ok
      ? { id: r.keyId, label: r.label, ok: true, authFailure: false, httpStatus: null }
      : { id: r.keyId, label: r.label, ok: false, error: r.error, authFailure: r.authFailure, httpStatus: r.httpStatus })),
    complete: reads.every((r) => r.ok),
  };
}
