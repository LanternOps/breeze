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
 */

export interface ExtensionWebAsset {
  /** Extraction root on disk (same value registerExtensionRoot receives). */
  root: string;
  /** VerifiedExtensionBundle.artifactDigest for this extension's active bundle. */
  digest: string;
  /** VerifiedExtensionBundle.files — the verified member allowlist/hashes. */
  files: ReadonlyMap<string, { sha256: string; uncompressedSize: number }>;
}

const webAssets = new Map<string, ExtensionWebAsset>();

/** Record the retained web-bundle info for an activated extension. */
export function registerExtensionWebAsset(name: string, asset: ExtensionWebAsset): void {
  webAssets.set(name, asset);
}

/** Drop an extension's retained web-bundle info when it is withdrawn / fails reconciliation. */
export function clearExtensionWebAsset(name: string): void {
  webAssets.delete(name);
}

/** The retained `{ root, digest, files }` for an extension, or undefined if none is active. */
export function getExtensionWebAsset(name: string): ExtensionWebAsset | undefined {
  return webAssets.get(name);
}
