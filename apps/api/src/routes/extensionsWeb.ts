/**
 * Authenticated runtime-extension web surface: the registry projection and
 * digest-addressed serving of extension web/* assets.
 *
 * TWO DIFFERENT GATES (issue #4164). `GET /registry` keeps the ordinary
 * bearer `authMiddleware` — ANY authenticated user, not just platform admins,
 * may read it. `GET /assets/...` CANNOT: the browser loads an extension's
 * entry module with a bare dynamic `import(url)`, a native module fetch that
 * cannot attach an `Authorization` header, so a bearer gate there 401'd every
 * extension UI permanently. Instead `/registry` — which is authenticated —
 * mints a short-lived signed capability per extension bundle and embeds it in
 * the `moduleUrl` it advertises, and the asset route verifies THAT (step 0
 * below). See services/extensionAssetToken.ts for exactly what the token does
 * and does not prove; the short version is that it cannot be forged,
 * re-pointed at another extension or digest, re-scoped to another tenant, or
 * used past its expiry — but it is a bearer capability, so whoever holds it
 * within its lifetime can read the bundle.
 *
 * There is no per-org filtering here: `installed_extensions.enabled` (the
 * state store's `isEnabled`) is a GLOBAL fleet-wide switch, not an org-scoped
 * one (see stateStore.ts — `getRow`/`setEnabled` take only `name`), so
 * "enabled" is the only gate this surface applies. If a future task adds
 * org-scoped extension state, this router's live re-check is the place to
 * extend — and the token already carries the minting principal's
 * partner/org scope so that check has something to compare against.
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
import {
  assertVerifiedMemberBytes,
  getExtensionWebAsset,
  isServableWebMember,
  type ExtensionWebAsset,
} from '../extensions/webAssets';
import {
  ASSET_TOKEN_SEGMENT,
  buildRuntimeWebRegistry,
  type RuntimeWebRegistrySource,
} from '../extensions/webRegistry';
import {
  mintExtensionAssetToken,
  verifyExtensionAssetToken,
  type ExtensionAssetTokenScope,
} from '../services/extensionAssetToken';
import { createReportThrottle } from '../utils/reportThrottle';

/** The state-store surface this router needs (injectable for tests). */
export type ExtensionsWebStore = Pick<ExtensionStateStore, 'isEnabled'>;

/** The registry surface this router needs (injectable for tests). */
export type ExtensionsWebRegistry = Pick<ExtensionContributionRegistry, 'listActive'>;

export interface ExtensionsWebDeps {
  stateStore: ExtensionsWebStore;
  registry: ExtensionsWebRegistry;
  /** Task 2's retained `{ root, digest, files }` accessor. */
  getWebAsset: (name: string) => ExtensionWebAsset | undefined;
  /** Injectable so tests can mint deterministically; production wires the real
   *  HMAC minter (services/extensionAssetToken.ts). */
  mintAssetToken: (
    binding: { name: string; digest: string },
    scope: ExtensionAssetTokenScope,
  ) => string;
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

/**
 * Serving failures on this route used to be reachable only by authenticated
 * users; now that the bearer gate is gone, anonymous scanning traffic 404s
 * through the same code. That would bury a REAL fault — a deleted extraction
 * root, a permissions change, an unreadable mount — in noise, so the two are
 * separated by WHEN they happen: anything failing after the token verified is
 * by construction a legitimate request hitting an infrastructure problem, and
 * that is the only subset worth reporting. Throttled, because one broken
 * bundle fails on every page load of every user.
 */
const ASSET_SERVE_THROTTLE = createReportThrottle(5 * 60_000);

/** Test seam — the throttle is module-global, so a suite asserting on the
 *  warning must clear the window between cases or the assertions become
 *  order-dependent. */
export function __resetExtensionAssetServeThrottleForTests(): void {
  ASSET_SERVE_THROTTLE.reset();
}

function reportVerifiedServeFailure(name: string, member: string, phase: 'resolve' | 'read'): void {
  if (!ASSET_SERVE_THROTTLE.shouldReport(`extension-asset-serve:${phase}:${name}`)) return;
  console.warn(
    `[extensionsWeb] failed to ${phase} a VERIFIED extension asset (${name} :: ${member}). `
    + 'The caller held a valid capability, so this is a serving fault, not a probe — '
    + "the extension's UI is broken for every user until it is resolved.",
  );
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

  // Bearer gate scoped to `/registry` ONLY — deliberately not `use('*')`, so
  // the carve-out for `/assets/*` is a property of this line rather than of
  // route-registration order. Any authenticated user qualifies (no
  // platform-admin requirement; extension web UI is ordinary tenant-facing).
  // `/assets/*` is gated by the signed token minted here instead; see the
  // header comment.
  routes.use('/registry', authMiddleware);
  // Belt and braces for a future `/registry/<something>` sub-route: the gate is
  // enumerated per path, so a new one must not inherit "unauthenticated" from
  // the `/assets/*` carve-out by accident.
  routes.use('/registry/*', authMiddleware);

  routes.get('/registry', async (c) => {
    const auth = c.get('auth');
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

    // The response now carries live credentials (one asset token per
    // extension), so it must never be stored by a shared or disk cache.
    c.header('Cache-Control', 'no-store');
    return c.json(buildRuntimeWebRegistry(sources, (binding) => deps.mintAssetToken(binding, {
      partnerId: auth?.partnerId ?? null,
      orgId: auth?.orgId ?? null,
    })));
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
  // does not hand this handler a `member` string containing `..`. The token
  // and inventory-key checks below (steps 0 and 4) are what actually reject it
  // either way; this comment just explains why a literal `../x` never reaches
  // here.
  //
  // The `t/:token` pair sits ABOVE `:member` on purpose (see
  // webRegistry.ts's ASSET_TOKEN_SEGMENT): a relative specifier inside the
  // bundle (`import './chunk.js'`) resolves against the importing module's
  // URL, which drops a query string but keeps the parent path segments — so a
  // path-carried capability is inherited by every sibling chunk request, while
  // a `?t=` one would leave a code-split bundle's chunks all 404ing.
  routes.get(`/assets/${ASSET_TOKEN_SEGMENT}/:token/:name/:digest/:member{.+}`, async (c) => {
    const token = c.req.param('token');
    const name = c.req.param('name');
    const digest = c.req.param('digest');
    const member = c.req.param('member');

    // 0. The signed capability, FIRST — before the state-store read, the two
    //    `realpath` calls, the file read and the re-hash below. An
    //    unauthenticated caller presenting junk must cost nothing but a regex
    //    and one HMAC, never disk or database I/O. `verifyExtensionAssetToken`
    //    binds the token to THIS `name` + `digest` and returns null (never
    //    throws, never says why) for every failure mode, so a forged, expired,
    //    re-scoped or mis-bound token is indistinguishable from the other
    //    rejections below — the no-oracle property still holds.
    const verified = verifyExtensionAssetToken(token, { name, digest });
    if (!verified) return notFound(c);

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
      // distinguishable from "not found" to the caller. They ARE distinguishable
      // to us: the token already verified, so this is a real serving fault.
      reportVerifiedServeFailure(name, member, 'resolve');
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
      // Same reasoning as the realpath catch above — and a hash mismatch here
      // is the loudest case of all: the bytes on disk no longer match the
      // verified inventory.
      reportVerifiedServeFailure(name, member, 'read');
      return notFound(c);
    }

    // 9. Response headers. The freshness lifetime is capped at the presented
    //    token's REMAINING life, not the year an immutable digest-addressed URL
    //    would otherwise earn: a private cache that outlived the token would go
    //    on serving these bytes without ever re-reaching the enabled re-check
    //    in step 3, which is how a disabled extension keeps running. `immutable`
    //    still holds — the URL is digest-addressed, so within that window the
    //    bytes genuinely cannot change.
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Type', contentType);
    c.header('Cache-Control', `private, max-age=${Math.max(0, verified.remainingSeconds)}, immutable`);
    return c.body(new Uint8Array(bytes));
  });

  // Anything else under `/assets/` — a malformed or legacy URL shape — answers
  // with this router's bare 404 rather than falling through to the app-level
  // notFound handler, which echoes `c.req.path` back in the body (index.ts) and
  // would therefore reflect a presented token into the response.
  routes.all('/assets/*', notFound);

  return routes;
}

/** The production router, wired to the shared registry, store and webAssets accessor. */
export const extensionsWebRoutes = createExtensionsWebRoutes({
  stateStore: createExtensionStateStore(),
  registry: extensionContributionRegistry,
  getWebAsset: getExtensionWebAsset,
  mintAssetToken: mintExtensionAssetToken,
});
