#!/usr/bin/env tsx
/**
 * One-time recovery for agents stuck on a "won't auto-update" version. Two
 * regressions feed into this script (see BROKEN_AGENT_VERSIONS for both):
 *
 *   - v0.65.5 / v0.65.6 baked the wrong manifest trust root (#568) — agents
 *     can't verify manifests at all.
 *   - v0.65.7 / v0.65.8 predate per-deployment manifest pinning (#625) —
 *     self-host BINARY_SOURCE=local servers sign manifests with a deploy-
 *     specific Ed25519 key the agent doesn't trust until v0.65.9 lands and
 *     the heartbeat / enrollment pub-key delivery kicks in.
 *
 * For each affected device we queue a dev_update command pointing at
 * the latest binary from agent_versions. dev_update uses
 * UpdateFromURL, which skips manifest verification and only checks a
 * checksum the API computed after verifying the GitHub release
 * manifest (or, in BINARY_SOURCE=local mode, after computing the hash
 * during syncBinaries). Trust chain becomes API → agent (already
 * established via bearer token + TLS) instead of (LanternOps key | deploy
 * key) → agent (which is what's broken for these versions).
 *
 * Usage (from the API container):
 *   pnpm recover:stuck-agents               # dry run (default)
 *   pnpm recover:stuck-agents -- --apply    # actually queue the commands
 *
 * The script is idempotent — repeated runs won't enqueue duplicate
 * dev_update commands for devices that already have a pending or
 * sent recovery command in flight. If the run aborts mid-loop (DB
 * blip, network), re-running picks up where it stopped because of
 * that same idempotency check.
 *
 * Exit codes:
 *   0  every recoverable device queued (or no work to do)
 *   1  fatal error before/after the loop, or one or more per-device
 *      enqueues threw (operator should retry; idempotent)
 *   2  one or more devices were skipped during --apply (e.g. latest
 *      registered binary is still on a broken version — operator
 *      forgot to bump BREEZE_VERSION first). Distinct from 1 so
 *      shell scripts can decide whether re-running will help.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import { closeDb, db, withSystemDbAccessContext } from '../src/db';
import { agentVersions } from '../src/db/schema/agentVersions';
import { devices, deviceCommands } from '../src/db/schema/devices';
import {
  AgentVersionRow,
  BROKEN_AGENT_VERSIONS,
  DeviceRow,
  Plan,
  RECOVERY_COMMAND_MARKER,
  planRecovery,
} from './recover-stuck-agents.lib';

async function selectAffectedDevices(): Promise<DeviceRow[]> {
  return db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      agentVersion: devices.agentVersion,
      osType: devices.osType,
      architecture: devices.architecture,
      status: devices.status,
    })
    .from(devices)
    .where(
      and(
        inArray(devices.agentVersion, BROKEN_AGENT_VERSIONS as unknown as string[]),
        sql`${devices.status} != 'decommissioned'`,
      ),
    );
}

async function selectLatestBinaries(): Promise<AgentVersionRow[]> {
  return db
    .select({
      version: agentVersions.version,
      platform: agentVersions.platform,
      architecture: agentVersions.architecture,
      downloadUrl: agentVersions.downloadUrl,
      checksum: agentVersions.checksum,
    })
    .from(agentVersions)
    .where(
      and(
        eq(agentVersions.component, 'agent'),
        eq(agentVersions.isLatest, true),
      ),
    );
}

async function hasRecoveryAlreadyQueued(deviceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.type, 'dev_update'),
        inArray(deviceCommands.status, ['pending', 'sent']),
        sql`${deviceCommands.payload}->>'reason' = ${RECOVERY_COMMAND_MARKER}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

function getServerOrigin(): string {
  const candidate =
    process.env.PUBLIC_API_URL?.trim() ||
    process.env.PUBLIC_APP_URL?.trim() ||
    process.env.BREEZE_SERVER?.trim();
  if (!candidate) {
    throw new Error(
      'Cannot determine server origin: set PUBLIC_API_URL (or PUBLIC_APP_URL / BREEZE_SERVER) so dev_update download URLs match the agent\'s expected server host.',
    );
  }
  return candidate.replace(/\/+$/, '');
}

// The agent's downloader (updater.go:downloadFromURL) rejects download URLs
// whose host doesn't match its configured server origin — so we cannot pass
// the github.com URL stored in agent_versions.downloadUrl when the server is
// running BINARY_SOURCE=github. Build a server-relative URL instead; the
// API's /api/v1/agents/download/:os/:arch route will 302 to GitHub from
// there (or serve from disk/S3 in non-github mode), and Go's HTTP client
// follows the redirect transparently because the host check has already
// passed on the originating URL.
function buildAgentDownloadUrl(serverOrigin: string, platform: string, architecture: string): string {
  const osParam = platform === 'macos' ? 'darwin' : platform;
  return `${serverOrigin}/api/v1/agents/download/${osParam}/${architecture}`;
}

async function enqueueRecovery(plan: Plan, serverOrigin: string): Promise<'queued' | 'already-pending'> {
  if (await hasRecoveryAlreadyQueued(plan.device.id)) {
    return 'already-pending';
  }
  const downloadUrl = buildAgentDownloadUrl(serverOrigin, plan.binary.platform, plan.binary.architecture);
  await db.insert(deviceCommands).values({
    deviceId: plan.device.id,
    type: 'dev_update',
    targetRole: 'agent',
    status: 'pending',
    payload: {
      version: plan.binary.version,
      component: 'agent',
      downloadUrl,
      checksum: plan.binary.checksum,
      // preserveAutoUpdate is honoured by v0.65.7+ agents; older
      // agents don't read it and will set auto_update=false after
      // recovery (operator must re-enable manually until they're on
      // a build that respects the flag).
      preserveAutoUpdate: true,
      reason: RECOVERY_COMMAND_MARKER,
    },
  });
  return 'queued';
}

async function run(apply: boolean): Promise<void> {
  return withSystemDbAccessContext(async () => {
    const serverOrigin = getServerOrigin();
    const [devs, binaries] = await Promise.all([
      selectAffectedDevices(),
      selectLatestBinaries(),
    ]);

    if (devs.length === 0) {
      console.log('[recover-stuck-agents] No devices on broken versions — nothing to do.');
      return;
    }

    console.log(`[recover-stuck-agents] Server origin (for dev_update download URLs): ${serverOrigin}`);

    console.log(
      `[recover-stuck-agents] Found ${devs.length} device(s) on ${BROKEN_AGENT_VERSIONS.join(' / ')}.`,
    );
    console.log(
      `[recover-stuck-agents] ${binaries.length} latest agent binar${binaries.length === 1 ? 'y' : 'ies'} registered:`,
    );
    for (const b of binaries) {
      console.log(`  - ${b.version} ${b.platform}/${b.architecture}`);
    }

    const { plans, skipped } = planRecovery(devs, binaries);

    if (skipped.length > 0) {
      console.log(`\n[recover-stuck-agents] Skipping ${skipped.length} device(s):`);
      for (const s of skipped) {
        console.log(`  - ${s.device.hostname ?? s.device.id} (${s.device.agentVersion}): ${s.reason}`);
      }
    }

    if (plans.length === 0) {
      console.log('\n[recover-stuck-agents] No recoverable devices.');
      // Skips with no plans during --apply still mean the operator's intent
      // wasn't fully satisfied (e.g. forgot to bump BREEZE_VERSION). Surface
      // it via exit code 2 so a wrapping shell script doesn't declare victory.
      if (apply && skipped.length > 0) {
        process.exitCode = 2;
      }
      return;
    }

    console.log(`\n[recover-stuck-agents] ${apply ? 'Queueing' : 'Would queue'} dev_update for ${plans.length} device(s):`);

    let queued = 0;
    let alreadyPending = 0;
    let failed = 0;
    for (const p of plans) {
      const label = `  - ${p.device.hostname ?? p.device.id} (${p.device.agentVersion} ${p.device.osType}/${p.device.architecture}) → ${p.binary.version}`;
      if (!apply) {
        console.log(label);
        continue;
      }
      try {
        const outcome = await enqueueRecovery(p, serverOrigin);
        if (outcome === 'queued') {
          queued++;
          console.log(`${label}  [queued]`);
        } else {
          alreadyPending++;
          console.log(`${label}  [skipped: recovery already pending]`);
        }
      } catch (err) {
        // Don't abort the whole loop on a single device's DB blip — re-running
        // is safe (hasRecoveryAlreadyQueued de-dupes), but if the loop dies
        // here the operator is left without a tally and may not know which
        // devices made it through. Keep going and report at the end.
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${label}  [FAILED: ${msg}]`);
      }
    }

    if (!apply) {
      console.log('\n[recover-stuck-agents] Dry run only. Re-run with --apply to queue commands.');
      return;
    }

    console.log(
      `\n[recover-stuck-agents] Done. Queued ${queued}, ${alreadyPending} already-pending` +
        (failed > 0 ? `, ${failed} failed` : '') +
        (skipped.length > 0 ? `, ${skipped.length} pre-skipped` : '') +
        '.',
    );
    if (failed > 0) {
      console.error(
        `[recover-stuck-agents] ${failed} device(s) failed to enqueue — re-run is safe and idempotent.`,
      );
      process.exitCode = 1;
    } else if (skipped.length > 0) {
      // No per-device failures, but at least one device couldn't be reached
      // by the safety/eligibility checks. Operator probably needs to act
      // (e.g. bump BREEZE_VERSION) before another run will help.
      process.exitCode = 2;
    }
    console.log(
      '[recover-stuck-agents] Agents will pick up the command on their next heartbeat (within ~60s).',
    );
    console.log(
      '[recover-stuck-agents] Note: dev_update disables auto_update on agents that ignore preserveAutoUpdate (i.e. all currently broken versions).',
    );
    console.log(
      '[recover-stuck-agents] After recovery, re-enable auto_update on those devices via your config policy or admin UI.',
    );
  });
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const apply = args.has('--apply');
  await run(apply);
}

main()
  .catch((err) => {
    console.error('[recover-stuck-agents] FAILED');
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
