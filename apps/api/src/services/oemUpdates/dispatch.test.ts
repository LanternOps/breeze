import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { oemUpdateRunPayloadSchema, type OemCategory } from '@breeze/shared';

const state = vi.hoisted(() => ({
  device: null as Record<string, unknown> | null,
  status: null as Record<string, unknown> | null,
  keys: [] as Array<{ protectorId: string | null }>,
  inFlight: [] as Array<{ id: string }>,
  upserts: [] as Array<Record<string, unknown>>,
  upsertSet: null as Record<string, unknown> | null,
  executes: 0,
  order: [] as string[],
}));

vi.mock('../../db', () => {
  const table = (rows: () => unknown[], label: string) => {
    const c: Record<string, unknown> = {
      from: () => c,
      innerJoin: () => c,
      leftJoin: () => c,
      where: () => c,
      orderBy: () => c,
      limit: () => {
        state.order.push(label);
        return Promise.resolve(rows());
      },
    };
    return c;
  };
  let selects = 0;
  return {
    db: {
      select: vi.fn((shape: Record<string, unknown>) => {
        if ('partnerId' in shape || 'orgType' in shape) {
          selects = 0;
          return table(() => (state.device ? [state.device] : []), 'device');
        }
        if ('protectorId' in shape) return table(() => state.keys, 'keys');
        if ('commandId' in shape) return table(() => state.inFlight, 'inFlight');
        selects++;
        return table(() => (state.status ? [state.status] : []), 'status');
      }),
      execute: vi.fn(async () => {
        state.executes++;
        state.order.push('lock');
        return [];
      }),
      insert: vi.fn(() => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: (conflict: { set: Record<string, unknown> }) => {
            state.upserts.push(values);
            state.upsertSet = conflict.set;
            state.order.push('upsert');
            return Promise.resolve();
          },
        }),
      })),
    },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('../dispatchDeviceCommand', () => ({ dispatchDeviceCommand: vi.fn() }));
vi.mock('../partnerTrust.commands', () => ({ assertDeviceExecuteAllowed: vi.fn(async () => undefined) }));

vi.mock('./toolManifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./toolManifest')>();
  return {
    ...actual,
    isLaneOpen: vi.fn(() => true),
    openCategoriesForLane: vi.fn(() => ['bios', 'firmware', 'driver', 'application']),
    getLaneManifest: vi.fn(actual.getLaneManifest),
  };
});

import { dispatchDeviceCommand } from '../dispatchDeviceCommand';
import { assertDeviceExecuteAllowed } from '../partnerTrust.commands';
import {
  assertOemRunAllowedForActor,
  dispatchOemUpdateRelease,
  dispatchOemUpdateRun,
  type OemDispatchInput,
} from './dispatch';
import { defaultOfflinePolicy } from '../commandOfflinePolicy';
import { getLaneManifest, isLaneOpen, openCategoriesForLane } from './toolManifest';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG_ID = '33333333-3333-4333-8333-333333333333';
const PARTNER_ID = '44444444-4444-4444-8444-444444444444';
const COMMAND_ID = '55555555-5555-4555-8555-555555555555';
const PROTECTOR_ID = '66666666-6666-4666-8666-666666666666';
const USER_ID = '77777777-7777-4777-8777-777777777777';

function eligibleDevice(): Record<string, unknown> {
  return {
    id: DEVICE_ID,
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    orgType: 'customer',
    status: 'online',
    agentVersion: '0.127.0',
    osType: 'windows',
    isVirtual: false,
    isEphemeral: false,
    deviceRole: 'workstation',
    manufacturer: 'Dell Inc.',
    model: 'Latitude 7420',
    biosVersion: '1.20.0',
  };
}

function input(overrides: Partial<OemDispatchInput> = {}): OemDispatchInput {
  return {
    deviceId: DEVICE_ID,
    expectedOrgId: ORG_ID,
    trigger: 'on_demand',
    requestedCategories: ['driver'],
    blockedUpdateIds: [],
    rebootControlled: true,
    notAfter: new Date(Date.now() + 60 * 60 * 1000),
    occurrenceKey: null,
    actorUserId: USER_ID,
    ...overrides,
  };
}

function queued(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    command: { id: COMMAND_ID },
    delivery: 'queued_live',
    deliverBy: new Date(),
    ...extra,
  } as never;
}

function sentPayload(): Record<string, unknown> {
  return vi.mocked(dispatchDeviceCommand).mock.calls[0]![0].payload as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
  state.device = eligibleDevice();
  state.status = null;
  state.keys = [];
  state.inFlight = [];
  state.upserts = [];
  state.upsertSet = null;
  state.executes = 0;
  state.order = [];
  vi.mocked(dispatchDeviceCommand).mockReset();
  vi.mocked(dispatchDeviceCommand).mockResolvedValue(queued());
  vi.mocked(isLaneOpen).mockReturnValue(true);
  vi.mocked(openCategoriesForLane).mockReturnValue(['bios', 'firmware', 'driver', 'application']);
});

async function expectRefusal(refusal: string, overrides: Partial<OemDispatchInput> = {}): Promise<void> {
  await expect(dispatchOemUpdateRun(input(overrides))).resolves.toEqual({ ok: false, refusal });
  expect(dispatchDeviceCommand).not.toHaveBeenCalled();
  expect(state.upserts).toEqual([]);
}

describe('dispatchOemUpdateRun: one refusal per lock', () => {
  it('flag_off when the master flag is off', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    await expectRefusal('flag_off');
  });

  it('flag_off when the partner is not on the allowlist', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', 'some-other-partner');
    await expectRefusal('flag_off');
    vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', '');
  });

  it('lane_closed when the lane gate is closed', async () => {
    vi.mocked(isLaneOpen).mockReturnValue(false);
    await expectRefusal('lane_closed');
  });

  it('kill_switch when the lane is disabled by env', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'dell');
    await expectRefusal('kill_switch');
    vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', '');
  });

  it('agent_too_old for an older, null or unparseable version', async () => {
    for (const agentVersion of ['0.126.0', null, 'garbage', '']) {
      state.device = { ...eligibleDevice(), agentVersion };
      await expectRefusal('agent_too_old');
    }
  });

  it('not_applicable for a near-miss manufacturer', async () => {
    state.device = { ...eligibleDevice(), manufacturer: 'Dell EMC' };
    await expectRefusal('not_applicable');
  });

  it('not_applicable for a lane that has not shipped', async () => {
    state.device = { ...eligibleDevice(), manufacturer: 'Lenovo' };
    await expectRefusal('not_applicable');
  });

  it('not_supported while the tool and the model are the ones that refused', async () => {
    state.status = {
      applicability: 'not_supported',
      notSupportedToolVersion: getLaneManifest('dell').tool!.version,
      notSupportedModel: 'Latitude 7420',
    };
    await expectRefusal('not_supported');
  });

  it('ephemeral for a Quick Support device', async () => {
    state.device = { ...eligibleDevice(), isEphemeral: true };
    await expectRefusal('ephemeral');
  });

  it('parked for a device in a holding org', async () => {
    state.device = { ...eligibleDevice(), orgType: 'unassigned_pool' };
    await expectRefusal('parked');
  });

  it('offline for a device that is not online', async () => {
    for (const status of ['offline', 'maintenance', 'updating']) {
      state.device = { ...eligibleDevice(), status };
      await expectRefusal('offline');
    }
  });

  it('decommissioned for a decommissioned device', async () => {
    state.device = { ...eligibleDevice(), status: 'decommissioned' };
    await expectRefusal('decommissioned');
  });

  it('run_in_flight while a pending or sent run exists, checked under the device lock', async () => {
    state.inFlight = [{ id: 'cmd-old' }];
    await expectRefusal('run_in_flight');
    expect(state.order.indexOf('lock')).toBeLessThan(state.order.indexOf('inFlight'));
    expect(state.order.indexOf('lock')).toBeGreaterThanOrEqual(0);
  });

  it('no_open_categories when every requested category is closed', async () => {
    vi.mocked(openCategoriesForLane).mockReturnValue([]);
    await expectRefusal('no_open_categories');
  });

  it('device_not_found when the device does not exist', async () => {
    state.device = null;
    await expectRefusal('device_not_found');
  });
});

describe('dispatchOemUpdateRun: org binding', () => {
  it('expectedOrgId mismatch queues nothing (device moved mid-flight)', async () => {
    await expectRefusal('device_not_found', { expectedOrgId: OTHER_ORG_ID });
  });

  it('passes expectedOrgId to the seam and stamps the row with the device org', async () => {
    await dispatchOemUpdateRun(input());
    expect(vi.mocked(dispatchDeviceCommand).mock.calls[0]![0].expectedOrgId).toBe(ORG_ID);
    expect(state.upserts[0]).toMatchObject({ deviceId: DEVICE_ID, orgId: ORG_ID });
  });

  it('maps the enqueue seam refusals', async () => {
    const cases = [
      ['device_not_found', 'device_not_found'],
      ['device_offline', 'offline'],
      ['device_decommissioned', 'decommissioned'],
      ['device_pending_assignment', 'parked'],
      ['trust_denied', 'trust_denied'],
    ] as const;
    for (const [code, refusal] of cases) {
      vi.mocked(dispatchDeviceCommand).mockResolvedValueOnce({ ok: false, code, error: 'x' });
      await expect(dispatchOemUpdateRun(input())).resolves.toEqual({ ok: false, refusal });
      expect(state.upserts).toEqual([]);
    }
  });
});

describe('dispatchOemUpdateRun: categories', () => {
  it('a closed category is dropped, not sent', async () => {
    vi.mocked(openCategoriesForLane).mockReturnValue(['driver']);
    const res = await dispatchOemUpdateRun(input({ requestedCategories: ['bios', 'driver'] }));
    expect(res).toEqual({ ok: true, commandId: COMMAND_ID, categories: ['driver'], skippedCategories: [] });
    expect(sentPayload().categories).toEqual(['driver']);
  });

  it('passes the device id to the gate check so the lab override is per device', async () => {
    await dispatchOemUpdateRun(input());
    expect(openCategoriesForLane).toHaveBeenCalledWith('dell', { deviceId: DEVICE_ID });
    expect(isLaneOpen).toHaveBeenCalledWith('dell', { deviceId: DEVICE_ID });
  });

  it('bios and firmware are dropped without a reboot Breeze controls', async () => {
    const res = await dispatchOemUpdateRun(input({
      requestedCategories: ['bios', 'firmware', 'driver'],
      rebootControlled: false,
    }));
    expect(res).toMatchObject({ ok: true, categories: ['driver'], skippedCategories: ['bios', 'firmware'] });
    expect(sentPayload().categories).toEqual(['driver']);
    expect(sentPayload().rebootControlled).toBe(false);
  });

  it('reports only what was open and dropped for the reboot, never a closed gate', async () => {
    vi.mocked(openCategoriesForLane).mockReturnValue(['bios', 'driver']);
    const res = await dispatchOemUpdateRun(input({
      requestedCategories: ['bios', 'firmware', 'driver', 'application'],
      rebootControlled: false,
    }));
    expect(res).toMatchObject({ ok: true, categories: ['driver'], skippedCategories: ['bios'] });
  });

  it('a run that controls the reboot skips nothing', async () => {
    const res = await dispatchOemUpdateRun(input({ requestedCategories: ['bios', 'driver'], rebootControlled: true }));
    expect(res).toMatchObject({ ok: true, categories: ['bios', 'driver'], skippedCategories: [] });
  });

  it('the trust check a route makes first names this command type', async () => {
    await assertOemRunAllowedForActor(DEVICE_ID, USER_ID);
    expect(assertDeviceExecuteAllowed).toHaveBeenCalledWith(DEVICE_ID, 'oem_update_run', USER_ID);
  });

  it('only bios without a reboot Breeze controls has nothing to send', async () => {
    await expectRefusal('no_open_categories', { requestedCategories: ['bios'], rebootControlled: false });
  });

  it('a duplicate request is sent once', async () => {
    await dispatchOemUpdateRun(input({ requestedCategories: ['driver', 'driver'] as OemCategory[] }));
    expect(sentPayload().categories).toEqual(['driver']);
  });
});

describe('dispatchOemUpdateRun: the row', () => {
  it('deliver_by comes from notAfter, through a queue policy (Review Focus 4)', async () => {
    const notAfter = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await dispatchOemUpdateRun(input({ notAfter }));
    const call = vi.mocked(dispatchDeviceCommand).mock.calls[0]![0];
    expect(call.offlinePolicy?.kind).toBe('queue');
    const within = (call.offlinePolicy as { deliverWithinMs: number }).deliverWithinMs;
    expect(Math.abs(Date.now() + within - notAfter.getTime())).toBeLessThan(5000);
  });

  it('a notAfter already past is a caller bug, and queues nothing', async () => {
    await expect(dispatchOemUpdateRun(input({ notAfter: new Date(Date.now() - 1000) }))).rejects.toThrow(/notAfter/);
    expect(dispatchDeviceCommand).not.toHaveBeenCalled();
  });

  it('never skips the delivery leg contract: the row is written before the socket push', async () => {
    const deliver = vi.fn(async () => queued({ delivery: 'delivered' }));
    vi.mocked(dispatchDeviceCommand).mockResolvedValue(queued({ deliver }));
    await dispatchOemUpdateRun(input());
    expect(vi.mocked(dispatchDeviceCommand).mock.calls[0]![0].deferDelivery).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(state.upserts).toHaveLength(1);
  });

  it('reports a row cancelled by the push claim as a refusal', async () => {
    const deliver = vi.fn(async () => queued({ delivery: 'cancelled', cancelReason: 'scope_changed' }));
    vi.mocked(dispatchDeviceCommand).mockResolvedValue(queued({ deliver }));
    await expect(dispatchOemUpdateRun(input())).resolves.toEqual({ ok: false, refusal: 'cancelled_at_claim' });
  });

  it('a retried dispatch after a tool or model change is not stuck on not_supported', async () => {
    state.status = {
      applicability: 'not_supported',
      notSupportedToolVersion: 'older-tool',
      notSupportedModel: 'Latitude 7420',
    };
    await expect(dispatchOemUpdateRun(input())).resolves.toMatchObject({ ok: true });

    state.status = {
      applicability: 'not_supported',
      notSupportedToolVersion: getLaneManifest('dell').tool!.version,
      notSupportedModel: 'Latitude 5420',
    };
    await expect(dispatchOemUpdateRun(input())).resolves.toMatchObject({ ok: true });
  });
});

describe('dispatchOemUpdateRun: the payload', () => {
  it('satisfies the strict wire contract', async () => {
    state.keys = [{ protectorId: PROTECTOR_ID }];
    await dispatchOemUpdateRun(input({
      trigger: 'scheduled',
      occurrenceKey: '2027-01',
      blockedUpdateIds: ['ABC12'],
    }));
    const parsed = oemUpdateRunPayloadSchema.parse(sentPayload());
    expect(parsed).toMatchObject({
      lane: 'dell',
      trigger: 'scheduled',
      occurrenceKey: '2027-01',
      blockedUpdateIds: ['ABC12'],
      escrowedProtectorIds: [PROTECTOR_ID],
      tool: null,
    });
  });

  it('carries protector ids only, never key material', async () => {
    state.keys = [{ protectorId: PROTECTOR_ID }];
    await dispatchOemUpdateRun(input());
    const body = JSON.stringify(sentPayload()).toLowerCase();
    expect(body).not.toMatch(/recovery|password|encrypted|secret/);
    expect(sentPayload().escrowedProtectorIds).toEqual([PROTECTOR_ID]);
  });

  it('normalizes a braced Windows GUID, and drops one it cannot read', async () => {
    state.keys = [
      { protectorId: `{${PROTECTOR_ID.toUpperCase()}}` },
      { protectorId: 'not-a-guid' },
      { protectorId: null },
    ];
    await dispatchOemUpdateRun(input());
    expect(sentPayload().escrowedProtectorIds).toEqual([PROTECTOR_ID]);
  });
});

describe('dispatchOemUpdateRun: the not-returned monitor', () => {
  it.each([['bios'], ['firmware']] as const)('a %s run arms it and records the BIOS version', async (category) => {
    const before = Date.now();
    await dispatchOemUpdateRun(input({ requestedCategories: [category] }));
    const row = state.upserts[0]!;
    expect(row.biosVersionBefore).toBe('1.20.0');
    expect((row.returnDeadlineAt as Date).getTime()).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    expect(row.runStartedAt).toBeInstanceOf(Date);
    expect(row.notReturnedAlertedAt).toBeNull();
    expect(state.upsertSet).toMatchObject({ biosVersionBefore: '1.20.0', notReturnedAlertedAt: null });
    expect(state.upsertSet?.returnDeadlineAt).toBeInstanceOf(Date);
  });

  it('a driver-only run never arms and never disturbs an armed one', async () => {
    await dispatchOemUpdateRun(input({ requestedCategories: ['driver', 'application'] }));
    expect(state.upserts[0]!.returnDeadlineAt).toBeUndefined();
    expect(state.upserts[0]!.biosVersionBefore).toBeUndefined();
    expect(state.upsertSet).not.toHaveProperty('returnDeadlineAt');
    expect(state.upsertSet).not.toHaveProperty('notReturnedAlertedAt');
  });

  it('records the command and the occurrence on the status row', async () => {
    await dispatchOemUpdateRun(input({ occurrenceKey: '2027-01' }));
    expect(state.upserts[0]).toMatchObject({
      lane: 'dell',
      applicability: 'applicable',
      lastCommandId: COMMAND_ID,
      occurrenceKey: '2027-01',
    });
    expect(state.upsertSet).toMatchObject({ lastCommandId: COMMAND_ID, occurrenceKey: '2027-01', applicability: 'applicable' });
  });

  it("a scheduled run clears last month's outcome, so it cannot read as this month's", async () => {
    await dispatchOemUpdateRun(input({ trigger: 'scheduled', occurrenceKey: '2027-02' }));
    expect(state.upsertSet).toMatchObject({ lastOutcome: null, lastErrorCode: null });
  });

  it('Run Now belongs to no occurrence and leaves the key and the outcome alone', async () => {
    await dispatchOemUpdateRun(input({ occurrenceKey: null }));
    expect(state.upsertSet).not.toHaveProperty('occurrenceKey');
    expect(state.upsertSet).not.toHaveProperty('lastOutcome');
  });
});

describe('dispatchOemUpdateRelease', () => {
  const release = (overrides: Partial<Parameters<typeof dispatchOemUpdateRelease>[0]> = {}) =>
    dispatchOemUpdateRelease({ deviceId: DEVICE_ID, expectedOrgId: ORG_ID, lane: 'dell', actorUserId: USER_ID, ...overrides });

  async function expectReleaseRefusal(refusal: string, overrides = {}): Promise<void> {
    await expect(release(overrides)).resolves.toEqual({ ok: false, refusal });
    expect(dispatchDeviceCommand).not.toHaveBeenCalled();
  }

  it('queues while the device is offline', async () => {
    state.device = { ...eligibleDevice(), status: 'offline' };
    await expect(release()).resolves.toEqual({ ok: true, commandId: COMMAND_ID });
    const call = vi.mocked(dispatchDeviceCommand).mock.calls[0]![0];
    expect(call.type).toBe('oem_update_release');
    expect(call.payload).toEqual({ lane: 'dell' });
    expect(call.expectedOrgId).toBe(ORG_ID);
    // No override: the registry's own class decides, and it queues.
    expect(call.offlinePolicy).toBeUndefined();
    expect(defaultOfflinePolicy('oem_update_release').kind).toBe('queue');
  });

  it('agent below the release minimum is never sent one', async () => {
    for (const agentVersion of ['0.126.0', null, 'garbage', '']) {
      state.device = { ...eligibleDevice(), agentVersion };
      await expectReleaseRefusal('agent_too_old');
    }
  });

  it('does not check the feature flag, manifest gates or kill switches', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'dell');
    vi.mocked(isLaneOpen).mockReturnValue(false);
    await expect(release()).resolves.toEqual({ ok: true, commandId: COMMAND_ID });
    vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', '');
  });

  it('a device in another org is device_not_found', async () => {
    await expectReleaseRefusal('device_not_found', { expectedOrgId: OTHER_ORG_ID });
  });

  it('an unknown device is device_not_found', async () => {
    state.device = null;
    await expectReleaseRefusal('device_not_found');
  });

  it('refuses decommissioned, ephemeral and parked devices', async () => {
    state.device = { ...eligibleDevice(), status: 'decommissioned' };
    await expectReleaseRefusal('decommissioned');
    state.device = { ...eligibleDevice(), isEphemeral: true };
    await expectReleaseRefusal('ephemeral');
    state.device = { ...eligibleDevice(), orgType: 'unassigned_pool' };
    await expectReleaseRefusal('parked');
  });

  it('an existing pending or sent release is release_in_flight, after the per-device lock', async () => {
    state.inFlight = [{ id: COMMAND_ID }];
    state.order = [];
    await expectReleaseRefusal('release_in_flight');
    expect(state.order).toContain('lock');
    expect(state.order.indexOf('lock')).toBeLessThan(state.order.indexOf('inFlight'));
  });

  it('does not write the status row (takeover state belongs to the scheduler)', async () => {
    await release();
    expect(state.upserts).toEqual([]);
  });

  it('reports a release terminalised at claim', async () => {
    const deliver = vi.fn().mockResolvedValue({ ok: true, delivery: 'cancelled' });
    vi.mocked(dispatchDeviceCommand).mockResolvedValue(queued({ deliver }));
    await expect(release()).resolves.toEqual({ ok: false, refusal: 'cancelled_at_claim' });
  });
});

describe('dispatchOemUpdateRun: attempts per occurrence (#11065 W07)', () => {
  it('a new occurrence resets the count, by comparing inside the upsert', async () => {
    const outcome = await dispatchOemUpdateRun(input({ trigger: 'scheduled', occurrenceKey: '2027-02' }));
    expect(outcome.ok).toBe(true);
    const { sql, params } = new PgDialect().sqlToQuery(state.upsertSet!.attempts as SQL);
    expect(sql).toContain('IS DISTINCT FROM');
    expect(sql).toContain('"occurrence_key"');
    expect(params).toContain('2027-02');
    // A first row takes the column default, and a value can only be in the set.
    expect(state.upserts[0]).not.toHaveProperty('attempts');
  });

  it('Run Now leaves the count alone', async () => {
    const outcome = await dispatchOemUpdateRun(input({ trigger: 'on_demand', occurrenceKey: null }));
    expect(outcome.ok).toBe(true);
    expect(state.upsertSet).not.toHaveProperty('attempts');
  });
});
