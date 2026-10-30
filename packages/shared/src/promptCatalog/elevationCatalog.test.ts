import { describe, expect, it } from 'vitest';
import { PROMPT_CATALOG, renderPromptMessage } from './render';
import { PROMPT_LOCALES } from './negotiate';

// W07 (#10190): the elevation.request copy the agent renders
// (agent/internal/promptkinds/elevation.go).
describe('elevation namespace', () => {
  it('is registered with the waiting card and its unproven-dismiss sentence', () => {
    expect(Object.keys(PROMPT_CATALOG)).toContain('elevation');
    const ns = (PROMPT_CATALOG as Record<string, { messages: Record<string, unknown> }>).elevation;
    const keys = Object.keys(ns?.messages ?? {});
    for (const key of ['ask.title', 'waiting.title', 'waiting.dismissUnproven', 'waiting.dismissUnprovenGeneric', 'approved.bodyFrom', 'denied.body', 'cancelled.body']) {
      expect(keys).toContain(key);
    }
  });

  it('leaves the renderer placeholders in place in every locale', () => {
    expect(renderPromptMessage('elevation', 'ask.expiry', 'en')).toBe("If you don't answer within {remaining}, the request is not sent.");
    for (const locale of PROMPT_LOCALES) {
      expect(renderPromptMessage('elevation', 'ask.expiry', locale)).toContain('{remaining}');
      expect(renderPromptMessage('elevation', 'waiting.expiry', locale, { until: '{time:1}' })).toContain('{time:1}');
    }
  });

  it('needs its parameters', () => {
    expect(() => renderPromptMessage('elevation', 'approved.bodyFrom', 'en', { technician: 'Dana', program: 'x' })).toThrow(
      /needs parameter "partner"/,
    );
  });
});
