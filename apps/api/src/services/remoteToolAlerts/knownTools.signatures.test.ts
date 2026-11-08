import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWN_REMOTE_TOOLS } from './knownTools';

/**
 * #11306 — KNOWN_REMOTE_TOOLS gates which agent-reported names can create a
 * "new remote access tool" rule. It must list exactly the agent's RMM and
 * remote access signatures: a missing name never alerts, an extra one is dead.
 */
const SIGNATURES_GO = resolve(import.meta.dirname, '../../../../../agent/internal/mgmtdetect/signatures.go');

const GO_CATEGORY: Record<string, 'rmm' | 'remoteAccess'> = {
  CategoryRMM: 'rmm',
  CategoryRemoteAccess: 'remoteAccess',
};

function agentRemoteToolSignatures(): Record<string, 'rmm' | 'remoteAccess'> {
  const source = readFileSync(SIGNATURES_GO, 'utf8');
  const found: Record<string, 'rmm' | 'remoteAccess'> = {};
  for (const match of source.matchAll(/Name:\s*"([^"]+)",\s*Category:\s*(Category\w+)/g)) {
    const category = GO_CATEGORY[match[2]!];
    if (category) found[match[1]!] = category;
  }
  return found;
}

describe('KNOWN_REMOTE_TOOLS matches the agent signatures', () => {
  it('parses every RMM and remote access signature in signatures.go', () => {
    // If a signature stops matching the one-line `Name: "…", Category: …`
    // shape the parser reads, fail here with a clear count, not later with a
    // confusing "missing tool" diff.
    const source = readFileSync(SIGNATURES_GO, 'utf8');
    const declared = [...source.matchAll(/Category:\s*(CategoryRMM|CategoryRemoteAccess)\b/g)].length;
    expect(Object.keys(agentRemoteToolSignatures())).toHaveLength(declared);
  });

  it('lists every RMM and remote access signature, in the same category', () => {
    const agent = agentRemoteToolSignatures();
    expect(agent.UltraViewer).toBe('remoteAccess');
    expect(agent.ScreenConnect).toBe('rmm');
    expect({ ...KNOWN_REMOTE_TOOLS }).toEqual(agent);
  });

  it('the agent still reports a failed process listing with the prefix knownTools.ts keys on', () => {
    const runner = readFileSync(resolve(SIGNATURES_GO, '../runner.go'), 'utf8');
    expect(runner).toContain('"process snapshot: "+err.Error()');
  });
});
