import { describe, expect, it, vi } from 'vitest';

vi.mock('./promptVariants', async (orig) => {
  const real = await orig<typeof import('./promptVariants')>();
  return {
    ...real,
    PROMPT_VARIANTS: [
      { id: 'chat/claude-small@3', surface: 'chat', profile: 'claude-small', version: 3, state: 'active', canaryPercent: 0, guidance: 'Be brief.', hypothesis: 'h' },
    ],
  };
});

import { promptProvenanceFor, renderSystemPrompt, toPromptProfile } from './promptProfiles';
import { GUIDANCE_HEADING } from './promptVariants';

describe('promptProfiles (W11)', () => {
  it('promptProvenanceFor names the active variant of the surface + profile', () => {
    expect(promptProvenanceFor({ surface: 'chat', profile: 'claude-small', subjectId: 's1' }))
      .toEqual({ profile: 'claude-small', variant: 'chat/claude-small@3' });
  });
  it('the base prompt for another profile, a generic model, or a non-hook surface', () => {
    expect(promptProvenanceFor({ surface: 'chat', profile: 'claude-standard', subjectId: 's1' })).toEqual({ profile: 'claude-standard', variant: null });
    expect(promptProvenanceFor({ surface: 'chat', profile: 'generic', subjectId: 's1' })).toEqual({ profile: 'generic', variant: null });
    expect(promptProvenanceFor({ surface: 'script_reviewer', profile: 'claude-small', subjectId: 's1' })).toEqual({ profile: 'claude-small', variant: null });
  });
  it('renderSystemPrompt appends exactly the named variant', () => {
    expect(renderSystemPrompt('BASE', { profile: 'claude-small', variant: 'chat/claude-small@3' })).toBe(`BASE\n\n${GUIDANCE_HEADING}\nBe brief.`);
    expect(renderSystemPrompt('BASE', { profile: 'claude-small', variant: null })).toBe('BASE');
  });
  it('an unknown variant id (impossible in-process) sends the base prompt', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(renderSystemPrompt('BASE', { profile: 'claude-small', variant: 'chat/claude-small@99' })).toBe('BASE');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown prompt variant'), expect.anything());
    warn.mockRestore();
  });
  it('toPromptProfile is unchanged', () => {
    expect(toPromptProfile('claude-frontier')).toBe('claude-frontier');
    expect(toPromptProfile('nope')).toBe('generic');
    expect(toPromptProfile(null)).toBe('generic');
  });
});
