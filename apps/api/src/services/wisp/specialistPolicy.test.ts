import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_SPECIALIST_REQUESTS_PER_ASSESSMENT,
  SPECIALIST_KINDS,
  SPECIALIST_KIND_POLICY,
  isSpecialistKind,
} from './specialistPolicy';

describe('SPECIALIST_KIND_POLICY', () => {
  it('auto-admits exactly the "acts alone" kinds of spec §3', () => {
    const auto = SPECIALIST_KINDS.filter((k) => SPECIALIST_KIND_POLICY[k].autoAdmit);
    expect(auto).toEqual(['sweep', 'analysis']);
  });

  it('every kind requires ai_agents:write; analysis also requires ai_workspace:execute', () => {
    for (const k of SPECIALIST_KINDS) expect(SPECIALIST_KIND_POLICY[k].requiredPermissions).toContain('ai_agents:write');
    expect(SPECIALIST_KIND_POLICY.analysis.requiredPermissions).toContain('ai_workspace:execute');
    expect(SPECIALIST_KIND_POLICY.sweep.requiredPermissions).not.toContain('ai_workspace:execute');
  });

  it('bulk_ticket_reply (w00 A30) asks first and needs tickets:write', () => {
    expect(SPECIALIST_KINDS).toContain('bulk_ticket_reply');
    expect(SPECIALIST_KIND_POLICY.bulk_ticket_reply).toMatchObject({
      autoAdmit: false,
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

  it('only remediation_research requires a device', () => {
    expect(SPECIALIST_KINDS.filter((k) => SPECIALIST_KIND_POLICY[k].requiresDevice)).toEqual(['remediation_research']);
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
