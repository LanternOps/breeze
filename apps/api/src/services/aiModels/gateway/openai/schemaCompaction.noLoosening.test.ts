/**
 * #11395 no-loosening proof: schema compaction changes what a small model
 * READS, never what Breeze ACCEPTS. For every curated chat tool and a
 * deterministic fuzz corpus (valid, missing-required, wrong-type, extra-key,
 * over-long, pattern-breaking), `matchesToolSchema` returns the same verdict
 * on the original and the compacted schema, and the handler's own Zod
 * validation still rejects what the stripped keywords described.
 */
import { describe, expect, it } from 'vitest';
import '../../../aiTools'; // populates the registry
import { buildBreezeSdkTools } from '../../../aiAgentSdkTools';
import { validateToolInput } from '../../../aiToolSchemas';
import { advertisedInputSchema } from '../../../llm/toolCapture/advertisedSchema';
import { CURATED_PROFILES } from '../../toolProfiles';
import { compactInputSchema } from './schemaCompaction';
import { matchesToolSchema } from './translateResponse';

type Schema = Record<string, unknown>;

/** Mulberry32: a fixed seed, so the corpus is the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function typeOf(schema: Schema): string | undefined {
  const t = schema.type;
  return Array.isArray(t) ? (t.find((x) => x !== 'null') as string | undefined) : (t as string | undefined);
}

function sampleValue(schema: unknown, rand: () => number, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > 4) return 'x';
  const s = schema as Schema;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[Math.floor(rand() * s.enum.length)];
  if ('const' in s) return s.const;
  const branches = (s.anyOf ?? s.oneOf) as unknown[] | undefined;
  if (Array.isArray(branches) && branches.length > 0) return sampleValue(branches[0], rand, depth + 1);
  switch (typeOf(s)) {
    case 'string': return rand() < 0.5 ? 'abc' : 'x'.repeat(Math.floor(rand() * 20) + 1);
    case 'integer': return Math.floor(rand() * 50);
    case 'number': return rand() * 50;
    case 'boolean': return rand() < 0.5;
    case 'array': return [sampleValue(s.items, rand, depth + 1)];
    case 'object': return sampleObject(s, rand, depth + 1, 1);
    default: return 'x';
  }
}

function sampleObject(schema: Schema, rand: () => number, depth: number, optionalRate: number): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set((schema.required ?? []) as string[]);
  const out: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(props)) {
    if (required.has(name) || rand() < optionalRate) out[name] = sampleValue(sub, rand, depth);
  }
  return out;
}

const WRONG_TYPE: Record<string, unknown> = { string: 42, integer: 'nope', number: 'nope', boolean: 'yes', array: 'x', object: 'x' };

/** At least 50 inputs per tool, across the six classes. */
function corpus(schema: Schema, seed: number): unknown[] {
  const rand = rng(seed);
  const props = Object.entries((schema.properties ?? {}) as Record<string, Schema>);
  const required = (schema.required ?? []) as string[];
  const inputs: unknown[] = [{}, null, 'string', [], { unexpected_key: true }];
  for (let i = 0; inputs.length < 50; i++) {
    const base = sampleObject(schema, rand, 0, 0.3 + rand() * 0.7);
    switch (i % 7) {
      case 0: inputs.push(base); break; // plausibly valid
      case 1: { // missing one required key
        const drop = required[i % Math.max(1, required.length)];
        const copy = { ...base };
        if (drop) delete copy[drop];
        inputs.push(copy);
        break;
      }
      case 2: { // one property of the wrong type
        const [name, sub] = props[i % Math.max(1, props.length)] ?? [];
        inputs.push(name ? { ...base, [name]: WRONG_TYPE[typeOf(sub!) ?? 'string'] ?? 42 } : base);
        break;
      }
      case 3: inputs.push({ ...base, [`extra_${i}`]: 'k' }); break; // extra key
      case 4: { // over-long strings / out-of-range numbers (what maxLength/maximum described)
        const copy: Record<string, unknown> = { ...base };
        for (const [name, sub] of props) {
          const t = typeOf(sub);
          if (t === 'string' && !Array.isArray(sub.enum)) copy[name] = 'y'.repeat(5000);
          if (t === 'integer' || t === 'number') copy[name] = 10 ** 9;
        }
        inputs.push(copy);
        break;
      }
      case 6: { // out-of-enum values (what `enum` constrains)
        const copy: Record<string, unknown> = { ...base };
        for (const [name, sub] of props) if (Array.isArray(sub.enum)) copy[name] = 'zz_not_in_enum';
        inputs.push(copy);
        break;
      }
      default: { // pattern/format-breaking strings
        const copy: Record<string, unknown> = { ...base };
        for (const [name, sub] of props) {
          if (typeOf(sub) === 'string' && !Array.isArray(sub.enum)) copy[name] = '!!not-a-uuid @@ \u0000';
        }
        inputs.push(copy);
      }
    }
  }
  return inputs;
}

const CURATED_CHAT = [...new Set([...CURATED_PROFILES.chat.minimal, ...CURATED_PROFILES.chat.standard])];
const denyAuth = () => { throw new Error('handlers never run here'); };
/** The schema each curated tool ADVERTISES (what compaction actually rewrites). */
const ADVERTISED = new Map(buildBreezeSdkTools(denyAuth)
  .filter((t) => CURATED_CHAT.includes(t.name))
  .map((t) => [t.name, advertisedInputSchema(t)] as const));
const advertised = (name: string): Schema => ADVERTISED.get(name)!;

describe('schema compaction never loosens validation (#11395)', () => {
  it('covers every curated chat tool with an advertised schema', () => {
    expect(CURATED_CHAT.filter((name) => !ADVERTISED.has(name))).toEqual([]);
  });

  it.each(CURATED_CHAT)('%s: matchesToolSchema verdict is identical on the original and the compacted schema', (name) => {
    const original = advertised(name);
    const compacted = compactInputSchema(original);
    const inputs = corpus(original, name.length * 7919);
    expect(inputs.length).toBeGreaterThanOrEqual(50);
    const disagreements = inputs.filter((input) => matchesToolSchema(input, original) !== matchesToolSchema(input, compacted));
    expect(disagreements).toEqual([]);
  });

  it('the corpus discriminates: some inputs pass and some fail (not a vacuous comparison)', () => {
    let pass = 0;
    let fail = 0;
    for (const name of CURATED_CHAT) {
      const original = advertised(name);
      for (const input of corpus(original, name.length * 7919)) {
        if (matchesToolSchema(input, original)) pass++; else fail++;
      }
    }
    expect(pass).toBeGreaterThan(100);
    expect(fail).toBeGreaterThan(100);
  });

  /** A deliberately LOOSENING compactor: strips one structural keyword everywhere. */
  function stripEverywhere(node: unknown, key: string): unknown {
    if (Array.isArray(node)) return node.map((n) => stripEverywhere(n, key));
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node as Record<string, unknown>)
      .filter(([k]) => k !== key)
      .map(([k, v]) => [k, k === 'enum' || k === 'const' || k === 'required' ? v : stripEverywhere(v, key)]));
  }

  // `additionalProperties` is not in the list: the SDK's input-mode zod
  // conversion emits none for these schemas, so there is nothing to strip
  // (the keyword-level unit test in schemaCompaction.test.ts covers it).
  it.each(['required', 'enum', 'type'])(
    'mutation control: a compactor that stripped %s WOULD be caught by this corpus', (key) => {
      let disagreements = 0;
      for (const name of CURATED_CHAT) {
        const original = advertised(name);
        const loosened = stripEverywhere(original, key) as Schema;
        for (const input of corpus(original, name.length * 7919)) {
          if (matchesToolSchema(input, original) !== matchesToolSchema(input, loosened)) disagreements++;
        }
      }
      expect(disagreements).toBeGreaterThan(0);
    },
  );

  it('compaction removes keywords from the curated set (the comparison is not against identical schemas)', () => {
    const changed = CURATED_CHAT.filter((name) => {
      const original = advertised(name);
      return JSON.stringify(compactInputSchema(original)) !== JSON.stringify(original);
    });
    expect(changed.length).toBeGreaterThan(5);
  });

  it('validateToolInput still rejects a maxLength / pattern violation the compacted schema no longer advertises', () => {
    // search_documentation.query advertises a maxLength.
    const original = advertised('search_documentation');
    const queryProp = (original.properties as Record<string, Schema>).query!;
    expect(queryProp.maxLength).toBeTypeOf('number');
    const compacted = compactInputSchema(original);
    expect((compacted.properties as Record<string, Schema>).query!.maxLength).toBeUndefined();
    const tooLong = { query: 'q'.repeat((queryProp.maxLength as number) + 1) };
    expect(validateToolInput('search_documentation', tooLong).success).toBe(false);
    // Control: a valid query passes the same validator.
    expect(validateToolInput('search_documentation', { query: 'reset a password' }).success).toBe(true);
  });

  it('validateToolInput still rejects a malformed uuid (format/pattern) after compaction', () => {
    expect(validateToolInput('get_device_details', { deviceId: 'not-a-uuid' }).success).toBe(false);
    expect(validateToolInput('get_device_details', { deviceId: '11111111-2222-4333-8444-555555555555' }).success).toBe(true);
  });
});
