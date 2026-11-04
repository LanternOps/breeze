import { describe, expect, it } from 'vitest';
import {
  checkGuardrails,
  resolveApprovalScope,
  TIER3_FOUR_EYES_TOOLS,
  TIER3_SUPERVISED_TOOLS,
  TOOL_PERMISSIONS,
} from './aiGuardrails';
import { TOOL_TIERS } from './aiAgentSdkTools';
import { TOOL_RATE_LIMITS } from './aiToolRateLimits';
import { toolInputSchemas } from './aiToolSchemas';
import { AGENT_HUMAN_ONLY_TOOLS, HUMAN_ONLY_TOOLS } from './aiToolExposure';
import { isSoleOperatorSelfApprovalForbidden } from './actionIntents/selfApprovalPolicy';
import { requiresPinnedEffectDigest } from './actionIntents/pinnedEffectPolicy';

/**
 * Network-isolation W13 (#10101, plan W4b, spec §2 and §3.10): the AI
 * `release_containment` tool is Tier 3 FOUR-EYES — a second person (or the
 * sole operator through WebAuthn) must approve lifting a containment. Isolating
 * stays supervised. These pins are the tool-specific half of that contract; the
 * generic four-eyes machinery is covered by the approval-scope and intent suites.
 */
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ISOLATION_ID = '33333333-3333-4333-8333-333333333333';
const input = { deviceId: DEVICE_ID, isolationId: ISOLATION_ID, reason: 'Incident contained and cleaned' };

describe('release_containment tier and approval class (W13 #10101)', () => {
  it('is a Tier 3 tool that needs approval', () => {
    expect(TOOL_TIERS.release_containment).toBe(3);
    const check = checkGuardrails('release_containment', input);
    expect(check).toMatchObject({ tier: 3, allowed: true, requiresApproval: true });
  });

  it('tells the approver it LIFTS an isolation, on which episode and device, and why', () => {
    const { description } = checkGuardrails('release_containment', input);
    expect(description).toContain('Release network isolation');
    expect(description).toContain(ISOLATION_ID.slice(0, 8));
    expect(description).toContain(DEVICE_ID.slice(0, 8));
    expect(description).toContain('Incident contained and cleaned');
  });

  it('is four-eyes, never supervised — isolating stays supervised', () => {
    expect(TIER3_FOUR_EYES_TOOLS.has('release_containment')).toBe(true);
    expect(TIER3_SUPERVISED_TOOLS.has('release_containment')).toBe(false);
    expect(resolveApprovalScope('release_containment', undefined, input)).toBe('four_eyes');
    expect(resolveApprovalScope('release_containment', undefined, {})).toBe('four_eyes');
    expect(resolveApprovalScope('execute_containment', undefined, { actionType: 'network_isolation' })).toBe('supervised');
  });

  it('keeps the sole-operator WebAuthn fallback (ai.mdx "Approving your own request")', () => {
    // A four-eyes intent whose only eligible approver is the requester gets one
    // requester-owned row, approved with a WebAuthn platform verification.
    // Only tools on the forbidden list (PAM elevation) lose that fallback.
    expect(isSoleOperatorSelfApprovalForbidden('release_containment')).toBe(false);
  });

  it('pins its effect digest mandatorily (no NULL-means-nothing-to-check release)', () => {
    expect(requiresPinnedEffectDigest('release_containment', input)).toBe(true);
    expect(requiresPinnedEffectDigest('release_containment', {})).toBe(true);
  });

  it('needs devices:execute, the human release route\'s permission', () => {
    expect(TOOL_PERMISSIONS.release_containment).toEqual({ resource: 'devices', action: 'execute' });
  });

  it('is rate limited to 5 per 10 minutes, like execute_containment', () => {
    expect(TOOL_RATE_LIMITS.release_containment).toEqual({ limit: 5, windowSeconds: 600 });
    expect(TOOL_RATE_LIMITS.release_containment).toEqual(TOOL_RATE_LIMITS.execute_containment);
  });

  it('is chat-reachable but never available to an agent principal', () => {
    expect(HUMAN_ONLY_TOOLS.has('release_containment')).toBe(false);
    expect(AGENT_HUMAN_ONLY_TOOLS.has('release_containment')).toBe(true);
  });
});

describe('release_containment input schema (W13 #10101)', () => {
  const schema = () => {
    const s = toolInputSchemas.release_containment;
    expect(s, 'release_containment has no Zod schema').toBeDefined();
    return s!;
  };

  it('accepts exactly a device, an episode and a reason', () => {
    expect(schema().parse(input)).toEqual(input);
  });

  it.each([
    ['deviceId', { ...input, deviceId: 'not-a-uuid' }],
    ['isolationId', { ...input, isolationId: 'not-a-uuid' }],
    ['reason (blank)', { ...input, reason: '   ' }],
    ['reason (too long)', { ...input, reason: 'x'.repeat(2001) }],
    ['reason (missing)', { deviceId: DEVICE_ID, isolationId: ISOLATION_ID }],
    ['isolationId (missing)', { deviceId: DEVICE_ID, reason: 'r' }],
  ])('rejects an invalid %s', (_label, value) => {
    expect(schema().safeParse(value).success).toBe(false);
  });

  it('carries no generation, org or allowlist field the model could forge', () => {
    // The approval binding comes from the pinned effect digest, never from input.
    const parsed = schema().parse({ ...input, generation: 1, orgId: DEVICE_ID, allow: [] }) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['deviceId', 'isolationId', 'reason']);
  });
});
