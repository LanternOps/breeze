import { describe, expect, it } from 'vitest';
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
});
