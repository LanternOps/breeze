/**
 * W05 (#7603): every Agent SDK transport fact this registry relies on was
 * verified on ONE SDK version — W01 D1 (thinking display 'updates' is NOT
 * carriable), W01 D2 (fast via settings.fastMode), the W05 resume spike, and
 * W05 lab gate L1 (the served-speed signal). An SDK bump silently invalidates
 * them. This test fails on any bump until someone re-runs:
 *   apps/api/src/services/aiModels/__scripts__/sdkOptionPassthroughSpike.ts   (D1/D2)
 *   apps/api/src/services/aiModels/__scripts__/sdkResumeAcrossModelsSpike.ts  (resume, Q1–Q6)
 * records the results in the two spike-findings docs, and updates
 * VERIFIED_AGENT_SDK_VERSION. If D1 flips to "yes", W05's "Thinking…"
 * indicator can give way to progress notes (spec §7 `updates`).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERIFIED_AGENT_SDK_VERSION } from './wireParams';

const here = dirname(fileURLToPath(import.meta.url));

describe('Agent SDK version pin (re-run the D1 / resume / fast checks on a bump)', () => {
  it('the installed SDK is the verified one', () => {
    // apps/api/src/services/aiModels → apps/api/node_modules (pnpm links it there).
    const pkgPath = resolve(here, '../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json');
    const { version } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    expect(
      version,
      'Agent SDK bumped: re-run the W01 D1/D2 and W05 resume/fast spikes, then update VERIFIED_AGENT_SDK_VERSION',
    ).toBe(VERIFIED_AGENT_SDK_VERSION);
  });
});
