/**
 * A-W02 contract: every AI tool carries exactly one closed domain, a bounded
 * one-line search hint, and only `core` tools are always-loaded.
 *
 * No vi.mock — this suite needs the real registry (same rule as
 * aiAgentSdkTools.registryParity.contract.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { AI_TOOL_DOMAINS, AI_TOOL_SEARCH_HINT_MAX_CHARS, isAiToolDomain } from '@breeze/shared';
import { aiTools } from './aiToolNames';
import {
  getAllRegisteredToolNames, getToolAlwaysLoad, getToolDomain, getToolSearchHint,
} from './aiTools';
import { m365ToolSearchHints, m365ToolTiers } from './aiToolsM365';
import { googleToolSearchHints, googleToolTiers } from './aiToolsGoogle';
import { TOOL_TIERS, listChatSurfaceToolNames, buildBreezeSdkTools } from './aiAgentSdkTools';

/** Provisional core set (spec "Domains" row `core`). A-W04 replaces this from A-W01 telemetry. */
const CORE_ALWAYS_LOAD = ['list_organizations', 'query_devices', 'resolve_device_context', 'search_documentation'];

describe('AI tool domain metadata (A-W02)', () => {
  const names = getAllRegisteredToolNames();

  it('registers enough tools for these assertions to mean something', () => {
    expect(names.length).toBeGreaterThan(150);
  });

  it('every registered tool resolves exactly one closed domain', () => {
    const bad = names.filter((n) => !isAiToolDomain(getToolDomain(n)));
    expect(bad, `tools without a valid domain: ${bad.join(', ')}`).toEqual([]);
  });

  it('every registered tool has a one-line search hint within the cap', () => {
    const bad = names
      .map((n) => [n, getToolSearchHint(n)] as const)
      .filter(([, h]) => !h || h.trim() !== h || h.includes('\n') || h.length > AI_TOOL_SEARCH_HINT_MAX_CHARS)
      .map(([n, h]) => `${n} (${h?.length ?? 'missing'})`);
    expect(bad, `hints missing/multiline/over cap: ${bad.join(', ')}`).toEqual([]);
  });

  it('search hints never restate the tool name and never carry workflow prose', () => {
    const bad = names.filter((n) => {
      const h = getToolSearchHint(n) ?? '';
      return h.includes(n) || /\b(then call|first call|step \d|after that)\b/i.test(h);
    });
    expect(bad).toEqual([]);
  });

  it('alwaysLoad implies domain core, and the core set is the frozen provisional set', () => {
    const always = names.filter((n) => getToolAlwaysLoad(n)).sort();
    expect(always).toEqual(CORE_ALWAYS_LOAD);
    for (const n of always) expect(getToolDomain(n)).toBe('core');
    const coreNotAlways = names.filter((n) => getToolDomain(n) === 'core' && !getToolAlwaysLoad(n));
    expect(coreNotAlways).toEqual([]);
    expect(always.length).toBeLessThanOrEqual(15);
  });

  it('session-aware hint tables mirror their tier tables key-for-key', () => {
    expect(Object.keys(m365ToolSearchHints).sort()).toEqual(Object.keys(m365ToolTiers).sort());
    expect(Object.keys(googleToolSearchHints).sort()).toEqual(Object.keys(googleToolTiers).sort());
    for (const n of Object.keys(m365ToolTiers)) expect(getToolDomain(n)).toBe('integrations');
    for (const n of Object.keys(googleToolTiers)) expect(getToolDomain(n)).toBe('integrations');
  });

  it('every domain in the union is used by at least one tool', () => {
    const used = new Set(names.map((n) => getToolDomain(n)));
    expect([...AI_TOOL_DOMAINS].filter((d) => !used.has(d))).toEqual([]);
  });

  it('listChatSurfaceToolNames is sorted, a subset of TOOL_TIERS ∩ registry, every entry has a domain, and matches what buildBreezeSdkTools actually declares under the current env', () => {
    const chat = listChatSurfaceToolNames();
    expect(chat).toEqual([...chat].sort());
    const registered = new Set(names);
    const tieredAndRegistered = new Set(Object.keys(TOOL_TIERS).filter((n) => registered.has(n)));
    expect(chat.every((n) => tieredAndRegistered.has(n))).toBe(true);
    expect(chat.filter((n) => !getToolDomain(n))).toEqual([]);
    expect(aiTools.size).toBeGreaterThan(0);

    // The index must track what the chat/Helper SDK server actually declares
    // under the CURRENT env, not the full TOOL_TIERS ∩ registry set (which
    // includes tools env-gated off, e.g. m365_*/google_*/script proposal
    // tools on a default install with no flags set).
    const fakeAuth = () => { throw new Error('must not invoke tool handlers'); };
    const declared = new Set(
      buildBreezeSdkTools(fakeAuth as never)
        .map((t) => t.name)
        .filter((n) => registered.has(n)),
    );
    expect(new Set(chat)).toEqual(declared);
  });
});
