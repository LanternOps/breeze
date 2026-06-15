import { describe, expect, it } from 'vitest';
import {
  CLIENT_TOOL_CONTRACT,
  contractMutatingToolNames,
  contractToolNames,
} from './clientToolContract';
import { CLIENT_HOSTS } from '../api/types';

describe('CLIENT_TOOL_CONTRACT fixture', () => {
  it('has an entry for every client host', () => {
    expect(Object.keys(CLIENT_TOOL_CONTRACT).sort()).toEqual([...CLIENT_HOSTS].sort());
  });

  it('every tool entry has a boolean mutating flag and a sorted paramKeys array', () => {
    for (const host of Object.keys(CLIENT_TOOL_CONTRACT)) {
      for (const [name, def] of Object.entries(CLIENT_TOOL_CONTRACT[host])) {
        expect(typeof def.mutating, `${host}.${name}.mutating`).toBe('boolean');
        expect(Array.isArray(def.paramKeys), `${host}.${name}.paramKeys`).toBe(true);
        expect(def.paramKeys, `${host}.${name}.paramKeys sorted`).toEqual([...def.paramKeys].sort());
      }
    }
  });

  it('contractToolNames returns the sorted tool names for a host', () => {
    expect(contractToolNames('outlook')).toEqual([
      'draft_reply',
      'extract_action_items',
      'get_message_metadata',
      'summarize_thread',
    ]);
  });

  it('contractMutatingToolNames returns only the mutating tools', () => {
    expect(contractMutatingToolNames('outlook')).toEqual(['draft_reply']);
    expect(contractMutatingToolNames('word')).toEqual(['find_replace', 'format_text', 'insert_text']);
  });

  it('returns [] for an unknown host rather than throwing', () => {
    expect(contractToolNames('nope')).toEqual([]);
    expect(contractMutatingToolNames('nope')).toEqual([]);
  });

  it('pins the well-known Excel surface (14 tools / 9 mutating)', () => {
    expect(contractToolNames('excel')).toHaveLength(14);
    expect(contractMutatingToolNames('excel')).toHaveLength(9);
  });
});
