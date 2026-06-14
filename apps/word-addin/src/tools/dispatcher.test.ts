import { describe, expect, it } from 'vitest';
import { WORD_MUTATING_TOOLS, WORD_TOOL_EXECUTORS } from './dispatcher';

describe('Word tool registry', () => {
  it('registers exactly the 5 baseline Word tools', () => {
    expect(Object.keys(WORD_TOOL_EXECUTORS).sort()).toEqual([
      'find_replace',
      'format_text',
      'get_document_overview',
      'insert_text',
      'read_selection',
    ]);
  });

  it('marks exactly the 3 mutating tools', () => {
    expect([...WORD_MUTATING_TOOLS].sort()).toEqual(['find_replace', 'format_text', 'insert_text']);
  });

  it('every mutating tool has a backing executor', () => {
    for (const name of WORD_MUTATING_TOOLS) {
      expect(WORD_TOOL_EXECUTORS[name]).toBeTypeOf('function');
    }
  });

  it('read tools are NOT mutating', () => {
    expect(WORD_MUTATING_TOOLS.has('get_document_overview')).toBe(false);
    expect(WORD_MUTATING_TOOLS.has('read_selection')).toBe(false);
  });
});
