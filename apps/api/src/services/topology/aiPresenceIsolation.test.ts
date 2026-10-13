import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Site location W2 (#7886, spec S§14): AI/MCP is unchanged. No AI topology module, AI tool or MCP surface may
 * import the presence modules or read the presence tables — presence is a separately authorized, site-gated
 * presentation read, and AI evidence keeps its own allowlists.
 */
const SERVICES = resolve(__dirname, '..');
const TOPOLOGY = __dirname;
const PRESENCE_MODULE = /presence(Read|Evaluator|Classifier|Visibility|Inputs)\b/;
const PRESENCE_TABLE = /topology_(device_presence|site_fingerprints|org_presence_state)|topologyDevicePresence|topologySiteFingerprints|topologyOrgPresenceState/;

function sources(dir: string, match: (name: string) => boolean): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && match(name)).map((name) => join(dir, name));
}

describe('AI isolation from topology presence', () => {
  const files = [
    ...sources(TOPOLOGY, (name) => name.startsWith('ai')),
    ...sources(SERVICES, (name) => /^aiTools/.test(name) || /^mcp/i.test(name)),
  ];

  it('finds the AI surfaces it guards (vacuity check)', () => {
    expect(files.some((file) => file.endsWith('aiRead.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('aiEvidence.ts'))).toBe(true);
    expect(files.filter((file) => /aiTools/.test(file)).length).toBeGreaterThan(3);
  });

  it('no AI topology module, AI tool or MCP module imports presence modules or reads presence tables', () => {
    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return PRESENCE_MODULE.test(text) || PRESENCE_TABLE.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('AI graph reads still opt out of presentation groups (so no declaration or presence field reaches AI)', () => {
    for (const file of ['aiRead.ts', 'aiEvidence.ts']) {
      const text = readFileSync(join(TOPOLOGY, file), 'utf8');
      expect(text, file).toMatch(/presentationGroups:\s*false/);
    }
  });
});
