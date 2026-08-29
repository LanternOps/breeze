import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SWEEP_TOOL_ALLOWLIST } from './sweepProfile';
import { TOOL_TIERS } from '../aiAgentSdkTools';
import { TIER2_READONLY_TOOLS } from '../aiGuardrails';

const FORBIDDEN = [
  'services/aiGuardrails.ts',
  'services/aiAgents/executionLedger.ts',
  'services/actionIntents/policyDecide.ts',
  'services/aiAgents/actRevalidation.ts',
];

describe('verdict profile has no safety bypass (spec §7)', () => {
  it.each(FORBIDDEN)('%s never branches on the run profile', (rel) => {
    const src = readFileSync(join(__dirname, '../..', rel), 'utf8');
    expect(src).not.toMatch(/['"]verdict['"]/);
    expect(src).not.toMatch(/\brun\.profile\b|isVerdictProfile\(|AiAgentRunProfile/);
    // Phase 2 wave P2-2 (scheduled sweeps) — same safety-bypass contract for
    // the `sweep` profile: none of these files may special-case it either.
    expect(src).not.toMatch(/['"]sweep['"]/);
    expect(src).not.toMatch(/isSweepProfile\(/);
    expect(src).not.toMatch(/SWEEP_/);
  });
  it('outcome tools never import the db or execute a registered tool', () => {
    const src = readFileSync(join(__dirname, 'outcomeTools.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]\.\.\/\.\.\/db/);
    expect(src).not.toMatch(/executeTool\(/);
  });
  // Duplicated on purpose as a contract (task-4 brief): the sweep floor's
  // read-only property is load-bearing enough to assert both from
  // sweepProfile.test.ts (development coverage) and here (a safety
  // contract this file exists specifically to guard).
  it('sweep floor contains no mutating tool', () => {
    for (const name of SWEEP_TOOL_ALLOWLIST) {
      const tier = TOOL_TIERS[name as keyof typeof TOOL_TIERS];
      expect(tier === 1 || (tier === 2 && TIER2_READONLY_TOOLS.has(name)), name).toBe(true);
    }
  });
});
