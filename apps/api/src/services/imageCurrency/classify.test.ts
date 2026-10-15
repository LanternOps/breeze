import { describe, expect, it } from 'vitest';
import { cacheEntryAnswers, classifyGroup, statusFromLookup, type DueImageGroup } from './classify';
import { MEDIA_TYPE_DOCKER_MANIFEST, MEDIA_TYPE_OCI_INDEX } from './registryClient';

const D = (c: string) => `sha256:${c.repeat(64)}`;
const group = (over: Partial<DueImageGroup> = {}): DueImageGroup => ({
  orgId: 'org-1',
  imageRepository: 'docker.io/library/nginx',
  imageTag: '1.27',
  imageDigest: D('a'),
  pinned: false,
  digestUnknown: false,
  ...over,
});

describe('classifyGroup (no network decisions, spec §9.1)', () => {
  it('a digest-pinned reference is pinned, whatever else it carries', () => {
    expect(classifyGroup(group({ pinned: true, imageTag: null }))).toEqual({ kind: 'status', status: 'pinned' });
    expect(classifyGroup(group({ pinned: true, imageDigest: null, digestUnknown: true }))).toEqual({
      kind: 'status',
      status: 'pinned',
    });
  });

  it('no repo digest from a complete snapshot is local', () => {
    expect(classifyGroup(group({ imageDigest: null }))).toEqual({ kind: 'status', status: 'local' });
  });

  it('no repo digest from an incomplete snapshot is left alone (digest unknown, not local)', () => {
    expect(classifyGroup(group({ imageDigest: null, digestUnknown: true }))).toEqual({ kind: 'skip' });
  });

  it('no repository or no tag has nothing to compare: local', () => {
    expect(classifyGroup(group({ imageRepository: null }))).toEqual({ kind: 'status', status: 'local' });
    expect(classifyGroup(group({ imageTag: null }))).toEqual({ kind: 'status', status: 'local' });
  });

  it('a registry off the allowlist is unsupported_registry (no lookup)', () => {
    expect(classifyGroup(group({ imageRepository: 'registry.example.com/team/app' }))).toEqual({
      kind: 'status',
      status: 'unsupported_registry',
    });
    expect(classifyGroup(group({ imageRepository: 'localhost:5000/app' }))).toEqual({
      kind: 'status',
      status: 'unsupported_registry',
    });
  });

  it('an allowlisted registry needs a lookup keyed by canonical registry/path/tag', () => {
    expect(classifyGroup(group())).toEqual({
      kind: 'lookup',
      key: { registry: 'docker.io', path: 'library/nginx', tag: '1.27' },
    });
  });
});

describe('statusFromLookup', () => {
  const ok = (digest: string, mediaType: string | null, platformDigests: string[] | null = null) =>
    ({ kind: 'ok', digest, mediaType, platformDigests }) as const;

  it('equal digest is current', () => {
    expect(statusFromLookup(D('a'), ok(D('a'), MEDIA_TYPE_OCI_INDEX))).toEqual({ status: 'current', upstreamDigest: D('a') });
  });
  it('a platform manifest inside the current index is current, not behind', () => {
    expect(statusFromLookup(D('b'), ok(D('a'), MEDIA_TYPE_OCI_INDEX, [D('b'), D('c')]))).toEqual({
      status: 'current',
      upstreamDigest: D('a'),
    });
  });
  it('a different digest, not in the index, is behind', () => {
    expect(statusFromLookup(D('z'), ok(D('a'), MEDIA_TYPE_OCI_INDEX, [D('b')]))).toEqual({
      status: 'behind',
      upstreamDigest: D('a'),
    });
    expect(statusFromLookup(D('z'), ok(D('a'), MEDIA_TYPE_DOCKER_MANIFEST))).toEqual({ status: 'behind', upstreamDigest: D('a') });
  });
  it('an index whose platform list was not fetched cannot decide a mismatch (null)', () => {
    expect(statusFromLookup(D('z'), ok(D('a'), MEDIA_TYPE_OCI_INDEX, null))).toBeNull();
  });
  it('maps the non-ok results; skipped writes nothing', () => {
    expect(statusFromLookup(D('a'), { kind: 'private' })).toEqual({ status: 'private', upstreamDigest: null });
    expect(statusFromLookup(D('a'), { kind: 'not_found' })).toEqual({ status: 'not_found', upstreamDigest: null });
    expect(statusFromLookup(D('a'), { kind: 'error', reason: 'x' })).toEqual({ status: 'error', upstreamDigest: null });
    expect(statusFromLookup(D('a'), { kind: 'unsupported_registry' })).toEqual({
      status: 'unsupported_registry',
      upstreamDigest: null,
    });
    expect(statusFromLookup(D('a'), { kind: 'skipped', reason: 'registry_throttled' })).toBeNull();
  });
});

describe('cacheEntryAnswers', () => {
  const entry = (digest: string, mediaType: string | null, platformDigests: string[] | null) => ({ digest, mediaType, platformDigests });
  it('answers when every local digest matches, or the index list is known, or it is a single manifest', () => {
    expect(cacheEntryAnswers(entry(D('a'), MEDIA_TYPE_OCI_INDEX, null), [D('a')])).toBe(true);
    expect(cacheEntryAnswers(entry(D('a'), MEDIA_TYPE_OCI_INDEX, [D('b')]), [D('z')])).toBe(true);
    expect(cacheEntryAnswers(entry(D('a'), MEDIA_TYPE_DOCKER_MANIFEST, null), [D('z')])).toBe(true);
  });
  it('does not answer a mismatch against an index whose platform list was never fetched', () => {
    expect(cacheEntryAnswers(entry(D('a'), MEDIA_TYPE_OCI_INDEX, null), [D('a'), D('z')])).toBe(false);
  });
});
