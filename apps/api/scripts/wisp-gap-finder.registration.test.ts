import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { TOOL_TIERS } from '../src/services/aiAgentSdkTools';
import { aiTools } from '../src/services/aiTools';

const apiRoot = path.resolve(import.meta.dirname, '..');

/**
 * Wisp W07 Task 10 — the gap-finder is Todd's private, system-scope CLI. It is
 * never a model-callable tool, never a route, and nothing under src/ imports it.
 */
describe('wisp gap-finder is CLI only', () => {
  it('exists as a script', () => {
    expect(existsSync(path.join(apiRoot, 'scripts', 'wisp-gap-finder.ts'))).toBe(true);
    expect(existsSync(path.join(apiRoot, 'scripts', 'wisp-gap-finder.lib.ts'))).toBe(true);
  });

  it('is not a registered tool', () => {
    expect([...aiTools.keys()].some((n) => /gap_finder|gap-finder/.test(n))).toBe(false);
  });

  it('has no tool tier', () => {
    expect(TOOL_TIERS).not.toHaveProperty('wisp_gap_finder');
    expect(Object.keys(TOOL_TIERS).some((n) => /gap_finder|gap-finder/.test(n))).toBe(false);
  });

  it('is not referenced from src/ (no import, no route mount)', () => {
    expect(execSync("grep -rl 'wisp-gap-finder' src || true", { cwd: apiRoot }).toString().trim()).toBe('');
  });
});
