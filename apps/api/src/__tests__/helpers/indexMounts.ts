/**
 * Reads the router mounts out of `index.ts` (the composition root) without
 * booting it, so contract tests can load each mounted router on its own.
 *
 * Shared by `routerAuthGate.contract.test.ts` (every protected mount rejects a
 * bare request) and `writeRoutePermissionGate.contract.test.ts` (every write
 * route carries a permission gate).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono, type MiddlewareHandler } from 'hono';

export interface IndexMount {
  /** `api` (mounted under /api/v1) or `app` (mounted at the root). */
  owner: 'api' | 'app';
  /** Mount path passed to `.route()`. */
  path: string;
  /** Full router expression, e.g. `deviceRoutes` or `createAgentWsRoutes(upgradeWebSocket)`. */
  expression: string;
}

const INDEX_URL = new URL('../../index.ts', import.meta.url);
const AUTOPAY_MOUNT_URL = new URL('../../routes/autopay/mount.ts', import.meta.url);

export const indexSource = readFileSync(INDEX_URL, 'utf8');
const chargingMountSource = readFileSync(AUTOPAY_MOUNT_URL, 'utf8');

function collectImports(source: string, prefix: string, into: Map<string, { module: string; exported: string }>) {
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const binding of match[1]!.split(',')) {
      const [exported, local = exported] = binding.trim().split(/\s+as\s+/);
      if (exported && local) into.set(local, { module: `${prefix}${match[2]!}`, exported });
    }
  }
}

/** Local import name → module specifier (relative to index.ts) and exported name. */
export const indexImports = new Map<string, { module: string; exported: string }>();
collectImports(indexSource, '', indexImports);
// The autopay charging router is mounted by a helper rather than literally in
// index.ts; its imports resolve relative to routes/autopay/.
collectImports(chargingMountSource, './routes/autopay/', indexImports);

// Capture the complete expression (including factory calls), not only names.
export const literalMounts: IndexMount[] = [
  ...indexSource.matchAll(/^\s*(api|app)\.route\(\s*['"]([^'"]+)['"]\s*,\s*(.*?)\s*\);/gm),
].map((match) => ({ owner: match[1] as 'api' | 'app', path: match[2]!, expression: match[3]! }));

export const chargingMounts: IndexMount[] = [
  ...chargingMountSource.matchAll(/api\.route\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\s*\)/g),
].map((match) => ({ owner: 'api' as const, path: match[1]!, expression: match[2]! }));

export const indexMounts: IndexMount[] = [...literalMounts, ...chargingMounts];

/** Count of `.route(` calls in index.ts — lets callers assert the regex saw every mount. */
export const indexRouteCallCount = [...indexSource.matchAll(/\b(?:api|app)\.route\s*\(/g)].length;
export const indexCallsChargingMount = indexSource.includes('mountAutopayChargingRoutes(api)');

/**
 * Import the router named by a mount expression. Ordinary imports and
 * zero-argument router factories are supported; anything else throws so new
 * composition syntax fails loudly instead of escaping the contract.
 */
export async function loadMountedRouter(
  expression: string,
  options: { allowUpgradeWebSocketFactories?: boolean } = {},
): Promise<Hono> {
  const parsed = /^(\w+)(\((upgradeWebSocket)?\))?$/.exec(expression);
  if (!parsed) throw new Error(`Unsupported router expression: ${expression}`);
  if (parsed[3] && !options.allowUpgradeWebSocketFactories) {
    throw new Error(`Unsupported router expression: ${expression}`);
  }
  const binding = indexImports.get(parsed[1]!);
  if (!binding) throw new Error(`No import found for ${expression}`);
  const modulePath = fileURLToPath(new URL(binding.module, INDEX_URL));
  const exports = await import(modulePath);
  const factoryArgs = parsed[3] ? [stubUpgradeWebSocket] : [];
  const router = parsed[2] ? exports[binding.exported](...factoryArgs) : exports[binding.exported];
  if (!(router instanceof Hono)) throw new Error(`${expression} is not a Hono router`);
  return router;
}

/**
 * Stand-in for the node-ws `upgradeWebSocket` adapter: route registration only
 * needs it to return a middleware. Requests through it are never made.
 */
function stubUpgradeWebSocket(): MiddlewareHandler {
  return async (_c, next) => next();
}
