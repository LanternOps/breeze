import { beforeEach, describe, expect, it } from 'vitest';
import { draftPrompt, stashScriptDraft, takeScriptDraft } from './scriptDraftHandoff';

const d = { brief: 'Clear the spooler queue, then restart it', language: 'powershell' as const, title: 'Clear print queue', suggestionId: 's-1' };

describe('script draft hand-off', () => {
  beforeEach(() => sessionStorage.clear());
  it('is read-once', () => {
    expect(stashScriptDraft(d)).toBe(true);
    expect(takeScriptDraft()).toEqual(d);
    expect(takeScriptDraft()).toBeNull();
  });
  it('ignores a tampered or foreign value', () => {
    sessionStorage.setItem('breeze.scriptDraftHandoff', JSON.stringify({ brief: 1 }));
    expect(takeScriptDraft()).toBeNull();
  });
  it('builds a prompt that names the language and keeps the brief verbatim', () => {
    expect(draftPrompt(d)).toBe('Write a PowerShell script for this fix: Clear the spooler queue, then restart it');
  });
});
