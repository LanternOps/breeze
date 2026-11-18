import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findUnknownInputKeys, formatUnknownKeyFinding, unknownKeysCovered } from './aiToolUnknownKeys';

const keysOf = (schema: z.ZodType, input: unknown) => findUnknownInputKeys(schema, input).map((f) => ({ path: f.path, keys: f.keys }));

describe('findUnknownInputKeys (#11861)', () => {
  it('reports an unknown top-level key of a plain (stripping) object, with the accepted keys', () => {
    expect(findUnknownInputKeys(z.object({ a: z.string(), b: z.number().optional() }), { a: 'x', filter: 1 }))
      .toEqual([{ path: [], keys: ['filter'], accepted: ['a', 'b'] }]);
  });

  it('reports a strict object the same way', () => {
    expect(keysOf(z.strictObject({ a: z.string() }), { a: 'x', z: 1 })).toEqual([{ path: [], keys: ['z'] }]);
  });

  it('reports nothing for known keys only', () => {
    expect(findUnknownInputKeys(z.object({ a: z.string() }), { a: 'x' })).toEqual([]);
  });

  it('ignores an undefined-valued key', () => {
    expect(findUnknownInputKeys(z.object({ a: z.string() }), { a: 'x', b: undefined })).toEqual([]);
  });

  it('walks nested objects through optional/nullable/default wrappers and arrays', () => {
    const schema = z.object({
      sub: z.object({ k: z.string() }).optional(),
      list: z.array(z.object({ id: z.string() })).nullable(),
      dflt: z.object({ on: z.boolean() }).default({ on: true }),
    });
    expect(keysOf(schema, { sub: { k: 'v', x: 1 }, list: [{ id: '1' }, { id: '2', y: 2 }], dflt: { on: false, z: 3 } })).toEqual([
      { path: ['sub'], keys: ['x'] },
      { path: ['list', 1], keys: ['y'] },
      { path: ['dflt'], keys: ['z'] },
    ]);
  });

  it('checks a refined object (superRefine keeps the object) and the input side of a transform', () => {
    const refined = z.object({ a: z.string() }).superRefine(() => {});
    expect(keysOf(refined, { a: 'x', b: 1 })).toEqual([{ path: [], keys: ['b'] }]);
    const transformed = z.object({ a: z.string() }).transform((v) => v.a);
    expect(keysOf(transformed, { a: 'x', b: 1 })).toEqual([{ path: [], keys: ['b'] }]);
  });

  it('checks the schema a preprocess feeds', () => {
    const pre = z.preprocess((v) => v, z.object({ a: z.string() }));
    expect(keysOf(pre, { a: 'x', b: 1 })).toEqual([{ path: [], keys: ['b'] }]);
  });

  it('leaves open-by-design containers alone: record, loose/passthrough, catchall, plain union, any', () => {
    expect(keysOf(z.object({ r: z.record(z.string(), z.unknown()) }), { r: { anything: 1 } })).toEqual([]);
    expect(keysOf(z.object({ p: z.looseObject({ a: z.string() }) }), { p: { a: 'x', extra: 1 } })).toEqual([]);
    expect(keysOf(z.object({ p: z.object({ a: z.string() }).passthrough() }), { p: { a: 'x', extra: 1 } })).toEqual([]);
    expect(keysOf(z.object({ c: z.object({ a: z.string() }).catchall(z.number()) }), { c: { a: 'x', extra: 1 } })).toEqual([]);
    expect(keysOf(z.object({ u: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]) }), { u: { a: 'x', zz: 1 } })).toEqual([]);
    expect(keysOf(z.object({ x: z.any() }), { x: { deep: 1 } })).toEqual([]);
  });

  it('still checks the known keys of a loose object', () => {
    const schema = z.looseObject({ inner: z.object({ a: z.string() }) });
    expect(keysOf(schema, { inner: { a: 'x', b: 1 }, extra: 1 })).toEqual([{ path: ['inner'], keys: ['b'] }]);
  });

  it('discriminated union: checks the selected arm; an unmatched discriminator checks every arm\'s keys', () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), x: z.string() }),
      z.object({ kind: z.literal('b'), y: z.string() }),
    ]);
    expect(keysOf(schema, { kind: 'a', x: '1', y: '2' })).toEqual([{ path: [], keys: ['y'] }]);
    expect(findUnknownInputKeys(schema, { x: '1', q: 1 })).toEqual([{ path: [], keys: ['q'], accepted: ['kind', 'x', 'y'] }]);
  });

  it('never throws on malformed input and leaves type errors to the schema', () => {
    const schema = z.object({ sub: z.object({ a: z.string() }), list: z.array(z.object({ a: z.string() })) });
    for (const input of [null, undefined, 'str', 5, [], { sub: 'not-object', list: 'not-array' }]) {
      expect(() => findUnknownInputKeys(schema, input)).not.toThrow();
    }
    expect(findUnknownInputKeys(schema, { sub: 'not-object', list: 'not-array' })).toEqual([]);
  });
});

describe('unknownKeysCovered (dedupe of a strict schema\'s own unrecognized_keys)', () => {
  const findings = [{ path: ['items', 0], keys: ['z', 'y'], accepted: ['a'] }];

  it('covers an issue at the same path whose keys the finding names', () => {
    expect(unknownKeysCovered(findings, ['items', 0], ['z'])).toBe(true);
    expect(unknownKeysCovered(findings, ['items', 0], ['y', 'z'])).toBe(true);
  });

  it('never hides an issue that names a key the finding does not, or sits at another path', () => {
    expect(unknownKeysCovered(findings, ['items', 0], ['z', 'w'])).toBe(false);
    expect(unknownKeysCovered(findings, ['items', 1], ['z'])).toBe(false);
    expect(unknownKeysCovered(findings, ['items', '0'], ['z'])).toBe(false);
    expect(unknownKeysCovered([], [], ['z'])).toBe(false);
  });

  it('matches the paths zod itself reports for a strict object nested in an array under optional', () => {
    const schema = z.object({ items: z.array(z.strictObject({ a: z.string() })).optional() });
    const input = { items: [{ a: 'x' }, { a: 'x', z: 1 }] };
    const issue = schema.safeParse(input).error!.issues.find((i) => i.code === 'unrecognized_keys')!;
    expect(unknownKeysCovered(findUnknownInputKeys(schema, input), issue.path, issue.keys)).toBe(true);
  });
});

describe('formatUnknownKeyFinding', () => {
  it('names one key and the accepted list', () => {
    expect(formatUnknownKeyFinding({ path: [], keys: ['filter'], accepted: ['search', 'limit'] }))
      .toBe('unknown argument "filter" (accepted: search, limit)');
  });

  it('pluralises, and prefixes a nested path', () => {
    expect(formatUnknownKeyFinding({ path: ['targets', 0, 'scope'], keys: ['a', 'b'], accepted: ['kind'] }))
      .toBe('targets[0].scope: unknown arguments "a", "b" (accepted: kind)');
  });

  it('says none when the object defines no keys', () => {
    expect(formatUnknownKeyFinding({ path: [], keys: ['a'], accepted: [] })).toBe('unknown argument "a" (accepted: none)');
  });
});
