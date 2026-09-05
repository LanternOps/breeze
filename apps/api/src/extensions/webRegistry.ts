import { createHash } from 'node:crypto';
import type { ExtensionManifestV1 } from '@breeze/extension-sdk';

/**
 * The pure projection from "what's active" to the browser-safe document
 * `GET /api/v1/extensions/registry` serves (see routes/extensionsWeb.ts for
 * the live enabled-recheck and digest lookup that produce the input array).
 *
 * BROWSER-SAFE ONLY. This module is the one place that decides which fields
 * of an extension's manifest/state are allowed to reach a browser. Anything
 * NOT explicitly copied into `RuntimeWebExtension` below — the extraction
 * root, artifact URI, trust/publisher key material, `requires`, `server`,
 * `tenancy`, `migrationsDir`, `publicRoutes`, `agentRoutes` — is never
 * touched by this function, so a future manifest field added upstream cannot
 * silently leak here; it has to be deliberately added to the projection.
 *
 * DETERMINISM. Every replica in the fleet runs this independently against its
 * own in-memory registry snapshot. Two replicas that agree on WHICH
 * extensions are active must produce byte-identical JSON (and therefore the
 * same `revision`), so a client polling through a load balancer never sees
 * the document "change" for no reason. That means: sort extensions by name,
 * sort each extension's pages/navigation/slots by their manifest-declared
 * `id` (falling back to another schema-unique field when `id` is omitted —
 * the manifest schema allows that), and serialize with a fixed, explicit key
 * order (never rely on `Object.keys` insertion order of a spread).
 *
 * `moduleUrl` now embeds a short-lived signed asset token (issue #4164 — a
 * bare dynamic `import()` cannot send an Authorization header, so the
 * capability has to travel in the URL). That does NOT break determinism:
 * `mintExtensionAssetToken` snaps its `iat` to a coarse time bucket, so every
 * replica minting for the same extension + digest + tenant in the same bucket
 * emits the same bytes. The revision therefore stays stable within a bucket
 * and changes at each rollover — which is exactly the signal the browser
 * client needs to adopt freshly-credentialled URLs, and is why the token is
 * hashed INTO the revision rather than excluded from it. (Excluding it would
 * let the client's revision-keyed memo hand back a document whose token has
 * since expired.) The revision does vary per tenant scope, but a given client
 * is always one tenant, so no client sees it flap.
 */

export interface RuntimeWebPage {
  readonly id: string | undefined;
  readonly path: string;
  readonly element: string;
}

export interface RuntimeWebNavItem {
  readonly id: string | undefined;
  readonly label: string;
  readonly path: string;
  readonly order: number | undefined;
}

export interface RuntimeWebSlot {
  readonly id: string | undefined;
  readonly slot: string;
  readonly contractVersion: number;
  readonly element: string;
  readonly label: string | undefined;
  readonly order: number | undefined;
}

export interface RuntimeWebExtension {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly moduleUrl: string;
  readonly pages: readonly RuntimeWebPage[];
  readonly navigation: readonly RuntimeWebNavItem[];
  readonly slots: readonly RuntimeWebSlot[];
}

export interface RuntimeWebRegistry {
  readonly apiVersion: 'breeze.extensions.web/v1';
  readonly revision: string;
  readonly extensions: readonly RuntimeWebExtension[];
}

/**
 * One candidate extension to project. Deliberately NOT `StagedExtensionContributions`
 * (which carries route apps, job/AI-tool handlers, and the full manifest) —
 * this keeps the projection testable with hand-built fixtures and makes the
 * "what can possibly leak" surface exactly these four fields. The caller
 * (routes/extensionsWeb.ts) is responsible for narrowing a live snapshot +
 * the retained webAssets digest down to this shape, and for the live
 * enabled-recheck (a pure function has no business calling the DB).
 */
export interface RuntimeWebRegistrySource {
  readonly name: string;
  readonly version: string;
  readonly manifest: ExtensionManifestV1;
  /** VerifiedExtensionBundle.artifactDigest for this extension's active bundle (Task 2's map). */
  readonly digest: string;
}

const API_VERSION = 'breeze.extensions.web/v1' as const;

/**
 * The literal segment that introduces the signed asset token in an asset URL:
 * `/api/v1/extensions/assets/t/<token>/<name>/<digest>/<member...>`.
 *
 * The token sits ABOVE the member path on purpose. A relative specifier inside
 * a bundle (`import './chunk.js'`) resolves against the importing module's URL,
 * which drops a query string but keeps the parent path segments — so a
 * path-carried token is inherited by every sibling chunk request, while a `?t=`
 * one is not. Shared with routes/extensionsWeb.ts (which matches it) and
 * apps/web/src/lib/extensions/registry.ts (which strips it to derive a stable
 * module-cache key) so the three cannot drift.
 */
export const ASSET_TOKEN_SEGMENT = 't';

/** Mints the capability for one extension bundle. Injected rather than imported
 *  so this projection stays pure and hand-testable (the real implementation
 *  reads process-wide key material). */
export type ExtensionAssetTokenMinter = (binding: { name: string; digest: string }) => string;

export function buildExtensionAssetPath(
  token: string,
  name: string,
  digest: string,
  member: string,
): string {
  return `/api/v1/extensions/assets/${ASSET_TOKEN_SEGMENT}/${token}/${name}/${digest}/${member}`;
}

/** Stable sort key for a page/navigation entry: its `id`, or its unique `path`. */
function pageOrNavKey(entry: { id?: string; path: string }): string {
  return entry.id ?? entry.path;
}

/** Stable sort key for a slot entry: its `id`, or its unique `slot:element` pair. */
function slotKey(entry: { id?: string; slot: string; element: string }): string {
  return entry.id ?? `${entry.slot}:${entry.element}`;
}

function byKey<T>(key: (value: T) => string): (a: T, b: T) => number {
  return (a, b) => key(a).localeCompare(key(b));
}

function projectExtension(
  source: RuntimeWebRegistrySource,
  mintAssetToken: ExtensionAssetTokenMinter,
): RuntimeWebExtension | null {
  const web = source.manifest.web;
  if (!web) return null;

  const pages = [...web.pages].sort(byKey(pageOrNavKey)).map((page) => ({
    id: page.id,
    path: page.path,
    element: page.element,
  }));
  const navigation = [...web.navigation].sort(byKey(pageOrNavKey)).map((item) => ({
    id: item.id,
    label: item.label,
    path: item.path,
    order: item.order,
  }));
  const slots = [...web.slots].sort(byKey(slotKey)).map((slot) => ({
    id: slot.id,
    slot: slot.slot,
    contractVersion: slot.contractVersion,
    element: slot.element,
    label: slot.label,
    order: slot.order,
  }));

  return {
    name: source.name,
    version: source.version,
    digest: source.digest,
    moduleUrl: buildExtensionAssetPath(
      mintAssetToken({ name: source.name, digest: source.digest }),
      source.name,
      source.digest,
      web.entry,
    ),
    pages,
    navigation,
    slots,
  };
}

/**
 * Build the browser-safe web registry document from a set of candidate
 * sources. Pure: no I/O, no DB, no enabled-recheck — the caller supplies
 * exactly the sources that are enabled RIGHT NOW, and the asset-token minter
 * (which is the only thing here that touches process-wide state).
 */
export function buildRuntimeWebRegistry(
  sources: readonly RuntimeWebRegistrySource[],
  mintAssetToken: ExtensionAssetTokenMinter,
): RuntimeWebRegistry {
  const extensions = sources
    .map((source) => projectExtension(source, mintAssetToken))
    .filter((ext): ext is RuntimeWebExtension => ext !== null)
    .sort(byKey((ext) => ext.name));

  const revision = createHash('sha256')
    .update(JSON.stringify({ apiVersion: API_VERSION, extensions }))
    .digest('hex');

  return { apiVersion: API_VERSION, revision, extensions };
}
