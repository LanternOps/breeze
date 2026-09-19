import { describe, expect, it } from 'vitest';
import {
  AI_TOOL_DOMAINS, AI_TOOL_DOMAIN_LABELS, AI_TOOL_SEARCH_HINT_MAX_CHARS, isAiToolDomain,
} from './aiToolDomains';

describe('AI tool domains', () => {
  it('is the closed union decided in the 2026-09-17 spec, in spec order', () => {
    expect([...AI_TOOL_DOMAINS]).toEqual([
      'core', 'devices', 'scripts', 'patching', 'monitoring', 'network', 'security',
      'backup', 'tickets', 'billing', 'accounts', 'integrations', 'admin', 'ai',
    ]);
  });

  it('labels every domain and nothing else', () => {
    expect(Object.keys(AI_TOOL_DOMAIN_LABELS).sort()).toEqual([...AI_TOOL_DOMAINS].sort());
    for (const label of Object.values(AI_TOOL_DOMAIN_LABELS)) expect(label).toMatch(/^[A-Z]/);
  });

  it('guards unknown values', () => {
    expect(isAiToolDomain('devices')).toBe(true);
    expect(isAiToolDomain('psa')).toBe(false);
    expect(isAiToolDomain(undefined)).toBe(false);
    expect(AI_TOOL_SEARCH_HINT_MAX_CHARS).toBe(120);
  });
});
