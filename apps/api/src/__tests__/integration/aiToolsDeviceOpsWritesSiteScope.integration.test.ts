/**
 * Integration test — W04 (#6758) device-operation write tools honour the site
 * axis and the org axis, against real Postgres as the unprivileged `breeze_app`
 * role (org-axis RLS genuinely enforced; the site axis is applied app-layer).
 *
 * Tools: manage_processes:kill, manage_scheduled_tasks:run/disable/enable,
 * registry_operations:set_value/create_key/delete_key, trigger_agent_restart,
 * trigger_agent_upgrade.
 *
 * Entry point: `executeTool`, so the CENTRAL `enforceDeviceArgs` gate (the
 * tools' `deviceArgs`) runs before the handler exactly as in production. These
 * are Tier-3 / Tier-2 tools; the human approval step lives in the chat layer
 * (unit-tested in aiGuardrails.*), not in `executeTool`, so this suite tests
 * the scope behaviour that runs AFTER approval.
 *
 * Fixture: one org with two sites (A = the restricted caller's allowed site,
 * B = forbidden), an online device in each, plus a second org with its own
 * device. For every tool:
 *   (i)   out-of-site device(s) -> refused by the gate, command NOT queued
 *   (ii)  in-site device        -> the (stubbed) command is queued
 *   (iii) cross-org caller      -> "not found", command NOT queued
 *   (iv)  unrestricted caller   -> reaches the site-B device
 *
 * Only the device command dispatch (`aiExecuteCommand`) and the agent-build
 * resolver for trigger_agent_upgrade are stubbed: NOTHING contacts a device or
 * enqueues a Redis job. Every refusal under test happens before the stub.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const { executeCommandMock } = vi.hoisted(() => ({
  executeCommandMock: vi.fn(async (..._args: unknown[]) => ({ status: 'completed', result: { ok: true } })),
}));

vi.mock('../../services/aiDispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/aiDispatch')>();
  return { ...actual, aiExecuteCommand: executeCommandMock };
});
// trigger_agent_upgrade: a sanctioned build newer than the device's 1.0.0.
vi.mock('../../routes/agents/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/agents/helpers')>();
  return {
    ...actual,
    getOrgAgentUpdateConfig: vi.fn(async () => ({ pins: { agent: null } })),
    resolvePinnedUpgradeTarget: vi.fn(async () => '9.9.9'),
  };
});

import { withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { executeTool } from '../../services/aiTools';
import type { AuthContext } from '../../middleware/auth';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const DEVICE_DENIED = 'Device not found or access denied';

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  const [row] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `devops-${randomUUID()}`,
    hostname: `do-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'amd64',
    agentVersion: '1.0.0',
    status: 'online',
  }).returning({ id: devices.id });
  return row!.id;
}

function makeAuth(opts: {
  userId: string;
  partnerId: string;
  orgId: string;
  allowedSiteIds?: string[];
}): AuthContext {
  const { allowedSiteIds } = opts;
  return {
    principal: { kind: 'user_session' },
    user: { id: opts.userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: opts.partnerId,
    orgId: opts.orgId,
    scope: 'organization',
    accessibleOrgIds: [opts.orgId],
    orgCondition: (col: any) => eq(col, opts.orgId),
    canAccessOrg: (id: string) => id === opts.orgId,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) =>
      !allowedSiteIds ? true : !!s && allowedSiteIds.includes(s),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'device-ops-scope' },
  } as unknown as AuthContext;
}

function orgCtx(orgId: string, f: { partnerId: string; userId: string }): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: f.userId,
    currentPartnerId: f.partnerId,
  };
}

interface Fixture {
  partnerId: string;
  orgA: string;
  orgB: string;
  userId: string;
  devA: string;
  devB: string;
  devOther: string;
  restricted: AuthContext;
  unrestricted: AuthContext;
  otherOrg: AuthContext;
}

async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id, name: 'Device ops A' });
  const siteB = await createSite({ orgId: orgA.id, name: 'Device ops B' });
  const siteOther = await createSite({ orgId: orgB.id, name: 'Device ops other' });
  const user = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `do-${randomUUID()}@example.com` });

  const base = { userId: user.id, partnerId: partner.id };
  return {
    partnerId: partner.id,
    orgA: orgA.id,
    orgB: orgB.id,
    userId: user.id,
    devA: await seedDevice(orgA.id, siteA.id),
    devB: await seedDevice(orgA.id, siteB.id),
    devOther: await seedDevice(orgB.id, siteOther.id),
    restricted: makeAuth({ ...base, orgId: orgA.id, allowedSiteIds: [siteA.id] }),
    unrestricted: makeAuth({ ...base, orgId: orgA.id }),
    otherOrg: makeAuth({ ...base, orgId: orgB.id }),
  };
}

type Who = 'restricted' | 'unrestricted' | 'otherOrg';

async function run(f: Fixture, who: Who, tool: string, input: Record<string, unknown>) {
  const orgId = who === 'otherOrg' ? f.orgB : f.orgA;
  const raw = await withDbAccessContext(orgCtx(orgId, f), () => executeTool(tool, input, f[who]));
  return JSON.parse(raw) as Record<string, any>;
}

interface Case {
  label: string;
  tool: string;
  /** Builds the input for a single target device. */
  input: (deviceId: string) => Record<string, unknown>;
  commandType: string;
}

const SINGLE_DEVICE_CASES: Case[] = [
  {
    label: 'manage_processes:kill',
    tool: 'manage_processes',
    input: (deviceId) => ({ action: 'kill', deviceId, processId: '4242' }),
    commandType: 'kill_process',
  },
  ...(['run', 'disable', 'enable'] as const).map((action): Case => ({
    label: `manage_scheduled_tasks:${action}`,
    tool: 'manage_scheduled_tasks',
    input: (deviceId) => ({ action, deviceId, taskName: '\\Breeze\\ScopeTest' }),
    commandType: `task_${action === 'run' ? 'run' : action}`,
  })),
  {
    label: 'registry_operations:set_value',
    tool: 'registry_operations',
    input: (deviceId) => ({
      action: 'set_value', deviceId, keyPath: 'HKLM\\SOFTWARE\\BreezeScopeTest', valueName: 'V', valueData: '1', valueType: 'REG_SZ',
    }),
    commandType: 'registry_set',
  },
  {
    label: 'registry_operations:create_key',
    tool: 'registry_operations',
    input: (deviceId) => ({ action: 'create_key', deviceId, keyPath: 'HKLM\\SOFTWARE\\BreezeScopeTest\\New' }),
    commandType: 'registry_key_create',
  },
  {
    label: 'registry_operations:delete_key',
    tool: 'registry_operations',
    input: (deviceId) => ({ action: 'delete_key', deviceId, keyPath: 'HKLM\\SOFTWARE\\BreezeScopeTest\\Old' }),
    commandType: 'registry_key_delete',
  },
];

describe('W04 device-operation write tools — site axis + org axis (real Postgres, breeze_app)', () => {
  let f: Fixture;
  beforeEach(async () => {
    executeCommandMock.mockClear();
    f = await seedFixture();
  });

  describe.each(SINGLE_DEVICE_CASES)('$label', (c) => {
    runDb('out-of-site device is refused by the central gate and nothing is queued', async () => {
      const denied = await run(f, 'restricted', c.tool, c.input(f.devB));
      expect(denied).toEqual({ error: DEVICE_DENIED });
      expect(executeCommandMock).not.toHaveBeenCalled();
    });

    runDb('in-site device queues the command', async () => {
      const ok = await run(f, 'restricted', c.tool, c.input(f.devA));
      expect(ok.error).toBeUndefined();
      expect(executeCommandMock).toHaveBeenCalledTimes(1);
      const call = executeCommandMock.mock.calls[0]!;
      expect(call[1]).toBe(c.tool);
      expect(call[2]).toBe(f.devA);
      expect(typeof call[3]).toBe('string');
    });

    runDb('cross-org caller (and a cross-org device id for the in-org caller) gets not found', async () => {
      expect(await run(f, 'otherOrg', c.tool, c.input(f.devA))).toEqual({ error: DEVICE_DENIED });
      expect(await run(f, 'restricted', c.tool, c.input(f.devOther))).toEqual({ error: DEVICE_DENIED });
      expect(executeCommandMock).not.toHaveBeenCalled();
    });

    runDb('unrestricted caller reaches the site-B device', async () => {
      const ok = await run(f, 'unrestricted', c.tool, c.input(f.devB));
      expect(ok.error).toBeUndefined();
      expect(executeCommandMock).toHaveBeenCalledTimes(1);
      expect(executeCommandMock.mock.calls[0]![2]).toBe(f.devB);
    });
  });

  describe.each([
    { tool: 'trigger_agent_restart', commandType: 'restart_agent', input: (ids: string[]) => ({ deviceIds: ids }) },
    { tool: 'trigger_agent_upgrade', commandType: 'update_agent', input: (ids: string[]) => ({ deviceIds: ids }) },
  ])('$tool', ({ tool, commandType, input }) => {
    runDb('a batch containing an out-of-site device is refused whole, even when the first id is in-site', async () => {
      // The handler only site-checks the FIRST id; the central gate is what
      // covers the rest, so the in-site id must come first to prove it.
      const denied = await run(f, 'restricted', tool, input([f.devA, f.devB]));
      expect(denied).toEqual({ error: DEVICE_DENIED });
      expect(await run(f, 'restricted', tool, input([f.devB]))).toEqual({ error: DEVICE_DENIED });
      expect(executeCommandMock).not.toHaveBeenCalled();
    });

    runDb('in-site device queues the watchdog command', async () => {
      const ok = await run(f, 'restricted', tool, input([f.devA]));
      expect(ok.error).toBeUndefined();
      expect(ok.queued).toBe(1);
      expect(ok.errors).toBeUndefined();
      expect(executeCommandMock).toHaveBeenCalledTimes(1);
      const call = executeCommandMock.mock.calls[0]!;
      expect(call[1]).toBe(tool);
      expect(call[2]).toBe(f.devA);
      expect(call[3]).toBe(commandType);
      expect((call[5] as { targetRole?: string }).targetRole).toBe('watchdog');
    });

    runDb('cross-org caller gets not found', async () => {
      expect(await run(f, 'otherOrg', tool, input([f.devA]))).toEqual({ error: DEVICE_DENIED });
      expect(await run(f, 'restricted', tool, input([f.devA, f.devOther]))).toEqual({ error: DEVICE_DENIED });
      expect(executeCommandMock).not.toHaveBeenCalled();
    });

    runDb('unrestricted caller reaches both sites in one batch', async () => {
      const ok = await run(f, 'unrestricted', tool, input([f.devA, f.devB]));
      expect(ok.error).toBeUndefined();
      expect(ok.queued).toBe(2);
      expect(executeCommandMock).toHaveBeenCalledTimes(2);
      expect(executeCommandMock.mock.calls.map((c) => c[2]).sort()).toEqual([f.devA, f.devB].sort());
    });
  });
});
