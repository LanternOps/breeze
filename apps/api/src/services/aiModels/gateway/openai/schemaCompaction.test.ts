import { describe, expect, it } from 'vitest';
import { COMPACTED_SCHEMA_KEYWORDS, compactInputSchema } from './schemaCompaction';

describe('compactInputSchema (#11395)', () => {
  it('strips exactly the eight size/format keywords plus the $schema meta keyword', () => {
    expect([...COMPACTED_SCHEMA_KEYWORDS].sort()).toEqual(
      ['$schema', 'default', 'examples', 'format', 'maxLength', 'maximum', 'minLength', 'minimum', 'pattern'],
    );
  });

  it('drops the root $schema the SDK MCP server advertises (a dialect tag, not a constraint)', () => {
    expect(compactInputSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: {} }))
      .toEqual({ type: 'object', properties: {} });
  });

  it('removes only the eight keywords; keeps required/enum/type/properties/additionalProperties/description', () => {
    const schema = {
      type: 'object',
      description: 'top',
      additionalProperties: false,
      required: ['action', 'limit'],
      properties: {
        action: { type: 'string', enum: ['list', 'get'], description: 'what to do', default: 'list' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
        query: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[a-z]+$', examples: ['abc'] },
        when: { type: 'string', format: 'date-time' },
      },
    };
    expect(compactInputSchema(schema)).toEqual({
      type: 'object',
      description: 'top',
      additionalProperties: false,
      required: ['action', 'limit'],
      properties: {
        action: { type: 'string', enum: ['list', 'get'], description: 'what to do' },
        limit: { type: 'integer' },
        query: { type: 'string' },
        when: { type: 'string' },
      },
    });
  });

  it('never strips a PROPERTY whose name is a keyword (properties maps names, not keywords)', () => {
    const schema = {
      type: 'object',
      required: ['pattern', 'default'],
      properties: {
        pattern: { type: 'string', maxLength: 10 },
        default: { type: 'boolean' },
        format: { type: 'string', enum: ['json', 'csv'] },
      },
    };
    expect(compactInputSchema(schema)).toEqual({
      type: 'object',
      required: ['pattern', 'default'],
      properties: {
        pattern: { type: 'string' },
        default: { type: 'boolean' },
        format: { type: 'string', enum: ['json', 'csv'] },
      },
    });
  });

  it('recurses through items, anyOf/oneOf/allOf, not, additionalProperties, $defs and patternProperties', () => {
    const schema = {
      type: 'object',
      $defs: { id: { type: 'string', format: 'uuid', minLength: 36 } },
      properties: {
        ids: { type: 'array', items: { $ref: '#/$defs/id' }, maxItems: 5 },
        tags: { type: 'array', items: [{ type: 'string', maxLength: 3 }] },
        either: { anyOf: [{ type: 'string', pattern: 'x' }, { type: 'number', minimum: 0 }] },
        one: { oneOf: [{ type: 'string', format: 'email' }] },
        all: { allOf: [{ type: 'string', minLength: 2 }] },
        notThis: { not: { type: 'string', maxLength: 1 } },
        map: { type: 'object', additionalProperties: { type: 'string', maxLength: 9 } },
        pp: { type: 'object', patternProperties: { '^x': { type: 'string', minLength: 1 } } },
      },
    };
    expect(compactInputSchema(schema)).toEqual({
      type: 'object',
      $defs: { id: { type: 'string' } },
      properties: {
        // maxItems is not one of the eight: it stays.
        ids: { type: 'array', items: { $ref: '#/$defs/id' }, maxItems: 5 },
        tags: { type: 'array', items: [{ type: 'string' }] },
        either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        one: { oneOf: [{ type: 'string' }] },
        all: { allOf: [{ type: 'string' }] },
        notThis: { not: { type: 'string' } },
        map: { type: 'object', additionalProperties: { type: 'string' } },
        pp: { type: 'object', patternProperties: { '^x': { type: 'string' } } },
      },
    });
  });

  it('does not mutate its input', () => {
    const schema = { type: 'object', properties: { a: { type: 'string', maxLength: 5 } } };
    const before = JSON.stringify(schema);
    compactInputSchema(schema);
    expect(JSON.stringify(schema)).toBe(before);
  });

  it('leaves enum/const values untouched even when they look like schemas', () => {
    const schema = { type: 'object', properties: { v: { const: { maxLength: 3 } }, e: { enum: [{ pattern: 'x' }] } } };
    expect(compactInputSchema(schema)).toEqual(schema);
  });
});
