/**
 * #4342 W2 (#11589) — script execution retention guards against real Postgres,
 * through the unprivileged `breeze_app` pool (forced RLS): a batch that forgot
 * to elect system scope matches zero rows here and fails these tests.
 *
 * The job is loaded with SCRIPT_EXECUTION_RETENTION_ENFORCE=true (set before
 * import, hoisted), so the enforce path writes. The report path is the same
 * run with `forceReport: true`, which must change nothing and count exactly
 * the rows the enforcing run then touches (one predicate, two modes).
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.SCRIPT_EXECUTION_RETENTION_ENFORCE = 'true';
});

import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import {
  monitorDefinitions,
  remediationSuggestions,
  scriptExecutionBatches,
  scriptExecutions,
  scripts,
} from '../../db/schema';
import type { RetentionTargetResult } from '../../jobs/retentionTarget';
import { runScriptExecutionRetention } from '../../jobs/scriptExecutionRetention';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * DAY_MS);
const KNOBS = { batchSize: 2, maxBatches: 50, outputRetentionDays: 90, retentionDays: 365 };

type Result = RetentionTargetResult | { table: string; error: string };
function eligible(r: Result | undefined): number {
  if (!r || !('mode' in r) || r.mode !== 'report') throw new Error(`expected a report run, got ${JSON.stringify(r)}`);
  return r.eligible;
}
function affected(r: Result | undefined): number {
  if (!r || !('mode' in r) || r.mode !== 'enforce') throw new Error(`expected an enforce run, got ${JSON.stringify(r)}`);
  return r.affected;
}

type ExecSeed = {
  scriptId: string;
  status: 'pending' | 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'timeout' | 'cancelled';
  createdAt: Date;
  completedAt?: Date | null;
  stdout?: string | null;
  stderr?: string | null;
  monitorId?: string | null;
  deviceId?: string;
  orgId?: string;
};

describe('script execution retention (#4342 W2, real Postgres)', () => {
  let partnerId: string;
  let orgId: string;
  let otherOrgId: string;
  let deviceId: string;
  let otherOrgDeviceId: string;

  beforeEach(async () => {
    partnerId = (await createPartner()).id;
    orgId = (await createOrganization({ partnerId, name: 'Retention Org' })).id;
    otherOrgId = (await createOrganization({ partnerId, name: 'Retention Org 2' })).id;
    const site = await createSite({ orgId });
    const otherSite = await createSite({ orgId: otherOrgId });
    deviceId = (await createDevice({ orgId, siteId: site.id })).id;
    otherOrgDeviceId = (await createDevice({ orgId: otherOrgId, siteId: otherSite.id })).id;
  });

  async function script(name: string): Promise<string> {
    // A partner-wide script: run by devices in more than one org.
    const [row] = await getTestDb().insert(scripts).values({
      partnerId, name, osTypes: ['windows'], language: 'powershell', content: 'Write-Output ok',
    }).returning({ id: scripts.id });
    return row!.id;
  }

  async function monitor(): Promise<string> {
    const [row] = await getTestDb().insert(monitorDefinitions).values({
      orgId, name: `probe-${crypto.randomUUID()}`, kind: 'script', condition: {}, severity: 'medium',
    }).returning({ id: monitorDefinitions.id });
    return row!.id;
  }

  async function exec(seed: ExecSeed): Promise<string> {
    const terminal = ['completed', 'failed', 'timeout', 'cancelled'].includes(seed.status);
    const [row] = await getTestDb().insert(scriptExecutions).values({
      scriptId: seed.scriptId,
      deviceId: seed.deviceId ?? deviceId,
      orgId: seed.orgId ?? orgId,
      status: seed.status,
      createdAt: seed.createdAt,
      completedAt: seed.completedAt === undefined ? (terminal ? seed.createdAt : null) : seed.completedAt,
      stdout: seed.stdout ?? null,
      stderr: seed.stderr ?? null,
      monitorId: seed.monitorId ?? null,
    }).returning({ id: scriptExecutions.id });
    return row!.id;
  }

  async function rows(ids: string[]) {
    const found = await getTestDb()
      .select({
        id: scriptExecutions.id,
        stdout: scriptExecutions.stdout,
        stderr: scriptExecutions.stderr,
        outputPurgedAt: scriptExecutions.outputPurgedAt,
      })
      .from(scriptExecutions)
      .where(inArray(scriptExecutions.id, ids));
    return new Map(found.map((r) => [r.id, r]));
  }

  it('scrubs output of terminal runs past the output window, idempotently, and never the newest monitor probe', async () => {
    const s = await script('output');
    const m = await monitor();
    const ids = {
      oldCompleted: await exec({ scriptId: s, status: 'completed', createdAt: daysAgo(100), stdout: 'out', stderr: 'err' }),
      oldStderrOnly: await exec({ scriptId: s, status: 'failed', createdAt: daysAgo(120), stderr: 'boom' }),
      // Boundary: an hour either side of the 90-day cutoff.
      justPast: await exec({ scriptId: s, status: 'completed', createdAt: new Date(NOW - 90 * DAY_MS - HOUR_MS), stdout: 'out' }),
      justInside: await exec({ scriptId: s, status: 'completed', createdAt: new Date(NOW - 90 * DAY_MS + HOUR_MS), stdout: 'out' }),
      recent: await exec({ scriptId: s, status: 'completed', createdAt: daysAgo(10), stdout: 'out' }),
      // Aged by completion, not creation.
      lateCompletion: await exec({ scriptId: s, status: 'completed', createdAt: daysAgo(200), completedAt: daysAgo(10), stdout: 'out' }),
      // Never terminal, whatever the age.
      oldRunning: await exec({ scriptId: s, status: 'running', createdAt: daysAgo(200), stdout: 'partial' }),
      oldCancelling: await exec({ scriptId: s, status: 'cancelling', createdAt: daysAgo(200), stdout: 'partial' }),
      // No output to remove: not counted.
      oldEmpty: await exec({ scriptId: s, status: 'completed', createdAt: daysAgo(150) }),
      // Monitor probes: the newest keeps its verdict output, the older one is scrubbed.
      olderProbe: await exec({ scriptId: s, status: 'completed', createdAt: daysAgo(130), stdout: 'BREEZE_MONITOR ok', monitorId: m }),
      newestProbe: await exec({ scriptId: s, status: 'completed', createdAt: daysAgo(100), stdout: 'BREEZE_MONITOR breach', monitorId: m }),
    };
    const all = Object.values(ids);
    const scrubbed = ['oldCompleted', 'oldStderrOnly', 'justPast', 'olderProbe'] as const;

    const before = await rows(all);
    const report = await runScriptExecutionRetention({ ...KNOBS, forceReport: true });
    expect(await rows(all)).toEqual(before);
    expect(eligible(report[0])).toBe(scrubbed.length);

    const enforce = await runScriptExecutionRetention(KNOBS);
    expect(affected(enforce[0])).toBe(scrubbed.length);
    const after = await rows(all);
    expect(after.size).toBe(all.length); // the scrub never deletes a row
    for (const k of scrubbed) {
      const r = after.get(ids[k])!;
      expect(r.stdout, k).toBeNull();
      expect(r.stderr, k).toBeNull();
      expect(r.outputPurgedAt, k).toBeInstanceOf(Date);
    }
    for (const k of Object.keys(ids) as Array<keyof typeof ids>) {
      if ((scrubbed as readonly string[]).includes(k)) continue;
      expect(after.get(ids[k]), k).toEqual(before.get(ids[k]));
    }

    // A second run selects nothing and leaves the stamps alone.
    const again = await runScriptExecutionRetention(KNOBS);
    expect(affected(again[0])).toBe(0);
    expect(await rows(all)).toEqual(after);
  });

  it('deletes terminal runs past the row window, keeping the newest per (monitor, device) and per (script, org)', async () => {
    const s1 = await script('s1');
    const s2 = await script('s2');
    const s3 = await script('s3');
    const m = await monitor();
    const ids = {
      // s1: a recent run exists, so the old ones go.
      s1Old1: await exec({ scriptId: s1, status: 'completed', createdAt: daysAgo(500) }),
      s1Old2: await exec({ scriptId: s1, status: 'timeout', createdAt: daysAgo(400) }),
      s1JustPast: await exec({ scriptId: s1, status: 'completed', createdAt: new Date(NOW - 365 * DAY_MS - HOUR_MS) }),
      s1JustInside: await exec({ scriptId: s1, status: 'completed', createdAt: new Date(NOW - 365 * DAY_MS + HOUR_MS) }),
      s1Recent: await exec({ scriptId: s1, status: 'completed', createdAt: daysAgo(10) }),
      s1LateCompletion: await exec({ scriptId: s1, status: 'failed', createdAt: daysAgo(500), completedAt: daysAgo(10) }),
      s1OldRunning: await exec({ scriptId: s1, status: 'running', createdAt: daysAgo(900) }),
      s1OldCancelling: await exec({ scriptId: s1, status: 'cancelling', createdAt: daysAgo(900) }),
      s1OldPending: await exec({ scriptId: s1, status: 'pending', createdAt: daysAgo(900) }),
      // s2: every run is old. The newest per org survives — in each org.
      s2Oldest: await exec({ scriptId: s2, status: 'completed', createdAt: daysAgo(600) }),
      s2Newest: await exec({ scriptId: s2, status: 'cancelled', createdAt: daysAgo(400) }),
      s2OtherOrg: await exec({ scriptId: s2, status: 'completed', createdAt: daysAgo(700), orgId: otherOrgId, deviceId: otherOrgDeviceId }),
      // s3 is a monitor probe script with a recent run, so only the monitor guard can keep a probe.
      probeOld: await exec({ scriptId: s3, status: 'completed', createdAt: daysAgo(500), monitorId: m }),
      probeNewest: await exec({ scriptId: s3, status: 'failed', createdAt: daysAgo(450), monitorId: m }),
      s3Recent: await exec({ scriptId: s3, status: 'completed', createdAt: daysAgo(5) }),
    };
    const all = Object.values(ids);

    // A suggestion pointing at a doomed execution is unlinked, not deleted.
    const [suggestion] = await getTestDb().insert(remediationSuggestions).values({
      orgId, sourceType: 'alert', sourceId: 'retention-test', targetType: 'diagnostic',
      title: 't', rationale: 'r', expectedAction: 'e', scriptExecutionId: ids.s1Old1,
    }).returning({ id: remediationSuggestions.id });

    const [oldBatch] = await getTestDb().insert(scriptExecutionBatches).values({
      scriptId: s1, orgId, devicesTargeted: 1, status: 'queued', createdAt: daysAgo(400),
    }).returning({ id: scriptExecutionBatches.id });
    const [newBatch] = await getTestDb().insert(scriptExecutionBatches).values({
      scriptId: s1, orgId, devicesTargeted: 1, status: 'queued', createdAt: daysAgo(10),
    }).returning({ id: scriptExecutionBatches.id });

    const report = await runScriptExecutionRetention({ ...KNOBS, forceReport: true });
    expect((await rows(all)).size).toBe(all.length);

    const enforce = await runScriptExecutionRetention(KNOBS);
    const left = await rows(all);
    const deleted = ['s1Old1', 's1Old2', 's1JustPast', 's2Oldest', 'probeOld'] as const;
    for (const k of deleted) expect(left.has(ids[k]), `${k} should be deleted`).toBe(false);
    const kept = [
      's1JustInside', 's1Recent', 's1LateCompletion', 's1OldRunning', 's1OldCancelling', 's1OldPending',
      's2Newest', 's2OtherOrg', 'probeNewest', 's3Recent',
    ] as const;
    for (const k of kept) expect(left.has(ids[k]), `${k} should survive`).toBe(true);

    expect(affected(enforce[1])).toBe(deleted.length);
    expect(eligible(report[1])).toBe(affected(enforce[1]));

    const [s] = await getTestDb().select({ scriptExecutionId: remediationSuggestions.scriptExecutionId })
      .from(remediationSuggestions).where(eq(remediationSuggestions.id, suggestion!.id));
    expect(s!.scriptExecutionId).toBeNull();

    const batches = await getTestDb().select({ id: scriptExecutionBatches.id }).from(scriptExecutionBatches)
      .where(inArray(scriptExecutionBatches.id, [oldBatch!.id, newBatch!.id]));
    expect(batches.map((b) => b.id)).toEqual([newBatch!.id]);
    expect(affected(enforce[2])).toBe(1);
    expect(eligible(report[2])).toBe(1);

    // Nothing left to do on a second run.
    const again = await runScriptExecutionRetention(KNOBS);
    expect(again.map((r) => affected(r))).toEqual([0, 0, 0]);
  });

  it('guard edges: NULL completed_at sorts last, keys are per device, only terminal rows shield, script-less runs age out', async () => {
    const s = await script('edges');
    const recentAnchor = await exec({ scriptId: s, status: 'completed', createdAt: daysAgo(1) }); // disarms the script guard
    const m = await monitor();
    const proposalRun = async (createdAt: Date) => {
      const [row] = await getTestDb().insert(scriptExecutions).values({
        scriptId: null, sourceKind: 'proposal', proposalId: crypto.randomUUID(),
        deviceId, orgId, status: 'completed', createdAt, completedAt: createdAt,
      }).returning({ id: scriptExecutions.id });
      return row!.id;
    };
    const ids = {
      // A terminal probe with no completed_at is never newer than a completed one (NULLS LAST)…
      nullCompletedProbe: await exec({ scriptId: s, status: 'cancelled', createdAt: daysAgo(400), completedAt: null, monitorId: m }),
      completedProbe: await exec({ scriptId: s, status: 'completed', createdAt: daysAgo(500), monitorId: m }),
      // …and the same monitor on another device keeps its own newest probe.
      otherDeviceOld: await exec({ scriptId: s, status: 'completed', createdAt: daysAgo(600), monitorId: m, deviceId: otherOrgDeviceId, orgId: otherOrgId }),
      otherDeviceNewest: await exec({ scriptId: s, status: 'completed', createdAt: daysAgo(550), monitorId: m, deviceId: otherOrgDeviceId, orgId: otherOrgId }),
      // Disarms the script guard in the other org, so only the per-device monitor key keeps otherDeviceNewest.
      otherOrgAnchor: await exec({ scriptId: s, status: 'completed', createdAt: daysAgo(1), deviceId: otherOrgDeviceId, orgId: otherOrgId }),
      plainOld: await exec({ scriptId: s, status: 'completed', createdAt: daysAgo(500) }),
      // Script-less (proposal) runs have only the age rule.
      proposalOld: await proposalRun(daysAgo(400)),
      proposalRecent: await proposalRun(daysAgo(10)),
    };
    // A newer probe still running does not displace the newest terminal one.
    const m2 = await monitor();
    const m2Old = await exec({ scriptId: s, status: 'failed', createdAt: daysAgo(500), monitorId: m2 });
    const m2Running = await exec({ scriptId: s, status: 'running', createdAt: daysAgo(400), monitorId: m2 });
    // A script whose only newer run is still running keeps its newest terminal run.
    const lone = await script('lone');
    const loneTerminal = await exec({ scriptId: lone, status: 'completed', createdAt: daysAgo(500) });
    const loneRunning = await exec({ scriptId: lone, status: 'running', createdAt: daysAgo(100) });
    // Two terminal probes that both lack completed_at tie, and ties are kept.
    const m3 = await monitor();
    const tieA = await exec({ scriptId: s, status: 'cancelled', createdAt: daysAgo(500), completedAt: null, monitorId: m3 });
    const tieB = await exec({ scriptId: s, status: 'cancelled', createdAt: daysAgo(450), completedAt: null, monitorId: m3 });

    const all = [...Object.values(ids), recentAnchor, m2Old, m2Running, loneTerminal, loneRunning, tieA, tieB];
    const report = await runScriptExecutionRetention({ ...KNOBS, forceReport: true });
    const enforce = await runScriptExecutionRetention(KNOBS);
    const left = await rows(all);

    const deleted = { nullCompletedProbe: ids.nullCompletedProbe, otherDeviceOld: ids.otherDeviceOld, plainOld: ids.plainOld, proposalOld: ids.proposalOld };
    for (const [k, id] of Object.entries(deleted)) expect(left.has(id), `${k} should be deleted`).toBe(false);
    const kept = {
      completedProbe: ids.completedProbe, otherDeviceNewest: ids.otherDeviceNewest, otherOrgAnchor: ids.otherOrgAnchor, proposalRecent: ids.proposalRecent,
      recentAnchor, m2Old, m2Running, loneTerminal, loneRunning, tieA, tieB,
    };
    for (const [k, id] of Object.entries(kept)) expect(left.has(id), `${k} should survive`).toBe(true);
    expect(affected(enforce[1])).toBe(Object.keys(deleted).length);
    expect(eligible(report[1])).toBe(affected(enforce[1]));
  });
});
