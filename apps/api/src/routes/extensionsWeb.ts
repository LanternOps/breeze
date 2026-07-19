/**
 * Authenticated runtime-extension web surface: the registry projection and
 * digest-addressed serving of extension web/* assets.
 *
 * Mounted under the authed `/api/v1` group (see index.ts), gated by the
 * ordinary `authMiddleware` — ANY authenticated user, not just platform
 * admins, may read the registry and fetch assets. There is no per-org
 * filtering here: `installed_extensions.enabled` (the state store's
 * `isEnabled`) is a GLOBAL fleet-wide switch, not an org-scoped one (see
 * stateStore.ts — `getRow`/`setEnabled` take only `name`), so "enabled" is
 * the only gate this surface applies. If a future task adds org-scoped
 * extension state, this router's live re-check is the place to extend.
 *
 * Part B (asset serving) is the highest-security code in this task: it
 * serves bytes read from disk in response to attacker-controlled path
 * segments, for extensions whose entire point is running UNTRUSTED
 * third-party code client-side. Every rejection is a bare 404 (never 403),
 * so a probing client cannot distinguish "wrong digest" from "not enabled"
 * from "not in the allowlist" from "tried to escape the root" — no oracle.
 * The ordered checks below mirror the task-3 brief exactly.
 */
import { Hono, type Context } from 'hono';
import { readFile, realpath as fsRealpath } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { authMiddleware } from '../middleware/auth';
import {
  extensionContributionRegistry,
  type ExtensionContributionRegistry,
  type StagedExtensionContributions,
} from '../extensions/contributionRegistry';
import { createExtensionStateStore, type ExtensionStateStore } from '../extensions/stateStore';
import { getExtensionWebAsset, isServableWebMember, type ExtensionWebAsset } from '../extensions/webAssets';
import { assertVerifiedMemberBytes } from '../extensions/bundleVerifier';
import { buildRuntimeWebRegistry, type RuntimeWebRegistrySource } from '../extensions/webRegistry';

/** The state-store surface this router needs (injectable for tests). */
export type ExtensionsWebStore = Pick<ExtensionStateStore, 'isEnabled'>;

/** The registry surface this router needs (injectable for tests). */
export type ExtensionsWebRegistry = Pick<ExtensionContributionRegistry, 'listActive'>;

export interface ExtensionsWebDeps {
  stateStore: ExtensionsWebStore;
  registry: ExtensionsWebRegistry;
  /** Task 2's retained `{ root, digest, files }` accessor. */
  getWebAsset: (name: string) => ExtensionWebAsset | undefined;
}

/**
 * Extension → Content-Type allowlist. Exact set from the task-3 brief — no
 * `.node` (native modules), no `.map` (source maps can carry unbundled
 * source), no `.html` (would be a same-origin page, not a leaf asset), and
 * nothing outside this list. `mime` sniffing is deliberately not used: the
 * Content-Type is fully determined by this table, matched with
 * `X-Content-Type-Options: nosniff`.
 */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
]);

function notFound(c: Context): Response {
  return c.json({ error: 'not found' }, 404);
}

/** Narrow a live, enabled snapshot + its retained digest to the registry projection's input shape. */
function toRegistrySource(
  snapshot: StagedExtensionContributions,
  asset: ExtensionWebAsset,
): RuntimeWebRegistrySource {
  return {
    name: snapshot.name,
    version: snapshot.version,
    manifest: snapshot.manifest,
    digest: asset.digest,
  };
}

export function createExtensionsWebRoutes(deps: ExtensionsWebDeps): Hono {
  const routes = new Hono();

  // ONE gate for the whole group — any authenticated user (no platform-admin
  // requirement; extension web assets are ordinary tenant-facing UI).
  routes.use('*', authMiddleware);

  routes.get('/registry', async (c) => {
    const candidates = deps.registry.listActive();

    // The in-process registry snapshot can be stale on THIS replica (another
    // replica's disable hasn't invalidated it) — re-check the durable,
    // fleet-wide flag per extension, live, per request. Same rationale as
    // enabledGate.ts / the gateway's per-dispatch check.
    const liveEnabled = await Promise.all(
      candidates.map((snapshot) => deps.stateStore.isEnabled(snapshot.name)),
    );

    const sources: RuntimeWebRegistrySource[] = [];
    candidates.forEach((snapshot, index) => {
      if (!liveEnabled[index]) return;
      const asset = deps.getWebAsset(snapshot.name);
      // No retained web asset (e.g. a server-only extension, or one whose
      // bundle info was cleared concurrently) means nothing safe to serve —
      // omit it rather than guess at a digest.
      if (!asset) return;
      sources.push(toRegistrySource(snapshot, asset));
    });

    return c.json(buildRuntimeWebRegistry(sources));
  });

  // `:member{.+}` (a named regex-capture param), NOT a bare `*` — this Hono
  // version's default router does not populate `c.req.param('*')` at all for
  // trailing wildcards (verified empirically; it returns undefined), so a
  // bare `*` would 404 every legitimate request. `{.+}` captures the full
  // remaining path (including slashes) as a normal decoded param. Separately:
  // the underlying WHATWG URL parser that builds the incoming Request already
  // collapses `.` / `..` dot-segments (and their `%2e` percent-encoded form
  // identically) BEFORE Hono's router ever sees the path, so a traversal
  // attempt reshuffles which segments land in `:digest` vs `:member` — it
  // does not hand this handler a `member` string containing `..`. The exact
  // inventory-key check below (step 4) is what actually rejects it either
  // way; this comment just explains why a literal `../x` never reaches here.
  routes.get('/assets/:name/:digest/:member{.+}', async (c) => {
    const name = c.req.param('name');
    const digest = c.req.param('digest');
    const member = c.req.param('member');

    // 1. Must have a retained web asset at all.
    const asset = deps.getWebAsset(name);
    if (!asset) return notFound(c);

    // 2. :digest must equal the retained ACTIVE digest exactly.
    if (digest !== asset.digest) return notFound(c);

    // 3. Live enabled re-check — a disabled/withdrawn extension serves nothing.
    const enabled = await deps.stateStore.isEnabled(name);
    if (!enabled) return notFound(c);

    // 4. The requested member must be an EXACT key in the verified inventory
    //    — the inventory IS the allowlist. No filesystem fallback.
    const inventoryEntry = asset.files.get(member);
    if (!inventoryEntry) return notFound(c);

    // 5. Defense-in-depth: never serve the manifest itself or the
    //    server/migrations subtrees, even if they somehow appear in
    //    `asset.files` (e.g. a future `getWebAsset` source that doesn't
    //    route through `registerExtensionWebAsset`'s retention-time filter).
    //    `registerExtensionWebAsset` (webAssets.ts) already filters these out
    //    at the source using the SAME `isServableWebMember` — this is the
    //    boundary re-check, not the primary defense.
    if (!isServableWebMember(member)) return notFound(c);

    // 6. Resolve under `root` and assert containment. `path.join` collapses
    //    any `..` in `member`, but we still verify the resolved path is
    //    genuinely inside `root` (not just string-prefixed by it — a sibling
    //    directory like "<root>-evil" would pass a naive `startsWith(root)`)
    //    AND re-resolve through the real filesystem (`fs.realpath`) so a
    //    symlink planted inside `root` cannot point outside it.
    const candidatePath = join(asset.root, member);
    const rootWithSep = asset.root.endsWith(sep) ? asset.root : asset.root + sep;
    if (!candidatePath.startsWith(rootWithSep)) return notFound(c);

    let realMemberPath: string;
    let realRoot: string;
    try {
      [realMemberPath, realRoot] = await Promise.all([
        fsRealpath(candidatePath),
        fsRealpath(asset.root),
      ]);
    } catch {
      // Missing file, broken symlink, permission error — none of these are
      // distinguishable from "not found" to the caller.
      return notFound(c);
    }
    const realRootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (!realMemberPath.startsWith(realRootWithSep)) return notFound(c);

    // 7. Extension/content-type allowlist. Reject anything not explicitly
    //    listed (`.node`, `.map`, `.html`, unknown extensions included).
    const ext = extname(member).toLowerCase();
    const contentType = CONTENT_TYPES.get(ext);
    if (!contentType) return notFound(c);

    // 8. TOCTOU: re-hash the bytes actually read, against the verified
    //    inventory hash, before responding with them.
    let bytes: Buffer;
    try {
      bytes = await readFile(realMemberPath);
      assertVerifiedMemberBytes(member, bytes, inventoryEntry.sha256);
    } catch {
      return notFound(c);
    }

    // 9. Response headers.
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Type', contentType);
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    return c.body(new Uint8Array(bytes));
  });

  return routes;
}

/** The production router, wired to the shared registry, store and webAssets accessor. */
export const extensionsWebRoutes = createExtensionsWebRoutes({
  stateStore: createExtensionStateStore(),
  registry: extensionContributionRegistry,
  getWebAsset: getExtensionWebAsset,
});
