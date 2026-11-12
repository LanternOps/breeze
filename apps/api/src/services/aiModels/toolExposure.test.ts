import { describe, expect, it } from 'vitest';
import {
  AUTO_FIT_FRACTION,
  FULL_IDENTITY_FINGERPRINT,
  RESULT_CHAR_BUDGET,
  TOOL_EXPOSURE_INPUT_KEYS,
  pickAutoProfile,
  resolveToolExposure,
  toolProfileKey,
  type ToolExposureInput,
  type ToolProfileFacts,
} from './toolExposure';
import { getToolDomain } from '../aiTools';
import { CHAT_MINIMAL_TOOLS, type ProfilePrefixTokens } from './toolProfiles';

const facts = (over: Partial<ToolProfileFacts> = {}): ToolProfileFacts => ({
  toolProfile: 'auto', toolAllowlist: null, effectiveWindow: null, transport: 'gateway', ...over,
});

const CHAT_BASE = [...CHAT_MINIMAL_TOOLS, 'set_device_context', 'propose_action_plan', 'execute_command', 'manage_alerts', 'query_backups'];
const TENANT = { name: 'mcp__tenant_a__lookup', domain: 'integrations' as const };
const OUTCOME = { name: 'submit_alert_verdict', domain: null, alwaysKeep: true };

function input(over: Partial<ToolExposureInput> = {}): ToolExposureInput {
  return { surface: 'chat', facts: facts(), surfaceBaseSet: CHAT_BASE, extraTools: [], ...over };
}

/** Fixture prefixes from the plan's worked example (chat 3,000 / 11,000 / 68,000). */
const FIXTURE_PREFIX: ProfilePrefixTokens = {
  chat: { minimal: 3000, standard: 11000, full: 68000 },
  helper: { minimal: null, standard: null, full: null },
  script_builder: { minimal: null, standard: null, full: null },
  ai_agents: { minimal: null, standard: null, full: null },
  office_chat: { minimal: null, standard: null, full: null },
};

describe('resolveToolExposure', () => {
  it('full + unknown window + gateway is the identity exposure', () => {
    const e = resolveToolExposure(input({ extraTools: [TENANT] }));
    expect(e).toMatchObject({
      profile: 'full', names: null, extraToolNames: [TENANT.name], promptMode: 'standard', toolSearchAllowed: true,
      compactSchemas: false, resultCharBudget: 8000, fingerprint: FULL_IDENTITY_FINGERPRINT, droppedCustomNames: [], tooSmall: false,
    });
  });

  it('auto with an unknown window stays full (ships dark: no window is known until W02)', () => {
    expect(resolveToolExposure(input({ facts: facts({ effectiveWindow: null }) })).profile).toBe('full');
  });

  it('#11395: auto with a known window resolves from the measured pins', () => {
    expect(resolveToolExposure(input({ facts: facts({ effectiveWindow: 8192 }) })).profile).toBe('minimal');
  });

  it('explicit full is the identity exposure too', () => {
    expect(resolveToolExposure(input({ facts: facts({ toolProfile: 'full', effectiveWindow: 4096 }) })).fingerprint)
      .toBe(FULL_IDENTITY_FINGERPRINT);
  });

  it('minimal + anthropic transport: compactSchemas false, promptMode constrained (Decision 1)', () => {
    const e = resolveToolExposure(input({ facts: facts({ toolProfile: 'minimal', transport: 'anthropic' }) }));
    expect(e).toMatchObject({ profile: 'minimal', compactSchemas: false, promptMode: 'constrained', toolSearchAllowed: false, resultCharBudget: 2000 });
  });

  it('minimal + gateway: compactSchemas true', () => {
    expect(resolveToolExposure(input({ facts: facts({ toolProfile: 'minimal' }) })).compactSchemas).toBe(true);
  });

  it('standard budget is 4000, custom 8000', () => {
    expect(resolveToolExposure(input({ facts: facts({ toolProfile: 'standard' }) })).resultCharBudget).toBe(RESULT_CHAR_BUDGET.standard);
    expect(resolveToolExposure(input({
      facts: facts({ toolProfile: 'custom', toolAllowlist: { domains: [], tools: ['query_devices'] } }),
    })).resultCharBudget).toBe(8000);
  });

  it('names are a subset of surfaceBaseSet, in surface order', () => {
    const e = resolveToolExposure(input({ facts: facts({ toolProfile: 'minimal' }), surfaceBaseSet: ['get_device_details', 'query_devices', 'not_curated'] }));
    expect(e.names).toEqual(['get_device_details', 'query_devices']);
  });

  it('minimal chat keeps exactly the curated set present plus the chat always-keep set (set_device_context, propose_action_plan), nothing else', () => {
    const e = resolveToolExposure(input({ facts: facts({ toolProfile: 'minimal' }) }));
    expect(new Set(e.names)).toEqual(new Set([...CHAT_MINIMAL_TOOLS, 'set_device_context', 'propose_action_plan']));
  });

  it('custom execute_command on helper basic is dropped (not in the surface set) and reported', () => {
    const e = resolveToolExposure(input({
      surface: 'helper',
      surfaceBaseSet: ['get_device_details', 'analyze_metrics'],
      facts: facts({ toolProfile: 'custom', toolAllowlist: { domains: [], tools: ['execute_command', 'get_device_details'] } }),
    }));
    expect(e.names).toEqual(['get_device_details']);
    expect(e.droppedCustomNames).toEqual(['execute_command']);
  });

  it('custom domains keep every surface tool of that domain (domain lookup injected)', () => {
    const e = resolveToolExposure(input({
      facts: facts({ toolProfile: 'custom', toolAllowlist: { domains: ['backup'], tools: [] } }),
    }), { domainOf: getToolDomain });
    expect(e.names).toEqual(expect.arrayContaining(['query_backups', 'set_device_context']));
    expect(e.names).not.toContain('query_devices');
  });

  it('extraTools: outcome tool kept under minimal; tenant tool dropped under minimal, kept under custom integrations', () => {
    const minimal = resolveToolExposure(input({ facts: facts({ toolProfile: 'minimal' }), extraTools: [TENANT, OUTCOME] }));
    expect(minimal.extraToolNames).toEqual([OUTCOME.name]);
    const custom = resolveToolExposure(input({
      facts: facts({ toolProfile: 'custom', toolAllowlist: { domains: ['integrations'], tools: [] } }),
      extraTools: [TENANT, OUTCOME],
    }));
    expect(custom.extraToolNames).toEqual([TENANT.name, OUTCOME.name]);
  });

  it('set_device_context always kept for chat, even under a custom list without it', () => {
    const e = resolveToolExposure(input({ facts: facts({ toolProfile: 'custom', toolAllowlist: { domains: [], tools: ['query_devices'] } }) }));
    expect(e.names).toEqual(['query_devices', 'set_device_context', 'propose_action_plan']);
  });

  it('chat keeps propose_action_plan under every approval mode (the live query outlives a mode change)', () => {
    const base = input({ facts: facts({ toolProfile: 'minimal' }) });
    for (const approvalMode of [undefined, 'per_step', 'action_plan', 'hybrid_plan', 'auto_approve'] as const) {
      expect(resolveToolExposure({ ...base, ...(approvalMode ? { approvalMode } : {}) }).names).toContain('propose_action_plan');
    }
  });

  it('a non-chat surface keeps propose_action_plan only when the approval mode needs it', () => {
    const base = input({ surface: 'helper', facts: facts({ toolProfile: 'minimal' }), surfaceBaseSet: ['get_device_details', 'propose_action_plan'] });
    expect(resolveToolExposure({ ...base, approvalMode: 'per_step' }).names).toEqual(['get_device_details']);
    expect(resolveToolExposure({ ...base, approvalMode: 'action_plan' }).names).toEqual(['get_device_details', 'propose_action_plan']);
  });

  it('toolProfileKey survives an allow-list missing its arrays (a stored row that does not parse)', () => {
    const broken = { domains: undefined, tools: undefined } as unknown as ToolProfileFacts['toolAllowlist'];
    expect(() => toolProfileKey(facts({ toolProfile: 'custom', toolAllowlist: broken }), 'chat')).not.toThrow();
  });

  it('a surface outside the profiled set is never narrowed', () => {
    const e = resolveToolExposure(input({ surface: 'script_reviewer', facts: facts({ toolProfile: 'minimal' }) }));
    expect(e.names).toBeNull();
    expect(e.fingerprint).toBe(FULL_IDENTITY_FINGERPRINT);
  });

  it('unknown custom names land in droppedCustomNames, never names', () => {
    const e = resolveToolExposure(input({ facts: facts({ toolProfile: 'custom', toolAllowlist: { domains: [], tools: ['no_such_tool', 'query_devices'] } }) }));
    expect(e.droppedCustomNames).toEqual(['no_such_tool']);
    expect(e.names).not.toContain('no_such_tool');
  });

  it('a custom profile with no allow-list (impossible under the CHECK) exposes only the always-keep set', () => {
    const e = resolveToolExposure(input({ facts: facts({ toolProfile: 'custom', toolAllowlist: null }) }));
    expect(e.names).toEqual(['set_device_context', 'propose_action_plan']);
  });

  it('fingerprint changes on one custom name; unchanged by base or extra order', () => {
    const a = resolveToolExposure(input({ facts: facts({ toolProfile: 'custom', toolAllowlist: { domains: ['integrations'], tools: ['query_devices'] } }), extraTools: [TENANT, OUTCOME] }));
    const b = resolveToolExposure(input({
      facts: facts({ toolProfile: 'custom', toolAllowlist: { domains: ['integrations'], tools: ['query_devices'] } }),
      extraTools: [OUTCOME, TENANT],
      surfaceBaseSet: [...CHAT_BASE].reverse(),
    }));
    const c = resolveToolExposure(input({ facts: facts({ toolProfile: 'custom', toolAllowlist: { domains: ['integrations'], tools: ['query_devices', 'search_logs'] } }), extraTools: [TENANT, OUTCOME] }));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('fingerprint differs between gateway (compact) and anthropic (not compact) for the same names', () => {
    const g = resolveToolExposure(input({ facts: facts({ toolProfile: 'minimal' }) }));
    const a = resolveToolExposure(input({ facts: facts({ toolProfile: 'minimal', transport: 'anthropic' }) }));
    expect(g.names).toEqual(a.names);
    expect(g.fingerprint).not.toBe(a.fingerprint);
  });

  it('the input has no page-context key: its documented keys are the whole contract', () => {
    expect([...TOOL_EXPOSURE_INPUT_KEYS].sort()).toEqual(['approvalMode', 'extraTools', 'facts', 'runProfile', 'surface', 'surfaceBaseSet']);
    expect(() => resolveToolExposure({ ...input(), pageContext: { type: 'device' } } as unknown as ToolExposureInput))
      .toThrow(/unexpected key: pageContext/);
  });
});

describe('toolProfileKey (the live-query key segment)', () => {
  it('is null for the identity exposure: auto/unknown, explicit full, unprofiled surface', () => {
    expect(toolProfileKey(facts(), 'chat')).toBeNull();
    expect(toolProfileKey(facts({ toolProfile: 'full' }), 'chat')).toBeNull();
    expect(toolProfileKey(facts({ toolProfile: 'minimal' }), 'script_reviewer')).toBeNull();
  });

  it('moves with the profile, the transport and any allow-list edit; ignores allow-list order', () => {
    const minimal = toolProfileKey(facts({ toolProfile: 'minimal' }), 'chat');
    expect(minimal).toMatch(/^[0-9a-f]{16}$/);
    expect(toolProfileKey(facts({ toolProfile: 'standard' }), 'chat')).not.toBe(minimal);
    expect(toolProfileKey(facts({ toolProfile: 'minimal', transport: 'anthropic' }), 'chat')).not.toBe(minimal);
    const a = toolProfileKey(facts({ toolProfile: 'custom', toolAllowlist: { domains: ['devices', 'backup'], tools: ['b', 'a'] } }), 'chat');
    const b = toolProfileKey(facts({ toolProfile: 'custom', toolAllowlist: { domains: ['backup', 'devices'], tools: ['a', 'b'] } }), 'chat');
    const c = toolProfileKey(facts({ toolProfile: 'custom', toolAllowlist: { domains: ['backup', 'devices'], tools: ['a'] } }), 'chat');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('pickAutoProfile', () => {
  it.each([
    [8192, 'minimal'],
    [32768, 'standard'],
    [131072, 'full'],
    [4096, 'too_small'],
  ] as const)('chat window %i → %s (plan worked example)', (window, expected) => {
    expect(pickAutoProfile(window, 'chat', FIXTURE_PREFIX)).toBe(expected);
  });

  it('caps the prefix at AUTO_FIT_FRACTION of the window', () => {
    expect(AUTO_FIT_FRACTION).toBe(0.75);
    // Window 20,000: a 15,500 prefix + the 4,357 minimal reserve fits (19,857),
    // but the prefix is over 0.75 × 20,000 = 15,000. A 14,900 prefix fits both.
    const over: ProfilePrefixTokens = { ...FIXTURE_PREFIX, chat: { minimal: 15500, standard: 30000, full: 68000 } };
    const under: ProfilePrefixTokens = { ...FIXTURE_PREFIX, chat: { minimal: 14900, standard: 30000, full: 68000 } };
    expect(pickAutoProfile(20000, 'chat', over)).toBe('too_small');
    expect(pickAutoProfile(20000, 'chat', under)).toBe('minimal');
  });

  it('unmeasured prefixes resolve to full (nothing constrained on a guess)', () => {
    expect(pickAutoProfile(8192, 'helper', FIXTURE_PREFIX)).toBe('full');
    // Office is not measured (#11395): its pins stay null.
    expect(pickAutoProfile(8192, 'office_chat')).toBe('full');
  });

  it('#11395: the measured chat pins: 8k → minimal, 32k → standard, 131k → standard (full is ~128k on a gateway), 4k → too_small', () => {
    expect(pickAutoProfile(8192, 'chat')).toBe('minimal');
    expect(pickAutoProfile(32768, 'chat')).toBe('standard');
    expect(pickAutoProfile(131072, 'chat')).toBe('standard');
    expect(pickAutoProfile(4096, 'chat')).toBe('too_small');
    expect(pickAutoProfile(1_000_000, 'chat')).toBe('full');
  });

  /**
   * #11396 (W02, `auto` goes live): the smallest window at which each profile
   * is picked on each surface, from the MEASURED pins. This is the behaviour
   * a gateway offering gets once its window is known; the PR body's table is
   * this table. A re-measured pin moves a threshold and must update it here.
   */
  it.each([
    ['chat', 7_647, 16_728, 171_067],
    ['helper', 7_147, 10_291, 16_920],
    ['script_builder', 7_777, 9_929, 14_730],
    ['ai_agents', 7_353, 15_983, 105_428],
  ] as const)('%s: minimal from %i, standard from %i, full from %i (measured pins)', (surface, minimal, standard, full) => {
    expect(pickAutoProfile(minimal - 1, surface)).toBe('too_small');
    expect(pickAutoProfile(minimal, surface)).toBe('minimal');
    expect(pickAutoProfile(standard - 1, surface)).toBe('minimal');
    expect(pickAutoProfile(standard, surface)).toBe('standard');
    expect(pickAutoProfile(full - 1, surface)).toBe('standard');
    expect(pickAutoProfile(full, surface)).toBe('full');
  });

  it('office_chat stays full at any window (its prefixes are unmeasured)', () => {
    for (const w of [4_096, 8_192, 131_072]) expect(pickAutoProfile(w, 'office_chat')).toBe('full');
  });

  it('auto + tooSmall resolves minimal with tooSmall set', () => {
    const e = resolveToolExposure(input({ facts: facts({ effectiveWindow: 4096 }) }), { prefixTokens: FIXTURE_PREFIX });
    expect(e).toMatchObject({ profile: 'minimal', tooSmall: true });
    const ok = resolveToolExposure(input({ facts: facts({ effectiveWindow: 32768 }) }), { prefixTokens: FIXTURE_PREFIX });
    expect(ok).toMatchObject({ profile: 'standard', tooSmall: false });
  });
});
