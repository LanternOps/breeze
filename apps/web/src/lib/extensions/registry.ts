// Browser-side client for the runtime web extension registry
// (`GET /api/v1/extensions/registry`, see apps/api/src/extensions/webRegistry.ts
// for the exact wire shape this mirrors and apps/api/src/routes/extensionsWeb.ts
// for the live enabled-recheck baked into every response).
//
// Mirrors apps/web/src/lib/api/catalog.ts: no generic apiClient in this app,
// calls go through `fetchWithAuth` (stores/auth.ts), which injects the active
// orgId, refreshes tokens, and returns a raw Response.
//
// SECURITY — this module is the trust boundary for running third-party
// extension code in the browser. `loadExtensionModule` is the ONLY place in
// the app allowed to perform a runtime-URL dynamic import, and it does so
// only after the URL has both (a) come from a registry response that passed
// `runtimeWebRegistrySchema` validation, and (b) been re-resolved against
// `window.location.origin` and checked same-origin + path-allowlisted. A
// forged/compromised registry response advertising an absolute remote
// `moduleUrl` is refused before any `import()` is attempted — see
// `assertSameOriginAssetUrl` below and registry.test.ts's "SECURITY" cases.
import { z } from 'zod';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { EXTENSION_HOST_EVENT_NAME } from '@breeze/extension-web-sdk';

// ---- wire shape (mirrors apps/api/src/extensions/webRegistry.ts) ----------

const runtimeWebPageSchema = z.object({
  id: z.string().optional(),
  path: z.string().min(1),
  element: z.string().min(1),
}).strict();

const runtimeWebNavItemSchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1),
  path: z.string().min(1),
  order: z.number().optional(),
}).strict();

const runtimeWebSlotSchema = z.object({
  id: z.string().optional(),
  slot: z.string().min(1),
  contractVersion: z.number(),
  element: z.string().min(1),
  label: z.string().optional(),
  order: z.number().optional(),
}).strict();

const runtimeWebExtensionSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  digest: z.string().min(1),
  moduleUrl: z.string().min(1),
  pages: z.array(runtimeWebPageSchema),
  navigation: z.array(runtimeWebNavItemSchema),
  slots: z.array(runtimeWebSlotSchema),
}).strict();

const runtimeWebRegistrySchema = z.object({
  apiVersion: z.literal('breeze.extensions.web/v1'),
  revision: z.string().min(1),
  extensions: z.array(runtimeWebExtensionSchema),
}).strict();

export type RuntimeWebPage = z.infer<typeof runtimeWebPageSchema>;
export type RuntimeWebNavItem = z.infer<typeof runtimeWebNavItemSchema>;
export type RuntimeWebSlot = z.infer<typeof runtimeWebSlotSchema>;
export type RuntimeWebExtension = z.infer<typeof runtimeWebExtensionSchema>;
export type RuntimeWebRegistry = z.infer<typeof runtimeWebRegistrySchema>;

/** Thrown by `getExtensionRegistry` on a non-2xx response or a shape that
 *  doesn't match `runtimeWebRegistrySchema` (including a non-JSON body). */
export class ExtensionRegistryError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ExtensionRegistryError';
    this.status = status;
  }
}

async function fetchAndValidateRegistry(): Promise<RuntimeWebRegistry> {
  const response = await fetchWithAuth('/extensions/registry');
  if (!response.ok) {
    throw new ExtensionRegistryError(
      `extension registry request failed with status ${response.status}`,
      response.status,
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ExtensionRegistryError('extension registry response was not valid JSON');
  }

  const parsed = runtimeWebRegistrySchema.safeParse(json);
  if (!parsed.success) {
    throw new ExtensionRegistryError('extension registry response failed shape validation');
  }
  return parsed.data;
}

// Last-known-good registry, kept only to hand back a referentially-stable
// object when a fresh fetch resolves to the same `revision` (so callers that
// key effects/memoization off the registry object don't see spurious
// "changed" registries for identical content). This is NOT a skip-the-network
// cache: every `getExtensionRegistry()` call still fetches, except when it
// piggybacks on an already-in-flight request from a concurrent caller. That
// matters for correctness — a disabled/withdrawn extension must stop
// resolving as soon as the next navigation asks, not "whenever some
// unrelated cache happens to expire" (mirrors the server's own live
// enabled-recheck philosophy, see extensionsWeb.ts).
let lastRegistry: RuntimeWebRegistry | null = null;
let inFlight: Promise<RuntimeWebRegistry> | null = null;

export function getExtensionRegistry(): Promise<RuntimeWebRegistry> {
  if (!inFlight) {
    inFlight = fetchAndValidateRegistry()
      .then((fresh) => {
        if (lastRegistry && lastRegistry.revision === fresh.revision) {
          return lastRegistry;
        }
        lastRegistry = fresh;
        return fresh;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Clears the registry document cache (NOT the module-import cache below,
 *  which is keyed by immutable digest-addressed URLs and never needs
 *  invalidating). Called on the `refresh-registry` host event and on auth
 *  change. */
export function clearExtensionRegistryCache(): void {
  lastRegistry = null;
  inFlight = null;
}

export interface ResolvedExtensionPage {
  readonly extension: RuntimeWebExtension;
  readonly page: RuntimeWebPage;
}

/** Resolves the page descriptor for `name`/`path` from the current registry,
 *  or null when the extension is absent/disabled or has no matching page. */
export async function findExtensionPage(
  name: string,
  path: string,
): Promise<ResolvedExtensionPage | null> {
  const registry = await getExtensionRegistry();
  const extension = registry.extensions.find((ext) => ext.name === name);
  if (!extension) return null;
  const page = extension.pages.find((p) => p.path === path);
  if (!page) return null;
  return { extension, page };
}

// ---- refresh-registry / auth-change invalidation ---------------------------

// `EXTENSION_HOST_EVENT_NAME` events are dispatched with `bubbles: true,
// composed: true` (see @breeze/extension-web-sdk events.ts), so they reach
// `window` regardless of which extension's shadow DOM they originated in.
// This listener does NOT use `parseExtensionHostEventV1` — it only cares
// whether `detail.type === 'refresh-registry'`, which carries no
// extension-namespaced data to validate, and an over-eager cache clear from a
// malformed event is harmless (worst case: one extra registry fetch).
if (typeof window !== 'undefined') {
  window.addEventListener(EXTENSION_HOST_EVENT_NAME, (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (
      detail
      && typeof detail === 'object'
      && (detail as { type?: unknown }).type === 'refresh-registry'
    ) {
      clearExtensionRegistryCache();
    }
  });
}

// Auth transitions (login/logout) invalidate the registry cache: a fresh
// session may see a different active extension set (e.g. platform-admin vs.
// ordinary user visibility, or simply a stale in-flight request spanning a
// logout).
let lastAuthenticated = useAuthStore.getState().isAuthenticated;
useAuthStore.subscribe((state) => {
  if (state.isAuthenticated !== lastAuthenticated) {
    lastAuthenticated = state.isAuthenticated;
    clearExtensionRegistryCache();
  }
});

// ---- module loader (the trust boundary) ------------------------------------

/** Every extension asset — including the web entry module — is served under
 *  this digest-addressed prefix (see apps/api/src/routes/extensionsWeb.ts).
 *  A `moduleUrl` whose resolved pathname doesn't start here is refused. */
const ASSET_PATH_PREFIX = '/api/v1/extensions/assets/';

const ALLOWED_MODULE_PROTOCOLS = new Set(['http:', 'https:']);

/** Encoded slash/backslash variants that could smuggle an extra path
 *  segment past a naive `startsWith` prefix check on `resolved.pathname`
 *  (the `URL` constructor does NOT decode these — they survive intact into
 *  `pathname`). The server-side exact-inventory-key check + realpath
 *  containment (extensionsWeb.ts) is the actual defense; this is
 *  belt-and-suspenders so the client never even attempts to import such a
 *  URL. */
const ENCODED_SLASH_RE = /%2f|%5c/i;

export class UntrustedExtensionModuleUrlError extends Error {
  constructor(moduleUrl: string, reason: string) {
    super(`refusing to import extension module ${JSON.stringify(moduleUrl)}: ${reason}`);
    this.name = 'UntrustedExtensionModuleUrlError';
  }
}

/**
 * Resolves `moduleUrl` against the current origin and enforces the loader's
 * trust boundary. Throws (never imports) unless the resolved URL is:
 *   - a valid URL at all,
 *   - http/https (rejects `blob:`, `data:`, `javascript:`, etc.),
 *   - exactly same-origin as `window.location.origin` (rejects absolute
 *     remote origins AND protocol-relative `//host` URLs, which resolve to a
 *     different origin unless the attacker's host happens to equal ours),
 *   - and has a pathname under `/api/v1/extensions/assets/` (the URL
 *     constructor normalizes `..` dot-segments before this check runs, so a
 *     traversal attempt can't smuggle a pathname that only LOOKS prefixed).
 */
function assertSameOriginAssetUrl(moduleUrl: string): URL {
  let resolved: URL;
  try {
    resolved = new URL(moduleUrl, window.location.origin);
  } catch {
    throw new UntrustedExtensionModuleUrlError(moduleUrl, 'not a valid URL');
  }

  if (!ALLOWED_MODULE_PROTOCOLS.has(resolved.protocol)) {
    throw new UntrustedExtensionModuleUrlError(moduleUrl, `disallowed protocol ${resolved.protocol}`);
  }
  if (resolved.origin !== window.location.origin) {
    throw new UntrustedExtensionModuleUrlError(moduleUrl, `must be same-origin as ${window.location.origin}`);
  }
  if (!resolved.pathname.startsWith(ASSET_PATH_PREFIX)) {
    throw new UntrustedExtensionModuleUrlError(moduleUrl, `must be under ${ASSET_PATH_PREFIX}`);
  }
  if (ENCODED_SLASH_RE.test(resolved.pathname)) {
    throw new UntrustedExtensionModuleUrlError(moduleUrl, 'must not contain an encoded slash or backslash');
  }
  return resolved;
}

/** Test-only seam: the real dynamic import can't be intercepted by module
 *  mocking (the specifier is a runtime string, not a static import), so
 *  tests swap this out to observe/control it. Defaults to the real
 *  `import(/* @vite-ignore *\/ url)`. */
export type ExtensionModuleImporter = (url: string) => Promise<unknown>;

let moduleImporter: ExtensionModuleImporter = (url: string) => import(/* @vite-ignore */ url);

export function __setExtensionModuleImporterForTests(fn: ExtensionModuleImporter | null): void {
  moduleImporter = fn ?? ((url: string) => import(/* @vite-ignore */ url));
}

// One in-flight (then settled) import promise per resolved, immutable
// module URL — two slots/pages that reference the same digest-addressed
// entry share a single `import()` call instead of double-importing.
const moduleImportCache = new Map<string, Promise<unknown>>();

export function __resetExtensionModuleCacheForTests(): void {
  moduleImportCache.clear();
}

/**
 * Validates `moduleUrl` against the trust boundary, then imports it exactly
 * once per resolved URL (concurrent/subsequent callers share the promise).
 * Throws synchronously (before any import is attempted) for a forged/invalid
 * URL; returns the import's promise (which may itself reject) otherwise.
 */
export function loadExtensionModule(moduleUrl: string): Promise<unknown> {
  const resolved = assertSameOriginAssetUrl(moduleUrl);
  const key = resolved.href;

  const cached = moduleImportCache.get(key);
  if (cached) return cached;

  const promise = moduleImporter(key);
  moduleImportCache.set(key, promise);
  // A rejected import (network hiccup, transient 401 racing a token refresh)
  // shouldn't permanently poison the cache for this URL — allow a later
  // caller to retry. The original `promise` returned above still rejects for
  // its own caller; this just clears the memo so the NEXT call starts fresh.
  promise.catch(() => {
    if (moduleImportCache.get(key) === promise) {
      moduleImportCache.delete(key);
    }
  });
  return promise;
}

export function __resetExtensionRegistryForTests(): void {
  clearExtensionRegistryCache();
  moduleImportCache.clear();
  moduleImporter = (url: string) => import(/* @vite-ignore */ url);
  lastAuthenticated = useAuthStore.getState().isAuthenticated;
}
