/**
 * Retained per-active-extension web-bundle info.
 *
 * The reconcile loop (reconciler.ts) verifies each extension's bundle once and
 * gets back a `VerifiedExtensionBundle` — its extraction root, its
 * `artifactDigest`, and its `files` inventory (the exact allowlist of members
 * the bundle contained, each with its verified sha256/size). Historically only
 * the extraction root survived past the reconcile loop (via
 * registerExtensionRoot/clearExtensionRoot in faultAttribution.ts); the digest
 * and files inventory were discarded once the loop moved to the next
 * extension.
 *
 * A later task's asset route needs all three together to serve an extension's
 * web/* files: `root` to resolve a path on disk, `files` as the allowlist +
 * verified hash for each member (TOCTOU re-check at serve time), and `digest`
 * for cache-busting / integrity headers. This module is that retention: the
 * SINGLE source both the registry and asset routes read.
 *
 * Register/clear MUST be called at exactly the same points
 * registerExtensionRoot/clearExtensionRoot are (reconciler.ts) — success path
 * and every withdraw/failure path — so a withdrawn/failed extension can never
 * leave stale asset data behind. Serving a disabled extension's bytes from a
 * stale entry here would be a real security gap, not just a bug.
 *
 * SECURITY (Plan-03 final review): `VerifiedExtensionBundle.files` is the
 * FULL verified inventory of a signed bundle — `manifest.json`, the server
 * code, migrations, everything, not just the browser-facing web assets. The
 * digest-addressed asset route (extensionsWeb.ts) treats this inventory as
 * its allowlist, so retaining the full inventory unfiltered would let ANY
 * authenticated user fetch `manifest.json` (leaking `publicRoutes`,
 * `tenancy`, and `server.entry` filesystem-adjacent paths) or arbitrary
 * `server/*` / `migrations/*` members whose extension happens to have a
 * `.js`/`.json` name. `web.entry` is NOT currently pinned under a `web/`
 * prefix by the manifest schema (`packages/extension-sdk/src/manifest.ts`
 * — `safeJavaScriptPath` allows any safe relative path), so this can't be a
 * `web/`-only allowlist without risking a 404 on a schema-valid extension's
 * real entry point. Instead `registerExtensionWebAsset` retains a DENYLIST-
 * filtered inventory: everything except the manifest itself and the
 * server/migrations subtrees. That filtered map is the single source both
 * the registry (moduleUrl) and the asset route read, so nothing downstream
 * can accidentally see the excluded members.
 */
import { RESERVED_MEMBERS } from './bundleVerifier';

export interface ExtensionWebAsset {
  /** Extraction root on disk (same value registerExtensionRoot receives). */
  readonly root: string;
  /** VerifiedExtensionBundle.artifactDigest for this extension's active bundle. */
  readonly digest: string;
  /** The verified inventory, already filtered to the servable web surface
   *  (see `isServableWebMember`) — never the raw `VerifiedExtensionBundle.files`. */
  readonly files: ReadonlyMap<string, { sha256: string; uncompressedSize: number }>;
}

/** What `registerExtensionWebAsset` needs from a verified bundle: the raw
 *  (unfiltered) inventory plus the manifest's declared `migrationsDir`, so
 *  registration — not the caller — owns the filtering decision. */
export interface RegisterableExtensionWebAsset {
  readonly root: string;
  readonly digest: string;
  readonly files: ReadonlyMap<string, { sha256: string; uncompressedSize: number }>;
  /** `ExtensionManifestV1.migrationsDir`; defaults to `'migrations'` to match
   *  the manifest schema's own default when a caller omits it (e.g. existing
   *  tests that predate this field). */
  readonly migrationsDir?: string;
}

/**
 * True if `member` is safe to hand to a browser via the digest-addressed
 * asset route — i.e. it is not the manifest itself, a reserved trust-
 * envelope member, or part of the server/migrations subtrees. Exported so
 * both retention (below) and the asset route's defense-in-depth check
 * (extensionsWeb.ts) share ONE definition instead of two that could drift.
 */
export function isServableWebMember(member: string, migrationsDir = 'migrations'): boolean {
  if (member === 'manifest.json' || RESERVED_MEMBERS.has(member)) return false;
  if (member === 'server' || member.startsWith('server/')) return false;
  if (member === 'migrations' || member.startsWith('migrations/')) return false;
  if (
    migrationsDir !== 'migrations'
    && (member === migrationsDir || member.startsWith(`${migrationsDir}/`))
  ) {
    return false;
  }
  return true;
}

function toServableWebFiles(
  files: ReadonlyMap<string, { sha256: string; uncompressedSize: number }>,
  migrationsDir: string,
): ReadonlyMap<string, { sha256: string; uncompressedSize: number }> {
  const webFiles = new Map<string, { sha256: string; uncompressedSize: number }>();
  for (const [member, entry] of files) {
    if (isServableWebMember(member, migrationsDir)) webFiles.set(member, entry);
  }
  return webFiles;
}

const webAssets = new Map<string, ExtensionWebAsset>();

/** Record the retained web-bundle info for an activated extension. `files` is
 *  filtered to the servable web surface here — by construction, nothing else
 *  in `webAssets` can ever hold `manifest.json` or a `server/`/`migrations/`
 *  member. */
export function registerExtensionWebAsset(name: string, asset: RegisterableExtensionWebAsset): void {
  webAssets.set(name, {
    root: asset.root,
    digest: asset.digest,
    files: toServableWebFiles(asset.files, asset.migrationsDir ?? 'migrations'),
  });
}

/** Drop an extension's retained web-bundle info when it is withdrawn / fails reconciliation. */
export function clearExtensionWebAsset(name: string): void {
  webAssets.delete(name);
}

/** The retained `{ root, digest, files }` for an extension, or undefined if none is active. */
export function getExtensionWebAsset(name: string): ExtensionWebAsset | undefined {
  return webAssets.get(name);
}
