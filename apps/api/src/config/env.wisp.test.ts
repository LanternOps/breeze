import { afterEach, describe, expect, it } from 'vitest';
import { AI_AGENTS_ENABLED, wispEnabled } from './env';

const ORIGINAL = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL }; });

describe('wispEnabled() — hosted-only sub-flag of BREEZE_AI_AGENTS_ENABLED (Wisp design §10)', () => {
  it('is false by default', () => {
    delete process.env.BREEZE_WISP_ENABLED;
    process.env.IS_HOSTED = 'true';
    expect(wispEnabled()).toBe(false);
  });

  it('is false on a self-hosted deployment even when the flag is on', () => {
    process.env.BREEZE_WISP_ENABLED = 'true';
    process.env.IS_HOSTED = 'false';
    expect(wispEnabled()).toBe(false);
  });

  it('is true only when hosted AND the flag AND the parent flag are on', () => {
    process.env.BREEZE_WISP_ENABLED = 'true';
    process.env.IS_HOSTED = 'true';
    expect(wispEnabled()).toBe(AI_AGENTS_ENABLED);
  });

  it('is false when the parent BREEZE_AI_AGENTS_ENABLED is off, hosted and flag on', () => {
    process.env.BREEZE_WISP_ENABLED = 'true';
    process.env.IS_HOSTED = 'true';
    process.env.BREEZE_AI_AGENTS_ENABLED = 'false';
    expect(wispEnabled()).toBe(false);
  });

  it('is true when all three terms are on (read at call time)', () => {
    process.env.BREEZE_WISP_ENABLED = 'true';
    process.env.IS_HOSTED = 'true';
    process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
    expect(wispEnabled()).toBe(true);
  });
});
