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
 * Runs in the heartbeat's ambient org-scoped DB context: system scripts are
 * org-readable (2026-05-15-scripts-is-system-rls-select.sql) and the
 * script_executions/device claim writes are to the device's own org.
 */

import { createHash } from 'node:crypto';
import { statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { devices } from '../db/schema/devices';
import { scripts } from '../db/schema/scripts';
import { getBinaryEdition } from './binaryEdition';
import { compareAgentVersions } from './agentEditionCompat';
import { dispatchScriptToDevice, type DispatchScriptInput } from './scriptDispatch';
import { captureException } from './sentry';

export const EDITION_MIGRATION_SCRIPT_NAME = 'Migrate Agent Edition (Windows)';

export function editionAutoMigrateEnabled(): boolean {
  return process.env.AGENT_EDITION_AUTO_MIGRATE_ENABLED === 'true';
}

// In-process guards. `failedDevices` stops a released claim from re-arming a
// 60s-cadence retry loop for the life of this process; `warnedConditions`
// dedupes the precondition warns (missing script/MSI/base URL) that would
// otherwise log on every stranded heartbeat.
const failedDevices = new Set<string>();
const warnedConditions = new Set<string>();
let dispatchCaptured = false;

export function __resetEditionAutoMigrateStateForTests(): void {
  failedDevices.clear();
  warnedConditions.clear();
  dispatchCaptured = false;
  msiShaCache = null;
}

function warnOnce(key: string, message: string): void {
  if (warnedConditions.has(key)) return;
  warnedConditions.add(key);
  console.warn(message);
}

// sha256 of the staged MSI, cached by (mtimeMs, size) so the hot path stats
// instead of re-hashing ~30MB per stranded device. binaries-init replaces the
// file on deploy, which changes the mtime and invalidates the cache.
let msiShaCache: { mtimeMs: number; size: number; sha256: string } | null = null;

function stagedMsiPath(): string {
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  return join(binaryDir, 'breeze-agent.msi');
}

function stagedMsiSha256(): string | null {
  try {
    const path = stagedMsiPath();
    const stat = statSync(path);
    if (msiShaCache && msiShaCache.mtimeMs === stat.mtimeMs && msiShaCache.size === stat.size) {
      return msiShaCache.sha256;
    }
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    msiShaCache = { mtimeMs: stat.mtimeMs, size: stat.size, sha256 };
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

export async function maybeDispatchEditionMigration(args: {
  device: AutoMigrateDevice;
  reportedAgentVersion: string | null | undefined;
  normalizedArch: string | null;
  updateGateAllows: boolean;
  /** Pin-honouring target resolution — the heartbeat passes the same resolver the offer path uses. */
  resolveTarget: () => Promise<string | null | undefined>;
}): Promise<void> {
  const { device } = args;
  let claimed = false;
  try {
    if (!editionAutoMigrateEnabled()) return;
    // One-way by design: hosted builds hard-refuse self-host artifacts, so a
    // self-host-serving deployment never auto-migrates anything.
    if (getBinaryEdition() !== 'hosted') return;
    if (device.osType !== 'windows' || args.normalizedArch !== 'amd64') return;
    if (!args.updateGateAllows) return;
    if (device.editionMigrationDispatchedAt) return;
    if (failedDevices.has(device.id)) return;

    const target = (await args.resolveTarget()) ?? null;
    if (!target) return;
    const reported = args.reportedAgentVersion?.trim();
    // Upgrade-only, mirroring the offer path: a pin at or below the installed
    // version is a deliberate hold and must hold auto-migration too.
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
    const msiSha256 = stagedMsiSha256();
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
    const claimRows = await db
      .update(devices)
      .set({ editionMigrationDispatchedAt: new Date() })
      .where(and(eq(devices.id, device.id), isNull(devices.editionMigrationDispatchedAt)))
      .returning({ id: devices.id });
    if (claimRows.length === 0) return;
    claimed = true;

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

    console.warn(
      `[edition-auto-migrate] dispatched "${EDITION_MIGRATION_SCRIPT_NAME}" to device ${device.id} ` +
        `(${device.hostname ?? 'unknown host'}, ${args.reportedAgentVersion} -> ${target}, ` +
        `command ${result.commandId}, delivered=${result.delivered}). ` +
        'The command is expected to report no result; verify via the device returning online on a hosted build.',
    );
    if (!dispatchCaptured) {
      dispatchCaptured = true;
      captureException(
        new Error(
          `Auto edition migration dispatched for at least one stranded device (first: ${device.id}). ` +
            'Informational — see per-device [edition-auto-migrate] logs.',
        ),
      );
    }
  } catch (err) {
    failedDevices.add(device.id);
    if (claimed) {
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
