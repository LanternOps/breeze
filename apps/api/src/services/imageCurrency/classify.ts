/**
 * Pure decisions for the image-currency pass (spec §9.1). No I/O: what a due
 * group of container rows needs (a fixed status, a registry lookup, or
 * nothing yet), and what a lookup result means for one local digest.
 */
import type { WorkloadUpstreamStatus } from '@breeze/shared';
import {
  isIndexMediaType,
  registryRequestHost,
  splitImageRepository,
  type RegistryLookupResult,
} from './registryClient';

/** One org's container rows sharing an image identity (the worker's unit of work and of writing). */
export interface DueImageGroup {
  orgId: string;
  imageRepository: string | null;
  imageTag: string | null;
  imageDigest: string | null;
  /** The reference was created as `repo@sha256:…` (or `repo:tag@sha256:…`). */
  pinned: boolean;
  /** No digest because the runtime's last snapshot was incomplete: digest-unknown, not local. */
  digestUnknown: boolean;
}

export interface LookupKey {
  /** Agent-canonical registry (`docker.io`), also the cache key's registry. */
  registry: string;
  path: string;
  tag: string;
}

export type GroupDecision =
  | { kind: 'status'; status: WorkloadUpstreamStatus }
  | { kind: 'lookup'; key: LookupKey }
  /** Leave the rows as they are (still due); decided by a later pass. */
  | { kind: 'skip' };

export const lookupKeyString = (key: LookupKey): string => `${key.registry}/${key.path}:${key.tag}`;

/** Order matters: pinned → local/unknown → unsupported → lookup. Never touches the network. */
export function classifyGroup(group: DueImageGroup): GroupDecision {
  if (group.pinned) return { kind: 'status', status: 'pinned' };
  if (!group.imageDigest) return group.digestUnknown ? { kind: 'skip' } : { kind: 'status', status: 'local' };
  // A repo digest but no repository/tag reference (e.g. the tag moved away and
  // nothing names the image any more): there is no upstream tag to compare.
  if (!group.imageRepository || !group.imageTag) return { kind: 'status', status: 'local' };
  const parts = splitImageRepository(group.imageRepository);
  if (!parts || !registryRequestHost(parts.registry)) return { kind: 'status', status: 'unsupported_registry' };
  return { kind: 'lookup', key: { registry: parts.registry, path: parts.path, tag: group.imageTag } };
}

export interface UpstreamWrite {
  status: WorkloadUpstreamStatus;
  upstreamDigest: string | null;
}

/** What a lookup means for one local digest; null = write nothing (rows stay due). */
export function statusFromLookup(localDigest: string, result: RegistryLookupResult): UpstreamWrite | null {
  switch (result.kind) {
    case 'ok': {
      if (result.digest === localDigest) return { status: 'current', upstreamDigest: result.digest };
      if (result.platformDigests?.includes(localDigest)) return { status: 'current', upstreamDigest: result.digest };
      // An index we never listed could still contain the local platform
      // manifest: calling that "behind" is the false positive §9.2 exists to avoid.
      if (isIndexMediaType(result.mediaType) && result.platformDigests === null) return null;
      return { status: 'behind', upstreamDigest: result.digest };
    }
    case 'private':
    case 'not_found':
    case 'unsupported_registry':
      return { status: result.kind, upstreamDigest: null };
    case 'error':
      return { status: 'error', upstreamDigest: null };
    case 'skipped':
      return null;
  }
}

export interface CachedUpstream {
  digest: string;
  mediaType: string | null;
  platformDigests: string[] | null;
}

/** Can this (unexpired) cache entry decide every local digest without a new lookup? */
export function cacheEntryAnswers(entry: CachedUpstream, localDigests: readonly string[]): boolean {
  if (localDigests.every((d) => d === entry.digest)) return true;
  return !isIndexMediaType(entry.mediaType) || entry.platformDigests !== null;
}
