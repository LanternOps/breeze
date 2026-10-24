import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FILTER_FIELDS } from './filterFields';

// The web catalog is a hand mirror of the API's built-in FILTER_FIELDS
// (`apps/api/src/services/filterEngine.ts`, the source of truth that
// `validateFilter` enforces). Importing the API module here would drag in its
// DB layer, so the API side is read as source, the same way
// `lib/executionRefusedFields.test.ts` pins the refused-field list (#8611).
function apiCatalog(): Map<string, string> {
  const source = readFileSync(resolve(__dirname, '../../../../api/src/services/filterEngine.ts'), 'utf8');
  const block = source.match(/export const FILTER_FIELDS: FilterFieldDefinition\[\] = \[([\s\S]*?)\n\];/);
  expect(block).not.toBeNull();
  const fields = new Map<string, string>();
  for (const m of block![1]!.matchAll(/\{\s*key:\s*'([^']+)'[^}]*?type:\s*'([^']+)'/g)) {
    fields.set(m[1]!, m[2]!);
  }
  // Every entry must have been parsed: an entry the regex skips (e.g. a `}`
  // inside a description) would otherwise drop out of the comparison silently.
  expect(fields.size).toBe(block![1]!.match(/\{\s*key:\s*'/g)!.length);
  return fields;
}

describe('web filter catalog mirrors the API built-in catalog', () => {
  it('lists the same field keys with the same types', () => {
    const api = apiCatalog();
    expect(api.size).toBeGreaterThan(40);
    const web = new Map(FILTER_FIELDS.map((f) => [f.key, f.type] as const));
    expect([...web.keys()].sort()).toEqual([...api.keys()].sort());
    for (const [key, type] of api) expect(web.get(key), key).toBe(type);
  });

  it('includes the log-shipping health filter (#8611)', () => {
    expect(apiCatalog().get('logShippingFailing')).toBe('boolean');
    expect(FILTER_FIELDS.find((f) => f.key === 'logShippingFailing')?.type).toBe('boolean');
  });

  it('offers group exclusion operators on Device Group only (#9179)', () => {
    const group = FILTER_FIELDS.find((f) => f.key === 'groupId')!;
    expect(group.operators).toEqual(expect.arrayContaining(['equals', 'notEquals', 'in', 'notIn']));
    for (const key of ['orgId', 'siteId']) {
      const ops = FILTER_FIELDS.find((f) => f.key === key)!.operators;
      expect(ops).not.toContain('notEquals');
      expect(ops).not.toContain('notIn');
    }
    const source = readFileSync(resolve(__dirname, '../../../../api/src/services/filterEngine.ts'), 'utf8');
    const apiLine = source.split('\n').find((l) => l.includes("key: 'groupId'"))!;
    expect(apiLine).toContain("'notEquals'");
    expect(apiLine).toContain("'notIn'");
  });
});
