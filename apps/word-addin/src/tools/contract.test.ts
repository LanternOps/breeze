/**
 * FF2 — cross-package wire-contract guard (CLIENT side, Word).
 *
 * Asserts this dispatcher's WORD_TOOL_EXECUTORS key set and WORD_MUTATING_TOOLS
 * set EXACTLY equal the Word slice of the shared checked-in contract
 * (@breeze/office-addin-core CLIENT_TOOL_CONTRACT, mirrored from the server
 * registry). A tool rename/add/remove or a mutating-flag flip on EITHER side
 * fails: the server side fails clientAiTools.contract.test.ts; the client side
 * fails here.
 */
import { describe, expect, it } from 'vitest';
import { contractMutatingToolNames, contractToolNames } from '@breeze/office-addin-core';
import { WORD_MUTATING_TOOLS, WORD_TOOL_EXECUTORS } from './dispatcher';

const HOST = 'word';

describe('Word dispatcher <-> server contract parity', () => {
  it('WORD_TOOL_EXECUTORS keys exactly equal the contract tool names', () => {
    expect(Object.keys(WORD_TOOL_EXECUTORS).sort()).toEqual(contractToolNames(HOST));
  });

  it('WORD_MUTATING_TOOLS exactly equals the contract mutating set', () => {
    expect([...WORD_MUTATING_TOOLS].sort()).toEqual(contractMutatingToolNames(HOST));
  });

  it('every executor name is a known contract tool (no client-only tools)', () => {
    const contractNames = new Set(contractToolNames(HOST));
    for (const name of Object.keys(WORD_TOOL_EXECUTORS)) {
      expect(contractNames.has(name), `executor '${name}' is not in the contract`).toBe(true);
    }
  });

  it('every contract tool has a backing executor (no missing tools)', () => {
    for (const name of contractToolNames(HOST)) {
      expect(WORD_TOOL_EXECUTORS[name], `contract tool '${name}' has no executor`).toBeTypeOf('function');
    }
  });
});
