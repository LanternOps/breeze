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
});
