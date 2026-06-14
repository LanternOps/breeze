import { describe, expect, it } from 'vitest';
import { OUTLOOK_MUTATING_TOOLS, OUTLOOK_TOOL_EXECUTORS } from './dispatcher';

describe('Outlook tool registry', () => {
  it('registers exactly the 4 baseline Outlook tools', () => {
    expect(Object.keys(OUTLOOK_TOOL_EXECUTORS).sort()).toEqual([
      'draft_reply',
      'extract_action_items',
      'get_message_metadata',
      'summarize_thread',
    ]);
  });

  it('marks exactly draft_reply as mutating', () => {
    expect([...OUTLOOK_MUTATING_TOOLS]).toEqual(['draft_reply']);
  });

  it('every mutating tool has a backing executor', () => {
    for (const name of OUTLOOK_MUTATING_TOOLS) {
      expect(OUTLOOK_TOOL_EXECUTORS[name]).toBeTypeOf('function');
    }
  });

  it('read tools are NOT mutating', () => {
    expect(OUTLOOK_MUTATING_TOOLS.has('summarize_thread')).toBe(false);
    expect(OUTLOOK_MUTATING_TOOLS.has('extract_action_items')).toBe(false);
    expect(OUTLOOK_MUTATING_TOOLS.has('get_message_metadata')).toBe(false);
  });
});
