import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Network-isolation W13 (#10101, plan W4b): the AI `release_containment`
 * handler routes through `releaseNetworkIsolation` and nothing else. It never
 * queues a command itself, and it runs only as an approved release that carries
 * the episode binding the effect digest verified.
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./networkIsolation/service', () => ({ startNetworkIsolation: vi.fn(), releaseNetworkIsolation: vi.fn() }));
vi.mock('./aiDispatch', () => ({ aiQueueCommandForExecution: vi.fn() }));
vi.mock('./dispatchDeviceCommand', () => ({ dispatchDeviceCommand: vi.fn() }));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn(async () => undefined) }));
vi.mock('../routes/remote/screenAccessConsentGate', () => ({ checkScreenAccessConsentGate: vi.fn(async () => ({ ok: true })) }));
vi.mock('./aiTools', () => ({ resolveWritableToolOrgId: vi.fn(() => ORG_ID), verifyDeviceAccess: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { aiQueueCommandForExecution } from './aiDispatch';
import { dispatchDeviceCommand } from './dispatchDeviceCommand';
import { registerIncidentTools } from './aiToolsIncident';
import { releaseNetworkIsolation, startNetworkIsolation } from './networkIsolation/service';
import { captureException } from './sentry';
import type { ToolExecutionContext } from './toolExecutionContext';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ISOLATION_ID = '33333333-3333-4333-8333-333333333333';
const input = { deviceId: DEVICE_ID, isolationId: ISOLATION_ID, reason: 'Incident contained and cleaned' };
const binding = { orgId: ORG_ID, deviceId: DEVICE_ID, isolationId: ISOLATION_ID, generation: 3 };
const releasedContext: ToolExecutionContext = {
  actionIntentId: '66666666-6666-4666-8666-666666666666',
  verifiedIsolationRelease: binding,
  releaseDecision: { approvalScope: 'four_eyes', decidedVia: 'web' } as never,
};

function makeAuth(): AuthContext {
  return {
    user: { id: '77777777-7777-4777-8777-777777777777', email: 'tech@example.test', name: 'Tech' },
    token: {} as never, partnerId: null, orgId: ORG_ID, scope: 'organization', accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID, orgCondition: vi.fn(() => undefined),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
  } as unknown as AuthContext;
}

function tool(): AiTool {
  const map = new Map<string, AiTool>();
  registerIncidentTools(map);
  const registered = map.get('release_containment');
  expect(registered, 'release_containment is not registered').toBeDefined();
  return registered!;
}

async function run(args: Record<string, unknown>, context?: ToolExecutionContext, auth = makeAuth()) {
  return JSON.parse(await tool().handler(args, auth, context)) as Record<string, unknown>;
}

function expectNothingQueued() {
  expect(aiQueueCommandForExecution).not.toHaveBeenCalled();
  expect(dispatchDeviceCommand).not.toHaveBeenCalled();
  expect(startNetworkIsolation).not.toHaveBeenCalled();
  expect(db.insert).not.toHaveBeenCalled();
  expect(db.update).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(releaseNetworkIsolation).mockResolvedValue({
    episode: { id: ISOLATION_ID, state: 'release_requested', generation: 4 }, commandId: 'release-command-1',
  } as never);
});

describe('release_containment registration (W13 #10101)', () => {
  it('is Tier 3, device-bound on deviceId, and asks for exactly device, episode and reason', () => {
    const t = tool();
    expect(t.tier).toBe(3);
    expect(t.deviceArgs).toEqual(['deviceId']);
    expect(t.domain).toBe('monitoring');
    expect(t.definition.input_schema.required).toEqual(['deviceId', 'isolationId', 'reason']);
    expect(Object.keys(t.definition.input_schema.properties ?? {}).sort()).toEqual(['deviceId', 'isolationId', 'reason']);
  });
});

describe('release_containment routes through the isolation service only (W13 #10101)', () => {
  it('calls releaseNetworkIsolation with kind ai and the verified binding, and queues nothing itself', async () => {
    const auth = makeAuth();
    const out = await run(input, releasedContext, auth);
    expect(releaseNetworkIsolation).toHaveBeenCalledTimes(1);
    expect(releaseNetworkIsolation).toHaveBeenCalledWith(auth, DEVICE_ID, ISOLATION_ID,
      { reason: 'Incident contained and cleaned' }, { kind: 'ai', approvalBinding: binding });
    expectNothingQueued();
    expect(out).toMatchObject({ success: true, commandId: 'release-command-1' });
  });

  it('returns scalars only: never the allowlist snapshot, agent report or sealed secret', async () => {
    vi.mocked(releaseNetworkIsolation).mockResolvedValue({
      episode: {
        id: ISOLATION_ID, state: 'release_requested', desiredState: 'released', generation: 4, releaseKind: 'ai',
        allowSnapshot: [{ scope: 'breeze', host: 'control.example.test' }], lastAgentReport: { generation: 3 },
        breakGlassSecretEnc: 'enc:never', reason: 'free text',
      },
      commandId: 'release-command-1',
    } as never);
    const out = await run(input, releasedContext);
    expect(out.episode).toEqual({
      id: ISOLATION_ID, state: 'release_requested', desiredState: 'released', generation: 4, releaseKind: 'ai',
    });
    expect(JSON.stringify(out)).not.toMatch(/control\.example\.test|enc:never|lastAgentReport|allowSnapshot/);
  });

  it('accepts an upper-case id when it names the bound episode', async () => {
    const upper = { ...input, deviceId: DEVICE_ID.toUpperCase(), isolationId: ISOLATION_ID.toUpperCase() };
    expect(await run(upper, releasedContext)).toMatchObject({ success: true });
    expect(vi.mocked(releaseNetworkIsolation).mock.calls[0]![4]).toEqual({ kind: 'ai', approvalBinding: binding });
  });

  it('trims the reason the way the service schema will', async () => {
    await run({ ...input, reason: '  Incident contained  ' }, releasedContext);
    expect(vi.mocked(releaseNetworkIsolation).mock.calls[0]![3]).toEqual({ reason: 'Incident contained' });
  });

  it('never takes the binding from the input: a forged generation/org is ignored', async () => {
    await run({ ...input, generation: 99, orgId: '99999999-9999-4999-8999-999999999999' }, releasedContext);
    expect(vi.mocked(releaseNetworkIsolation).mock.calls[0]![4]).toEqual({ kind: 'ai', approvalBinding: binding });
  });

  it.each([
    ['no context at all (a direct chat/MCP/script call)', undefined],
    ['an approved release without a verified binding', { actionIntentId: releasedContext.actionIntentId }],
    ['a binding outside an approved release', { verifiedIsolationRelease: binding }],
  ] as const)('refuses %s without calling the service', async (_label, context) => {
    const out = await run(input, context as ToolExecutionContext | undefined);
    expect(out.error).toMatch(/approved four-eyes release/);
    expect(out.code).toBe('approval_required');
    expect(releaseNetworkIsolation).not.toHaveBeenCalled();
    expectNothingQueued();
  });

  it.each([
    ['another isolation', { ...binding, isolationId: '88888888-8888-4888-8888-888888888888' }],
    ['another device', { ...binding, deviceId: '99999999-9999-4999-8999-999999999999' }],
  ])('refuses a binding for %s as approval_mismatch', async (_label, other) => {
    const out = await run(input, { ...releasedContext, verifiedIsolationRelease: other });
    expect(out).toMatchObject({ error: 'approval_mismatch' });
    expect(releaseNetworkIsolation).not.toHaveBeenCalled();
    expectNothingQueued();
  });

  it.each([undefined, '', '   ', 42])('asks for a reason when it is %j', async (reason) => {
    const out = await run({ ...input, reason }, releasedContext);
    expect(out.error).toMatch(/reason is required/i);
    expect(releaseNetworkIsolation).not.toHaveBeenCalled();
  });

  it.each(['deviceId', 'isolationId'])('requires %s', async (field) => {
    const out = await run({ ...input, [field]: undefined }, releasedContext);
    expect(out.error).toMatch(new RegExp(`${field} is required`));
    expect(releaseNetworkIsolation).not.toHaveBeenCalled();
  });

  it.each(['approval_mismatch', 'isolation_not_found', 'isolation_conflict', 'site_forbidden', 'device_not_found'] as const)(
    'surfaces the service refusal %s as a tool error, not success', async (error) => {
      vi.mocked(releaseNetworkIsolation).mockResolvedValue({ error } as never);
      const out = await run(input, releasedContext);
      expect(out).toEqual({ error });
      expect(out).not.toHaveProperty('success');
      expectNothingQueued();
    });

  it('sanitizes a thrown service error into a tool error and reports it', async () => {
    const fault = new Error('connection reset by peer at 192.0.2.10');
    vi.mocked(releaseNetworkIsolation).mockRejectedValue(fault);
    const out = await run(input, releasedContext);
    expect(typeof out.error).toBe('string');
    expect(out.error).toMatch(/^Failed to release network isolation/);
    expect(out).not.toHaveProperty('success');
    expect(captureException).toHaveBeenCalledWith(fault, undefined, expect.objectContaining({ phase: 'release_containment' }));
  });

  it('says so when the device had already confirmed the release (idempotent answer, nothing queued)', async () => {
    vi.mocked(releaseNetworkIsolation).mockResolvedValue({
      episode: { id: ISOLATION_ID, state: 'released', desiredState: 'released', generation: 4, releaseKind: 'console', releaseConfirmedAt: new Date() },
      commandId: 'earlier-release-command',
    } as never);
    const out = await run(input, releasedContext);
    expect(out).toMatchObject({ success: true, alreadyReleased: true });
    expect(out.note).toMatch(/already confirmed/);
  });

  it('a fresh release is not reported as already released', async () => {
    vi.mocked(releaseNetworkIsolation).mockResolvedValue({
      episode: { id: ISOLATION_ID, state: 'release_requested', desiredState: 'released', generation: 4, releaseKind: 'ai', releaseConfirmedAt: null },
      commandId: 'release-command-1',
    } as never);
    const out = await run(input, releasedContext);
    expect(out).not.toHaveProperty('alreadyReleased');
  });
});

describe('aiToolsIncident.ts never builds or queues a release_containment command (W13 #10101)', () => {
  const source = readFileSync(new URL('./aiToolsIncident.ts', import.meta.url), 'utf8');
  const start = source.indexOf("name: 'release_containment'");
  const end = source.indexOf('registerTool({', start);
  const block = source.slice(start, end === -1 ? undefined : end);

  it('the module imports no raw command-queue primitive', () => {
    const imports = source.split('\n').filter((line) => /^import\b/.test(line)).join('\n');
    expect(imports).not.toMatch(/dispatchDeviceCommand|commandQueue|\bdeviceCommands\b/);
  });

  it('the handler block calls the service and nothing that dispatches', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toMatch(/releaseNetworkIsolation\(/);
    expect(block).not.toMatch(/aiQueueCommandForExecution|dispatchDeviceCommand|queueCommand|db\.insert|db\.update/);
    expect(block).not.toMatch(/type:\s*'release_containment'/);
  });
});
