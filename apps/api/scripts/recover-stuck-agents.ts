#!/usr/bin/env tsx
/**
 * One-time recovery for agents whose embedded manifest trust root was
 * baked wrong in v0.65.5/v0.65.6 (PR #568). Those agents cannot
 * auto-update because manifest signature verification always fails, so
 * they will never pick up the v0.65.7 fix on their own.
 *
 * For each affected device we queue a dev_update command pointing at
 * the latest binary from agent_versions. dev_update uses
 * UpdateFromURL, which skips manifest verification and only checks a
 * checksum the API computed after verifying the GitHub release
 * manifest — so the trust chain becomes API → agent (already
 * established via bearer token + TLS) instead of GitHub → agent
 * (which is what's broken).
 *
 * Usage (from the API container):
 *   pnpm recover:stuck-agents               # dry run (default)
 *   pnpm recover:stuck-agents -- --apply    # actually queue the commands
 *
 * The script is idempotent — repeated runs won't enqueue duplicate
 * dev_update commands for devices that already have a pending or
 * sent recovery command in flight.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import { closeDb, db, withSystemDbAccessContext } from '../src/db';
import { agentVersions } from '../src/db/schema/agentVersions';
import { devices, deviceCommands } from '../src/db/schema/devices';
import { normalizeAgentArchitecture } from '../src/routes/agents/helpers';

// Versions known to ship with the broken trust root. If you discover
// another, append it here — the regression test in
// agent/internal/updater/updater_test.go prevents new releases from
// joining this list.
const BROKEN_AGENT_VERSIONS = ['0.65.5', '0.65.6'] as const;

const RECOVERY_COMMAND_MARKER = 'agent_update_trust_root_recovery';

type DeviceRow = {
  id: string;
  hostname: string | null;
  agentVersion: string | null;
  osType: string | null;
  architecture: string | null;
  status: string;
};

type AgentVersionRow = {
  version: string;
  platform: string;
  architecture: string;
  downloadUrl: string;
  checksum: string;
};

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

type Plan = {
  device: DeviceRow;
  binary: AgentVersionRow;
};

type Skip = {
  device: DeviceRow;
  reason: string;
};

function planRecovery(devs: DeviceRow[], binaries: AgentVersionRow[]): {
  plans: Plan[];
  skipped: Skip[];
} {
  const byPlatformArch = new Map<string, AgentVersionRow>();
  for (const b of binaries) {
    byPlatformArch.set(`${b.platform}/${b.architecture}`, b);
  }

  const plans: Plan[] = [];
  const skipped: Skip[] = [];

  for (const d of devs) {
    if (!d.osType) {
      skipped.push({ device: d, reason: 'os_type is null' });
      continue;
    }
    const arch = normalizeAgentArchitecture(d.architecture);
    if (!arch) {
      skipped.push({ device: d, reason: `unrecognised architecture: ${d.architecture}` });
      continue;
    }
    const binary = byPlatformArch.get(`${d.osType}/${arch}`);
    if (!binary) {
      skipped.push({
        device: d,
        reason: `no isLatest=true agent binary registered for ${d.osType}/${arch}`,
      });
      continue;
    }
    if (BROKEN_AGENT_VERSIONS.includes(binary.version as typeof BROKEN_AGENT_VERSIONS[number])) {
      skipped.push({
        device: d,
        reason: `latest binary is still ${binary.version} (broken). Bump BREEZE_VERSION on this server first.`,
      });
      continue;
    }
    plans.push({ device: d, binary });
  }

  return { plans, skipped };
}

async function enqueueRecovery(plan: Plan): Promise<'queued' | 'already-pending'> {
  if (await hasRecoveryAlreadyQueued(plan.device.id)) {
    return 'already-pending';
  }
  await db.insert(deviceCommands).values({
    deviceId: plan.device.id,
    type: 'dev_update',
    targetRole: 'agent',
    status: 'pending',
    payload: {
      version: plan.binary.version,
      component: 'agent',
      downloadUrl: plan.binary.downloadUrl,
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
    const [devs, binaries] = await Promise.all([
      selectAffectedDevices(),
      selectLatestBinaries(),
    ]);

    if (devs.length === 0) {
      console.log('[recover-stuck-agents] No devices on broken versions — nothing to do.');
      return;
    }

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
      return;
    }

    console.log(`\n[recover-stuck-agents] ${apply ? 'Queueing' : 'Would queue'} dev_update for ${plans.length} device(s):`);

    let queued = 0;
    let alreadyPending = 0;
    for (const p of plans) {
      const label = `  - ${p.device.hostname ?? p.device.id} (${p.device.agentVersion} ${p.device.osType}/${p.device.architecture}) → ${p.binary.version}`;
      if (!apply) {
        console.log(label);
        continue;
      }
      const outcome = await enqueueRecovery(p);
      if (outcome === 'queued') {
        queued++;
        console.log(`${label}  [queued]`);
      } else {
        alreadyPending++;
        console.log(`${label}  [skipped: recovery already pending]`);
      }
    }

    if (!apply) {
      console.log('\n[recover-stuck-agents] Dry run only. Re-run with --apply to queue commands.');
      return;
    }

    console.log(`\n[recover-stuck-agents] Done. Queued ${queued}, skipped ${alreadyPending} already-pending.`);
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
