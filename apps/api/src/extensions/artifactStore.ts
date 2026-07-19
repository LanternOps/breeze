import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { get as httpsGet } from 'node:https';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

/**
 * Content-addressed, immutable on-disk store for verified extension artifacts.
 *
 * An artifact is fetched (from a `file:` or `https:` URI), its whole-artifact
 * sha256 is computed while streaming, and it is committed atomically to
 * `<root>/sha256-<hex>.breeze-ext`. The DIGEST is the only storage key — never a
 * version or extension name — so the same bytes always land at the same path and
 * an already-present artifact is returned untouched (immutable).
 *
 * Trust boundary notes:
 *   - Only `file:` and `https:` schemes are accepted; anything else is rejected
 *     before any I/O (this is the scheme allowlist the config layer defers to).
 *   - A pinned digest, when supplied, is verified against the streamed bytes; a
 *     mismatch throws and commits nothing.
 *   - A hard streamed byte cap (default 128 MiB) aborts a runaway download/copy
 *     before it can fill the disk. The temp file lives on the SAME filesystem as
 *     the final path so the commit is an atomic rename, never a cross-device copy.
 *
 * This store does NOT verify the signature/manifest — that is the bundle
 * verifier's job, run against the file this store returns.
 */

/** Default streamed byte cap for a single artifact (matches the archive limit). */
export const DEFAULT_MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;

const DIGEST_PREFIX = 'sha256:';

export interface ArtifactStoreOptions {
  /** Hard cap on streamed bytes before the fetch/copy is aborted. */
  maxArtifactBytes?: number;
}

/** The subset of an extension selection the store needs to fetch an artifact. */
export interface ArtifactSource {
  uri: string;
  /** Optional pinned `sha256:<hex>` digest to verify (and to short-circuit on). */
  digest?: string;
}

/**
 * Resolve the artifact-store root. Mirrors the `BREEZE_EXTENSIONS_DIR` idiom in
 * discovery.ts: env override wins, otherwise the plan's default. `/data/...`
 * stays the DEFAULT (env-overridable) rather than being hardcoded — a root-owned
 * `/data` on the shared volume was an EACCES trap (issue #1059).
 */
export function resolveArtifactStoreRoot(): string {
  const override = process.env.BREEZE_EXTENSIONS_ARTIFACTS_DIR;
  if (override) return path.resolve(override);
  return '/data/extensions/artifacts';
}

/** Convenience: a store rooted at the resolved default (env-overridable). */
export function createArtifactStore(options?: ArtifactStoreOptions): ArtifactStore {
  return new ArtifactStore(resolveArtifactStoreRoot(), options);
}

export class ArtifactStore {
  private readonly maxArtifactBytes: number;

  constructor(
    private readonly root: string,
    options: ArtifactStoreOptions = {},
  ) {
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  }

  /** Absolute path a given hex digest is (or would be) stored at. */
  private artifactPath(hex: string): string {
    return path.join(this.root, `sha256-${hex}.breeze-ext`);
  }

  /**
   * Fetch the artifact named by `source` into the store and return its immutable
   * on-disk path. Idempotent: acquiring the same bytes twice returns the same
   * path without re-fetching or rewriting.
   */
  async acquire(source: ArtifactSource): Promise<string> {
    // Validate the scheme BEFORE any I/O — this is the trust gate.
    const url = new URL(source.uri);
    if (url.protocol !== 'file:' && url.protocol !== 'https:') {
      throw new Error(`unsupported artifact URI scheme "${url.protocol}" (only file: and https: are allowed)`);
    }
    if (url.username !== '' || url.password !== '') {
      // Reject credentials embedded in the URI: they would be an unlogged secret
      // on the artifact source and have no legitimate use for a signed bundle.
      throw new Error('artifact URI must not embed credentials');
    }

    const pinnedHex = this.pinnedHex(source.digest);

    // Fast path: a pinned digest already present is immutable — return it and
    // skip the fetch entirely.
    if (pinnedHex) {
      const target = this.artifactPath(pinnedHex);
      if (await pathExists(target)) return target;
    }

    await mkdir(this.root, { recursive: true });

    // Stream to a same-filesystem temp file (inside root) while hashing.
    const tempPath = path.join(this.root, `.acquire-${randomToken()}.part`);
    let hex: string;
    try {
      const source$ = url.protocol === 'file:'
        ? createReadStream(fileURLToPath(url))
        : await openHttpsStream(url);
      hex = await this.streamToTemp(source$, tempPath);

      if (pinnedHex && pinnedHex !== hex) {
        throw new Error('artifact digest does not match the pinned sha256 digest');
      }

      const target = this.artifactPath(hex);
      // Content-addressed + immutable: identical bytes are already committed →
      // discard the temp copy and return the existing file untouched.
      if (await pathExists(target)) {
        await rm(tempPath, { force: true });
        return target;
      }
      await rename(tempPath, target);
      return target;
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  private pinnedHex(digest: string | undefined): string | null {
    if (!digest) return null;
    if (!digest.startsWith(DIGEST_PREFIX)) {
      throw new Error('pinned digest must be a "sha256:" prefixed hex digest');
    }
    const hex = digest.slice(DIGEST_PREFIX.length);
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      throw new Error('pinned digest must be "sha256:" followed by 64 lowercase hex characters');
    }
    return hex;
  }

  /**
   * Pump a source stream into `tempPath`, hashing as we go and aborting the
   * moment the cap is exceeded, then fsync for durability before the caller
   * renames it into place. Returns the whole-artifact sha256 hex.
   */
  private async streamToTemp(source: Readable, tempPath: string): Promise<string> {
    const hash = createHash('sha256');
    const maxBytes = this.maxArtifactBytes;
    let total = 0;

    const out = createWriteStream(tempPath, { flags: 'wx' });
    await pipeline(
      source,
      async function* enforceCap(chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          total += chunk.length;
          if (total > maxBytes) {
            throw new Error(`artifact exceeds the ${maxBytes}-byte streamed size limit`);
          }
          hash.update(chunk);
          yield chunk;
        }
      },
      out,
    );

    // fsync the committed bytes so a crash between rename and the next boot
    // can't surface a torn artifact.
    const handle = await open(tempPath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    return hash.digest('hex');
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Idle/connect timeout for an artifact download. A hung or slow-loris origin
 * must fail the fetch rather than stall boot indefinitely (the reconciler awaits
 * this at startup). Applies to connection setup and to any subsequent stall in
 * the response body (the socket timer stays armed after the stream resolves).
 */
const ARTIFACT_HTTP_TIMEOUT_MS = 30_000;

/**
 * Open an https response as a Readable, following the security posture of the
 * rest of this module: reject non-2xx up front. Redirects are NOT followed — an
 * artifact URI must point directly at the bytes. A stalled connection is torn
 * down after {@link ARTIFACT_HTTP_TIMEOUT_MS} so boot cannot hang on a slow
 * origin.
 */
async function openHttpsStream(url: URL): Promise<Readable> {
  return new Promise<Readable>((resolve, reject) => {
    const request = httpsGet(url, (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.resume();
        request.destroy();
        reject(new Error(`artifact download failed with HTTP ${status}`));
        return;
      }
      resolve(response);
    });
    request.setTimeout(ARTIFACT_HTTP_TIMEOUT_MS, () => {
      // Destroying the request errors the in-flight response stream, so a stall
      // after resolve() surfaces as a download failure in the consuming
      // pipeline rather than an unbounded hang.
      request.destroy(new Error(`artifact download timed out after ${ARTIFACT_HTTP_TIMEOUT_MS}ms`));
    });
    request.on('error', reject);
  });
}
