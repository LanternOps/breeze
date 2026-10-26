/**
 * Wisp W07 — registration of the two specialist tool names across the six
 * registries (plan Tasks 4 and 6; spec §7.5 is the deny-list sign-off).
 * REAL registries, no mocks.
 *
 *   launch_specialist        chat Tier 2 (asks-first kinds escalate to Tier 3),
 *                            agent-denied, MCP-declared, ai_sessions:use.
 *   wisp_specialist_request  the approval carrier: human-only, untiered, never
 *                            declared; minted by the coordinator under the
 *                            assessment run's agent principal.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiTools } from './aiTools';
import { TOOL_TIERS } from './aiAgentSdkTools';
import {
  checkAgentGuardrails,
  checkGuardrails,
  describeSpecialistRequest,
  TIER3_SUPERVISED_TOOLS,
  TOOL_PERMISSIONS,
} from './aiGuardrails';
import { AGENT_COORDINATOR_CARRIER_TOOLS, AGENT_HUMAN_ONLY_TOOLS, HUMAN_ONLY_TOOLS } from './aiToolExposure';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_CAPABILITY } from './aiAgents/agentToolCatalog';
import { TOOL_RATE_LIMITS } from './aiToolRateLimits';
import { SPECIALIST_KINDS, SPECIALIST_KIND_POLICY } from './wisp/specialistPolicy';
import { WISP_SPECIALIST_REQUEST_TOOL } from './wisp/specialistIntent';

// checkAgentGuardrails denies everything while autonomous agents are off.
beforeEach(() => { vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true'); });

const SDK_SRC = readFileSync(join(__dirname, 'aiAgentSdkTools.ts'), 'utf8');

const agentPolicy = {
  enabled: true, mode: 'shadow' as const, toolAllowlist: [] as string[],
  protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
  deviceId: null, deviceSiteId: null,
};

describe('wisp_specialist_request (approval carrier)', () => {
  it('is human-only: in aiTools (Tier 3), in HUMAN_ONLY_TOOLS, supervised, not in TOOL_TIERS, never declared to MCP', () => {
    expect(aiTools.get(WISP_SPECIALIST_REQUEST_TOOL)?.tier).toBe(3);
    expect(HUMAN_ONLY_TOOLS.has(WISP_SPECIALIST_REQUEST_TOOL)).toBe(true);
    expect(TIER3_SUPERVISED_TOOLS.has(WISP_SPECIALIST_REQUEST_TOOL)).toBe(true);
    expect(TOOL_TIERS[WISP_SPECIALIST_REQUEST_TOOL as keyof typeof TOOL_TIERS]).toBeUndefined();
    expect(SDK_SRC).not.toContain(`tool('${WISP_SPECIALIST_REQUEST_TOOL}'`);
    expect(TOOL_PERMISSIONS[WISP_SPECIALIST_REQUEST_TOOL]).toEqual({ resource: 'ai_sessions', action: 'use' });
    expect(TOOL_CAPABILITY[WISP_SPECIALIST_REQUEST_TOOL]).toBe('tenancy');
    expect(toolInputSchemas[WISP_SPECIALIST_REQUEST_TOOL]).toBeDefined();
  });

  it('is NOT agent-denied: the coordinator mints and releases it under the assessment run\'s agent principal', () => {
    expect(AGENT_HUMAN_ONLY_TOOLS.has(WISP_SPECIALIST_REQUEST_TOOL)).toBe(false);
    expect(AGENT_COORDINATOR_CARRIER_TOOLS.has(WISP_SPECIALIST_REQUEST_TOOL)).toBe(true);
  });

  it('every coordinator carrier is also human-only (never declared, so no model can call it)', () => {
    for (const name of AGENT_COORDINATOR_CARRIER_TOOLS) {
      expect(HUMAN_ONLY_TOOLS.has(name), name).toBe(true);
      expect(SDK_SRC).not.toContain(`tool('${name}'`);
    }
  });

  it('a device-less assessment run may raise it (proposed, never acted) even though it is not in the agent\'s allowlist', () => {
    const verdict = checkAgentGuardrails(WISP_SPECIALIST_REQUEST_TOOL, {}, agentPolicy);
    expect(verdict.disposition, verdict.reason).toBe('propose');
  });

  it('the carve-out is the carrier only: another device-less Tier-3 mutation is still denied', () => {
    expect(checkAgentGuardrails('operator_plan', {}, agentPolicy).disposition).toBe('deny');
    // Same tier, same device-less run, not a carrier, not allowlisted → denied.
    expect(checkAgentGuardrails('send_endpoint_message', { action: 'send' }, agentPolicy).disposition).toBe('deny');
    expect(checkAgentGuardrails('manage_services', { action: 'restart', deviceId: 'd', serviceName: 's' }, agentPolicy).disposition).toBe('deny');
  });

  it('the carve-out never bypasses the agent kill switch, mode off or a disabled agent', () => {
    expect(checkAgentGuardrails(WISP_SPECIALIST_REQUEST_TOOL, {}, { ...agentPolicy, mode: 'off' }).disposition).toBe('deny');
    expect(checkAgentGuardrails(WISP_SPECIALIST_REQUEST_TOOL, {}, { ...agentPolicy, enabled: false }).disposition).toBe('deny');
  });
});

describe('launch_specialist (Tier-2 chat tool)', () => {
  it('is tiered 2, agent-denied, permissioned ai_sessions:use, declared to MCP, schema + capability + rate limit present', () => {
    expect(TOOL_TIERS.launch_specialist).toBe(2);
    expect(aiTools.get('launch_specialist')?.tier).toBe(2);
    expect(AGENT_HUMAN_ONLY_TOOLS.has('launch_specialist')).toBe(true);
    expect(TOOL_PERMISSIONS.launch_specialist).toEqual({ resource: 'ai_sessions', action: 'use' });
    expect(toolInputSchemas.launch_specialist).toBeDefined();
    expect(TOOL_CAPABILITY.launch_specialist).toBe('tenancy');
    expect(SDK_SRC).toContain("tool('launch_specialist'");
    expect(TOOL_RATE_LIMITS.launch_specialist).toEqual({ limit: 10, windowSeconds: 3600 });
  });

  it('auto-admit kinds stay Tier 2; every asks-first kind escalates to a supervised Tier-3 approval in chat', () => {
    for (const kind of SPECIALIST_KINDS) {
      const check = checkGuardrails('launch_specialist', { orgId: 'o', kind, reason: 'because' });
      if (SPECIALIST_KIND_POLICY[kind].autoAdmit) {
        expect(check.tier, kind).toBe(2);
      } else {
        expect(check.tier, kind).toBe(3);
        expect(check.requiresApproval, kind).toBe(true);
      }
    }
  });

  // #10144: ONE approval per call. The chat gate raises exactly one card from
  // one guardrail verdict — the Tier-2 bridge card (per_step only) for an
  // auto-admit kind, or one supervised Tier-3 intent for an asks-first kind —
  // never a Tier-2 card followed by a Tier-3 one. So each kind must resolve to
  // a single tier, with one approver (supervised, never four_eyes), in every
  // chat context, and the coordinator must not mint a second (carrier) card on
  // the user path (coordinator.test.ts: `operator_recipe from user → admitted`).
  it('every kind resolves to exactly one approval: Tier 2 (no intent) or one supervised Tier-3 intent', () => {
    for (const kind of SPECIALIST_KINDS) {
      for (const context of [undefined, { chatSession: true as const }]) {
        const check = checkGuardrails('launch_specialist', { orgId: 'o', kind, reason: 'because' }, context);
        if (SPECIALIST_KIND_POLICY[kind].autoAdmit) {
          expect(check, kind).toMatchObject({ tier: 2, allowed: true, requiresApproval: false });
          expect('approvalScope' in check, kind).toBe(false);
        } else {
          expect(check, kind).toMatchObject({ tier: 3, allowed: true, requiresApproval: true, approvalScope: 'supervised' });
        }
      }
    }
  });

  it('the card names the org, not a raw id prefix, when the chat gate resolved its name', () => {
    const input = { orgId: '64233cbe-0000-4000-8000-000000000001', kind: 'sweep', reason: 'disks are filling' };
    expect(describeSpecialistRequest(input, 'Default Organization'))
      .toBe('Wisp wants to run a health sweep at Default Organization: disks are filling');
    // No resolved name → never the raw id prefix.
    expect(describeSpecialistRequest(input)).toBe('Wisp wants to run a health sweep at this organization: disks are filling');
    expect(checkGuardrails('launch_specialist', input).description).not.toContain('64233cbe');
    // Tenant-controlled: one line, bounded.
    expect(describeSpecialistRequest(input, `Acme\n${'x'.repeat(200)}`))
      .toBe(`Wisp wants to run a health sweep at ${`Acme ${'x'.repeat(200)}`.slice(0, 80)}…: disks are filling`);
  });

  it('the tool tells the model which params each kind takes (goal is analysis-only)', () => {
    const def = aiTools.get('launch_specialist')!.definition;
    const paramsField = (def.input_schema.properties as Record<string, { description?: string }>).params!.description ?? '';
    // The params field lists the short kinds; the tool description the two long ones.
    const text = `${def.description} ${paramsField}`;
    for (const kind of SPECIALIST_KINDS) expect(text, kind).toMatch(new RegExp(`${kind} \\{`));
    expect(paramsField).toMatch(/sweep \{sweepKinds\?\}/);
    expect(paramsField).toMatch(/patch_plan \{\}/);
    expect(text.match(/goal/g)).toHaveLength(1);
    expect(paramsField).toMatch(/analysis \{goal/);
  });

  it('an agent principal is denied launch_specialist whatever its allowlist says', () => {
    const verdict = checkAgentGuardrails('launch_specialist', { orgId: 'o', kind: 'sweep', reason: 'x' }, {
      ...agentPolicy, deviceId: 'd', toolAllowlist: ['launch_specialist'],
    });
    expect(verdict.disposition).toBe('deny');
  });

  it('the landmine deny stays: workspace_launch_analysis is still agent-human-only', () => {
    expect(AGENT_HUMAN_ONLY_TOOLS.has('workspace_launch_analysis')).toBe(true);
  });
});
