/**
 * Contract for the streamingSessionManager.*.test.ts family (#11011).
 *
 * getOrCreate lazily imports ./flows/flowTools for an ordinary session. On a cold
 * transform cache the real graph costs ~5 s, and that cost lands inside the 5 s
 * budget of whichever test reaches it first. That test times out, and its
 * abandoned session later writes into the next test's fixtures, which shows up
 * as a bogus "expected length 1 but got 2" on an innocent test.
 *
 * Whether a test loses depends on whether a sibling file already warmed the
 * cache, so this is a static check over every file rather than a timing
 * assertion. It asserts the mock is present, not that it is reached: a suite whose
 * sessions skip the flow branch (custom mcpServerFactory) carries it for
 * uniformity. Flow tool behaviour itself is pinned in
 * streamingSessionManager.flowTools.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVICES_DIR = fileURLToPath(new URL('.', import.meta.url));
const SELF = 'streamingSessionManager.flowToolsMock.contract.test.ts';
// Needs a factory: automocking (no factory) still imports the real module.
// Anchored so a commented-out line does not count.
const FLOW_TOOLS_MOCK = /^vi\.mock\('\.\/flows\/flowTools',/m;

function sessionManagerSuites(): string[] {
  return readdirSync(SERVICES_DIR)
    .filter((name) => /^streamingSessionManager\..*\.test\.ts$/.test(name) && name !== SELF)
    .filter((name) => readFileSync(`${SERVICES_DIR}${name}`, 'utf8').includes('getOrCreate'));
}

describe('streamingSessionManager test family', () => {
  it('finds the suites it is meant to police', () => {
    // A renamed family or a broken filter must not turn the check below vacuous.
    expect(sessionManagerSuites().length).toBeGreaterThanOrEqual(15);
  });

  it('mocks ./flows/flowTools in every suite that calls getOrCreate', () => {
    const unmocked = sessionManagerSuites().filter(
      (name) => !FLOW_TOOLS_MOCK.test(readFileSync(`${SERVICES_DIR}${name}`, 'utf8')),
    );
    expect(unmocked).toEqual([]);
  });
});
