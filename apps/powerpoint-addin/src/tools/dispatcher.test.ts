import { describe, expect, it } from 'vitest';
import { POWERPOINT_MUTATING_TOOLS, POWERPOINT_TOOL_EXECUTORS } from './dispatcher';

describe('PowerPoint tool registry', () => {
  it('registers exactly the 5 PowerPoint tools', () => {
    expect(Object.keys(POWERPOINT_TOOL_EXECUTORS).sort()).toEqual([
      'add_slide',
      'format_selection',
      'get_presentation_overview',
      'insert_text_box',
      'read_selection',
    ]);
  });

  it('marks exactly the 3 mutating tools', () => {
    expect([...POWERPOINT_MUTATING_TOOLS].sort()).toEqual([
      'add_slide',
      'format_selection',
      'insert_text_box',
    ]);
  });

  it('every mutating tool has a backing executor', () => {
    for (const name of POWERPOINT_MUTATING_TOOLS) {
      expect(POWERPOINT_TOOL_EXECUTORS[name]).toBeTypeOf('function');
    }
  });

  it('read tools are NOT mutating', () => {
    expect(POWERPOINT_MUTATING_TOOLS.has('get_presentation_overview')).toBe(false);
    expect(POWERPOINT_MUTATING_TOOLS.has('read_selection')).toBe(false);
  });
});
