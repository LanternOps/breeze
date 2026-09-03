import { describe, expect, it } from 'vitest';
import { sweepProposedActionSchema } from '@breeze/shared/validators';
import { aiTools } from '../aiTools';
import { DEVICE_COMPLETE_TARGET_TOOLS } from './intentApprovers';

/**
 * Contract (wave 3b, review blocker 1): `DEVICE_COMPLETE_TARGET_TOOLS` is the
 * hand-verified allowlist of tools whose COMPLETE target surface is expressed
 * by their registered `deviceArgs`. `resolveIntentTargetScope` derives the
 * target-site set for a supervised agent intent from those args; every tool
 * OUTSIDE the set is treated as having indirect targets (deployments, groups,
 * filters) and fans out to site-UNRESTRICTED approvers only.
 *
 * This file runs against the REAL registry (unlike intentApprovers.test.ts,
 * whose partial db/schema mocks force a stub registry): a listed tool that is
 * renamed, unregistered, or loses its deviceArgs declaration must fail here —
 * otherwise the target-scope resolution silently degrades to an empty device
 * union for that tool.
 */
describe('DEVICE_COMPLETE_TARGET_TOOLS contract', () => {
  it('every listed tool declares deviceArgs in the registry', () => {
    expect(DEVICE_COMPLETE_TARGET_TOOLS.size).toBeGreaterThan(0);
    for (const name of DEVICE_COMPLETE_TARGET_TOOLS) {
      const tool = aiTools.get(name);
      expect(tool, `"${name}" is listed in DEVICE_COMPLETE_TARGET_TOOLS but not registered in aiTools`).toBeDefined();
      expect(
        tool?.deviceArgs?.length ?? 0,
        `"${name}" is listed in DEVICE_COMPLETE_TARGET_TOOLS but declares no deviceArgs`,
      ).toBeGreaterThan(0);
    }
  });

  /**
   * The reverse direction (#4452): every tool a SWEEP FINDING can propose
   * (`SweepProposedAction`, packages/shared/src/types/aiAgentSchedules.ts —
   * a CLOSED, discriminated union, currently `manage_services` and
   * `remediate_vulnerability`) creates a device-SCOPED action intent
   * (sweepFindings.ts's `createActionIntent(..., { scope: { deviceId } })`).
   * A sweep-proposable tool missing from `DEVICE_COMPLETE_TARGET_TOOLS` is
   * exactly the #4452 bug: its scoped intents fall through to the
   * `{kind:'indirect'}` branch, forcing every fan-out to unrestricted-site
   * approvers instead of the resolved device's site, on every release/decide.
   *
   * Derives the tool names from the real zod schema (not a hardcoded list)
   * so a THIRD sweep-proposable tool added later trips this test the moment
   * it lands, without anyone remembering to update this file too.
   *
   * Not a claim that `DEVICE_COMPLETE_TARGET_TOOLS` must contain every tool
   * with non-empty `deviceArgs` in the whole registry — most Tier-3 device
   * tools (e.g. `s1_isolate_device`, `execute_containment`) are deliberately
   * OUTSIDE it because their args do not express a complete target (see the
   * hand-verification block in intentApprovers.ts). This narrower check is
   * scoped to the one closed, mechanically-derivable category the #4452 bug
   * actually came from: tools a sweep run can mint a device-scoped intent
   * for.
   */
  it('every SweepProposedAction tool is present in DEVICE_COMPLETE_TARGET_TOOLS', () => {
    const options = (sweepProposedActionSchema as unknown as { options: Array<{ shape: { tool: { value: string } } }> }).options;
    const sweepToolNames = options.map((option) => option.shape.tool.value);
    expect(sweepToolNames.length).toBeGreaterThan(0);
    for (const name of sweepToolNames) {
      expect(
        DEVICE_COMPLETE_TARGET_TOOLS.has(name),
        `sweep-proposable tool "${name}" (SweepProposedAction) is missing from DEVICE_COMPLETE_TARGET_TOOLS — its ` +
          'device-scoped intents cannot short-circuit target-scope resolution and fall back to indirect fan-out on ' +
          'every release/decide. If its deviceArgs genuinely cannot express a complete target, add it here anyway ' +
          'and document why the resolver, not the tool, must special-case it (see resolveIntentTargetScope).',
      ).toBe(true);
    }
  });
});
