/**
 * Automatic agent edition migration (#4072 follow-up).
 *
 * The heartbeat's artifact-edition gate (agentEditionCompat.ts) withholds
 * update offers from self-host-edition builds that would refuse a
 * hosted-edition artifact — leaving those devices permanently stranded on
 * their installed version, because the refusal is agent-side and cannot be
 * fixed OTA. The only recovery is the identity-preserving MSI reinstall the
 * 'Migrate Agent Edition (Windows)' system script performs
 * (systemScriptLibrary.ts, PR #4102), which until now an operator had to
 * dispatch by hand per device.
 *
 * This module closes the loop: when the gate withholds an offer for a live
 * Windows/amd64 device, the heartbeat calls maybeDispatchEditionMigration()
 * fire-and-forget, and — behind a default-off env flag — the script is
 * dispatched automatically with a server-derived MSI URL + sha256.
 *
 * Safety rails, in order of evaluation:
 *  - AGENT_EDITION_AUTO_MIGRATE_ENABLED must be exactly 'true' (default off).
 *  - Hosted-serving deployments only: hosted builds hard-refuse self-host
 *    artifacts BY DESIGN, so the hosted→self-host direction is never
 *    auto-migrated.
 *  - Windows/amd64 only — the migration script and the staged MSI are.
 *  - The org's effective update policy + maintenance window gate
 *    (updateGateAllows, resolved by the heartbeat) must allow an update right
 *    now: the migration IS this device's update, delivered differently.
 *  - The tenant's version pin is honoured via resolveTarget (the same
 *    resolvePinnedUpgradeTarget the offer path uses): no resolvable target, or
 *    a target not newer than the installed version (a holdback pin), means no
 *    migration. Pinning an org to its current version therefore acts as the
 *    operator hold for auto-migration too.
 *  - ONE attempt per device, ever: an atomic claim on
 *    devices.edition_migration_dispatched_at (UPDATE ... WHERE ... IS NULL)
 *    makes concurrent heartbeats race safely, and a dispatched-but-failed MSI
 *    dance is never auto-retried into an uninstall/reinstall loop — that
 *    device is an operator's to look at (Sentry has it). Only a dispatch that
 *    never reached the queue releases the claim, and even then an in-process
 *    dedupe stops hot retry loops until the API restarts.
 *
 * The MSI is served by the RAW installer route this feature ships with
 * (GET /api/v1/agents/download/windows/amd64/msi, routes/agents/download.ts):
 * unlike the enrollment installer routes, it embeds no per-download bootstrap
 * token, so its bytes match the staged file and the sha256 pin computed here.
 * Both route and hash read the same AGENT_BINARY_DIR file, so the pin can only
 * mismatch if the file changes between dispatch and download — in which case
 * the script verifies-then-aborts before touching the installed agent.
 *
 * MUST be invoked outside the heartbeat's request transaction (the hook wraps
 * the call in runOutsideDbContext + withSystemDbAccessContext): the caller
 * fires it detached, and the org-scoped withDbAccessContext transaction it
 * would otherwise inherit commits when the handler returns — leaving this
 * promise's queries pointed at a dead tx handle. System context is safe here:
 * every value dispatched was validated inside the org-scoped block, and
 * dispatchScriptToDevice's own org-equality invariant still applies.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join, resolve } from 'node:path';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { db } from '../db';
import { envFlag } from '../config/env';
import { devices } from '../db/schema/devices';
import { scripts } from '../db/schema/scripts';
import { getBinaryEdition } from './binaryEdition';
import { getGithubReleaseVersion } from './binarySource';
import { compareAgentVersions } from './agentEditionCompat';
import { dispatchScriptToDevice, type DispatchScriptInput } from './scriptDispatch';
import { captureException, captureMessage } from './sentry';

export const EDITION_MIGRATION_SCRIPT_NAME = 'Migrate Agent Edition (Windows)';

export function editionAutoMigrateEnabled(): boolean {
  return envFlag('AGENT_EDITION_AUTO_MIGRATE_ENABLED');
}

// In-process guards. `failedDevices` stops a released claim from re-arming a
// 60s-cadence retry loop for the life of this process; `warnedConditions`
// dedupes the precondition warns (missing script/MSI/base URL) that would
// otherwise log on every stranded heartbeat.
const failedDevices = new Set<string>();
const warnedConditions = new Set<string>();
let dispatchCaptured = false;

// Upgrade targets only change on release registration / pin writes, but a
// held-back stranded fleet would otherwise re-run the resolver's
// agent_versions SELECT on every ~60s heartbeat forever. Same in-process
// cache-with-invalidation idea as msiShaCache below, keyed by everything the
// resolution depends on.
const TARGET_CACHE_TTL_MS = 60_000;
const targetCache = new Map<string, { target: string | null; expiresAt: number }>();

export function __resetEditionAutoMigrateStateForTests(): void {
  failedDevices.clear();
  warnedConditions.clear();
  dispatchCaptured = false;
  msiShaCache = null;
  targetCache.clear();
}

function warnOnce(key: string, message: string): void {
  if (warnedConditions.has(key)) return;
  warnedConditions.add(key);
  console.warn(message);
}

// sha256 of the staged MSI, cached by (mtimeMs, size) so the hot path stats
// instead of re-hashing ~30MB per stranded device. binaries-init replaces the
// file on deploy, which changes the mtime and invalidates the cache. The hash
// itself streams (pipeline + chunked digest updates) rather than
// readFileSync-ing the whole installer, so the cache-miss path never stalls
// the event loop for the duration of a 30MB read+digest.
let msiShaCache: { mtimeMs: number; size: number; sha256: string } | null = null;
// Cold-cache singleflight: a reconnect burst of stranded devices must stream
// the 30MB installer once, not once per concurrent heartbeat.
let msiShaInFlight: Promise<string | null> | null = null;

function stagedMsiPath(): string {
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  return join(binaryDir, 'breeze-agent.msi');
}

async function stagedMsiSha256(): Promise<string | null> {
  if (msiShaInFlight) return msiShaInFlight;
  msiShaInFlight = computeStagedMsiSha256().finally(() => {
    msiShaInFlight = null;
  });
  return msiShaInFlight;
}

async function computeStagedMsiSha256(): Promise<string | null> {
  try {
    const path = stagedMsiPath();
    const fileStat = await stat(path);
    if (msiShaCache && msiShaCache.mtimeMs === fileStat.mtimeMs && msiShaCache.size === fileStat.size) {
      return msiShaCache.sha256;
    }
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    const sha256 = hash.digest('hex');
    msiShaCache = { mtimeMs: fileStat.mtimeMs, size: fileStat.size, sha256 };
    return sha256;
  } catch (err) {
    warnOnce(
      'msi-unreadable',
      `[edition-auto-migrate] staged MSI at ${stagedMsiPath()} is unreadable; ` +
        `auto edition migration is inert until it is staged. ${String(err)}`,
    );
    return null;
  }
}

type AutoMigrateDevice = DispatchScriptInput['device'] &
  Pick<typeof devices.$inferSelect, 'editionMigrationDispatchedAt'>;

/**
 * The cheap, non-DB gate — exported so the heartbeat can decide whether to
 * launch the (system-context-opening) dispatch at all. A flag-off deployment
 * or a non-candidate device must cost the heartbeat exactly these comparisons:
 * no AsyncLocalStorage exit, no system context, no second transaction.
 */
export function shouldConsiderEditionMigration(args: {
  device: AutoMigrateDevice;
  normalizedArch: string | null;
  updateGateAllows: boolean;
}): boolean {
  const { device } = args;
  if (!editionAutoMigrateEnabled()) return false;
  // One-way by design: hosted builds hard-refuse self-host artifacts, so a
  // self-host-serving deployment never auto-migrates anything.
  if (getBinaryEdition() !== 'hosted') return false;
  if (device.osType !== 'windows' || args.normalizedArch !== 'amd64') return false;
  if (!args.updateGateAllows) return false;
  if (device.editionMigrationDispatchedAt) return false;
  if (failedDevices.has(device.id)) return false;
  return true;
}

export async function maybeDispatchEditionMigration(args: {
  device: AutoMigrateDevice;
  reportedAgentVersion: string | null | undefined;
  normalizedArch: string | null;
  updateGateAllows: boolean;
  /** The org's effective agent version pin (null = track global latest) — part of the target-cache key. */
  pin: string | null;
  /** Pin-honouring target resolution — the heartbeat passes the same resolver the offer path uses. */
  resolveTarget: () => Promise<string | null | undefined>;
}): Promise<void> {
  const { device } = args;
  let claimed = false;
  let dispatchAttempted = false;
  try {
    // Idempotent re-check (the heartbeat already gates on it before opening
    // the system context): a direct caller must get the same rails.
    if (!shouldConsiderEditionMigration(args)) return;

    const cacheKey = `${device.osType}:${args.normalizedArch}:${args.pin ?? 'latest'}`;
    const now = Date.now();
    let cached = targetCache.get(cacheKey);
    if (!cached || cached.expiresAt <= now) {
      cached = { target: (await args.resolveTarget()) ?? null, expiresAt: now + TARGET_CACHE_TTL_MS };
      targetCache.set(cacheKey, cached);
    }
    const target = cached.target;
    if (!target) return;
    // The raw MSI route serves THE deployment's single staged installer —
    // whatever binaries-init staged for the release this server is pinned to.
    // The resolved target (pin, or controlled-promotion isLatest) must be
    // exactly that version, or dispatching would install something the tenant
    // did not select: an org pinned to 0.106 must never receive the staged
    // 0.108, and a staged release newer than the promoted isLatest must not
    // leak to the fleet ahead of promotion. Fail closed (skip, no claim
    // burned) on any mismatch or when the deployment's release is unknown.
    const stagedVersion = getGithubReleaseVersion();
    if (stagedVersion === 'latest' || compareAgentVersions(target, stagedVersion) !== 0) {
      warnOnce(
        `staged-version-mismatch:${target}:${stagedVersion}`,
        `[edition-auto-migrate] resolved target ${target} does not match this deployment's staged release ` +
          `${stagedVersion}; withholding automatic migration (the raw MSI route serves the staged installer only).`,
      );
      return;
    }
    const reported = args.reportedAgentVersion?.trim();
    // Upgrade-only, mirroring the offer path: a pin at or below the installed
    // version is a deliberate hold and must hold auto-migration too. Known
    // gap, accepted: a stranded self-host device already AT the resolved
    // hosted target's version (edition swap without a version bump) parks
    // here until the next release moves the target past it — the alternative
    // would strip operators of the pin-as-hold semantics this feature's
    // rollout depends on.
    if (!reported || compareAgentVersions(target, reported) <= 0) return;

    // Preconditions that don't depend on this device — checked BEFORE the
    // claim so a transient gap (script not yet ensured, MSI not yet staged,
    // env incomplete) never consumes a device's single attempt.
    const baseUrl = (process.env.PUBLIC_API_URL || process.env.API_URL || '').replace(/\/$/, '');
    if (!baseUrl) {
      warnOnce(
        'no-base-url',
        '[edition-auto-migrate] PUBLIC_API_URL/API_URL is not set; cannot build an MSI URL — auto edition migration is inert.',
      );
      return;
    }
    const msiSha256 = await stagedMsiSha256();
    if (!msiSha256) return;

    const [script] = await db
      .select()
      .from(scripts)
      .where(
        and(
          eq(scripts.name, EDITION_MIGRATION_SCRIPT_NAME),
          eq(scripts.isSystem, true),
          isNull(scripts.deletedAt),
        ),
      )
      .limit(1);
    if (!script) {
      warnOnce(
        'script-missing',
        `[edition-auto-migrate] system script "${EDITION_MIGRATION_SCRIPT_NAME}" not found ` +
          '(not ensured yet, or operator-deleted) — auto edition migration is inert.',
      );
      return;
    }

    // Atomic once-per-device claim: whichever concurrent heartbeat wins this
    // UPDATE dispatches; everyone else sees zero rows and stands down.
    // Bound to the org and liveness the decision was made under: a device
    // moved to another org (whose policy/pins were never consulted) or
    // decommissioned between the heartbeat and this detached claim must not
    // be migrated on stale grounds.
    const claimRows = await db
      .update(devices)
      .set({ editionMigrationDispatchedAt: new Date() })
      .where(
        and(
          eq(devices.id, device.id),
          eq(devices.orgId, device.orgId),
          ne(devices.status, 'decommissioned'),
          isNull(devices.editionMigrationDispatchedAt),
        ),
      )
      .returning({ id: devices.id });
    if (claimRows.length === 0) return;
    claimed = true;

    dispatchAttempted = true;
    const result = await dispatchScriptToDevice({
      device,
      source: { kind: 'saved', script },
      parameters: {
        msi_url: `${baseUrl}/api/v1/agents/download/windows/amd64/msi`,
        msi_sha256: msiSha256,
        target_edition: getBinaryEdition(),
      },
      triggerType: 'policy',
      createdBy: null,
      triggeredBy: null,
    });

    if (!result.ok) {
      // Nothing reached the device: release the claim so a future process can
      // retry, but stop THIS process from retrying every 60s heartbeat.
      failedDevices.add(device.id);
      await releaseClaim(device.id);
      claimed = false;
      console.error(
        `[edition-auto-migrate] dispatch refused for device ${device.id} (${result.code}): ${result.error}`,
      );
      captureException(
        new Error(
          `Auto edition migration dispatch refused for device ${device.id}: ${result.code} — ${result.error}`,
        ),
      );
      return;
    }

    // The dispatch reached the queue: the one-attempt claim must stand from
    // here on, whatever the informational logging below does.
    claimed = false;
    console.log(
      `[edition-auto-migrate] dispatched "${EDITION_MIGRATION_SCRIPT_NAME}" to device ${device.id} ` +
        `(${device.hostname ?? 'unknown host'}, ${args.reportedAgentVersion} -> ${target}, ` +
        `command ${result.commandId}, delivered=${result.delivered}). ` +
        'The command is expected to report no result; verify via the device returning online on a hosted build.',
    );
    if (!dispatchCaptured) {
      dispatchCaptured = true;
      captureMessage(
        'Auto edition migration dispatched for at least one stranded device this process lifetime; ' +
          'see per-device [edition-auto-migrate] logs.',
        { eventCode: 'agent_edition_auto_migration_dispatched' },
      );
    }
  } catch (err) {
    failedDevices.add(device.id);
    // Release ONLY when we know nothing reached the queue. A THROW from
    // dispatchScriptToDevice is indeterminate — it does post-insert work, so
    // the command may already exist; releasing there could let a later
    // process dispatch a second reinstall to a device that is mid-dance.
    // Fail toward the one-attempt invariant and leave the claim standing.
    if (claimed && !dispatchAttempted) {
      await releaseClaim(device.id);
    }
    console.error(`[edition-auto-migrate] failed for device ${device.id}:`, err);
    captureException(err);
  }
}

async function releaseClaim(deviceId: string): Promise<void> {
  try {
    await db
      .update(devices)
      .set({ editionMigrationDispatchedAt: null })
      .where(eq(devices.id, deviceId));
  } catch (releaseErr) {
    // The stale claim just means no second attempt — safe, log and move on.
    console.error(`[edition-auto-migrate] failed to release claim for device ${deviceId}:`, releaseErr);
  }
}
