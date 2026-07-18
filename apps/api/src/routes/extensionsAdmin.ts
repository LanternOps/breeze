/**
 * Platform-admin operations surface for runtime extensions.
 *
 * Mounted at `/api/v1/admin/extensions` and gated by `platformAdminMiddleware`
 * (which itself runs `authMiddleware` first, enforces `isPlatformAdmin === true`
 * and audit-logs every request that reaches a handler).
 *
 * ── SOURCE-OF-TRUTH BOUNDARY ────────────────────────────────────────────────
 * `extensions.yaml` is the ONLY store of DESIRED state: which artifact, which
 * version, which digest, which publisher, whether it is required. None of that
 * is writable here, and this router never writes it to PostgreSQL. The single
 * mutable thing on this surface is the RUNTIME on/off switch
 * (`installed_extensions.enabled`), which is deliberately operational state:
 * an operator must be able to shut a misbehaving extension off fleet-wide
 * without a redeploy. Installing/upgrading is `breezectl extensions install`,
 * which edits the YAML.
 *
 * ── FLEET SEMANTICS ─────────────────────────────────────────────────────────
 * The `enabled` flag is the cross-replica contract: the request gateway
 * consults it per request (enabledGate.ts, no caching) and the job processor
 * re-checks it per tick (jobHost.ts), so every replica honors a flip
 * immediately. The registry mutation and schedule resync below are the LOCAL
 * replica's fast path plus the fleet-wide schedule cleanup — see
 * `applyEnabled` for why both are needed.
 *
 * ── SANITIZATION ────────────────────────────────────────────────────────────
 * Nothing derived from a raw error, a filesystem path, a key file, or a config
 * secret is serialized. Error text is reconstructed from the coarse persisted
 * CATEGORY via a fixed lookup table, so even a row written by some future code
 * path with a chatty message cannot leak through this surface. Fault
 * attribution is reported as a boolean, never as the extracted-root path.
 */
import { Hono, type Context } from 'hono';
import { platformAdminMiddleware } from '../middleware/platformAdmin';
import {
  checkExtensionCompatibility,
  type CompatibilityResult,
  type ExtensionHostDescriptor,
} from '../extensions/compatibility';
import { HOST_DESCRIPTOR } from '../extensions/hostDescriptor';
import {
  extensionContributionRegistry,
  type ExtensionContributionRegistry,
} from '../extensions/contributionRegistry';
import { extensionRootsSnapshot } from '../extensions/faultAttribution';
import { resyncExtensionSchedules } from '../extensions/jobHost';
import {
  createExtensionStateStore,
  type ExtensionStateRecord,
  type ExtensionStateStore,
} from '../extensions/stateStore';

/**
 * Fixed, secret-free explanations keyed by the coarse failure CATEGORY the
 * reconciler persists. The persisted `last_error_message` is never read; this
 * table is the only thing an operator sees, so the surface is provably free of
 * bundle bytes, key material, paths, SQL, and exception text.
 */
const CATEGORY_SUMMARIES: Record<string, string> = {
  acquire: 'failed to acquire the extension artifact',
  trust: 'could not establish the extension publisher trust anchor',
  verify: 'extension bundle verification failed',
  observe: 'failed to record extension observed state',
  compatibility: 'extension is not compatible with this host',
  incompatible: 'extension is not compatible with this host',
  extract: 'failed to extract the verified extension payload',
  load: 'failed to load the extension server module',
  migration: 'extension database migrations failed',
  tenancy: 'extension tenancy validation failed',
  stage: 'failed to stage extension contributions',
  activate: 'failed to activate extension contributions',
};

function errorSummary(category: string | null): string | null {
  if (!category) return null;
  return CATEGORY_SUMMARIES[category] ?? 'extension reconciliation failed';
}

/** The state-store surface this router needs (injectable for tests). */
export type ExtensionsAdminStore = Pick<ExtensionStateStore, 'listAll' | 'get' | 'setEnabled'>;

/** The registry surface this router needs (injectable for tests). */
export type ExtensionsAdminRegistry = Pick<
  ExtensionContributionRegistry,
  'get' | 'activate' | 'withdraw'
>;

export interface ExtensionsAdminDeps {
  stateStore: ExtensionsAdminStore;
  registry: ExtensionsAdminRegistry;
  /**
   * Reconcile the BullMQ repeatable schedules against the current registry.
   * Best-effort: a failure (Redis down) must not fail the enable/disable.
   */
  resyncSchedules: () => Promise<void>;
  hostDescriptor: ExtensionHostDescriptor;
  /** Live extension-name → extracted-root map (used only as a presence check). */
  extensionRoots: () => ReadonlyMap<string, string>;
}

/** The sanitized row shape returned by `GET /`. */
function sanitizeRecord(
  row: ExtensionStateRecord,
  loadedInThisReplica: boolean,
): Record<string, unknown> {
  return {
    name: row.name,
    enabled: row.enabled,
    lifecycleState: row.lifecycleState,
    // Desired state, as OBSERVED from extensions.yaml + the verified bundle.
    // Read-only here; `breezectl extensions install/upgrade` changes it.
    configuredVersion: row.configuredVersion,
    activeVersion: row.activeVersion,
    // The ARTIFACT digest is a public content address of a signed bundle — it
    // is the thing an operator pins in extensions.yaml, not a secret.
    artifactDigest: row.artifactDigest,
    publisher: row.publisherId,
    manifestApiVersion: row.manifestApiVersion,
    requiresServerSdk: row.serverSdkVersion,
    requiresWebSdk: row.webSdkVersion,
    errorCategory: row.lastErrorCategory,
    errorSummary: errorSummary(row.lastErrorCategory),
    migratedAt: row.migratedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
    loadedInThisReplica,
  };
}

export function createExtensionsAdminRoutes(deps: ExtensionsAdminDeps): Hono {
  const routes = new Hono();

  // ONE gate for the whole group — mirrors routes/admin/index.ts.
  routes.use('*', platformAdminMiddleware);

  routes.get('/', async (c) => {
    const rows = await deps.stateStore.listAll();
    return c.json({
      extensions: rows.map((row) =>
        sanitizeRecord(row, deps.registry.get(row.name) !== undefined),
      ),
    });
  });

  routes.get('/:name/doctor', async (c) => {
    const name = c.req.param('name');
    const row = await deps.stateStore.get(name);
    if (!row) return c.json({ error: 'extension not found' }, 404);

    const snapshot = deps.registry.get(name);

    // Compatibility can only be recomputed when this replica actually holds the
    // verified manifest. When the bundle never loaded here (another replica
    // owns it, or it failed before `load`), report null rather than guessing —
    // a fabricated "compatible" would be worse than an honest unknown.
    let compatibility: CompatibilityResult | null = null;
    if (snapshot) {
      compatibility = checkExtensionCompatibility(snapshot.manifest, deps.hostDescriptor);
    }

    return c.json({
      name: row.name,
      enabled: row.enabled,
      lifecycleState: row.lifecycleState,
      configuredVersion: row.configuredVersion,
      activeVersion: row.activeVersion,
      artifactDigest: row.artifactDigest,
      publisher: row.publisherId,
      manifestApiVersion: row.manifestApiVersion,
      requiresServerSdk: row.serverSdkVersion,
      requiresWebSdk: row.webSdkVersion,
      errorCategory: row.lastErrorCategory,
      errorSummary: errorSummary(row.lastErrorCategory),
      compatibility,
      faultAttribution: {
        // Presence only. The extracted root is an on-disk path and is never
        // serialized; a boolean is all an operator needs to know whether a
        // process fault could be attributed to this extension here.
        codeLoaded: deps.extensionRoots().has(name),
        routeNamespace: snapshot?.manifest.routeNamespace ?? null,
        jobs: snapshot ? [...snapshot.jobs.keys()] : [],
        aiTools: snapshot ? [...snapshot.aiTools.keys()] : [],
      },
      activatedAt: row.activatedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt?.toISOString() ?? null,
    });
  });

  routes.post('/:name/enable', (c) => applyEnabled(c, deps, true));
  routes.post('/:name/disable', (c) => applyEnabled(c, deps, false));

  return routes;
}

/**
 * Flip the runtime enabled flag and make it take effect NOW.
 *
 * Three things happen, in this order, and the order matters:
 *
 *  1. `stateStore.setEnabled` — the durable, fleet-wide source of truth for the
 *     on/off switch. Every replica's request gateway and job processor read it,
 *     so this alone already stops new requests and new job ticks everywhere.
 *  2. Registry withdraw/activate — the LOCAL replica's in-process view. The
 *     registry keeps the staged snapshot and only flips its `enabled` field, so
 *     a disable is fully reversible without a restart.
 *  3. Schedule resync — the piece the boot-only `ExtensionJobHost.sync()` could
 *     not deliver. Without this, a disabled extension's BullMQ REPEATABLE
 *     entries keep firing (the processor skips them, but the schedules linger
 *     and reappear as churn) until the next restart. Resyncing here removes the
 *     disabled extension's repeatables immediately, and restores them on enable.
 *
 * Step 3 is BEST-EFFORT on purpose: scheduling lives in Redis, the flag lives in
 * PostgreSQL, and an operator disabling a misbehaving extension must not be
 * blocked because Redis is unreachable. If the resync throws we still return
 * 200 with `scheduleSyncDeferred: true` — the flag is already authoritative, the
 * processor already skips disabled jobs, and the next boot's `sync()` reconciles
 * the leftover schedules.
 */
async function applyEnabled(
  c: Context,
  deps: ExtensionsAdminDeps,
  enabled: boolean,
): Promise<Response> {
  const name = c.req.param('name');
  if (!name) return c.json({ error: 'extension name is required' }, 400);

  const row = await deps.stateStore.get(name);
  if (!row) return c.json({ error: 'extension not found' }, 404);

  await deps.stateStore.setEnabled(name, enabled);

  const snapshot = deps.registry.get(name);
  if (snapshot) {
    if (enabled) {
      deps.registry.activate({ ...snapshot, enabled: true });
    } else {
      deps.registry.withdraw(name);
    }
  }

  let scheduleSyncDeferred = false;
  try {
    await deps.resyncSchedules();
  } catch (error) {
    // Log the raw error for the operator's server logs, but never return it.
    scheduleSyncDeferred = true;
    console.error(
      `[extensions] schedule resync after ${enabled ? 'enable' : 'disable'} of "${name}" failed; ` +
        'the enabled flag is applied and will be honored per request and per job tick',
      error,
    );
  }

  return c.json({ name, enabled, scheduleSyncDeferred });
}

/** The production router, wired to the shared registry, store and job queue. */
export const extensionsAdminRoutes = createExtensionsAdminRoutes({
  stateStore: createExtensionStateStore(),
  registry: extensionContributionRegistry,
  resyncSchedules: () => resyncExtensionSchedules(),
  hostDescriptor: HOST_DESCRIPTOR,
  extensionRoots: extensionRootsSnapshot,
});
