/**
 * Wisp W03 (#9909) — spec §8.4: `ai_memory_blocks` is reached only through
 * the memory broker (agent side: system context + GrantCeiling filter) and
 * the memory service (human side: request context, RLS-enforced; one audited
 * system-context admin read; recordHumanBlock, w00 A34).
 *
 * A third file that queried the table directly would bypass one of those two
 * gates — an agent path without the ceiling, or a human path without RLS or the
 * partner-wide write check. Adding a file to either allowlist is a review
 * decision: say in the PR why it cannot call the broker or the service. W05's
 * concern_outcome retention job is the one planned addition (w03 plan
 * "Reconciliation edits").
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..', '..');

/** Files allowed to touch ai_memory_blocks at all (read or write), and why. Paths relative to apps/api/src. */
export const AI_MEMORY_BLOCKS_ACCESS_ALLOWLIST: Record<string, string> = {
  'services/wisp/memoryBroker.ts': 'the agent-side broker: system context + ceiling filter (spec §8.4)',
  'services/wisp/memoryService.ts': 'the human-side service: request context, RLS-enforced; one audited admin read',
  'jobs/wispConcernRetention.ts': 'retention delete, not an agent-side write (concern_outcome blocks past 180 days, system context)',
};

/** Files allowed to INSERT/UPDATE/DELETE ai_memory_blocks, split by side so neither can quietly absorb the other. */
export const AI_MEMORY_BLOCKS_WRITER_ALLOWLIST: Record<string, 'agent' | 'human' | 'retention'> = {
  'services/wisp/memoryBroker.ts': 'agent',   // rememberForGrant: unconfirmed, grant + revision stamped
  'services/wisp/memoryService.ts': 'human',  // confirm / retract / recordHumanBlock: a person acted
  'jobs/wispConcernRetention.ts': 'retention', // retention delete, not an agent-side write
};

const ACCESS_PATTERNS: RegExp[] = [
  /\b(?:from|insert|update|delete)\(\s*aiMemoryBlocks\s*\)/,
  // Joins, namespace access (schema.aiMemoryBlocks, db.query.aiMemoryBlocks) and any
  // value import of the table (including an alias) — a read through any of these
  // would bypass both the ceiling filter and the service.
  /\b\w*[Jj]oin\(\s*(?:\w+\.)?aiMemoryBlocks\b/,
  /\.aiMemoryBlocks\b/,
  /\bimport\s*\{[^}]*(?<!type\s)\baiMemoryBlocks\b[^}]*\}/,
  /\b(?:FROM|INTO|UPDATE|JOIN)\s+(?:public\.)?ai_memory_blocks\b/i,
  /identifier\(\s*['"]ai_memory_blocks['"]\s*\)/,
];

const WRITE_PATTERNS: RegExp[] = [
  /\b(?:insert|update|delete)\(\s*aiMemoryBlocks\s*\)/,
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?ai_memory_blocks\b/i,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(full, out);
    } else if (name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function scan(patterns: RegExp[], files: Array<{ rel: string; text: string }>): string[] {
  return files.filter((f) => patterns.some((re) => re.test(f.text))).map((f) => f.rel).sort();
}

describe('ai_memory_blocks single-caller contract (Wisp spec §8.4)', () => {
  let accessors: string[] = [];
  let writers: string[] = [];
  beforeAll(() => {
    const files = walk(SRC).map((file) => ({
      rel: path.relative(SRC, file).split(path.sep).join('/'),
      text: readFileSync(file, 'utf8'),
    }));
    accessors = scan(ACCESS_PATTERNS, files);
    writers = scan(WRITE_PATTERNS, files);
  }, 120_000);

  it('every query of ai_memory_blocks lives in an allowlisted file', () => {
    const offenders = accessors.filter((f) => !(f in AI_MEMORY_BLOCKS_ACCESS_ALLOWLIST));
    expect(offenders, [
      'These files query ai_memory_blocks outside the memory broker / memory service.',
      'Agent paths call recallForGrant / rememberForGrant (ceiling-filtered); human paths call memoryService (RLS).',
      'Only add a file to AI_MEMORY_BLOCKS_ACCESS_ALLOWLIST with the reason it cannot.',
    ].join(' ')).toEqual([]);
  });

  it('every write of ai_memory_blocks lives in an allowlisted writer', () => {
    expect(writers.filter((f) => !(f in AI_MEMORY_BLOCKS_WRITER_ALLOWLIST))).toEqual([]);
  });

  it('the scan finds both allowlisted files (guards against patterns that match nothing)', () => {
    expect(accessors).toEqual(expect.arrayContaining(Object.keys(AI_MEMORY_BLOCKS_ACCESS_ALLOWLIST)));
    expect(writers).toEqual(expect.arrayContaining(Object.keys(AI_MEMORY_BLOCKS_WRITER_ALLOWLIST)));
  });

  it('the tools and routes reach memory only through the broker / service', () => {
    for (const rel of ['services/wisp/memoryTools.ts', 'routes/wisp/memory.ts']) {
      // Anti-vacuity: the file must exist for "not found" to mean anything.
      expect(statSync(path.join(SRC, rel)).isFile(), `${rel} should exist`).toBe(true);
      expect(accessors).not.toContain(rel);
    }
  });

  it('the Drizzle schema declaration is not mistaken for a query', () => {
    expect(accessors).not.toContain('db/schema/aiMemoryBlocks.ts');
  });
});
