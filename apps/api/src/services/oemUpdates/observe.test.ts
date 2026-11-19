import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { oemObservePayloadSchema, OEM_UPDATES_POLICY_DEFAULTS } from '@breeze/shared';

// Fake ids only: the canary partner is an env value and never named in the repo.
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const CANARY = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_PARTNER = 'bbbbbbbb-0000-4000-8000-000000000002';
const COMMAND_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = '77777777-7777-4777-8777-777777777777';

const state = vi.hoisted(() => ({
  device: null as Record<string, unknown> | null,
  recent: [] as Array<{ id: string }>,
  keys: [] as Array<{ protectorId: string | null }>,
  newestObserve: [] as Array<{ result: unknown }>,
  sweepRows: [] as Array<Record<string, unknown>>,
  sweepWhere: null as SQL | null,
  selects: 0,
  updates: [] as Array<{ table: unknown; set: Record<string, unknown> }>,
  inserts: 0,
}));

vi.mock('../../db', () => {
  const chain = (rows: () => unknown[], onWhere?: (w: SQL) => void) => {
    const c: Record<string, unknown> = {
      from: () => c,
      innerJoin: () => c,
      leftJoin: () => c,
      where: (w: SQL) => {
        onWhere?.(w);
        return c;
      },
      orderBy: () => c,
      limit: () => Promise.resolve(rows()),
    };
    return c;
  };
  return {
    db: {
      select: vi.fn((shape: Record<string, unknown>) => {
        state.selects++;
        if ('candidate' in shape) return chain(() => state.sweepRows, (w) => { state.sweepWhere = w; });
        if ('orgType' in shape) return chain(() => (state.device ? [state.device] : []));
        if ('protectorId' in shape) return chain(() => state.keys);
        if ('result' in shape) return chain(() => state.newestObserve);
        return chain(() => state.recent);
      }),
      execute: vi.fn(async () => []),
      update: vi.fn((table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: () => {
            state.updates.push({ table, set });
            return Promise.resolve();
          },
        }),
      })),
      insert: vi.fn(() => {
        state.inserts++;
        throw new Error('observe must not insert');
      }),
    },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('../dispatchDeviceCommand', () => ({ dispatchDeviceCommand: vi.fn() }));
vi.mock('./resolver', () => ({ resolveOemUpdatesLinkForDevice: vi.fn() }));
// Observe installs nothing, so the manifest gates have nothing to protect. Any
// read of them from the observe path is a bug.
vi.mock('./toolManifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./toolManifest')>();
  const boom = () => {
    throw new Error('observe must not consult manifest gates');
  };
  return { ...actual, isCategoryOpen: vi.fn(boom), isLaneOpen: vi.fn(boom), openCategoriesForLane: vi.fn(boom) };
});

import { deviceCommands, deviceOemUpdateStatus } from '../../db/schema';
import { commandRevalidations } from '../commandClaimEligibility';
import { dispatchDeviceCommand } from '../dispatchDeviceCommand';
import { resolveOemUpdatesLinkForDevice, type ResolvedOemUpdatesLink } from './resolver';
import { revalidateOemObserve } from './revalidation';
import {
  applyOemObserveResult,
  decideObserve,
  dispatchOemObserve,
  OEM_OBSERVE_DELIVER_WITHIN_MS,
  observedHpPlatformUnsupported,
  observeLinkAllows,
  runOemObserveSweep,
  type ObserveDeviceFacts,
} from './observe';

const WIRE = path.resolve(__dirname, '../../../../../agent/internal/oemupdates/observe/testdata/wire');
const golden = (lane: string) => JSON.parse(readFileSync(path.join(WIRE, `${lane}.json`), 'utf8'));

function device(overrides: Partial<ObserveDeviceFacts> = {}): ObserveDeviceFacts {
  return {
    id: DEVICE_ID,
    orgId: ORG_ID,
    partnerId: CANARY,
    orgType: 'customer',
    status: 'online',
    agentVersion: '0.131.0',
    osType: 'windows',
    isVirtual: false,
    isEphemeral: false,
    deviceRole: 'workstation',
    manufacturer: 'LENOVO',
    model: '21K5000AUS',
    ...overrides,
  };
}

function link(vendors: Record<string, unknown>, extra: Partial<ResolvedOemUpdatesLink> = {}): ResolvedOemUpdatesLink {
  return {
    linkId: 'l',
    configPolicyId: 'p',
    armedAt: null,
    assignedPolicyId: 'p',
    settings: { ...OEM_UPDATES_POLICY_DEFAULTS, enabled: true, vendors } as ResolvedOemUpdatesLink['settings'],
    invalidStoredSettings: false,
    ...extra,
  };
}
const lenovoOn = () => link({ lenovo: { enabled: true, categories: {}, blockedUpdateIds: [] } });

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
  vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
  state.device = device() as unknown as Record<string, unknown>;
  state.recent = [];
  state.keys = [];
  state.newestObserve = [];
  state.sweepRows = [];
  state.sweepWhere = null;
  state.selects = 0;
  state.updates = [];
  state.inserts = 0;
  vi.mocked(dispatchDeviceCommand).mockReset();
  vi.mocked(dispatchDeviceCommand).mockResolvedValue({
    ok: true,
    command: { id: COMMAND_ID },
    delivery: 'queued_live',
    deliverBy: new Date(),
  } as never);
  vi.mocked(resolveOemUpdatesLinkForDevice).mockReset();
  vi.mocked(resolveOemUpdatesLinkForDevice).mockResolvedValue(lenovoOn());
});

describe('decideObserve: one refusal per check, in order', () => {
  const decide = (d: ObserveDeviceFacts | null, expected = ORG_ID) => decideObserve(d, expected);

  it('device_not_found for no device or a device in another org', () => {
    expect(decide(null)).toEqual({ ok: false, refusal: 'device_not_found' });
    expect(decide(device(), '99999999-9999-4999-8999-999999999999')).toEqual({ ok: false, refusal: 'device_not_found' });
  });

  it('flag_off with the master flag off, or the partner off the allowlist', () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    expect(decide(device())).toEqual({ ok: false, refusal: 'flag_off' });
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
    vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', OTHER_PARTNER);
    expect(decide(device())).toEqual({ ok: false, refusal: 'flag_off' });
  });

  it('not_canary for a partner off the canary list, and with the list empty', () => {
    expect(decide(device({ partnerId: OTHER_PARTNER }))).toEqual({ ok: false, refusal: 'not_canary' });
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', '');
    expect(decide(device())).toEqual({ ok: false, refusal: 'not_canary' });
  });

  it('ephemeral, parked and decommissioned', () => {
    expect(decide(device({ isEphemeral: true }))).toEqual({ ok: false, refusal: 'ephemeral' });
    expect(decide(device({ orgType: 'unassigned_pool' }))).toEqual({ ok: false, refusal: 'parked' });
    expect(decide(device({ status: 'decommissioned' }))).toEqual({ ok: false, refusal: 'decommissioned' });
  });

  it('not_applicable off Windows, virtual, a server, a near-miss maker, or Dell (no stage entry)', () => {
    for (const d of [
      device({ osType: 'macos' }),
      device({ isVirtual: true }),
      device({ deviceRole: 'server' }),
      device({ manufacturer: 'Lenovo Group' }),
      device({ manufacturer: 'Microsoft Corporation', model: 'Virtual Machine' }),
      device({ manufacturer: 'Dell Inc.' }),
      device({ manufacturer: 'HPE' }),
    ]) {
      expect(decide(d)).toEqual({ ok: false, refusal: 'not_applicable' });
    }
  });

  it('lenovo observable though not in SHIPPED_OEM_LANES', () => {
    expect(decide(device())).toEqual({ ok: true, lane: 'lenovo' });
  });

  it('consumer HP and both Surface architectures are observable', () => {
    expect(decide(device({ manufacturer: 'HP', model: 'HP Laptop 15-fd0xxx' }))).toEqual({ ok: true, lane: 'hp' });
    expect(decide(device({ manufacturer: 'Microsoft Corporation', model: 'Surface Laptop, 7th Edition' })))
      .toEqual({ ok: true, lane: 'surface' });
  });

  it('kill_switch for the lane kill switch or the canary pair disabled', () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'lenovo');
    expect(decide(device())).toEqual({ ok: false, refusal: 'kill_switch' });
    vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', '');
    vi.stubEnv('BREEZE_VENDOR_CANARY_DISABLED', 'oem_updates:lenovo');
    expect(decide(device())).toEqual({ ok: false, refusal: 'kill_switch' });
    expect(decide(device({ manufacturer: 'HP', model: 'x' }))).toEqual({ ok: true, lane: 'hp' });
  });

  it('agent_too_old below the observe minimum, which is its own', () => {
    for (const agentVersion of ['0.130.0', '0.127.0', null, 'dev']) {
      expect(decide(device({ agentVersion }))).toEqual({ ok: false, refusal: 'agent_too_old' });
    }
  });

  it('observe ignores manifest gates (every gate is closed and observe still decides)', () => {
    expect(decide(device())).toEqual({ ok: true, lane: 'lenovo' });
  });
});

describe('observeLinkAllows: the policy opt-in', () => {
  it('needs an enabled policy with the lane enabled; categories are not required', () => {
    expect(observeLinkAllows(null, 'lenovo')).toBe(false);
    expect(observeLinkAllows(lenovoOn(), 'lenovo')).toBe(true);
    expect(observeLinkAllows(lenovoOn(), 'hp')).toBe(false);
    expect(observeLinkAllows(link({ lenovo: { enabled: false, categories: {}, blockedUpdateIds: [] } }), 'lenovo')).toBe(false);
    const off = lenovoOn();
    off.settings = { ...off.settings, enabled: false };
    expect(observeLinkAllows(off, 'lenovo')).toBe(false);
    expect(observeLinkAllows(link({ lenovo: { enabled: true, categories: {}, blockedUpdateIds: [] } }, { invalidStoredSettings: true }), 'lenovo')).toBe(false);
  });
});

describe('dispatchOemObserve', () => {
  const run = (trigger: 'on_demand' | 'scheduled' = 'on_demand') =>
    dispatchOemObserve({ deviceId: DEVICE_ID, expectedOrgId: ORG_ID, trigger, actorUserId: USER_ID });

  it('queues a strict passive payload with a short delivery window and writes no status row', async () => {
    state.keys = [{ protectorId: '{66666666-6666-4666-8666-666666666666}' }, { protectorId: 'garbage' }];
    await expect(run()).resolves.toEqual({ ok: true, commandId: COMMAND_ID });
    const call = vi.mocked(dispatchDeviceCommand).mock.calls[0]![0];
    expect(call.type).toBe('oem_observe');
    expect(call.expectedOrgId).toBe(ORG_ID);
    expect(oemObservePayloadSchema.parse(call.payload)).toEqual({
      lane: 'lenovo',
      observeLevel: 'passive',
      escrowedProtectorIds: ['66666666-6666-4666-8666-666666666666'],
    });
    expect(call.offlinePolicy).toEqual({ kind: 'queue', deliverWithinMs: OEM_OBSERVE_DELIVER_WITHIN_MS });
    expect(OEM_OBSERVE_DELIVER_WITHIN_MS).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(state.inserts).toBe(0);
    expect(state.updates).toEqual([]);
  });

  it('Run Now without a policy refuses no_policy for observe', async () => {
    vi.mocked(resolveOemUpdatesLinkForDevice).mockResolvedValue(null);
    await expect(run()).resolves.toEqual({ ok: false, refusal: 'no_policy' });
    expect(dispatchDeviceCommand).not.toHaveBeenCalled();
  });

  it('offline after the policy check', async () => {
    state.device = device({ status: 'offline' }) as unknown as Record<string, unknown>;
    await expect(run()).resolves.toEqual({ ok: false, refusal: 'offline' });
    expect(dispatchDeviceCommand).not.toHaveBeenCalled();
  });

  it('recent_observation when one ran in the last 24 h or is in flight', async () => {
    state.recent = [{ id: 'x' }];
    await expect(run()).resolves.toEqual({ ok: false, refusal: 'recent_observation' });
    expect(dispatchDeviceCommand).not.toHaveBeenCalled();
  });

  it('carries a pure refusal through without touching the queue', async () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', '');
    await expect(run()).resolves.toEqual({ ok: false, refusal: 'not_canary' });
    expect(resolveOemUpdatesLinkForDevice).not.toHaveBeenCalled();
    expect(dispatchDeviceCommand).not.toHaveBeenCalled();
  });

  it('maps a socket-claim cancel to cancelled_at_claim', async () => {
    vi.mocked(dispatchDeviceCommand).mockResolvedValue({
      ok: true,
      command: { id: COMMAND_ID },
      delivery: 'queued_live',
      deliverBy: new Date(),
      deliver: async () => ({ ok: true, delivery: 'cancelled' }),
    } as never);
    await expect(run()).resolves.toEqual({ ok: false, refusal: 'cancelled_at_claim' });
  });
});

describe('applyOemObserveResult', () => {
  const command = (lane = 'lenovo') => ({ id: COMMAND_ID, deviceId: DEVICE_ID, type: 'oem_observe', payload: { lane, observeLevel: 'passive', escrowedProtectorIds: [] } });

  it('result never touches device_oem_update_status, reboot planner or update-type exclusion', async () => {
    for (const lane of ['surface', 'hp', 'lenovo']) {
      await applyOemObserveResult({
        commandId: COMMAND_ID,
        deviceId: DEVICE_ID,
        command: command(lane) as never,
        envelopeStatus: 'completed',
        stdout: JSON.stringify(golden(lane)),
      });
    }
    expect(state.updates).toEqual([]);
    expect(state.inserts).toBe(0);
    // Structural: the module imports none of the writers it must not reach.
    const source = readFileSync(path.join(__dirname, 'observe.ts'), 'utf8');
    for (const banned of ['./results', './rebootPlanner', './laneDelivery', './policySideStore', 'deviceOemUpdateStatus']) {
      expect(source.includes(banned), banned).toBe(false);
    }
    expect(deviceOemUpdateStatus).toBeDefined();
  });

  it('scrubs a stored result that fails the contract, so unvalidated output does not persist', async () => {
    const bad = golden('lenovo');
    bad.smbios.serialNumber = 'PF123456';
    await applyOemObserveResult({
      commandId: COMMAND_ID,
      deviceId: DEVICE_ID,
      command: command() as never,
      envelopeStatus: 'completed',
      stdout: JSON.stringify(bad),
    });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.table).toBe(deviceCommands);
    expect(state.updates[0]!.set).toEqual({ result: { status: 'completed', rejected: 'observation_invalid' } });
    expect(JSON.stringify(state.updates[0]!.set)).not.toContain('PF123456');
  });

  it('scrubs non-JSON stdout and a lane that does not match the command', async () => {
    await applyOemObserveResult({ commandId: COMMAND_ID, deviceId: DEVICE_ID, command: command() as never, envelopeStatus: 'completed', stdout: 'C:\\Users\\someone' });
    await applyOemObserveResult({ commandId: COMMAND_ID, deviceId: DEVICE_ID, command: command('hp') as never, envelopeStatus: 'completed', stdout: JSON.stringify(golden('lenovo')) });
    expect(state.updates).toHaveLength(2);
  });

  it('leaves a failed command alone: its text is the agent\'s own error', async () => {
    await applyOemObserveResult({ commandId: COMMAND_ID, deviceId: DEVICE_ID, command: command() as never, envelopeStatus: 'failed', stdout: '' });
    expect(state.updates).toEqual([]);
  });
});

describe('revalidateOemObserve (claim recheck, both transports)', () => {
  const reader = (partnerId: string | null) => ({
    execute: vi.fn(async () => (partnerId ? [{ partner_id: partnerId }] : [])),
    select: vi.fn(),
    transaction: vi.fn(),
  });
  const row = (payload: unknown = { lane: 'lenovo', observeLevel: 'passive', escrowedProtectorIds: [] }) => ({
    id: COMMAND_ID, type: 'oem_observe', deviceId: DEVICE_ID, payload,
  });

  it('is the registered revalidation for oem_observe', () => {
    expect(commandRevalidations.oem_observe).toBe(revalidateOemObserve);
  });

  it('delivers while every check still holds', async () => {
    await expect(revalidateOemObserve(reader(CANARY) as never, row())).resolves.toBeNull();
  });

  it('stage off at claim cancels: partner off the list, list emptied, or pair disabled', async () => {
    await expect(revalidateOemObserve(reader(OTHER_PARTNER) as never, row())).resolves.toBe('scope_changed');
    await expect(revalidateOemObserve(reader(null) as never, row())).resolves.toBe('scope_changed');
    vi.stubEnv('BREEZE_VENDOR_CANARY_DISABLED', 'oem_updates:lenovo');
    await expect(revalidateOemObserve(reader(CANARY) as never, row())).resolves.toBe('scope_changed');
    vi.stubEnv('BREEZE_VENDOR_CANARY_DISABLED', '');
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', '');
    await expect(revalidateOemObserve(reader(CANARY) as never, row())).resolves.toBe('scope_changed');
  });

  it('flag off or lane killed at claim cancels', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    await expect(revalidateOemObserve(reader(CANARY) as never, row())).resolves.toBe('scope_changed');
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
    vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'lenovo');
    await expect(revalidateOemObserve(reader(CANARY) as never, row())).resolves.toBe('scope_changed');
  });

  it('an unreadable payload is refused', async () => {
    await expect(revalidateOemObserve(reader(CANARY) as never, row({ lane: 'dell' }))).resolves.toBe('authority_unavailable');
    await expect(revalidateOemObserve(reader(CANARY) as never, row({ lane: 'lenovo', observeLevel: 'scan', escrowedProtectorIds: [] }))).resolves.toBe('authority_unavailable');
  });
});

describe('runOemObserveSweep', () => {
  it('default off is inert: no query, no command', async () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', '');
    await expect(runOemObserveSweep(new Date())).resolves.toEqual({ considered: 0, dispatched: 0 });
    expect(state.selects).toBe(0);
    expect(dispatchDeviceCommand).not.toHaveBeenCalled();
  });

  it('inert with the master flag off too', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    await expect(runOemObserveSweep(new Date())).resolves.toEqual({ considered: 0, dispatched: 0 });
    expect(state.selects).toBe(0);
  });

  it("a non-canary partner's device is never swept: the query is scoped to the canary list", async () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', `${CANARY}`);
    state.sweepRows = [{ candidate: DEVICE_ID, orgId: ORG_ID }];
    await expect(runOemObserveSweep(new Date())).resolves.toEqual({ considered: 1, dispatched: 1 });
    const rendered = new PgDialect().sqlToQuery(state.sweepWhere!);
    expect(rendered.params).toContain(CANARY);
    expect(rendered.params).not.toContain(OTHER_PARTNER);
    expect(rendered.sql).toContain('"organizations"."partner_id" in');
    expect(vi.mocked(dispatchDeviceCommand).mock.calls[0]![0].type).toBe('oem_observe');
  });

  it('only partners the master allowlist also admits are swept', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', OTHER_PARTNER);
    await expect(runOemObserveSweep(new Date())).resolves.toEqual({ considered: 0, dispatched: 0 });
    expect(state.selects).toBe(0);
  });
});

describe('observedHpPlatformUnsupported', () => {
  it('true only for the newest observation with a 404 HP platform catalog', async () => {
    state.newestObserve = [{ result: { status: 'completed', stdout: JSON.stringify(golden('hp')) } }];
    await expect(observedHpPlatformUnsupported(DEVICE_ID)).resolves.toBe(true);
    const ok = golden('hp');
    ok.hp.platformCatalog.status = 200;
    state.newestObserve = [{ result: { status: 'completed', stdout: JSON.stringify(ok) } }];
    await expect(observedHpPlatformUnsupported(DEVICE_ID)).resolves.toBe(false);
    state.newestObserve = [{ result: { status: 'completed', rejected: 'observation_invalid' } }];
    await expect(observedHpPlatformUnsupported(DEVICE_ID)).resolves.toBe(false);
    state.newestObserve = [];
    await expect(observedHpPlatformUnsupported(DEVICE_ID)).resolves.toBe(false);
  });
});
