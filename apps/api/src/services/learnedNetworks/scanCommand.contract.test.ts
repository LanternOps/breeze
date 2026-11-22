/**
 * Learned networks E8 (#12369, spec §8.2): `scanCommand.ts` is the only place either discovery command type is
 * constructed, and every list that names one command type names the other.
 *
 * Reads every non-test `.ts` under `apps/api/src` with comments stripped. A file that names either type is in
 * CLASSES (or PENDING): `builder` (constructs the command), `paired` (a registry that must name the guarded type
 * as often as the base type) or `toolName` (names the AI tool `network_discovery`, not the command type).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../..');

const LITERAL = /(['"`])network_discovery(_guarded)?\1|\bnetwork_discovery(_guarded)?\s*:/g;
const BASE_LITERAL = /(['"`])network_discovery\1|\bnetwork_discovery\s*:/g;
const GUARDED_NAMED = /(['"`])network_discovery_guarded\1|\bnetwork_discovery_guarded\s*:|\bGUARDED_COMMAND_TYPES\.network_discovery\b/g;
const CONSTRUCT = /\btype\s*:\s*(['"`]network_discovery(_guarded)?['"`]|GUARDED_COMMAND_TYPES\.network_discovery|DISCOVERY_SCAN_FAMILY\b)/;
const AI_HELPER_TYPE = /\b(aiExecuteCommand|aiExecuteCommandWithSystemPrecheck|aiQueueCommand|aiQueueCommandForExecution)\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*(['"`]network_discovery|DISCOVERY_SCAN_FAMILY\b|GUARDED_COMMAND_TYPES\.)/;
const HELPER_TYPE = /\b(executeCommand|executeCommandWithSystemPrecheck|executeCommandWithCallerPrecheck|queueCommand|queueCommandForExecution)\(\s*[^,]+,\s*['"`]network_discovery/;

type Class = { kind: 'builder' } | { kind: 'paired' } | { kind: 'toolName'; reason: string };
const AI_TOOL = (what: string): Class => ({ kind: 'toolName', reason: `names the AI tool network_discovery: ${what}` });

const CLASSES: Record<string, Class> = {
  'services/learnedNetworks/scanCommand.ts': { kind: 'builder' },
  'services/commandResultHandlers.ts': { kind: 'paired' },
  'routes/agents/commands.ts': { kind: 'paired' },
  'services/partnerTrust.ts': { kind: 'paired' },
  'services/commandOfflinePolicy.ts': { kind: 'paired' },
  'services/aiToolsNetwork.ts': AI_TOOL('the tool definition and aiExecuteCommand\'s tool-name argument'),
  'services/aiAgentSdkTools.ts': AI_TOOL('tier and SDK registration'),
  'services/aiToolStandingVerbs.ts': AI_TOOL('standing verb'),
  'services/aiToolRateLimits.ts': AI_TOOL('rate limit'),
  'services/aiGuardrails.ts': AI_TOOL('guardrail tier, permission and description'),
  'services/helperToolFilter.ts': AI_TOOL('helper allowlist and target argument'),
  'services/toolTimeouts.ts': AI_TOOL('timeout'),
  'services/actionIntents/intentRowTarget.ts': AI_TOOL('intent row target'),
  'services/mcpCoverage.ts': AI_TOOL('MCP coverage'),
  'services/aiToolSchemas.ts': AI_TOOL('input schema'),
  'services/aiToolOutput.ts': AI_TOOL('output fence'),
  'services/aiAgents/agentToolCatalog.ts': AI_TOOL('agent tool catalog'),
  'services/wisp/toolSubjects.ts': AI_TOOL('Wisp tool subjects'),
  'services/llm/toolEval/goldenPrompts.ts': AI_TOOL('eval golden prompts'),
};

/** Producers not yet moved onto the builder. They count as classified and the construction check skips them. */
const PENDING = new Set<string>([]);

/** Strips `//` and block comments, leaving string and template contents (and their `//`) alone. */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      out += ' ';
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\') j++;
        else if (c !== '`' && source[j] === '\n') break;
        j++;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      files.push(...walk(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

const SOURCES = new Map(walk(SRC).map((full) => [relative(SRC, full).split('\\').join('/'), stripComments(readFileSync(full, 'utf8'))]));
const count = (text: string, re: RegExp) => (text.match(new RegExp(re.source, 'g')) ?? []).length;
const naming = [...SOURCES].filter(([, text]) => count(text, LITERAL) > 0).map(([file]) => file);

describe('discovery scan command builder contract (E8)', () => {
  it('every file naming either type is classified, and no classification is stale', () => {
    expect(naming.filter((file) => !(file in CLASSES) && !PENDING.has(file))).toEqual([]);
    expect(Object.keys(CLASSES).filter((file) => !naming.includes(file))).toEqual([]);
  });

  it('only the builder constructs a discovery scan command', () => {
    const offenders: string[] = [];
    for (const [file, text] of SOURCES) {
      if (CLASSES[file]?.kind === 'builder' || PENDING.has(file)) continue;
      if (CONSTRUCT.test(text) || AI_HELPER_TYPE.test(text) || HELPER_TYPE.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('every paired list names the guarded type as often as the base type', () => {
    const unpaired = Object.entries(CLASSES)
      .filter(([, c]) => c.kind === 'paired')
      .map(([file]) => ({ file, base: count(SOURCES.get(file) ?? '', BASE_LITERAL), guarded: count(SOURCES.get(file) ?? '', GUARDED_NAMED) }))
      .filter((row) => row.base !== row.guarded);
    expect(unpaired).toEqual([]);
  });

  it('finds the known sites (not vacuous)', () => {
    const kinds = Object.values(CLASSES).map((c) => c.kind);
    expect(kinds.filter((k) => k === 'paired').length).toBeGreaterThanOrEqual(4);
    expect(kinds.filter((k) => k === 'toolName').length).toBeGreaterThanOrEqual(14);
    expect(SOURCES.size).toBeGreaterThan(500);
    expect(CONSTRUCT.test(`const c = { id, type: 'network_discovery', payload }`)).toBe(true);
    expect(CONSTRUCT.test('return { type: GUARDED_COMMAND_TYPES.network_discovery }')).toBe(true);
    expect(CONSTRUCT.test('const c = { id, type: DISCOVERY_SCAN_FAMILY, payload }')).toBe(true);
    expect(CONSTRUCT.test('explain({ commandType: DISCOVERY_SCAN_FAMILY })')).toBe(false);
    expect(AI_HELPER_TYPE.test(`aiExecuteCommand(auth, 'network_discovery', deviceId, DISCOVERY_SCAN_FAMILY, {})`)).toBe(true);
    expect(AI_HELPER_TYPE.test(`aiExecuteCommand(auth, 'network_discovery', deviceId, 'network_discovery', {})`)).toBe(true);
    expect(HELPER_TYPE.test(`executeCommand(deviceId, 'network_discovery', payload)`)).toBe(true);
    expect(stripComments(`const a = 'x'; // 'network_discovery'\n/* network_discovery: */ const u = 'https://x';`))
      .not.toMatch(/network_discovery/);
  });
});
