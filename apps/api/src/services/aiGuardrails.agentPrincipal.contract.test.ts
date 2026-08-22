import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_TIERS } from './aiAgentSdkTools';
import {
  BLOCKED_TOOLS,
  checkAgentGuardrails,
  checkGuardrails,
  TIER2_READONLY_ACTIONS,
  TIER2_READONLY_TOOLS,
  TOOL_ACTION_INPUT_KEYS,
  type AgentGuardrailPolicy,
} from './aiGuardrails';
import {
  isSecretBearingTool,
  SECRET_BEARING_TOOLS,
} from './actionIntents/secretBearingTools';

const EMPTY = {
  toolAllowlist: [],
  protectedResources: {
    services: [],
    paths: [],
    registryKeys: [],
    deviceTags: [],
  },
  deviceSiteId: 'site-a',
} satisfies AgentGuardrailPolicy;

describe('checkAgentGuardrails — fail closed for every registered tool', () => {
  beforeEach(() => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  for (const toolName of Object.keys(TOOL_TIERS)) {
    it(`${toolName}: an empty allowlist admits only Tier 1 / Tier-2-read-only`, () => {
      const base = checkGuardrails(toolName, {});
      const agent = checkAgentGuardrails(toolName, {}, EMPTY);
      const readOnly = base.tier === 1
        || (base.tier === 2 && (base.readOnly === true || TIER2_READONLY_TOOLS.has(toolName)));

      expect(agent.allowed).toBe(base.allowed && readOnly && !isSecretBearingTool(toolName));
    });

    const base = checkGuardrails(toolName, {});
    if (base.tier === 3 || base.tier === 4 || !base.allowed || isSecretBearingTool(toolName)) {
      it(`${toolName}: explicit allowlisting cannot bypass unconditional denials`, () => {
        const agent = checkAgentGuardrails(toolName, {}, {
          ...EMPTY,
          toolAllowlist: [toolName],
        });
        const unconditionallyDenied = base.tier === 4
          || !base.allowed
          || BLOCKED_TOOLS.has(toolName)
          || isSecretBearingTool(toolName);

        // Tier 3 is the explicitly allowlistable case. Tier 4, blocked, and
        // secret-bearing tools remain denied even when the snapshot names them.
        expect(agent.allowed).toBe(base.tier === 3 && !unconditionallyDenied);
      });
    }
  }

  it('denies unknown tools even when allowlisted', () => {
    expect(checkAgentGuardrails('future_unregistered_tool', {}, {
      ...EMPTY,
      toolAllowlist: ['future_unregistered_tool'],
    }).allowed).toBe(false);
  });

  it('denies every explicitly blocked tool even when allowlisted', () => {
    for (const toolName of BLOCKED_TOOLS) {
      expect(checkAgentGuardrails(toolName, {}, {
        ...EMPTY,
        toolAllowlist: [toolName],
      }).allowed).toBe(false);
    }
  });

  it('denies every secret-bearing tool even when allowlisted', () => {
    for (const toolName of SECRET_BEARING_TOOLS) {
      expect(checkAgentGuardrails(toolName, {}, {
        ...EMPTY,
        toolAllowlist: [toolName],
      }).allowed).toBe(false);
    }
  });

  it('denies when the run policy snapshot is missing', () => {
    expect(checkAgentGuardrails('query_devices', {}, undefined).allowed).toBe(false);
    expect(checkAgentGuardrails('query_devices', {}, null).allowed).toBe(false);
  });

  it('denies every tool when autonomous agents are disabled', () => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');

    for (const toolName of Object.keys(TOOL_TIERS)) {
      expect(checkAgentGuardrails(toolName, {}, {
        ...EMPTY,
        toolAllowlist: [toolName],
      }).allowed).toBe(false);
    }
  });

  it('denies every tool when the feature flag is absent or malformed', () => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', '');
    expect(checkAgentGuardrails('query_devices', {}, EMPTY).allowed).toBe(false);

    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'yes');
    expect(checkAgentGuardrails('query_devices', {}, EMPTY).allowed).toBe(false);
  });

  it('admits read-only actions on mixed tools but denies mutating actions with an empty allowlist', () => {
    for (const [toolName, actions] of Object.entries(TIER2_READONLY_ACTIONS)) {
      const actionKey = TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action';
      for (const action of actions) {
        expect(checkAgentGuardrails(toolName, { [actionKey]: action }, EMPTY).allowed).toBe(true);
      }
    }

    expect(checkAgentGuardrails('manage_services', { action: 'restart' }, EMPTY).allowed).toBe(false);
  });

  it('preserves Tier-3 approval semantics for an allowlisted tool', () => {
    const result = checkAgentGuardrails('run_script', {}, {
      ...EMPTY,
      toolAllowlist: ['run_script'],
    });

    expect(result.allowed).toBe(true);
    expect(result.tier).toBe(3);
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalScope).toBeDefined();
  });

  it('honours exact tool:action allowlist entries', () => {
    const policy = { ...EMPTY, toolAllowlist: ['manage_services:restart'] };

    expect(checkAgentGuardrails('manage_services', { action: 'restart' }, policy).allowed).toBe(true);
    expect(checkAgentGuardrails('manage_services', { action: 'stop' }, policy).allowed).toBe(false);
  });

  it('denies protected services case-insensitively without prefix overmatching', () => {
    const policy = {
      ...EMPTY,
      toolAllowlist: ['manage_services:restart'],
      protectedResources: { ...EMPTY.protectedResources, services: ['MSSQLSERVER'] },
    };

    expect(checkAgentGuardrails('manage_services', {
      action: 'restart', serviceName: 'mssqlserver',
    }, policy).allowed).toBe(false);
    expect(checkAgentGuardrails('manage_services', {
      action: 'restart', serviceName: 'MSSQLSERVER-DEV',
    }, policy).allowed).toBe(true);
  });

  it('denies protected Windows paths case-insensitively, including subpaths only', () => {
    const policy = {
      ...EMPTY,
      toolAllowlist: ['file_operations:delete'],
      protectedResources: { ...EMPTY.protectedResources, paths: ['C:\\Windows\\System32'] },
    };

    expect(checkAgentGuardrails('file_operations', {
      action: 'delete', path: 'c:/WINDOWS/system32/drivers/x.sys',
    }, policy).allowed).toBe(false);
    expect(checkAgentGuardrails('file_operations', {
      action: 'delete', path: 'C:\\Windows\\Temp\\..\\System32\\drivers\\x.sys',
    }, policy).allowed).toBe(false);
    expect(checkAgentGuardrails('file_operations', {
      action: 'delete', path: 'C:\\Windows\\System32-old\\x.sys',
    }, policy).allowed).toBe(true);
  });

  it('denies protected registry keys case-insensitively, including subkeys only', () => {
    const policy = {
      ...EMPTY,
      toolAllowlist: ['registry_operations:delete_key'],
      protectedResources: { ...EMPTY.protectedResources, registryKeys: ['HKLM\\SYSTEM'] },
    };

    expect(checkAgentGuardrails('registry_operations', {
      action: 'delete_key', key: 'hklm\\system\\CurrentControlSet',
    }, policy).allowed).toBe(false);
    expect(checkAgentGuardrails('registry_operations', {
      action: 'delete_key', key: 'HKLM\\SYSTEM-OLD',
    }, policy).allowed).toBe(true);
  });

  it('denies inputs carrying a protected device tag', () => {
    const policy = {
      ...EMPTY,
      protectedResources: { ...EMPTY.protectedResources, deviceTags: ['production'] },
    };

    expect(checkAgentGuardrails('query_devices', { deviceTags: ['production'] }, policy).allowed).toBe(false);
    expect(checkAgentGuardrails('query_devices', { deviceTags: ['staging'] }, policy).allowed).toBe(true);
  });

  it("denies an explicit site selector outside the run device's site", () => {
    expect(checkAgentGuardrails('query_devices', { siteId: 'site-b' }, EMPTY).allowed).toBe(false);
    expect(checkAgentGuardrails('query_devices', { siteIds: ['site-a', 'site-b'] }, EMPTY).allowed).toBe(false);
    expect(checkAgentGuardrails('query_devices', { siteId: 'site-a' }, EMPTY).allowed).toBe(true);
  });

  it('denies explicit site selectors when the run device site is unavailable', () => {
    expect(checkAgentGuardrails('query_devices', { siteId: 'site-a' }, {
      ...EMPTY,
      deviceSiteId: null,
    }).allowed).toBe(false);
  });
});
