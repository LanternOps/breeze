/**
 * #11395 (W03 T8): every tool a constrained profile can advertise reads short.
 * Each curated `minimal`/`standard` registry tool has an explicit
 * `compactDescription` ≤ 200 chars that names no other tool (a small set must
 * not be pointed at tools it may not have); any other tool (a `custom` pick,
 * a script-builder tool) falls back to its first sentence, capped at 200.
 */
import { describe, expect, it } from 'vitest';
import '../aiTools';
import { aiTools, compactDescriptionFor, getAllRegisteredToolNames, getToolCompactDescription } from '../aiTools';
import { buildScriptBuilderTools } from '../scriptBuilderTools';
import { CURATED_PROFILES, PROFILED_SURFACES } from './toolProfiles';
import { COMPACT_TOOL_DESCRIPTIONS } from '../aiToolCompactDescriptions';

const registry = new Set(getAllRegisteredToolNames());
const curatedRegistryTools = [...new Set(PROFILED_SURFACES
  .filter((s) => s !== 'office_chat')
  .flatMap((s) => [...CURATED_PROFILES[s].minimal, ...CURATED_PROFILES[s].standard]))]
  .filter((name) => registry.has(name))
  .sort();

describe('compact tool descriptions (#11395)', () => {
  it('covers a realistic number of curated registry tools', () => {
    expect(curatedRegistryTools.length).toBeGreaterThan(40);
  });

  it.each(curatedRegistryTools)('%s has a compactDescription of at most 200 chars', (name) => {
    const compact = getToolCompactDescription(name);
    expect(compact, name).toBeTypeOf('string');
    expect(compact!.length).toBeGreaterThan(20);
    expect(compact!.length).toBeLessThanOrEqual(200);
  });

  it('every compactDescription names no OTHER registered tool', () => {
    const offenders: string[] = [];
    for (const [name, text] of Object.entries(COMPACT_TOOL_DESCRIPTIONS)) {
      const tokens = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
      for (const token of tokens) if (token !== name && registry.has(token)) offenders.push(`${name} → ${token}`);
    }
    expect(offenders).toEqual([]);
  });

  it('every key is a registered tool, and is shorter than its full description', () => {
    for (const [name, text] of Object.entries(COMPACT_TOOL_DESCRIPTIONS)) {
      expect(registry.has(name), name).toBe(true);
      expect(text.length, name).toBeLessThanOrEqual((aiTools.get(name)?.definition.description ?? '').length);
    }
  });

  it('a tool without one falls back to its first sentence, capped at 200', () => {
    expect(compactDescriptionFor('no_such_tool', 'Does a thing. Then another thing.')).toBe('Does a thing.');
    expect(compactDescriptionFor('no_such_tool', 'Short and whole')).toBe('Short and whole');
    const long = compactDescriptionFor('no_such_tool', `${'word '.repeat(80)}end.`);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith('…')).toBe(true);
    // An explicit compact description wins over the fallback.
    expect(compactDescriptionFor('query_devices', 'ignored. text.')).toBe(getToolCompactDescription('query_devices'));
  });

  it('every curated script-builder tool reads ≤ 200 under compaction (its own descriptions, first-sentence fallback)', () => {
    const deny = () => { throw new Error('never'); };
    const curated = new Set([...CURATED_PROFILES.script_builder.minimal, ...CURATED_PROFILES.script_builder.standard]);
    const tools = buildScriptBuilderTools(deny as never).filter((t) => curated.has(t.name));
    expect(tools.length).toBe(curated.size);
    for (const t of tools) expect(compactDescriptionFor(t.name, t.description).length, t.name).toBeLessThanOrEqual(200);
  });
});
