import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SWEEP_TOOL_ALLOWLIST } from './sweepProfile';
import {
  NARRATIVE_OUTCOME_TOOL_NAME,
  NARRATIVE_TOOL_ALLOWLIST,
  narrativeToolAllowlist,
} from './narrativeProfile';
import {
  TRIAGE_OUTCOME_TOOL_NAME,
  TRIAGE_TOOL_ALLOWLIST,
  triageToolAllowlist,
} from './triageProfile';
import { TOOL_TIERS } from '../aiAgentSdkTools';
import { TIER2_READONLY_TOOLS, checkGuardrails, isReadOnlyResolution } from '../aiGuardrails';
import { PATCH_OUTCOME_TOOL_NAME, PATCH_TOOL_ALLOWLIST, patchToolAllowlist } from './patchProfile';
import { AI_AGENT_RUN_PROFILES, AI_AGENT_SCHEDULE_KINDS } from '@breeze/shared';
import { outcomeToolsForProfile } from './outcomeTools';

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
    // Phase 2 wave P2-3 (weekly org narrative) — same safety-bypass contract
    // for the `narrative` profile. It matters MORE here, not less: a
    // narrative run's tool floor is empty, so any of these files quietly
    // relaxing a check "because narrative is harmless" would be granting an
    // exemption to the one profile whose whole input is untrusted,
    // model-summarised org content.
    expect(src).not.toMatch(/['"]narrative['"]/);
    expect(src).not.toMatch(/isNarrativeProfile\(/);
    expect(src).not.toMatch(/NARRATIVE_/);
    // Phase 2 wave P2-4 (ticket triage, #4191) — same safety-bypass contract
    // for the `triage` profile. It matters as much as narrative's case: a
    // triage run's tool floor is ALSO empty, so any of these files quietly
    // relaxing a check "because triage is harmless" would be granting an
    // exemption to a profile whose whole input is untrusted, attacker-
    // reachable ticket content (`ticketContext.ts`'s threat model).
    expect(src).not.toMatch(/['"]triage['"]/);
    expect(src).not.toMatch(/isTriageProfile\(/);
    expect(src).not.toMatch(/TRIAGE_/);
    // Fleet Designer (W01) — same safety-bypass contract for the `design`
    // profile. It matters as much as narrative's/triage's case: a design
    // run's tool floor is ALSO a small fixed allowlist plus one outcome
    // tool, so any of these files quietly relaxing a check "because design
    // is read-only" would be granting an exemption that has nothing to do
    // with whether the run can actually mutate anything.
    expect(src).not.toMatch(/['"]design['"]/);
    expect(src).not.toMatch(/isDesignProfile\(/);
    expect(src).not.toMatch(/DESIGN_/);
    // AI patch agent (W01) — same contract for the `patch` profile. A patch
    // plan's evidence carries untrusted VENDOR text (patch titles), so none
    // of these files may relax a check "because a patch run only proposes".
    expect(src).not.toMatch(/['"]patch['"]/);
    expect(src).not.toMatch(/isPatchProfile\(/);
    expect(src).not.toMatch(/PATCH_/);
  });
  it('the patch floor reaches no mutating tool; its only non-read entry is its outcome tool', () => {
    const floor = patchToolAllowlist(['manage_patches:install', 'run_script']);
    expect(floor.filter((n) => !(PATCH_TOOL_ALLOWLIST as readonly string[]).includes(n))).toEqual([PATCH_OUTCOME_TOOL_NAME]);
    const tiers = TOOL_TIERS as Record<string, number | undefined>;
    expect(tiers[PATCH_OUTCOME_TOOL_NAME]).toBeUndefined();
    for (const entry of PATCH_TOOL_ALLOWLIST) {
      const [base, action] = entry.split(':') as [string, string | undefined];
      if (action === undefined) {
        const tier = tiers[base];
        expect(tier === 1 || (tier === 2 && TIER2_READONLY_TOOLS.has(base)), entry).toBe(true);
      } else {
        // An action-level entry resolves through the guardrail's own
        // tiering — the same resolution the run's pre-hook applies.
        const check = checkGuardrails(base, { action });
        expect(isReadOnlyResolution(base, check), entry).toBe(true);
      }
    }
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
  /**
   * Phase 2 wave P2-3 — the narrative floor's read-only property is stated
   * differently from sweep's, because the floor is EMPTY: a narrative run
   * gets no drill-down tools at all, only its outcome tool. Asserting
   * emptiness (rather than walking a list, which would pass vacuously the
   * moment the list is empty) is what actually pins that. Anything added to
   * this list later must ALSO pass the read-only tier check below, which is
   * why both halves are here.
   */
  it('narrative floor is empty', () => {
    expect(NARRATIVE_TOOL_ALLOWLIST).toEqual([]);
    expect(NARRATIVE_TOOL_ALLOWLIST).toHaveLength(0);
    for (const name of NARRATIVE_TOOL_ALLOWLIST as readonly string[]) {
      const tier = TOOL_TIERS[name as keyof typeof TOOL_TIERS];
      expect(tier === 1 || (tier === 2 && TIER2_READONLY_TOOLS.has(name)), name).toBe(true);
    }
  });
  it('the narrative floor exposes no mutating tool through its outcome-tool entry either', () => {
    // The whole floor a narrative run ever sees, agent allowlist ignored.
    const floor = narrativeToolAllowlist(['manage_services', 'run_script']);
    expect(floor).toEqual([NARRATIVE_OUTCOME_TOOL_NAME]);
    // The outcome tool is a pure submission channel, never a registered
    // executable tool — it must not appear in the execution tier table at all.
    // Indexed through a widened Record because `TOOL_TIERS`' key union does
    // not (and must not) contain an outcome-tool name: asserting the absence
    // is the point, so the lookup cannot be typed against that union.
    const tiers = TOOL_TIERS as Record<string, number | undefined>;
    expect(tiers[NARRATIVE_OUTCOME_TOOL_NAME]).toBeUndefined();
  });
  /**
   * Phase 2 wave P2-4 (ticket triage, #4191) — same empty-floor contract as
   * narrative, for the same reason and by the same construction: a triage
   * run gets no drill-down tools at all, only its outcome tool. Asserting
   * emptiness (rather than walking a list, which would pass vacuously the
   * moment the list is empty) is what actually pins that.
   */
  it('triage floor is empty', () => {
    expect(TRIAGE_TOOL_ALLOWLIST).toEqual([]);
    expect(TRIAGE_TOOL_ALLOWLIST).toHaveLength(0);
    for (const name of TRIAGE_TOOL_ALLOWLIST as readonly string[]) {
      const tier = TOOL_TIERS[name as keyof typeof TOOL_TIERS];
      expect(tier === 1 || (tier === 2 && TIER2_READONLY_TOOLS.has(name)), name).toBe(true);
    }
  });
  it('the triage floor exposes no mutating tool through its outcome-tool entry either', () => {
    // The whole floor a triage run ever sees, agent allowlist ignored.
    const floor = triageToolAllowlist(['manage_services', 'run_script']);
    expect(floor).toEqual([TRIAGE_OUTCOME_TOOL_NAME]);
    // The outcome tool is a pure submission channel, never a registered
    // executable tool — it must not appear in the execution tier table at all.
    const tiers = TOOL_TIERS as Record<string, number | undefined>;
    expect(tiers[TRIAGE_OUTCOME_TOOL_NAME]).toBeUndefined();
  });
});

/**
 * AI patch agent W01 (#5747), Task 13 — the per-profile and per-schedule-kind
 * switches stay exhaustive.
 *
 * `profileCaps` (runService.ts) and `buildAdmission` (aiAgentSweepScheduler.ts)
 * are both module-private — `profileCaps` is a helper of one caller and
 * `buildAdmission` is an inline closure over the sweeper's loop state — and
 * neither is worth exporting purely to be driven here. Each already ends in a
 * `const exhaustive: never` default, so TypeScript refuses to compile a missing
 * arm; these assertions are the second line: they fail the moment a NEW profile
 * or schedule kind is added to the shared union without a matching `case` in
 * the switch, which is what tsc reports as a type error somewhere else
 * entirely.
 */
describe('every run profile and schedule kind has an arm in its switch', () => {
  it('outcomeToolsForProfile answers for every profile, and only patch gets submit_patch_plan', () => {
    for (const profile of AI_AGENT_RUN_PROFILES) {
      const tools = outcomeToolsForProfile(profile);
      expect(Array.isArray(tools), profile).toBe(true);
      expect(tools.includes(PATCH_OUTCOME_TOOL_NAME as never), profile)
        .toBe(profile === 'patch');
    }
  });

  it('profileCaps carries a case for every run profile', () => {
    const src = readFileSync(join(__dirname, 'runService.ts'), 'utf8');
    const body = src.slice(src.indexOf('function profileCaps('));
    for (const profile of AI_AGENT_RUN_PROFILES) {
      expect(body, profile).toContain(`case '${profile}'`);
    }
    expect(body).toContain('const exhaustive: never');
  });

  it('the sweeper admission switch carries a case for every schedule kind', () => {
    const src = readFileSync(join(__dirname, '../../jobs/aiAgentSweepScheduler.ts'), 'utf8');
    const body = src.slice(src.indexOf('const buildAdmission'));
    for (const kind of AI_AGENT_SCHEDULE_KINDS) {
      expect(body, kind).toContain(`case '${kind}'`);
    }
    expect(body).toContain('const exhaustive: never');
  });
});
