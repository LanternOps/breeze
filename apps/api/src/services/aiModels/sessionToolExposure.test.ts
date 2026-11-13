import { describe, expect, it } from 'vitest';
import { ContextWindowTooSmallError, ToolProfileUnderpoweredError, allowedToolsUnder, bareToolName, chatPromptExposure, finalizeSessionToolExposure, toolExposureRefusal, type SessionToolExposureInput } from './sessionToolExposure';
import { FULL_IDENTITY_FINGERPRINT, type ToolProfileFacts } from './toolExposure';
import { CHAT_MINIMAL_TOOLS } from './toolProfiles';
import { resolvedLiveQueryKey } from './sessionToolExposure';
import { liveQueryKey, turnBindingFrom } from './turnBinding';
import { makeResolvedModel } from './__fixtures__/resolvedModel';

const REGISTRY = [...CHAT_MINIMAL_TOOLS, 'set_device_context', 'execute_command', 'manage_alerts', 'get_cis_device_report'];
const facts = (over: Partial<ToolProfileFacts> = {}): ToolProfileFacts => ({
  toolProfile: 'auto', toolAllowlist: null, effectiveWindow: null, transport: 'gateway', ...over,
});
const TENANT = { name: 'tenant_a__lookup', domain: 'integrations' as const };
const FLOW = { name: 'flow__reset_password', domain: 'scripts' as const };

function input(over: Partial<SessionToolExposureInput> = {}): SessionToolExposureInput {
  return {
    surface: 'chat', facts: facts(), allowedTools: undefined, registryNames: () => REGISTRY, breezeServer: true, domainOf: () => undefined,
    extraTools: [TENANT, FLOW], ...over,
  };
}

describe('bareToolName', () => {
  it.each([
    ['mcp__breeze__query_devices', 'query_devices'],
    ['mcp__script_builder__execute_script_on_device', 'execute_script_on_device'],
    ['mcp__breeze__tenant_a__lookup', 'tenant_a__lookup'],
    ['query_devices', 'query_devices'],
  ])('%s → %s', (mcp, bare) => expect(bareToolName(mcp)).toBe(bare));
});

describe('finalizeSessionToolExposure (#11394)', () => {
  it('identity: allowedTools, registration and extras all unchanged', () => {
    const chat = finalizeSessionToolExposure(input());
    expect(chat.exposure.fingerprint).toBe(FULL_IDENTITY_FINGERPRINT);
    expect(chat.allowedTools).toBeUndefined();
    expect(chat.onlyTools).toBeUndefined();
    expect(chat.keepsExtra(TENANT.name) && chat.keepsExtra(FLOW.name)).toBe(true);
    const helperList = ['mcp__breeze__get_device_details', 'mcp__breeze__execute_command'];
    expect(finalizeSessionToolExposure(input({ surface: 'helper', allowedTools: helperList })).allowedTools).toEqual(helperList);
  });

  it('chat minimal: onlyTools = curated set + set_device_context; allowedTools = their mcp names; tenant and flow tools absent', () => {
    const r = finalizeSessionToolExposure(input({ facts: facts({ toolProfile: 'minimal' }) }));
    const expected = [...CHAT_MINIMAL_TOOLS, 'set_device_context'];
    expect(new Set(r.onlyTools)).toEqual(new Set(expected));
    expect(new Set(r.allowedTools)).toEqual(new Set(expected.map((n) => `mcp__breeze__${n}`)));
    expect(r.keepsExtra(TENANT.name)).toBe(false);
    expect(r.keepsExtra(FLOW.name)).toBe(false);
    expect(r.allowedTools).not.toContain(`mcp__breeze__${TENANT.name}`);
  });

  it('chat custom integrations keeps the tenant tool in both registration and allowedTools', () => {
    const r = finalizeSessionToolExposure(input({ facts: facts({ toolProfile: 'custom', toolAllowlist: { domains: ['integrations'], tools: ['query_devices'] } }) }));
    expect(r.keepsExtra(TENANT.name)).toBe(true);
    expect(r.allowedTools).toEqual(['mcp__breeze__query_devices', 'mcp__breeze__set_device_context', `mcp__breeze__${TENANT.name}`]);
  });

  it('helper with only client-declared tools keeps them under every profile (no curated list describes them)', () => {
    const allowed = ['mcp__helper_client__open_settings', 'mcp__helper_client__restart_print_spooler'];
    for (const profile of ['minimal', 'standard'] as const) {
      const r = finalizeSessionToolExposure(input({ surface: 'helper', allowedTools: allowed, breezeServer: false, extraTools: [], facts: facts({ toolProfile: profile }) }));
      expect(r.allowedTools, profile).toEqual(allowed);
      expect(r.onlyTools).toBeUndefined();
    }
  });

  it('a narrower entry without set_device_context (the topology turn) is not refused for a floor it never offered', () => {
    const topology = ['mcp__breeze__get_topology', 'mcp__breeze__query_devices'];
    const r = finalizeSessionToolExposure(input({ allowedTools: topology, extraTools: [], facts: facts({ toolProfile: 'minimal' }) }));
    expect(r.allowedTools).toEqual(['mcp__breeze__query_devices']);
  });

  it('allowedToolsUnder keeps a caller list narrowed on reuse, even when the caller hands back a wider list', () => {
    const r = finalizeSessionToolExposure(input({
      surface: 'helper', allowedTools: ['mcp__breeze__get_device_details'], extraTools: [], facts: facts({ toolProfile: 'minimal' }),
    }));
    expect(allowedToolsUnder(r.exposure, ['mcp__breeze__get_device_details', 'mcp__breeze__execute_command']))
      .toEqual(['mcp__breeze__get_device_details']);
  });

  it('helper on the Breeze server: registration narrows to the profile within the level list', () => {
    const allowed = ['mcp__breeze__get_device_details', 'mcp__breeze__execute_command'];
    const r = finalizeSessionToolExposure(input({ surface: 'helper', allowedTools: allowed, extraTools: [], facts: facts({ toolProfile: 'minimal' }) }));
    expect([...r.onlyTools!]).toEqual(['get_device_details']);
  });

  it('office_chat minimal registers only the non-mutating client tools of the host list', () => {
    const allowed = ['mcp__excel__get_workbook_overview', 'mcp__excel__read_range', 'mcp__excel__write_range'];
    const r = finalizeSessionToolExposure(input({ surface: 'office_chat', allowedTools: allowed, breezeServer: false, extraTools: [], facts: facts({ toolProfile: 'minimal' }) }));
    expect(r.allowedTools).toEqual(['mcp__excel__get_workbook_overview', 'mcp__excel__read_range']);
  });

  it('script_builder custom without execute_script_on_device throws before any provider call', () => {
    const allowed = ['mcp__script_builder__apply_script_code', 'mcp__script_builder__execute_script_on_device'];
    const run = () => finalizeSessionToolExposure(input({
      surface: 'script_builder', allowedTools: allowed, breezeServer: false, extraTools: [],
      facts: facts({ toolProfile: 'custom', toolAllowlist: { domains: [], tools: ['apply_script_code'] } }),
    }));
    expect(run).toThrow(ToolProfileUnderpoweredError);
    try { run(); } catch (err) {
      expect(err).toMatchObject({ code: 'tool_profile_underpowered', status: 409, surface: 'script_builder', missing: ['execute_script_on_device'] });
      expect((err as Error).message).toContain('script builder');
    }
  });
});

describe('too_small: a window that cannot hold even minimal refuses at session start (#11396)', () => {
  it('chat with a 4,096-token window throws ContextWindowTooSmallError naming the window and the surface', () => {
    const run = () => finalizeSessionToolExposure(input({ facts: facts({ toolProfile: 'auto', effectiveWindow: 4_096, transport: 'gateway' }) }));
    expect(run).toThrow(ContextWindowTooSmallError);
    try { run(); } catch (err) {
      expect(err).toMatchObject({ code: 'context_window_too_small', status: 409, surface: 'chat', contextWindow: 4_096 });
      expect((err as Error).message).toBe('This model\'s 4,096-token window is too small for Breeze chat tools.');
    }
  });

  it('control: the same chat at 8,192 resolves minimal and does not throw', () => {
    const r = finalizeSessionToolExposure(input({ facts: facts({ toolProfile: 'auto', effectiveWindow: 8_192, transport: 'gateway' }) }));
    expect(r.exposure).toMatchObject({ profile: 'minimal', tooSmall: false });
  });

  it('the helper names its own surface', () => {
    const run = () => finalizeSessionToolExposure(input({
      surface: 'helper', allowedTools: ['mcp__breeze__get_device_details'], extraTools: [],
      facts: facts({ toolProfile: 'auto', effectiveWindow: 4_096, transport: 'gateway' }),
    }));
    expect(run).toThrow(/too small for Breeze helper tools/);
  });

  it('toolExposureRefusal maps both refusals to a 409 body and ignores anything else', () => {
    expect(toolExposureRefusal(new ContextWindowTooSmallError('chat', 4_096)))
      .toEqual({ error: 'This model\'s 4,096-token window is too small for Breeze chat tools.', code: 'context_window_too_small' });
    expect(toolExposureRefusal(new ToolProfileUnderpoweredError('script_builder', ['x'])))
      .toMatchObject({ code: 'tool_profile_underpowered' });
    expect(toolExposureRefusal(new Error('boom'))).toBeNull();
    expect(toolExposureRefusal({ code: 'context_window_too_small' })).toBeNull();
  });
});

describe('chatPromptExposure (#11395)', () => {
  const deps = { registryNames: () => REGISTRY, domainOf: () => undefined };
  it.each([
    ['identity', facts()],
    ['minimal', facts({ toolProfile: 'minimal' })],
    ['standard', facts({ toolProfile: 'standard' })],
    ['custom', facts({ toolProfile: 'custom', toolAllowlist: { domains: ['integrations'], tools: ['query_devices', 'execute_command'] } })],
    ['minimal on anthropic', facts({ toolProfile: 'minimal', transport: 'anthropic' })],
  ] as const)('%s: names, promptMode and fingerprint-free fields equal the session exposure the query registers', (_label, f) => {
    const prompt = chatPromptExposure(f, deps);
    const session = finalizeSessionToolExposure(input({ facts: f })).exposure;
    expect(prompt.names).toEqual(session.names);
    expect(prompt.promptMode).toBe(session.promptMode);
    expect(prompt.profile).toBe(session.profile);
  });

  it('never reads the registry for the identity exposure', () => {
    const registryNames = () => { throw new Error('read'); };
    expect(chatPromptExposure(facts(), { registryNames, domainOf: () => undefined }).names).toBeNull();
  });
});

describe('resolvedLiveQueryKey (#11395)', () => {
  it('the identity exposure keeps the one-argument key; a constrained profile appends its segment', () => {
    const plain = makeResolvedModel('platform');
    expect(resolvedLiveQueryKey(plain)).toBe(liveQueryKey(turnBindingFrom(plain)));
    const minimal = makeResolvedModel('platform', { toolProfileFacts: facts({ toolProfile: 'minimal' }) });
    expect(resolvedLiveQueryKey(minimal)).not.toBe(liveQueryKey(turnBindingFrom(minimal)));
    expect(resolvedLiveQueryKey(minimal).startsWith(`${liveQueryKey(turnBindingFrom(minimal))}|tx:`)).toBe(true);
  });
});
