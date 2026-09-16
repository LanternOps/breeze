/**
 * Execution plane W04 — the `workspace_*` guardrail contract (spec §5.3, §8).
 * Sits beside redTeam.contract.test.ts and reuses its stance: authority comes
 * from `checkAgentGuardrails` only. Pinned here:
 *   1. every workspace tool resolves Tier 1 but NOT read-only;
 *   2. an empty allowlist denies it AT THE ALLOWLIST GATE;
 *   3. an allowlisted call on a DEVICE-LESS run is `allow` — never `propose`,
 *      never `act`, in shadow and act mode alike;
 *   4. a protected-resource hit still denies (the carve-out sits after it);
 *   5. `TOOL_PERMISSIONS` maps every workspace tool (chat path is not "no mapping").
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env')>();
  return {
    ...actual,
    envFlag: (name: string, fallback = false) => (name === 'BREEZE_AI_AGENTS_ENABLED' ? true : fallback),
  };
});

import './aiTools';
import {
  checkAgentGuardrails,
  checkGuardrails,
  isReadOnlyResolution,
  TIER1_NON_READONLY_TOOLS,
  TOOL_PERMISSIONS,
  WORKSPACE_TOOL_NAMES,
  type AgentGuardrailPolicy,
} from './aiGuardrails';

function policyWith(over: Partial<AgentGuardrailPolicy>): AgentGuardrailPolicy {
  return {
    enabled: true,
    mode: 'shadow',
    toolAllowlist: [],
    deviceId: null,
    deviceSiteId: null,
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    ...over,
  };
}

describe('workspace_* guardrail contract (W04)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('names exactly the four workspace tools and they are all Tier-1-non-read-only', () => {
    expect([...WORKSPACE_TOOL_NAMES].sort()).toEqual([
      'workspace_cancel', 'workspace_collect', 'workspace_run', 'workspace_stage',
    ]);
    for (const name of WORKSPACE_TOOL_NAMES) expect(TIER1_NON_READONLY_TOOLS.has(name), name).toBe(true);
  });

  it.each(WORKSPACE_TOOL_NAMES)('%s resolves tier 1 but readOnly=false', (name) => {
    const base = checkGuardrails(name, {});
    expect(base.tier).toBe(1);
    expect(isReadOnlyResolution(name, base)).toBe(false);
  });

  it.each(WORKSPACE_TOOL_NAMES)('%s with an empty allowlist denies at the allowlist gate', (name) => {
    const verdict = checkAgentGuardrails(name, {}, policyWith({ mode: 'act', toolAllowlist: [] }));
    expect(verdict.disposition).toBe('deny');
    expect(verdict.reason).toMatch(/allowlist/);
  });

  it.each(['shadow', 'act'] as const)(
    'allowlisted workspace tools on a device-less run are allow (never propose) in %s mode',
    (mode) => {
      for (const name of WORKSPACE_TOOL_NAMES) {
        const verdict = checkAgentGuardrails(
          name,
          {},
          policyWith({ mode, deviceId: null, toolAllowlist: [...WORKSPACE_TOOL_NAMES] }),
        );
        expect(verdict.disposition, name).toBe('allow');
        expect(verdict.allowed, name).toBe(true);
        expect(verdict.requiresApproval, name).toBe(false);
      }
    },
  );

  // `paths` is a PATH_INPUT_KEY (aiGuardrails.ts), so `workspace_collect` is
  // the workspace tool the protected-resource scan actually reaches. The
  // property under test is ORDERING: the W04 forced-allow sits AFTER the
  // protected check, so a protected hit still wins.
  it('a protected-resource hit still denies workspace_collect', () => {
    const verdict = checkAgentGuardrails(
      'workspace_collect',
      { paths: ['C:\\Windows\\System32\\drivers\\etc\\hosts'] },
      policyWith({
        toolAllowlist: [...WORKSPACE_TOOL_NAMES],
        protectedResources: {
          services: [], paths: ['C:\\Windows\\System32'], registryKeys: [], deviceTags: [],
        },
      }),
    );
    expect(verdict.disposition).toBe('deny');
  });

  it('every workspace tool has a TOOL_PERMISSIONS mapping', () => {
    for (const name of WORKSPACE_TOOL_NAMES) {
      expect(TOOL_PERMISSIONS[name], name).toEqual({ resource: 'ai_agents', action: 'read' });
    }
  });

  it('does not make any OTHER tier-1 tool non-read-only', () => {
    expect(TIER1_NON_READONLY_TOOLS.size).toBe(WORKSPACE_TOOL_NAMES.length);
    expect(isReadOnlyResolution('get_devices', { tier: 1, readOnly: undefined })).toBe(true);
  });
});
