/**
 * monitor_episodes / monitor_device_state — live RLS, the open-episode partial
 * unique, the recurrence latch and the FK cascades (#5287 W03 / #5290).
 *
 * `rls-coverage.integration.test.ts` proves the policies EXIST by reading
 * pg_catalog; only driving the real postgres.js connection as `breeze_app`
 * under FORCE RLS proves they ENFORCE anything, which is what this suite is
 * for. The latch/pause cases additionally exercise `episodeService` against a
 * real database, where the `FOR UPDATE` lock and the partial unique index are
 * real rather than mocked.
 */
import './setup';
import { getTestDb } from './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  devices,
  monitorDefinitions,
  monitorDeviceState,
  monitorEpisodes,
} from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner, createSite } from './db-utils';
import {
  recordMonitorEvaluation,
  detachMonitorFromDevice,
} from '../../services/monitors/episodeService';
import { resetMonitorEscalation } from '../../services/monitors/episodeReset';
import type { AuthContext } from '../../middleware/auth';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

let deviceSeq = 0;

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  deviceSeq += 1;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-ep-${Date.now()}-${deviceSeq}`,
      hostname: `ep-host-${deviceSeq}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x64',
      agentVersion: '1.0.0',
    })
    .returning({ id: devices.id });
  return device!.id;
}

async function seedMonitor(owner: {
  orgId?: string | null;
  partnerId?: string | null;
  recurrenceThreshold?: number | null;
  recurrenceWindowHours?: number | null;
  pauseResponsesOnEscalation?: boolean;
}): Promise<string> {
  const [row] = await getTestDb()
    .insert(monitorDefinitions)
    .values({
      orgId: owner.orgId ?? null,
      partnerId: owner.partnerId ?? null,
      name: `monitor-${Math.random().toString(36).slice(2, 10)}`,
      kind: 'cpu',
      condition: { operator: 'gt', value: 90 },
      severity: 'high',
      recurrenceThreshold: owner.recurrenceThreshold ?? null,
      recurrenceWindowHours: owner.recurrenceWindowHours ?? null,
      pauseResponsesOnEscalation: owner.pauseResponsesOnEscalation ?? true,
    })
    .returning({ id: monitorDefinitions.id });
  return row!.id;
}

function monitorArg(
  id: string,
  over: { recurrenceThreshold?: number | null; recurrenceWindowHours?: number | null; pauseResponsesOnEscalation?: boolean } = {},
) {
  return {
    id,
    recurrenceThreshold: over.recurrenceThreshold ?? null,
    recurrenceWindowHours: over.recurrenceWindowHours ?? null,
    pauseResponsesOnEscalation: over.pauseResponsesOnEscalation ?? true,
  } as never;
}

const createdPartnerIds: string[] = [];
const createdOrgIds: string[] = [];
const createdMonitorIds: string[] = [];

afterEach(async () => {
  const partnerIds = [...new Set(createdPartnerIds)];
  const orgIds = [...new Set(createdOrgIds)];
  const monitorIds = [...new Set(createdMonitorIds)];
  createdPartnerIds.length = 0;
  createdOrgIds.length = 0;
  createdMonitorIds.length = 0;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (monitorIds.length > 0) {
      await db.delete(monitorDefinitions).where(inArray(monitorDefinitions.id, monitorIds));
    }
    if (orgIds.length > 0) {
      await db.delete(devices).where(inArray(devices.orgId, orgIds));
      await db.delete(monitorDefinitions).where(inArray(monitorDefinitions.orgId, orgIds));
    }
    if (partnerIds.length > 0) {
      await db.delete(monitorDefinitions).where(inArray(monitorDefinitions.partnerId, partnerIds));
    }
  });
});

interface Fixture {
  partnerA: string;
  partnerB: string;
  orgA: string;
  orgB: string;
  deviceA: string;
  deviceA2: string;
  deviceB: string;
}

async function fixture(): Promise<Fixture> {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  createdPartnerIds.push(partnerA.id, partnerB.id);
  createdOrgIds.push(orgA.id, orgB.id);
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  return {
    partnerA: partnerA.id,
    partnerB: partnerB.id,
    orgA: orgA.id,
    orgB: orgB.id,
    deviceA: await seedDevice(orgA.id, siteA.id),
    deviceA2: await seedDevice(orgA.id, siteA.id),
    deviceB: await seedDevice(orgB.id, siteB.id),
  };
}

async function openEpisodesFor(monitorId: string, deviceId: string) {
  return withDbAccessContext(SYSTEM_CTX, () =>
    db
      .select()
      .from(monitorEpisodes)
      .where(and(eq(monitorEpisodes.monitorId, monitorId), eq(monitorEpisodes.deviceId, deviceId))),
  );
}

async function stateFor(monitorId: string, deviceId: string) {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .select()
      .from(monitorDeviceState)
      .where(
        and(eq(monitorDeviceState.monitorId, monitorId), eq(monitorDeviceState.deviceId, deviceId)),
      ),
  );
  return row;
}

beforeEach(() => {
  deviceSeq = 0;
});

describe('monitor episode tenancy (#5290)', () => {
  it('a cross-tenant forge of monitor_episodes fails as breeze_app', async () => {
    const f = await fixture();
    const monitorId = await seedMonitor({ orgId: f.orgA });
    createdMonitorIds.push(monitorId);

    // Org B's session forging a row for org A's device.
    await expectSqlState(
      () =>
        withDbAccessContext(orgContext(f.orgB, f.partnerB), () =>
          db.insert(monitorEpisodes).values({
            monitorId,
            deviceId: f.deviceA,
            orgId: f.orgA,
          }),
        ),
      '42501',
    );
  });

  it('a cross-tenant forge of monitor_device_state fails as breeze_app', async () => {
    const f = await fixture();
    const monitorId = await seedMonitor({ orgId: f.orgA });
    createdMonitorIds.push(monitorId);

    await expectSqlState(
      () =>
        withDbAccessContext(orgContext(f.orgB, f.partnerB), () =>
          db.insert(monitorDeviceState).values({
            monitorId,
            deviceId: f.deviceA,
            orgId: f.orgA,
          }),
        ),
      '42501',
    );
  });

  it('an org session cannot read another org\'s episodes', async () => {
    const f = await fixture();
    const monitorId = await seedMonitor({ orgId: f.orgA });
    createdMonitorIds.push(monitorId);

    await withDbAccessContext(SYSTEM_CTX, () =>
      recordMonitorEvaluation({
        monitor: monitorArg(monitorId),
        deviceId: f.deviceA,
        orgId: f.orgA,
        observation: 'breach',
      }),
    );

    const seenByB = await withDbAccessContext(orgContext(f.orgB, f.partnerB), () =>
      db.select().from(monitorEpisodes).where(eq(monitorEpisodes.monitorId, monitorId)),
    );
    expect(seenByB).toHaveLength(0);

    const seenByA = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
      db.select().from(monitorEpisodes).where(eq(monitorEpisodes.monitorId, monitorId)),
    );
    expect(seenByA).toHaveLength(1);
  });

  it('the partial unique index refuses a SECOND open episode for the same pair', async () => {
    const f = await fixture();
    const monitorId = await seedMonitor({ orgId: f.orgA });
    createdMonitorIds.push(monitorId);

    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(monitorEpisodes).values({ monitorId, deviceId: f.deviceA, orgId: f.orgA }),
    );

    await expectSqlState(
      () =>
        withDbAccessContext(SYSTEM_CTX, () =>
          db.insert(monitorEpisodes).values({ monitorId, deviceId: f.deviceA, orgId: f.orgA }),
        ),
      '23505',
    );
  });

  it('a partner-wide monitor breaching on two orgs writes each episode with the DEVICE org', async () => {
    const f = await fixture();
    // One partner-wide monitor; devices in two DIFFERENT partners' orgs would
    // never share one, so use partnerA and a second org under it.
    const monitorId = await seedMonitor({ partnerId: f.partnerA });
    createdMonitorIds.push(monitorId);
    const orgA2 = await createOrganization({ partnerId: f.partnerA });
    createdOrgIds.push(orgA2.id);
    const siteA2 = await createSite({ orgId: orgA2.id });
    const deviceA3 = await seedDevice(orgA2.id, siteA2.id);

    await withDbAccessContext(SYSTEM_CTX, async () => {
      await recordMonitorEvaluation({
        monitor: monitorArg(monitorId),
        deviceId: f.deviceA,
        orgId: f.orgA,
        observation: 'breach',
      });
      await recordMonitorEvaluation({
        monitor: monitorArg(monitorId),
        deviceId: deviceA3,
        orgId: orgA2.id,
        observation: 'breach',
      });
    });

    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(monitorEpisodes).where(eq(monitorEpisodes.monitorId, monitorId)),
    );
    expect(rows).toHaveLength(2);
    // The monitor's own org_id is NULL; every episode still carries a real org.
    expect(new Set(rows.map((r) => r.orgId))).toEqual(new Set([f.orgA, orgA2.id]));
  });
});

describe('recurrence latch and pause (#5290)', () => {
  it('latches once at the threshold and pauses responses for that device only', async () => {
    const f = await fixture();
    const monitorId = await seedMonitor({
      orgId: f.orgA,
      recurrenceThreshold: 2,
      recurrenceWindowHours: 24,
    });
    createdMonitorIds.push(monitorId);

    await withDbAccessContext(SYSTEM_CTX, async () => {
      const m = monitorArg(monitorId, { recurrenceThreshold: 2, recurrenceWindowHours: 24 });
      // Device A: breach → recover → breach (two episodes in the window).
      const first = await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'breach' });
      expect(first.latched).toBe(false);
      await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'ok' });
      const second = await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'breach' });
      expect(second.latched).toBe(true);
      expect(second.episodesInWindow).toBe(2);
      expect(second.responsesPaused).toBe(true);

      // A third breach on the same pair must NOT re-latch.
      await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'ok' });
      const third = await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'breach' });
      expect(third.latched).toBe(false);

      // The SIBLING device of the same monitor is untouched.
      const sibling = await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA2, orgId: f.orgA, observation: 'breach' });
      expect(sibling.latched).toBe(false);
      expect(sibling.responsesPaused).toBe(false);
    });

    expect((await stateFor(monitorId, f.deviceA))?.responsesPaused).toBe(true);
    expect((await stateFor(monitorId, f.deviceA2))?.responsesPaused).toBe(false);
  });

  it('an unknown observation never opens or closes an episode', async () => {
    const f = await fixture();
    const monitorId = await seedMonitor({ orgId: f.orgA });
    createdMonitorIds.push(monitorId);

    await withDbAccessContext(SYSTEM_CTX, async () => {
      const m = monitorArg(monitorId);
      const none = await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'unknown' });
      expect(none.episodeId).toBeNull();
      expect(none.episodeOpened).toBe(false);

      const opened = await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'breach' });
      const stale = await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'unknown' });
      expect(stale.episodeClosed).toBe(false);
      expect(stale.episodeId).toBe(opened.episodeId);
    });

    const open = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .select()
        .from(monitorEpisodes)
        .where(and(eq(monitorEpisodes.monitorId, monitorId), isNull(monitorEpisodes.endedAt))),
    );
    expect(open).toHaveLength(1);
  });

  it('reset resumes responses and the next breach opens a fresh episode', async () => {
    const f = await fixture();
    const monitorId = await seedMonitor({
      orgId: f.orgA,
      recurrenceThreshold: 2,
      recurrenceWindowHours: 24,
    });
    createdMonitorIds.push(monitorId);
    const m = monitorArg(monitorId, { recurrenceThreshold: 2, recurrenceWindowHours: 24 });

    await withDbAccessContext(SYSTEM_CTX, async () => {
      await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'breach' });
      await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'ok' });
      await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'breach' });
    });
    expect((await stateFor(monitorId, f.deviceA))?.escalatedAt).not.toBeNull();

    const auth = {
      user: { id: null },
      orgCondition: () => undefined,
    } as unknown as AuthContext;
    const result = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
      resetMonitorEscalation({ monitorId, deviceId: f.deviceA, auth }),
    );
    expect(result).toEqual({ reset: true });

    const afterReset = await stateFor(monitorId, f.deviceA);
    expect(afterReset?.escalatedAt).toBeNull();
    expect(afterReset?.responsesPaused).toBe(false);
    expect(afterReset?.episodesInWindow).toBe(0);
    // The OPEN episode is deliberately left open — a device still in breach is
    // still in breach.
    expect(afterReset?.currentEpisodeId).not.toBeNull();

    // A second reset on a pair that is no longer escalated reports false.
    const again = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
      resetMonitorEscalation({ monitorId, deviceId: f.deviceA, auth }),
    );
    expect(again).toEqual({ reset: false });
  });

  it('a reset really restarts the window: the next breach does NOT immediately re-latch', async () => {
    const f = await fixture();
    const monitorId = await seedMonitor({
      orgId: f.orgA,
      recurrenceThreshold: 2,
      recurrenceWindowHours: 24,
    });
    createdMonitorIds.push(monitorId);
    const m = monitorArg(monitorId, { recurrenceThreshold: 2, recurrenceWindowHours: 24 });

    await withDbAccessContext(SYSTEM_CTX, async () => {
      await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'breach' });
      await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'ok' });
      const latched = await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'breach' });
      expect(latched.latched).toBe(true);
    });

    const auth = { user: { id: null }, orgCondition: () => undefined } as unknown as AuthContext;
    await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
      resetMonitorEscalation({ monitorId, deviceId: f.deviceA, auth }),
    );

    // Both pre-reset episodes are still inside the 24h window. Without the
    // reset_at floor in the window recompute, this single new breach would
    // count 3 >= 2 and re-latch immediately, making the reset useless.
    const after = await withDbAccessContext(SYSTEM_CTX, async () => {
      await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'ok' });
      return recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'breach' });
    });

    expect(after.episodesInWindow).toBe(1);
    expect(after.latched).toBe(false);
    expect((await stateFor(monitorId, f.deviceA))?.responsesPaused).toBe(false);

    // Two NEW post-reset episodes still latch, so the counter is restarted, not disabled.
    const relatched = await withDbAccessContext(SYSTEM_CTX, async () => {
      await recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'ok' });
      return recordMonitorEvaluation({ monitor: m, deviceId: f.deviceA, orgId: f.orgA, observation: 'breach' });
    });
    expect(relatched.latched).toBe(true);
  });

  it('detachMonitorFromDevice closes the open episode as monitor_detached', async () => {
    const f = await fixture();
    const monitorId = await seedMonitor({ orgId: f.orgA });
    createdMonitorIds.push(monitorId);

    await withDbAccessContext(SYSTEM_CTX, async () => {
      await recordMonitorEvaluation({
        monitor: monitorArg(monitorId),
        deviceId: f.deviceA,
        orgId: f.orgA,
        observation: 'breach',
      });
      await detachMonitorFromDevice(monitorId, f.deviceA);
    });

    const rows = await openEpisodesFor(monitorId, f.deviceA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endReason).toBe('monitor_detached');
    expect(rows[0]!.endedAt).not.toBeNull();
    expect((await stateFor(monitorId, f.deviceA))?.currentEpisodeId).toBeNull();
  });
});

describe('cascades (#5290)', () => {
  it('deleting the device removes its episodes and state rows', async () => {
    const f = await fixture();
    const monitorId = await seedMonitor({ orgId: f.orgA });
    createdMonitorIds.push(monitorId);

    await withDbAccessContext(SYSTEM_CTX, () =>
      recordMonitorEvaluation({
        monitor: monitorArg(monitorId),
        deviceId: f.deviceA,
        orgId: f.orgA,
        observation: 'breach',
      }),
    );

    await withDbAccessContext(SYSTEM_CTX, async () => {
      // monitor_device_state.current_episode_id FKs the episode with ON DELETE
      // SET NULL, so the device cascade can remove both in either order.
      await db.delete(devices).where(eq(devices.id, f.deviceA));
    });

    expect(await openEpisodesFor(monitorId, f.deviceA)).toHaveLength(0);
    expect(await stateFor(monitorId, f.deviceA)).toBeUndefined();
  });

  it('deleting the monitor definition cascades both tables', async () => {
    const f = await fixture();
    const monitorId = await seedMonitor({ orgId: f.orgA });

    await withDbAccessContext(SYSTEM_CTX, () =>
      recordMonitorEvaluation({
        monitor: monitorArg(monitorId),
        deviceId: f.deviceA,
        orgId: f.orgA,
        observation: 'breach',
      }),
    );

    await withDbAccessContext(SYSTEM_CTX, () =>
      db.delete(monitorDefinitions).where(eq(monitorDefinitions.id, monitorId)),
    );

    expect(await openEpisodesFor(monitorId, f.deviceA)).toHaveLength(0);
    expect(await stateFor(monitorId, f.deviceA)).toBeUndefined();
  });
});
