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
 *  - ONE migration in flight per org (#5016): the first stranded device an org
 *    presents is its canary, and no other device in that org is claimed until
 *    the canary has come back reporting the target edition (or has provably
 *    survived the attempt on its old build). A canary that dispatched and went
 *    silent holds the whole org — that is the point: in #5016 the gate
 *    dispatched to all six stranded PCs of one org in the same minute and all
 *    six went dark together. The check and the claim run under a per-org
 *    transaction advisory lock so two concurrent heartbeats cannot both pass.
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
import { and, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { envFlag } from '../config/env';
import { devices } from '../db/schema/devices';
import { scripts } from '../db/schema/scripts';
import { getBinaryEdition } from './binaryEdition';
import { getGithubReleaseVersion } from './binarySource';
import { compareAgentVersions } from './agentEditionCompat';
import { dispatchScriptToDevice, type DispatchScriptInput, type DispatchScriptResult } from './scriptDispatch';
import { deliverDeferredDispatch } from './scriptDeferredDelivery';
import { captureException, captureMessage } from './sentry';
import { EDITION_MIGRATION_SETTLE_INTERVAL } from './editionMigrationWindow';

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

// #7039 — stranded devices withheld because the resolved target is not the
// staged release. Unlike the precondition warns above, this is per-org and
// operator-actionable (usually an org/partner agent version pin), so it is
// keyed by org + target + staged release, names the org, pin and a device,
// and re-emits at most hourly with the count of distinct devices held back —
// a single once-per-process line scrolls away after the first deploy.
const HOLD_BACK_REWARN_MS = 60 * 60_000;
const heldBackByOrg = new Map<string, { deviceIds: Set<string>; lastWarnAt: number }>();

// #5016 — per-org canary hold. Keyed by org + canary device: warned at most
// hourly per key (every stranded heartbeat in the org would otherwise log), and
// reported to Sentry once per canary per process — a canary that dispatched
// and never came back is exactly the "six PCs went silent" failure, and an
// operator has to go and look at that device.
const CANARY_HOLD_REWARN_MS = 60 * 60_000;
const canaryHoldWarnedAt = new Map<string, number>();
const canaryReported = new Set<string>();


export function __resetEditionAutoMigrateStateForTests(): void {
  canaryHoldWarnedAt.clear();
  canaryReported.clear();
  failedDevices.clear();
  warnedConditions.clear();
  dispatchCaptured = false;
  msiShaCache = null;
  targetCache.clear();
  heldBackByOrg.clear();
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

type EditionMigrationArgs = {
  device: AutoMigrateDevice;
  reportedAgentVersion: string | null | undefined;
  normalizedArch: string | null;
  updateGateAllows: boolean;
  /** The org's effective agent version pin (null = track global latest) — part of the target-cache key. */
  pin: string | null;
  /** Pin-honouring target resolution — the heartbeat passes the same resolver the offer path uses. */
  resolveTarget: () => Promise<string | null | undefined>;
};

type PreparedEditionMigration = {
  dispatch: Extract<DispatchScriptResult, { ok: true }>;
  target: string;
};

/**
 * Owns its DB context and must be called with NONE held (#7103). The claim and
 * the command rows are written in one short system context; the command is
 * sent only after that context commits, so the agent can never answer a row
 * the result path cannot see yet. Nested inside a caller's transaction the
 * system context would join it and the send would precede the commit again.
 */
export async function maybeDispatchEditionMigration(args: EditionMigrationArgs): Promise<void> {
  const prepared = await withSystemDbAccessContext(() => prepareEditionMigration(args));
  if (!prepared) return;
  const { device } = args;
  const { target } = prepared;
  const result = await deliverDeferredDispatch(prepared.dispatch, { deviceId: device.id, caller: 'edition-auto-migrate' });
  if (!result.ok) {
    // A claim-time refusal after commit. The command row exists and was driven
    // terminal by the gate (or is left for the stale reaper), so the one-attempt
    // claim stands: releasing it could put a second reinstall in flight. Stop
    // THIS process from retrying, and report it.
    failedDevices.add(device.id);
    console.error(
      `[edition-auto-migrate] delivery refused for device ${device.id} (${result.code}): ${result.error}`,
    );
    captureException(
      new Error(`Auto edition migration delivery refused for device ${device.id}: ${result.code} — ${result.error}`),
    );
    return;
  }
  try {
    console.log(
      `[edition-auto-migrate] dispatched "${EDITION_MIGRATION_SCRIPT_NAME}" to device ${device.id} ` +
        `(${device.hostname ?? 'unknown host'}, ${args.reportedAgentVersion} -> ${target}, ` +
        `command ${result.commandId}, delivered=${result.delivered}). ` +
        'The command reports once the script hands off to its detached second stage; the migration succeeded ' +
        'when the device returns online on a hosted build.',
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
    // Informational only: the command is committed and sent or queued.
    captureException(err);
  }
}

export type UnresolvedOrgEditionMigration = {
  id: string;
  hostname: string | null;
  editionMigrationDispatchedAt: Date | null;
  lastSeenAt: Date | null;
};

/**
 * #5016 — another device in `orgId` whose automatic edition migration is still
 * unresolved, if any. Unresolved = dispatched, not decommissioned, not yet
 * reporting `targetEdition`, and not seen since the settle interval elapsed
 * (a device heartbeating on its OLD edition well after dispatch survived the
 * attempt — the dance never reached the uninstall, or aborted before it —
 * and so no longer holds the org).
 *
 * A device that went silent after dispatch stays unresolved forever, holding
 * the org until an operator deals with it (reinstalls it — it then reports the
 * target edition — or removes it). The uninstall-intent reaper deliberately
 * does NOT auto-decommission such a device (offlineDetector.ts), which would
 * otherwise both hide it and silently release this hold 24h later.
 */
export async function findUnresolvedOrgEditionMigration(args: {
  orgId: string;
  excludeDeviceId: string;
  targetEdition: string;
}): Promise<UnresolvedOrgEditionMigration | null> {
  const [row] = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      editionMigrationDispatchedAt: devices.editionMigrationDispatchedAt,
      lastSeenAt: devices.lastSeenAt,
    })
    .from(devices)
    .where(
      and(
        eq(devices.orgId, args.orgId),
        ne(devices.id, args.excludeDeviceId),
        isNotNull(devices.editionMigrationDispatchedAt),
        ne(devices.status, 'decommissioned'),
        or(isNull(devices.agentEdition), ne(devices.agentEdition, args.targetEdition)),
        or(
          isNull(devices.lastSeenAt),
          // last_seen_at is `timestamp` holding UTC wall-clock time, the stamp
          // is `timestamptz`: read last_seen_at AS UTC explicitly. A raw
          // comparison casts it through the session TimeZone and shifts the
          // settle window by the zone offset.
          sql`(${devices.lastSeenAt} AT TIME ZONE 'UTC') < ${devices.editionMigrationDispatchedAt} + ${EDITION_MIGRATION_SETTLE_INTERVAL}::interval`,
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

function warnCanaryHold(device: AutoMigrateDevice, canary: UnresolvedOrgEditionMigration): void {
  const key = `${device.orgId}:${canary.id}`;
  const now = Date.now();
  const last = canaryHoldWarnedAt.get(key);
  if (last === undefined || now - last >= CANARY_HOLD_REWARN_MS) {
    canaryHoldWarnedAt.set(key, now);
    const dispatchedAt = canary.editionMigrationDispatchedAt?.toISOString() ?? 'unknown';
    const lastSeen = canary.lastSeenAt?.toISOString() ?? 'never';
    console.warn(
      `[edition-auto-migrate] org ${device.orgId}: holding automatic edition migration for the org's other ` +
        `stranded devices (latest: ${device.id}${device.hostname ? ` ${device.hostname}` : ''}) — ` +
        `device ${canary.id}${canary.hostname ? ` ${canary.hostname}` : ''} was dispatched at ${dispatchedAt} ` +
        `and has not come back on the target edition (last seen ${lastSeen}). Check ` +
        'C:\\ProgramData\\BreezeMigration\\migration.log on that device; the org resumes once it reports the ' +
        'target edition or is removed.',
    );
  }
  if (!canaryReported.has(canary.id)) {
    canaryReported.add(canary.id);
    captureMessage(
      `Auto edition migration canary ${canary.id} (org ${device.orgId}) has not come back on the target edition; ` +
        'holding the rest of the org.',
      { eventCode: 'agent_edition_auto_migration_canary_unresolved' },
    );
  }
}

async function prepareEditionMigration(args: EditionMigrationArgs): Promise<PreparedEditionMigration | null> {
  const { device } = args;
  let claimed = false;
  let dispatchAttempted = false;
  try {
    // Idempotent re-check (the heartbeat already gates on it before opening
    // the system context): a direct caller must get the same rails.
    if (!shouldConsiderEditionMigration(args)) return null;

    const cacheKey = `${device.osType}:${args.normalizedArch}:${args.pin ?? 'latest'}`;
    const now = Date.now();
    let cached = targetCache.get(cacheKey);
    if (!cached || cached.expiresAt <= now) {
      cached = { target: (await args.resolveTarget()) ?? null, expiresAt: now + TARGET_CACHE_TTL_MS };
      targetCache.set(cacheKey, cached);
    }
    const target = cached.target;
    if (!target) return null;
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
      warnStagedVersionHoldBack({ device, pin: args.pin, target, stagedVersion });
      return null;
    }
    const reported = args.reportedAgentVersion?.trim();
    // Upgrade-only, mirroring the offer path: a pin at or below the installed
    // version is a deliberate hold and must hold auto-migration too. Known
    // gap, accepted: a stranded self-host device already AT the resolved
    // hosted target's version (edition swap without a version bump) parks
    // here until the next release moves the target past it — the alternative
    // would strip operators of the pin-as-hold semantics this feature's
    // rollout depends on.
    if (!reported || compareAgentVersions(target, reported) <= 0) return null;

    // Preconditions that don't depend on this device — checked BEFORE the
    // claim so a transient gap (script not yet ensured, MSI not yet staged,
    // env incomplete) never consumes a device's single attempt.
    const baseUrl = (process.env.PUBLIC_API_URL || process.env.API_URL || '').replace(/\/$/, '');
    if (!baseUrl) {
      warnOnce(
        'no-base-url',
        '[edition-auto-migrate] PUBLIC_API_URL/API_URL is not set; cannot build an MSI URL — auto edition migration is inert.',
      );
      return null;
    }
    const msiSha256 = await stagedMsiSha256();
    if (!msiSha256) return null;

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
      return null;
    }

    // #5016 — one migration in flight per org. The advisory lock is held until
    // this system context commits (the claim below commits with it), so a
    // concurrent heartbeat from a sibling device waits here and then SEES this
    // claim in its own in-flight check instead of racing past it.
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`edition-auto-migrate:${device.orgId}`}, 0))`,
    );
    const inFlight = await findUnresolvedOrgEditionMigration({
      orgId: device.orgId,
      excludeDeviceId: device.id,
      targetEdition: getBinaryEdition(),
    });
    if (inFlight) {
      // An ordinary stand-down, like the staged-version hold: no claim burned,
      // no in-process veto, so this device is picked up on a later heartbeat
      // once the canary resolves.
      warnCanaryHold(device, inFlight);
      return null;
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
    if (claimRows.length === 0) return null;
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
      // The canary release and the reaper exclusion both measure their 2h
      // window from this claim, so the command must not sit queued past it
      // (the default script class queues for 168h). 15 min + the 1800s script
      // budget + stage-2 waits stays inside the window.
      offlinePolicy: { kind: 'queue', deliverWithinMs: 15 * 60_000 },
      // #7103 — sent by the caller after this context commits.
      deferDelivery: true,
    });

    if (!result.ok) {
      // Nothing reached the device: release the claim so a future process can
      // retry, but stop THIS process from retrying every 60s heartbeat.
      await releaseClaim(device.id);
      claimed = false;
      if (result.code === 'maintenance_suppressed') {
        // #4919 — an ORDINARY stand-down, not a fault. The migration IS this
        // device's update, so a window that suppresses scripts suppresses it
        // too. Note what this branch does NOT do: it does not add the device
        // to `failedDevices`. That set is a permanent (process-lifetime) veto,
        // and a maintenance window is temporary — poisoning it here would mean
        // a device that happened to heartbeat during a nightly window never
        // migrated again until the API restarted. The released claim plus an
        // un-poisoned device is exactly "try again next heartbeat". Reporting
        // it to Sentry would page on an operator's own maintenance schedule.
        console.log(
          `[edition-auto-migrate] deferred for device ${device.id}: ${result.error}`,
        );
        return null;
      }
      failedDevices.add(device.id);
      console.error(
        `[edition-auto-migrate] dispatch refused for device ${device.id} (${result.code}): ${result.error}`,
      );
      captureException(
        new Error(
          `Auto edition migration dispatch refused for device ${device.id}: ${result.code} — ${result.error}`,
        ),
      );
      return null;
    }

    // The dispatch reached the queue: the one-attempt claim must stand from
    // here on, whatever delivery and the informational logging do.
    claimed = false;
    return { dispatch: result, target };
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
    return null;
  }
}

function warnStagedVersionHoldBack(args: {
  device: AutoMigrateDevice;
  pin: string | null;
  target: string;
  stagedVersion: string;
}): void {
  const { device, pin, target, stagedVersion } = args;
  const key = `${device.orgId}:${target}:${stagedVersion}`;
  const now = Date.now();
  let entry = heldBackByOrg.get(key);
  const firstSighting = !entry;
  if (!entry) {
    entry = { deviceIds: new Set(), lastWarnAt: now };
    heldBackByOrg.set(key, entry);
  }
  entry.deviceIds.add(device.id);
  if (!firstSighting && now - entry.lastWarnAt < HOLD_BACK_REWARN_MS) return;
  entry.lastWarnAt = now;

  const count = entry.deviceIds.size;
  const subject =
    `[edition-auto-migrate] org ${device.orgId}: withholding automatic edition migration for ` +
    `${count} stranded self-host device(s) seen since startup (latest: ${device.id}` +
    `${device.hostname ? ` ${device.hostname}` : ''})`;
  let reason: string;
  if (stagedVersion === 'latest') {
    reason =
      `this deployment's staged binaries release is unknown (BINARY_VERSION, BREEZE_BINARIES_VERSION and ` +
      `BREEZE_VERSION all unset), so the raw MSI route's installer cannot be matched to the resolved target ` +
      `${target}. Set BREEZE_VERSION to the staged release.`;
  } else if (pin) {
    reason =
      `the effective agent version pin ${pin} (org setting, or the partner default it inherits) holds them at ` +
      `${target}, but the raw MSI route serves only the staged release ${stagedVersion}. ` +
      `To migrate these devices, raise or clear the agent version pin to ${stagedVersion}; ` +
      `leave it if the hold is intended.`;
  } else {
    reason =
      `there is no agent version pin and the promoted latest agent resolves to ${target}, but the raw MSI ` +
      `route serves only the staged release ${stagedVersion}. They migrate once the promoted latest and ` +
      `the staged release agree.`;
  }
  console.warn(`${subject}: ${reason}`);
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
