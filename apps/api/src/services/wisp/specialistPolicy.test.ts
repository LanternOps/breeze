import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ASSESSMENT_AUTO_ADMIT_SPECIALIST_KINDS,
  CHAT_TIER2_SPECIALIST_KINDS,
  CHAT_TIER3_SPECIALIST_KINDS,
  MAX_SPECIALIST_REQUESTS_PER_ASSESSMENT,
  SPECIALIST_KINDS,
  SPECIALIST_KIND_POLICY,
  isSpecialistKind,
} from './specialistPolicy';

describe('SPECIALIST_KIND_POLICY', () => {
  // Plan Decision 3 (#11084): the chat launch tier and the assessment
  // auto-admit are separate fields. Existing kinds keep today's behaviour
  // exactly; device_troubleshooting is a one-click chat hand-off that an
  // assessment can still only ASK for.
  it('an assessment auto-admits exactly the "acts alone" kinds of spec §3', () => {
    const auto = SPECIALIST_KINDS.filter((k) => SPECIALIST_KIND_POLICY[k].autoAdmitFromAssessment);
    expect(auto).toEqual(['sweep', 'analysis']);
    expect(ASSESSMENT_AUTO_ADMIT_SPECIALIST_KINDS).toEqual(['sweep', 'analysis']);
  });

  it('chat launches sweep, analysis and device_troubleshooting at Tier 2; every other kind at Tier 3', () => {
    expect(CHAT_TIER2_SPECIALIST_KINDS).toEqual(['sweep', 'analysis', 'device_troubleshooting']);
    expect(CHAT_TIER3_SPECIALIST_KINDS).toEqual(['operator_recipe', 'patch_plan', 'remediation_research', 'bulk_ticket_reply']);
    for (const k of SPECIALIST_KINDS) expect([2, 3]).toContain(SPECIALIST_KIND_POLICY[k].chatLaunchTier);
  });

  it('no kind is assessment-auto-admitted unless it is also a chat Tier-2 launch', () => {
    for (const k of SPECIALIST_KINDS) {
      if (SPECIALIST_KIND_POLICY[k].autoAdmitFromAssessment) expect(SPECIALIST_KIND_POLICY[k].chatLaunchTier, k).toBe(2);
    }
  });

  it('device_troubleshooting (#11084) needs a device, ai_agents:write and devices:execute', () => {
    expect(SPECIALIST_KIND_POLICY.device_troubleshooting).toMatchObject({
      chatLaunchTier: 2, autoAdmitFromAssessment: false, estimateCents: 100, requiresDevice: true,
    });
    expect(SPECIALIST_KIND_POLICY.device_troubleshooting.requiredPermissions).toEqual(['ai_agents:write', 'devices:execute']);
  });

  it('every kind requires ai_agents:write; analysis also requires ai_workspace:execute', () => {
    for (const k of SPECIALIST_KINDS) expect(SPECIALIST_KIND_POLICY[k].requiredPermissions).toContain('ai_agents:write');
    expect(SPECIALIST_KIND_POLICY.analysis.requiredPermissions).toContain('ai_workspace:execute');
    expect(SPECIALIST_KIND_POLICY.sweep.requiredPermissions).not.toContain('ai_workspace:execute');
  });

  it('bulk_ticket_reply (w00 A30) asks first and needs tickets:write', () => {
    expect(SPECIALIST_KINDS).toContain('bulk_ticket_reply');
    expect(SPECIALIST_KIND_POLICY.bulk_ticket_reply).toMatchObject({
      chatLaunchTier: 3,
      autoAdmitFromAssessment: false,
      estimateCents: 50,
      requiresDevice: false,
    });
    expect(SPECIALIST_KIND_POLICY.bulk_ticket_reply.requiredPermissions).toEqual(['ai_agents:write', 'tickets:write']);
  });

  it('operation keys are launch_specialist:<kind> and each entry names its own kind', () => {
    for (const k of SPECIALIST_KINDS) {
      expect(SPECIALIST_KIND_POLICY[k].operationKey).toBe(`launch_specialist:${k}`);
      expect(SPECIALIST_KIND_POLICY[k].kind).toBe(k);
    }
    expect(Object.keys(SPECIALIST_KIND_POLICY).sort()).toEqual([...SPECIALIST_KINDS].sort());
  });

  it('only remediation_research and device_troubleshooting require a device', () => {
    expect(SPECIALIST_KINDS.filter((k) => SPECIALIST_KIND_POLICY[k].requiresDevice)).toEqual(['remediation_research', 'device_troubleshooting']);
  });

  it('planner defaults for estimates and the per-assessment cap', () => {
    expect(SPECIALIST_KIND_POLICY.sweep.estimateCents).toBe(25);
    expect(SPECIALIST_KIND_POLICY.analysis.estimateCents).toBe(100);
    expect(SPECIALIST_KIND_POLICY.operator_recipe.estimateCents).toBe(50);
    expect(SPECIALIST_KIND_POLICY.patch_plan.estimateCents).toBe(50);
    expect(SPECIALIST_KIND_POLICY.remediation_research.estimateCents).toBe(50);
    expect(MAX_SPECIALIST_REQUESTS_PER_ASSESSMENT).toBe(3);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(SPECIALIST_KIND_POLICY)).toBe(true);
    expect(Object.isFrozen(SPECIALIST_KIND_POLICY.sweep)).toBe(true);
    expect(Object.isFrozen(SPECIALIST_KINDS)).toBe(true);
  });

  it('is a leaf module', () => {
    expect(readFileSync(new URL('./specialistPolicy.ts', import.meta.url), 'utf8')).not.toMatch(/^import /m);
  });

  it('rejects unknown kinds', () => {
    expect(isSpecialistKind('run_script')).toBe(false);
    expect(isSpecialistKind(undefined)).toBe(false);
    expect(isSpecialistKind('toString')).toBe(false);
    expect(isSpecialistKind('sweep')).toBe(true);
  });
});
