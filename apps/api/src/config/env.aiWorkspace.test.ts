import { afterEach, describe, expect, it } from 'vitest';
import { AI_AGENTS_ENABLED, aiWorkspaceEnabled, breezeRegion } from './env';

const ORIGINAL = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL }; });

describe('aiWorkspaceEnabled() — hosted-only sub-flag of BREEZE_AI_AGENTS_ENABLED (spec §8)', () => {
  it('is false by default', () => {
    delete process.env.BREEZE_AI_WORKSPACE_ENABLED;
    process.env.IS_HOSTED = 'true';
    expect(aiWorkspaceEnabled()).toBe(false);
  });

  it('is false on a self-hosted deployment even when the flag is on', () => {
    process.env.BREEZE_AI_WORKSPACE_ENABLED = 'true';
    process.env.IS_HOSTED = 'false';
    expect(aiWorkspaceEnabled()).toBe(false);
  });

  it('is true only when hosted AND the flag is on (parent flag read at module load)', () => {
    process.env.BREEZE_AI_WORKSPACE_ENABLED = 'true';
    process.env.IS_HOSTED = 'true';
    // AI_AGENTS_ENABLED is a module-load constant; assert the conjunction shape
    // rather than flipping it: with the parent off the result must be false,
    // with the parent on it must be true.
    expect(aiWorkspaceEnabled()).toBe(AI_AGENTS_ENABLED);
  });
});

describe('breezeRegion()', () => {
  it("defaults to 'us' when BREEZE_REGION is unset or empty", () => {
    delete process.env.BREEZE_REGION;
    expect(breezeRegion()).toBe('us');
    process.env.BREEZE_REGION = '';
    expect(breezeRegion()).toBe('us');
  });

  it("returns 'eu' for BREEZE_REGION=eu (case-insensitive, trimmed)", () => {
    process.env.BREEZE_REGION = ' EU ';
    expect(breezeRegion()).toBe('eu');
  });

  it("falls back to 'us' on an unrecognised value (validate.ts refuses it at boot)", () => {
    process.env.BREEZE_REGION = 'mars';
    expect(breezeRegion()).toBe('us');
  });
});
