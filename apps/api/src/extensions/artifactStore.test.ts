import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from './artifactStore';

/**
 * Unit tests run on the no-DB unit runner and never touch the network. Every
 * case here exercises the content-addressed store through `file:` URIs plus the
 * synchronous scheme allowlist, so no https server or large fixture is needed:
 *   - idempotency (brief verbatim): same digest → same immutable path, no rewrite
 *   - scheme allowlist: anything but file:/https: is rejected up front
 *   - digest verification: a pinned digest that doesn't match the bytes throws
 *   - streamed byte cap: enforced through the SAME stream-to-temp path as https,
 *     so an injectable low cap proves the guard without a 128 MiB download.
 */

function digestOf(data: Buffer): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

describe('ArtifactStore', () => {
  let tempDir: string;
  let rootDir: string;
  let fixturePath: string;
  const fixtureBytes = Buffer.from('breeze extension artifact fixture payload', 'utf8');

  function fileSelection(p: string, digest?: string) {
    return { uri: pathToFileURL(p).href, ...(digest ? { digest } : {}) };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'artifact-src-'));
    rootDir = mkdtempSync(path.join(tmpdir(), 'artifact-root-'));
    fixturePath = path.join(tempDir, 'bundle.breeze-ext');
    writeFileSync(fixturePath, fixtureBytes);
  });

  afterEach(() => {
    // mkdtemp dirs are throwaway; leave OS tmp reaping to handle them.
  });

  it('stores by digest and never replaces an existing immutable artifact', async () => {
    const store = new ArtifactStore(rootDir);
    const first = await store.acquire(fileSelection(fixturePath));
    const second = await store.acquire(fileSelection(fixturePath));
    expect(second).toBe(first);
    expect(first).toMatch(/sha256-[0-9a-f]{64}\.breeze-ext$/);
  });

  it('verifies a pinned digest and returns the same path when it matches', async () => {
    const store = new ArtifactStore(rootDir);
    const good = await store.acquire(fileSelection(fixturePath, digestOf(fixtureBytes)));
    expect(good).toMatch(/sha256-[0-9a-f]{64}\.breeze-ext$/);
    // Second acquire with the pinned digest must return the existing file
    // without re-copying it.
    const again = await store.acquire(fileSelection(fixturePath, digestOf(fixtureBytes)));
    expect(again).toBe(good);
  });

  it('rejects a URI whose scheme is not file: or https:', async () => {
    const store = new ArtifactStore(rootDir);
    await expect(store.acquire({ uri: 'http://example.com/x.breeze-ext' })).rejects.toThrow(/scheme/i);
    await expect(store.acquire({ uri: 'ftp://example.com/x.breeze-ext' })).rejects.toThrow(/scheme/i);
    await expect(store.acquire({ uri: 's3://bucket/x.breeze-ext' })).rejects.toThrow(/scheme/i);
  });

  it('rejects an artifact whose bytes do not match the pinned digest', async () => {
    const store = new ArtifactStore(rootDir);
    const wrongDigest = `sha256:${'0'.repeat(64)}`;
    await expect(store.acquire(fileSelection(fixturePath, wrongDigest))).rejects.toThrow(/digest/i);
    // The failed acquire must not leave a committed artifact behind.
    const committed = readdirSync(rootDir).filter((n) => n.endsWith('.breeze-ext'));
    expect(committed).toHaveLength(0);
  });

  it('aborts when the streamed artifact exceeds the byte cap', async () => {
    const store = new ArtifactStore(rootDir, { maxArtifactBytes: 8 });
    await expect(store.acquire(fileSelection(fixturePath))).rejects.toThrow(/(exceed|limit|cap)/i);
    const committed = readdirSync(rootDir).filter((n) => n.endsWith('.breeze-ext'));
    expect(committed).toHaveLength(0);
  });
});
