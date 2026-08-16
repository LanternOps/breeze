/**
 * Retained per-active-extension web-bundle info.
 *
 * The built-in loading path (builtinExtensions.ts) hashes an extension's
 * shipped `dist/` once at boot and hands the result here: its root on disk,
 * a digest over the whole inventory, and the `files` inventory itself (the
 * exact allowlist of members, each with its sha256/size).
 *
 * The asset route needs all three together to serve an extension's web/*
 * files: `root` to resolve a path on disk, `files` as the allowlist +
 * verified hash for each member (TOCTOU re-check at serve time, see
 * {@link assertVerifiedMemberBytes}), and `digest` for cache-busting /
 * integrity headers. This module is that retention: the SINGLE source both
 * the registry and asset routes read.
 *
 * Register/clear MUST be called at exactly the same points
 * registerExtensionRoot/clearExtensionRoot are — success path and every
 * withdraw/failure path — so a withdrawn/failed extension can never leave
 * stale asset data behind. Serving a disabled extension's bytes from a stale
 * entry here would be a real security gap, not just a bug.
 *
 * SECURITY (Plan-03 final review): the inventory handed to
 * `registerExtensionWebAsset` is the FULL inventory of an extension's built
 * output — `manifest.json`, the server code, migrations, everything, not just
 * the browser-facing web assets. The
 * digest-addressed asset route (extensionsWeb.ts) treats this inventory as
 * its allowlist, so retaining the full inventory unfiltered would let ANY
 * authenticated user fetch `manifest.json` (leaking `publicRoutes`,
 * `tenancy`, and `server.entry` filesystem-adjacent paths), arbitrary
 * `server/*` / `migrations/*` members whose extension happens to have a
 * `.js`/`.json` name — OR, as a follow-up re-review found, any OTHER
 * root-level or non-`web/` member the bundle happens to contain (a
 * `config.json`/`secrets.json` at the bundle root, a `data/seed.json`, a
 * stray helper `.js` outside `server/`): none of those were on the old
 * denylist, so they were servable to any authenticated user of any tenant
 * where the extension is enabled.
 *
 * `registerExtensionWebAsset` now retains a fail-CLOSED `web/`-prefix
 * ALLOWLIST instead: a member survives filtering only if it is under the
 * `web/` directory (exact path-segment match — `web/x.js` yes, `webhook/x.js`
 * no; `web`/`web/` alone is never a servable file). This subsumes every
 * exclusion the old denylist enumerated (manifest.json, RESERVED_MEMBERS,
 * server/, migrations/) by construction, plus the newly-flagged cases, since
 * none of them live under `web/`. It is verified (see the manifest audit in
 * this task's report) that every fixture/test manifest's `web.entry` is
 * already `web/...`, so this does not regress the happy path. That filtered
 * map is the single source both the registry (moduleUrl) and the asset route
 * read, so nothing downstream can accidentally see the excluded members.
 */
import { createHash } from 'node:crypto';

export interface ExtensionWebAsset {
  /** Root on disk (same value registerExtensionRoot receives). */
  readonly root: string;
  /** Content digest over this extension's active web inventory. */
  readonly digest: string;
  /** The verified inventory, already filtered to the servable web surface
   *  (see `isServableWebMember`) — never the raw, unfiltered inventory. */
  readonly files: ReadonlyMap<string, { sha256: string; uncompressedSize: number }>;
}

/** What `registerExtensionWebAsset` needs: the raw (unfiltered) inventory, so
 *  registration — not the caller — owns the filtering decision. */
export interface RegisterableExtensionWebAsset {
  readonly root: string;
  readonly digest: string;
  readonly files: ReadonlyMap<string, { sha256: string; uncompressedSize: number }>;
}

/** Exact-segment `web/` prefix, e.g. `web/x.js` — never a substring match
 *  (`webhook/x.js` must NOT pass). */
const WEB_DIR_PREFIX = 'web/';

/**
 * True if `member` is safe to hand to a browser via the digest-addressed
 * asset route — i.e. it is a real file under the `web/` directory of the
 * bundle. Exported so both retention (below) and the asset route's
 * defense-in-depth check (extensionsWeb.ts) share ONE definition instead of
 * two that could drift.
 *
 * Fail-CLOSED allowlist: `member` must start with the exact `web/` path
 * segment AND have a non-empty tail after it — `web` (no slash) and `web/`
 * (empty tail) are both rejected so the allowlist can never resolve to
 * serving the bundle root itself. Everything the old denylist enumerated
 * (`manifest.json`, `RESERVED_MEMBERS`, `server/*`, `migrations/*`) is
 * excluded by construction, since none of those live under `web/` — as is
 * any other non-`web/` member (a root `config.json`/`secrets.json`, a
 * `data/seed.json`, a stray non-`server/` `.js` helper) that a fail-open
 * denylist could otherwise have missed.
 */
export function isServableWebMember(member: string): boolean {
  return member.startsWith(WEB_DIR_PREFIX) && member.length > WEB_DIR_PREFIX.length;
}

function toServableWebFiles(
  files: ReadonlyMap<string, { sha256: string; uncompressedSize: number }>,
): ReadonlyMap<string, { sha256: string; uncompressedSize: number }> {
  const webFiles = new Map<string, { sha256: string; uncompressedSize: number }>();
  for (const [member, entry] of files) {
    if (isServableWebMember(member)) webFiles.set(member, entry);
  }
  return webFiles;
}

const webAssets = new Map<string, ExtensionWebAsset>();

/** Record the retained web-bundle info for an activated extension. `files` is
 *  filtered to the servable web surface here — by construction, nothing else
 *  in `webAssets` can ever hold a member outside the `web/` directory. */
export function registerExtensionWebAsset(name: string, asset: RegisterableExtensionWebAsset): void {
  webAssets.set(name, {
    root: asset.root,
    digest: asset.digest,
    files: toServableWebFiles(asset.files),
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

/**
 * TOCTOU re-check for a member served off disk: the bytes actually read must
 * still hash to the digest recorded in the retained inventory.
 *
 * The inventory is computed once, at load time, from the files that shipped
 * inside the core image; the asset route reads those files again on every
 * request. Anything able to write the extension's directory between the two
 * could otherwise swap in different bytes and have them served under a
 * digest-addressed, immutably-cached URL.
 */
export function assertVerifiedMemberBytes(
  member: string,
  bytes: Buffer,
  expectedSha256: string,
): void {
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    throw new Error(
      `archive member "${member}" changed on disk after verification — integrity re-check failed`,
    );
  }
}
