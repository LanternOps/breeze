import { describe, it, expect } from 'vitest';

import { isBreezeAiRequester } from './requesterAvatarKind';

describe('isBreezeAiRequester', () => {
  it('is true for the chat flow\'s exact label', () => {
    expect(isBreezeAiRequester('Breeze AI')).toBe(true);
  });

  it('is false for other agent/app labels', () => {
    expect(isBreezeAiRequester('Breeze Agent')).toBe(false);
    expect(isBreezeAiRequester('Claude Desktop')).toBe(false);
    expect(isBreezeAiRequester('Patch Hygiene Agent')).toBe(false);
    expect(isBreezeAiRequester('MCP API client')).toBe(false);
  });

  it('tolerates incidental whitespace', () => {
    expect(isBreezeAiRequester('  Breeze AI  ')).toBe(true);
  });

  it('is false for an empty label', () => {
    expect(isBreezeAiRequester('')).toBe(false);
  });

  it('is case-sensitive — the server always sends the exact literal', () => {
    // Locks in the exact-match contract documented above: a future casing
    // drift on either side (server or here) should fail a test, not
    // silently start showing the wrong avatar for a real AI approval.
    expect(isBreezeAiRequester('breeze ai')).toBe(false);
    expect(isBreezeAiRequester('BREEZE AI')).toBe(false);
  });
});
