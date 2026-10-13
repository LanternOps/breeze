import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXECUTION_REFUSED_FIELDS, executionRefusedFieldsUsed } from './executionRefusedFields';

describe('executionRefusedFieldsUsed', () => {
  it('flags agent-reported targeting fields and custom.* fields', () => {
    expect(executionRefusedFieldsUsed(['osType', 'hostname', 'custom.owner', 'siteId'])).toEqual([
      'hostname',
      'custom.owner',
    ]);
  });

  it('returns nothing for server-controlled and low-risk fields', () => {
    expect(executionRefusedFieldsUsed(['osType', 'siteId', 'status'])).toEqual([]);
    expect(executionRefusedFieldsUsed([])).toEqual([]);
  });

  // The web copy exists only to disable a picker row early; the server decides.
  // This pins it to the API's denylist so the two cannot drift silently.
  it('mirrors EXECUTION_REFUSED_AGENT_FIELDS in the API filter engine', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../api/src/services/filterEngine.ts'),
      'utf8',
    );
    const block = source.match(/EXECUTION_REFUSED_AGENT_FIELDS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(block).not.toBeNull();
    const withoutComments = block![1]!.replace(/\/\/.*$/gm, '');
    const apiFields = [...withoutComments.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(apiFields.length).toBeGreaterThan(5);
    expect([...EXECUTION_REFUSED_FIELDS].sort()).toEqual([...apiFields].sort());
  });
});
