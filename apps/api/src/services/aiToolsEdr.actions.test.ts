import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  resolveScope: vi.fn(),
  mfa: true,
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  hasDbAccessContext: vi.fn(() => false),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./edrProviders/read', async () => {
  const actual = await vi.importActual<typeof import('./edrProviders/read')>('./edrProviders/read');
  return { ...actual, resolveEdrReadScope: h.resolveScope };
});
vi.mock('./edrProviders/actions', () => ({ dispatchEdrAction: h.dispatch }));
vi.mock('../middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth')>('../middleware/auth');
  return {
    ...actual,
    hasSatisfiedMfa: vi.fn(() => h.mfa),
    withAuthDbAccessContext: vi.fn(async (_a: unknown, fn: () => Promise<unknown>) => fn()),
  };
});

import { EDR_DETECTION_ACTIONS, EDR_ENDPOINT_ACTIONS } from '@breeze/shared';
import { aiTools, type AiTool } from './aiTools';
import { registerEdrTools } from './aiToolsEdr';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_TIERS } from './aiAgentSdkTools';
import {
  checkGuardrails,
  TIER2_ACTIONS,
  TIER3_ACTIONS,
  TIER3_FOUR_EYES_ACTIONS,
  TIER3_FOUR_EYES_TOOLS,
  TIER3_SUPERVISED_ACTIONS,
  TOOL_PERMISSIONS,
} from './aiGuardrails';
import { EdrActionError } from './edrProviders/actionErrors';
import type { AuthContext } from '../middleware/auth';
import type { ToolExecutionContext } from './toolExecutionContext';

const DEVICE = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-0000000000aa';

function handler(): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerEdrTools(reg);
  return reg.get('edr_endpoint_action')!.handler;
}
function auth(over: Record<string, unknown> = {}): AuthContext {
  return {
    user: { id: USER, email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: { mfa: true } as any, partnerId: 'p1', orgId: null, scope: 'partner',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    principal: { kind: 'user_session' },
    ...over,
  } as unknown as AuthContext;
}
const run = (input: Record<string, unknown>, a = auth(), ctx?: ToolExecutionContext) =>
  handler()(input, a, ctx).then((s) => JSON.parse(s as string));

beforeEach(() => {
  vi.clearAllMocks();
  h.mfa = true;
  h.resolveScope.mockImplementation(async (a: unknown) => ({ auth: a, allowedDeviceIds: null, allowedSiteIds: null }));
  h.dispatch.mockResolvedValue({ actionId: 'act-1', status: 'succeeded', outcomeUnknown: false, error: null, message: null, httpStatus: 200 });
});

// Spec §4.10 classification — the first detection-action adapter must wire these up.
const EXPECT: Record<string, { tier: 2 | 3; scope?: 'supervised' | 'four_eyes' }> = {
  isolate: { tier: 3, scope: 'supervised' },
  unisolate: { tier: 3, scope: 'four_eyes' },
  scan: { tier: 2 },
  update_agent: { tier: 2 },
  kill_process: { tier: 3, scope: 'supervised' },
  rollback: { tier: 3, scope: 'four_eyes' },
  resolve_detection: { tier: 3, scope: 'four_eyes' },
  mark_false_positive: { tier: 3, scope: 'four_eyes' },
  quarantine_restore: { tier: 3, scope: 'four_eyes' },
  quarantine_delete: { tier: 3, scope: 'supervised' },
};

describe('edr_endpoint_action — registration', () => {
  it('has no per-tool AI rate-limit row (dispatchEdrAction enforces per-actor + per-connection limits)', async () => {
    const { TOOL_RATE_LIMITS } = await import('./aiToolRateLimits');
    expect(Object.keys(TOOL_RATE_LIMITS).length).toBeGreaterThan(10);
    expect(TOOL_RATE_LIMITS.edr_endpoint_action).toBeUndefined();
  });

  it('is registered at base tier 3, self-managed DB context, deviceId-gated, devices.execute', () => {
    const tool = aiTools.get('edr_endpoint_action')!;
    expect(tool).toBeDefined();
    expect(tool.tier).toBe(3);
    expect(tool.selfManagedDbContext).toBe(true);
    expect(tool.deviceArgs).toEqual(['deviceId']);
    expect(TOOL_TIERS['edr_endpoint_action' as keyof typeof TOOL_TIERS]).toBe(3);
    expect(TOOL_PERMISSIONS.edr_endpoint_action).toEqual({ resource: 'devices', action: 'execute' });
    expect(tool.definition.description?.length ?? 0).toBeLessThanOrEqual(300);
  });

  it('the model surface only offers implemented actions', () => {
    const schema = toolInputSchemas.edr_endpoint_action!;
    for (const action of ['isolate', 'unisolate', 'scan']) {
      expect(schema.safeParse({ deviceId: DEVICE, action }).success, action).toBe(true);
    }
    for (const action of ['update_agent', 'kill_process', 'wipe', 'rollback']) {
      expect(schema.safeParse({ deviceId: DEVICE, action }).success, action).toBe(false);
    }
    expect(schema.safeParse({ action: 'scan' }).success).toBe(false);
    expect(schema.safeParse({ deviceId: 'nope', action: 'scan' }).success).toBe(false);
    expect(schema.safeParse({ deviceId: DEVICE, action: 'scan', reason: 'x'.repeat(501) }).success).toBe(false);
    const props = (aiTools.get('edr_endpoint_action')!.definition.input_schema as { properties: { action: { enum: string[] } } }).properties;
    expect(props.action.enum).toEqual(['isolate', 'unisolate', 'scan']);
  });

  it('edr_detection_action is NOT registered until an adapter implements a detection action (A4b)', () => {
    expect(aiTools.get('edr_detection_action')).toBeUndefined();
    expect(checkGuardrails('edr_detection_action', { action: 'rollback' })).toMatchObject({ tier: 4 });
  });
});

const OFFERED = ['isolate', 'unisolate', 'scan'] as const;
const NOT_OFFERED = EDR_ENDPOINT_ACTIONS.filter((a) => !(OFFERED as readonly string[]).includes(a));

describe('edr_endpoint_action — fail-closed tiers (spec §4.10)', () => {
  it.each(OFFERED.map((a) => [a]))('%s resolves to its classified tier and scope', (action) => {
    const g = checkGuardrails('edr_endpoint_action', { action, deviceId: DEVICE });
    expect(g.tier).toBe(EXPECT[action]!.tier);
    if (EXPECT[action]!.scope) expect((g as { approvalScope?: string }).approvalScope).toBe(EXPECT[action]!.scope);
  });

  it.each(NOT_OFFERED.map((a) => [a]))('%s (no adapter yet, not offered) fails closed to tier 3 four_eyes', (action) => {
    // The approvalScope contract forbids tier-table rows for actions outside the
    // real enum; the pinned EXPECT row is what the first adapter wires up.
    expect(checkGuardrails('edr_endpoint_action', { action, deviceId: DEVICE })).toMatchObject({ tier: 3, approvalScope: 'four_eyes' });
  });

  it('every offered endpoint action sits in exactly one bucket (tier 2 XOR supervised XOR four_eyes)', () => {
    for (const action of OFFERED) {
      const buckets = [
        TIER2_ACTIONS.edr_endpoint_action?.includes(action),
        TIER3_SUPERVISED_ACTIONS.edr_endpoint_action?.includes(action),
        TIER3_FOUR_EYES_ACTIONS.edr_endpoint_action?.includes(action),
      ].filter(Boolean);
      expect(buckets, action).toHaveLength(1);
      const t3 = TIER3_ACTIONS.edr_endpoint_action?.includes(action) ?? false;
      expect(t3, action).toBe(EXPECT[action]!.tier === 3);
    }
  });

  it('an unknown action string fails closed to tier 3 four_eyes', () => {
    expect(checkGuardrails('edr_endpoint_action', { action: 'wipe', deviceId: DEVICE })).toMatchObject({
      tier: 3, approvalScope: 'four_eyes',
    });
    expect(TIER3_FOUR_EYES_TOOLS.has('edr_endpoint_action')).toBe(true);
  });

  it('the detection-action classification is pinned for the first adapter that adds one', () => {
    // Recorded here, not in the guardrail tables, while the tool is unregistered.
    for (const action of EDR_DETECTION_ACTIONS) expect(EXPECT[action], action).toBeDefined();
    expect(Object.keys(EXPECT).sort()).toEqual([...EDR_ENDPOINT_ACTIONS, ...EDR_DETECTION_ACTIONS].sort());
  });
});

describe('edr_endpoint_action — handler', () => {
  it('approver release mismatch → refused before dispatch', async () => {
    const out = await run({ deviceId: DEVICE, action: 'isolate' }, auth(), {
      actionIntentId: 'intent-1', approverRelease: { approverUserId: 'someone-else' },
    } as ToolExecutionContext);
    expect(out).toEqual({ error: 'approver_auth_mismatch' });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('MFA unsatisfied → refused', async () => {
    h.mfa = false;
    expect(await run({ deviceId: DEVICE, action: 'scan' })).toEqual({ error: 'MFA required' });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it.each(['isolate', 'unisolate'])('tier-3 %s without an approved intent → approval_required, no dispatch', async (action) => {
    const out = await run({ deviceId: DEVICE, action });
    expect(out).toMatchObject({ error: 'approval_required' });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('an unknown action is refused as approval_required (never dispatched)', async () => {
    expect(await run({ deviceId: DEVICE, action: 'wipe' })).toMatchObject({ error: 'approval_required' });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('tier-2 scan without an intent dispatches with AI provenance', async () => {
    const a = auth({ aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' } });
    const out = await run({ deviceId: DEVICE, action: 'scan', reason: 'triage' }, a);
    expect(out).toEqual({ success: true, actionId: 'act-1', status: 'succeeded', outcomeUnknown: false });
    expect(h.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedVia: 'ai', requestedBy: USER, aiSessionId: 'sess-1', approvalId: null, reason: 'triage',
      }),
      { kind: 'device', deviceId: DEVICE, action: 'scan' },
    );
  });

  it('a released isolate carries approvalId = the intent and requestedBy = the approver', async () => {
    const approver = '00000000-0000-4000-8000-0000000000bb';
    await run({ deviceId: DEVICE, action: 'isolate', connectionId: '00000000-0000-4000-8000-0000000000cc' },
      auth({ user: { id: approver, email: 'x', name: 'x', isPlatformAdmin: false } }),
      { actionIntentId: 'intent-9', approverRelease: { approverUserId: approver } } as ToolExecutionContext);
    expect(h.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ requestedBy: approver, approvalId: 'intent-9', requestedVia: 'ai' }),
      { kind: 'device', deviceId: DEVICE, connectionId: '00000000-0000-4000-8000-0000000000cc', action: 'isolate' },
    );
  });

  it('a device-bound run whose frozen set excludes the device is refused before dispatch', async () => {
    const out = await run({ deviceId: DEVICE, action: 'scan' }, auth({ allowedDeviceIds: ['00000000-0000-4000-8000-000000000009'] }));
    expect(out).toMatchObject({ error: 'site_denied' });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('the site restriction is the caller scope ∩ the run\'s frozen devices', async () => {
    h.resolveScope.mockImplementation(async (a: unknown) => ({ auth: a, allowedDeviceIds: [DEVICE, 'd2'], allowedSiteIds: ['s1'] }));
    await run({ deviceId: DEVICE, action: 'scan' }, auth({ allowedDeviceIds: [DEVICE], allowedSiteIds: ['s1'] }));
    expect(h.dispatch.mock.calls[0]![0].restriction).toEqual({ allowedDeviceIds: [DEVICE], allowedSiteIds: ['s1'] });
  });

  it('EdrActionError maps to { error: code, message }; vendor raw text never appears', async () => {
    h.dispatch.mockRejectedValue(new EdrActionError('unsupported', 422, 'Already isolated'));
    expect(await run({ deviceId: DEVICE, action: 'scan' })).toEqual({ error: 'unsupported', message: 'Already isolated' });
    h.dispatch.mockResolvedValue({
      actionId: 'a', status: 'failed', outcomeUnknown: false, error: 'vendor_rejected', message: 'vendor says <script>', httpStatus: 502,
    });
    const out = await run({ deviceId: DEVICE, action: 'scan' });
    expect(out).toEqual({ success: false, actionId: 'a', status: 'failed', outcomeUnknown: false, error: 'vendor_rejected' });
    expect(JSON.stringify(out)).not.toContain('<script>');
  });
});
