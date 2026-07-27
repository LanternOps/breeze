import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isSecretBearingTool } from './secretBearingTools';

/**
 * Files that legitimately mention credential identifiers without minting one.
 * Every entry needs a reason — an unexplained allowlist entry is how this test
 * decays into a rubber stamp.
 */
const ALLOWLIST: Record<string, string> = {
  'services/m365DirectGraph.ts': 'generates the credential for the M365 direct backend; returns it structured',
  'services/actionIntents/resultSecrets.ts': 'owns the seal/unseal/burn primitives',
  'services/actionIntents/secretBearingTools.ts': 'this registry',
  'services/m365ControlPlane/writeActionService.ts': 'M365 control-plane write path; structured result',
  'routes/actionIntents.ts': 'the reveal endpoint',
  'routes/ai.ts': 'tempPasswordState projection (key presence only)',
  'jobs/intentExpiryReaper.ts': 'sweeps sealed credentials past the reveal window',
  'jobs/intentReleaseWorker.ts': 'seals on the durable path',
};

const MINTS_CREDENTIAL = /generateTempPassword\s*\(/;

/**
 * Files that mint a credential directly via `generateTempPassword` but are
 * accepted conditionally: only while the tool they back is still registered
 * in secretBearingTools.ts. If someone later removes the registry entry, this
 * file falls straight through to the plain offenders list and the test fails
 * — that's the whole point of this contract.
 */
const MINTER_TO_TOOL: Record<string, string> = {
  'services/aiToolsGoogle.ts': 'google_reset_password',
};

describe('secret-bearing tool registry parity', () => {
  it('every file that mints a credential is covered by a registered tool', () => {
    const root = join(__dirname, '../..');
    const offenders: string[] = [];
    let visited = 0;

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;

        visited += 1;
        const rel = full.slice(root.length + 1);
        if (rel in ALLOWLIST) continue;
        if (MINTER_TO_TOOL[rel] && isSecretBearingTool(MINTER_TO_TOOL[rel])) continue;
        if (MINTS_CREDENTIAL.test(readFileSync(full, 'utf8'))) offenders.push(rel);
      }
    };
    walk(root);

    // A silently-empty scan would pass forever. Prove the walk actually
    // visited a realistic slice of apps/api/src (well over a thousand files
    // at the time this test was written).
    expect(visited).toBeGreaterThan(500);

    expect(offenders, `these files mint a credential but are neither registered nor allowlisted:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('both known credential-minting tools are registered', () => {
    expect(isSecretBearingTool('m365_reset_password')).toBe(true);
    expect(isSecretBearingTool('google_reset_password')).toBe(true);
  });

  it('every MINTER_TO_TOOL mapping points at a currently-registered tool', () => {
    for (const [rel, toolName] of Object.entries(MINTER_TO_TOOL)) {
      expect(isSecretBearingTool(toolName), `${rel} is mapped to ${toolName}, which is not registered`).toBe(true);
    }
  });

  it('the allowlist has no stale entries', () => {
    const root = join(__dirname, '../..');
    for (const rel of Object.keys(ALLOWLIST)) {
      expect(() => readFileSync(join(root, rel), 'utf8'), `allowlisted file no longer exists: ${rel}`).not.toThrow();
    }
  });

  it('the MINTER_TO_TOOL map has no stale entries', () => {
    const root = join(__dirname, '../..');
    for (const rel of Object.keys(MINTER_TO_TOOL)) {
      expect(() => readFileSync(join(root, rel), 'utf8'), `mapped file no longer exists: ${rel}`).not.toThrow();
    }
  });
});
