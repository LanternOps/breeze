/**
 * `operator_plan` is a tool that EXECUTES NOTHING (Recipe Library spec §6.4).
 * Registering it as a real tool buys tier 3, four-eyes, RBAC, the effect-digest
 * pin and the existing approval card / durable release worker. Its handler's
 * whole job is to mark the plan approved (via the releasing intent) and wake
 * the task. It is AGENT_HUMAN_ONLY so a model can never propose one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { markPlanApproved } = vi.hoisted(() => ({ markPlanApproved: vi.fn() }));
vi.mock('./aiOperator/planApproval', () => ({ markPlanApproved }));

import { aiTools } from './aiToolNames';
import { getToolTier } from './aiTools';
import { TOOL_TIERS } from './aiAgentSdkTools';
import { HUMAN_ONLY_TOOLS } from './aiToolExposure';
import {
  AGENT_HUMAN_ONLY_TOOLS, TIER3_FOUR_EYES_TOOLS, TIER3_SUPERVISED_TOOLS,
  TOOL_PERMISSIONS, checkGuardrails, resolveApprovalScope,
} from './aiGuardrails';
import { TOOL_CAPABILITY, listAgentReachableTools } from './aiAgents/agentToolCatalog';
import { effectDigestResolverKey, requiresPinnedEffectDigest } from './actionIntents/effectDigest';
import { isOrgWideGovernanceIntent } from './actionIntents/orgWideGovernanceTools';

const TASK = '00000000-0000-4000-8000-0000000000a1';

beforeEach(() => markPlanApproved.mockReset());

describe('operator_plan registration', () => {
  it('is a registered core tool at tier 3, and TOOL_TIERS agrees', () => {
    expect(aiTools.has('operator_plan')).toBe(true);
    expect(getToolTier('operator_plan')).toBe(3);
    // Human-only: never tiered for chat (TOOL_TIERS) — the registry is the tier source.
    expect('operator_plan' in TOOL_TIERS).toBe(false);
    expect(HUMAN_ONLY_TOOLS.has('operator_plan')).toBe(true);
  });

  it('is FOUR-EYES, and is in exactly one whole-tool scope set', () => {
    expect(TIER3_FOUR_EYES_TOOLS.has('operator_plan')).toBe(true);
    expect(TIER3_SUPERVISED_TOOLS.has('operator_plan')).toBe(false);
    expect(resolveApprovalScope('operator_plan', undefined, {})).toBe('four_eyes');
  });

  it('checkGuardrails resolves it to tier 3 four_eyes end to end', () => {
    const check = checkGuardrails('operator_plan', {
      taskId: TASK, planRevision: 1, effectSetDigest: 'a'.repeat(64), effects: [],
    });
    expect(check.tier).toBe(3);
    expect(check.approvalScope).toBe('four_eyes');
    expect(check.readOnly).not.toBe(true);
  });

  it('carries an RBAC requirement', () => {
    expect(TOOL_PERMISSIONS.operator_plan).toBeDefined();
  });

  it('is HUMAN-ONLY: no agent may ever propose a plan approval', () => {
    expect(AGENT_HUMAN_ONLY_TOOLS.has('operator_plan')).toBe(true);
    expect(listAgentReachableTools()).not.toContain('operator_plan');
  });

  it('maps to a capability, so the catalog parity contract holds', () => {
    expect(TOOL_CAPABILITY.operator_plan).toBeDefined();
  });

  it('PINS its effect content with a real resolver, and the pin is mandatory', () => {
    expect(effectDigestResolverKey('operator_plan')).toBe('operator_plan');
    expect(requiresPinnedEffectDigest('operator_plan')).toBe(true);
  });

  it('is org-wide governance: a site-restricted user can neither raise nor approve it', () => {
    expect(isOrgWideGovernanceIntent('operator_plan', {})).toBe(true);
  });

  it('renders a headline with the effect count and the task id', () => {
    const effects = [1, 2, 3].map((i) => ({ ordinal: i }));
    const check = checkGuardrails('operator_plan', { taskId: TASK, planRevision: 1, effectSetDigest: 'a'.repeat(64), effects });
    expect(check.description).toBe(`Approve a 3-effect plan for AI Operator task ${TASK}`);
  });

  it('declares object-shaped, bounded effects in its input schema', () => {
    const schema = aiTools.get('operator_plan')!.definition.input_schema as {
      properties: Record<string, { type?: string; maxItems?: number; items?: { type?: string } }>;
      required?: string[];
    };
    expect(schema.required).toEqual(expect.arrayContaining(['taskId', 'planRevision', 'effectSetDigest', 'effects']));
    expect(schema.properties.effects!.maxItems).toBe(64);
    expect(schema.properties.effects!.items?.type).toBe('object');
  });
});

describe('operator_plan handler', () => {
  const handler = () => aiTools.get('operator_plan')!.handler;
  const args = { taskId: TASK, planRevision: 2, effectSetDigest: 'a'.repeat(64), effects: [] };

  it('marks the plan approved FROM THE RELEASING INTENT, never from auth.user', async () => {
    markPlanApproved.mockResolvedValue({ ok: true, taskId: TASK, planRevision: 2, effectCount: 3, approverUserId: 'u2' });
    const out = await handler()(args, { orgId: 'o1', user: { id: 'requester' } } as never, { actionIntentId: 'intent-1' } as never);
    expect(markPlanApproved).toHaveBeenCalledTimes(1);
    expect(markPlanApproved).toHaveBeenCalledWith({ orgId: 'o1', intentId: 'intent-1' });
    expect(out).toContain('Plan revision 2 approved');
    expect(out).toContain('3 effect(s)');
  });

  it('refuses without a releasing intent and does not call markPlanApproved', async () => {
    const out = await handler()(args, { orgId: 'o1' } as never, undefined);
    expect(markPlanApproved).not.toHaveBeenCalled();
    expect(JSON.parse(out).error).toMatch(/release of its own approved intent/);
  });

  it('refuses without an org', async () => {
    const out = await handler()(args, {} as never, { actionIntentId: 'intent-1' } as never);
    expect(markPlanApproved).not.toHaveBeenCalled();
    expect(JSON.parse(out).error).toBeDefined();
  });

  it('surfaces a refusal as an error string', async () => {
    markPlanApproved.mockResolvedValue({ ok: false, reason: 'digest_mismatch', detail: 'rows moved' });
    const out = await handler()(args, { orgId: 'o1' } as never, { actionIntentId: 'intent-1' } as never);
    expect(JSON.parse(out).error).toBe('digest_mismatch: rows moved');
  });
});
