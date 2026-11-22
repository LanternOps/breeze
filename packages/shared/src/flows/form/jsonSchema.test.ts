import { describe, expect, it } from 'vitest';
import { flowDocumentJsonSchema } from './jsonSchema';

describe('flowDocumentJsonSchema', () => {
  it('the JSON schema requires version, name, trigger and steps', () => {
    const schema = flowDocumentJsonSchema() as { type?: string; required?: string[]; properties?: Record<string, unknown> };
    expect(schema.type).toBe('object');
    expect([...(schema.required ?? [])].sort()).toEqual(['name', 'steps', 'trigger', 'version']);
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(['version', 'name', 'trigger', 'steps', 'inputs']));
  });
});
