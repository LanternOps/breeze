import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TOOL_PROFILE_FACTS, toolProfileFactsFrom } from './toolProfileFacts';

describe('toolProfileFactsFrom (#11394)', () => {
  it('no offering row: auto, no allow-list, unknown window', () => {
    expect(toolProfileFactsFrom(null, 'anthropic')).toEqual(DEFAULT_TOOL_PROFILE_FACTS);
  });

  it('carries a valid custom allow-list and the transport', () => {
    const allowlist = { domains: ['devices' as const], tools: ['search_logs'] };
    expect(toolProfileFactsFrom({ toolProfile: 'custom', toolAllowlist: allowlist }, 'gateway'))
      .toEqual({ toolProfile: 'custom', toolAllowlist: allowlist, effectiveWindow: null, transport: 'gateway' });
  });

  it('a stored allow-list that does not parse becomes an empty one (never throws later)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const facts = toolProfileFactsFrom({ toolProfile: 'custom', toolAllowlist: { tools: 'oops' } as never }, 'gateway');
    expect(facts.toolAllowlist).toEqual({ domains: [], tools: [] });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
