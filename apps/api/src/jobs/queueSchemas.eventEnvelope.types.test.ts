import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Drift guard for `breezeEventEnvelopeSchema` (queueSchemas.ts) against
 * `BreezeEvent` (services/eventBus.ts) — style mirrors
 * `services/eventBus.types.test.ts` (readFileSync + regex over real source,
 * not a mocked/duplicated type).
 *
 * `breezeEventEnvelopeSchema` is `.strict()` and hand-mirrors `BreezeEvent`'s
 * field set (see its own doc comment in queueSchemas.ts for why `.strict()`
 * is kept rather than relaxed): a future `BreezeEvent` field that this
 * envelope schema doesn't know about would make EVERY route/deliver job fail
 * `.parse()` at the dequeue boundary — silent 100% delivery loss for the
 * enforce cohort, not a crash anyone would immediately connect to a routine
 * `BreezeEvent` edit. `.strict()` is what makes that failure loud (parse
 * rejects instead of silently dropping the field); THIS test is what makes
 * the two field sets provably identical so the loud failure only ever fires
 * on a real drift, not a false one.
 *
 * This asserts the KEY SETS are equal, both ways — a key on one side missing
 * from the other fails it either direction.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const eventBusSrc = readFileSync(`${HERE}../services/eventBus.ts`, 'utf8');
const queueSchemasSrc = readFileSync(`${HERE}queueSchemas.ts`, 'utf8');

/**
 * Extract the identifiers used as object keys DIRECTLY inside the outermost
 * `{ ... }` of `block` (depth 1) — skips keys belonging to a nested object
 * literal/type (e.g. BreezeEvent's inline `metadata: { ... }` shape), which a
 * naive whole-block regex would incorrectly fold in as if they were top-level
 * BreezeEvent fields.
 */
function extractTopLevelKeys(block: string): Set<string> {
  const keys = new Set<string>();
  let depth = 0;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (depth === 1) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\??:/);
      if (match) keys.add(match[1]!);
    }
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
  }
  return keys;
}

const INTERFACE_START_MARKER = 'export interface BreezeEvent<T = Record<string, unknown>> {';
const interfaceStart = eventBusSrc.indexOf(INTERFACE_START_MARKER);
// The interface's own closing brace is un-indented ("\n}"); the nested
// `metadata: { ... }` shape closes as "  };" (indented, semicolon) and so
// does not match this substring search.
const interfaceEnd = eventBusSrc.indexOf('\n}', interfaceStart + INTERFACE_START_MARKER.length);
const breezeEventBlock = eventBusSrc.slice(interfaceStart, interfaceEnd);

const SCHEMA_START_MARKER = 'const breezeEventEnvelopeSchema = z.object({';
const schemaStart = queueSchemasSrc.indexOf(SCHEMA_START_MARKER);
const schemaEnd = queueSchemasSrc.indexOf('}).strict();', schemaStart);
const envelopeSchemaBlock = queueSchemasSrc.slice(schemaStart, schemaEnd);

describe('breezeEventEnvelopeSchema keys ⟺ BreezeEvent keys', () => {
  it('both blocks were actually found and parsed (guards the markers/regex themselves)', () => {
    // Without this, a rename of either symbol leaves both key sets empty and
    // the equality assertions below pass vacuously.
    expect(interfaceStart).toBeGreaterThan(-1);
    expect(interfaceEnd).toBeGreaterThan(interfaceStart);
    expect(schemaStart).toBeGreaterThan(-1);
    expect(schemaEnd).toBeGreaterThan(schemaStart);

    const breezeEventKeys = extractTopLevelKeys(breezeEventBlock);
    const envelopeKeys = extractTopLevelKeys(envelopeSchemaBlock);
    expect(breezeEventKeys.size).toBeGreaterThan(5);
    expect(envelopeKeys.size).toBeGreaterThan(5);
  });

  it('every BreezeEvent field has a matching envelope schema key', () => {
    const breezeEventKeys = extractTopLevelKeys(breezeEventBlock);
    const envelopeKeys = extractTopLevelKeys(envelopeSchemaBlock);
    const missing = [...breezeEventKeys].filter((key) => !envelopeKeys.has(key));
    expect(
      missing,
      `BreezeEvent gained field(s) ${JSON.stringify(missing)} that breezeEventEnvelopeSchema `
      + `(jobs/queueSchemas.ts) does not know about. Because that schema is `
      + `.strict(), EVERY route-event/deliver-event job will fail .parse() at `
      + `the dequeue boundary the moment this field is ever set on a published `
      + `event — silent 100% delivery loss for the enforce cohort. Add the field `
      + `to breezeEventEnvelopeSchema (and breezeEventMetadataJobSchema if it `
      + `belongs under metadata).`,
    ).toEqual([]);
  });

  it('every envelope schema key corresponds to a real BreezeEvent field', () => {
    const breezeEventKeys = extractTopLevelKeys(breezeEventBlock);
    const envelopeKeys = extractTopLevelKeys(envelopeSchemaBlock);
    const extra = [...envelopeKeys].filter((key) => !breezeEventKeys.has(key));
    expect(
      extra,
      `breezeEventEnvelopeSchema has key(s) ${JSON.stringify(extra)} with no `
      + `matching BreezeEvent field — either BreezeEvent lost a field this `
      + `schema never noticed, or the schema has drifted to accept something `
      + `the publisher never actually sets.`,
    ).toEqual([]);
  });
});
