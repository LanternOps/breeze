import { describe, expect, it } from 'vitest';
import { agentEchEnabled, buildSettingsDecisionFields, type SettingsDecisionInput } from './heartbeatSettingsDecision';
import type { HelperSettings } from '../../services/helperSettings';

// #8616 — the pure legacy-or-retain builder for the heartbeat's PAM, helper
// and remote-management fields.

const HELPER_ON: HelperSettings = { enabled: true, showOpenPortal: true, showDeviceInfo: false, showRequestSupport: true };
const HELPER_OFF: HelperSettings = { enabled: false, showOpenPortal: true, showDeviceInfo: true, showRequestSupport: true };

/**
 * The oracle: the three inline expressions the heartbeat response assembled
 * before #8616, copied verbatim (heartbeat.ts final `c.json`, and the
 * org-scoped block's `manageRemoteManagement || undefined`).
 */
function legacyOracle(i: SettingsDecisionInput) {
  const pamSettings = i.pamSettings;
  const helperSettings = i.helperSettings;
  const manageRemoteManagement = i.remoteManagement.value;
  return {
    uacInterceptionEnabled: pamSettings?.uacInterceptionEnabled ?? false,
    helperEnabled: helperSettings?.enabled ?? false,
    helperSettings: helperSettings ?? undefined,
    manageRemoteManagement: manageRemoteManagement || undefined,
  };
}

const PAMS = [null, { uacInterceptionEnabled: true }, { uacInterceptionEnabled: false }] as const;
const HELPERS = [null, HELPER_ON, HELPER_OFF] as const;
const REMOTES = [
  { resolved: true, value: true },
  { resolved: true, value: false },
  { resolved: false, value: true },
  { resolved: false, value: false },
] as const;

function allInputs(base: Pick<SettingsDecisionInput, 'retainProtocol' | 'enabled'>): SettingsDecisionInput[] {
  const out: SettingsDecisionInput[] = [];
  for (const pamSettings of PAMS) {
    for (const helperSettings of HELPERS) {
      for (const remoteManagement of REMOTES) {
        for (const policyHierarchyLoaded of [true, false]) {
          out.push({ ...base, pamSettings, helperSettings, remoteManagement, policyHierarchyLoaded });
        }
      }
    }
  }
  return out;
}

const decided = (over: Partial<SettingsDecisionInput> = {}): SettingsDecisionInput => ({
  retainProtocol: 1,
  enabled: true,
  policyHierarchyLoaded: true,
  pamSettings: { uacInterceptionEnabled: true },
  helperSettings: HELPER_ON,
  remoteManagement: { resolved: true, value: true },
  ...over,
});

describe('buildSettingsDecisionFields — legacy mode reproduces the pre-#8616 payload exactly', () => {
  const legacyModes: Array<{ label: string; base: Pick<SettingsDecisionInput, 'retainProtocol' | 'enabled'> }> = [
    { label: 'protocol 0, kill switch on', base: { retainProtocol: 0, enabled: true } },
    { label: 'protocol 0, kill switch off', base: { retainProtocol: 0, enabled: false } },
    { label: 'protocol 1, kill switch off (HEARTBEAT_RETAIN_STATE_ENABLED=false)', base: { retainProtocol: 1, enabled: false } },
  ];
  for (const mode of legacyModes) {
    it(`${mode.label}: every null/non-null combination serializes byte-for-byte like the oracle`, () => {
      for (const input of allInputs(mode.base)) {
        const out = buildSettingsDecisionFields(input);
        expect('retainState' in out).toBe(false);
        // Same values AND same serialized bytes (key order included).
        expect(JSON.stringify(out)).toBe(JSON.stringify(legacyOracle(input)));
      }
    });
  }

  it('legacy mode ignores the hierarchy gate: an unloaded hierarchy still sends the resolver values', () => {
    const out = buildSettingsDecisionFields(decided({ retainProtocol: 0, policyHierarchyLoaded: false }));
    expect(out.uacInterceptionEnabled).toBe(true);
    expect(out.helperEnabled).toBe(true);
    expect(out.helperSettings).toEqual(HELPER_ON);
  });
});

describe('buildSettingsDecisionFields — retain mode (protocol 1, kill switch on)', () => {
  it('everything decided: no retainState, the same keys as legacy', () => {
    const input = decided();
    const out = buildSettingsDecisionFields(input);
    expect('retainState' in out).toBe(false);
    expect(JSON.stringify(out)).toBe(JSON.stringify(legacyOracle(input)));
  });

  it('pam null: retains pam and omits uacInterceptionEnabled entirely', () => {
    const out = buildSettingsDecisionFields(decided({ pamSettings: null }));
    expect(out.retainState).toEqual(['pam']);
    expect(JSON.parse(JSON.stringify(out))).not.toHaveProperty('uacInterceptionEnabled');
    expect(out.helperEnabled).toBe(true);
  });

  it('a decided uacInterceptionEnabled:false stays explicit and is NOT retained', () => {
    const out = buildSettingsDecisionFields(decided({ pamSettings: { uacInterceptionEnabled: false } }));
    expect(out.uacInterceptionEnabled).toBe(false);
    expect(JSON.parse(JSON.stringify(out))).toHaveProperty('uacInterceptionEnabled', false);
    expect('retainState' in out).toBe(false);
  });

  it('helper null: retains helper and omits helperEnabled and helperSettings', () => {
    const out = buildSettingsDecisionFields(decided({ helperSettings: null }));
    expect(out.retainState).toEqual(['helper']);
    const wire = JSON.parse(JSON.stringify(out));
    expect(wire).not.toHaveProperty('helperEnabled');
    expect(wire).not.toHaveProperty('helperSettings');
    expect(wire.uacInterceptionEnabled).toBe(true);
  });

  it('a decided helper enabled:false is sent explicitly and not retained', () => {
    const out = buildSettingsDecisionFields(decided({ helperSettings: HELPER_OFF }));
    expect(out.helperEnabled).toBe(false);
    expect(out.helperSettings).toEqual(HELPER_OFF);
    expect('retainState' in out).toBe(false);
  });

  it('remote management unresolved: retains remoteManagement and omits manageRemoteManagement, even when the default value is true', () => {
    for (const value of [true, false]) {
      const out = buildSettingsDecisionFields(decided({ remoteManagement: { resolved: false, value } }));
      expect(out.retainState).toEqual(['remoteManagement']);
      expect(JSON.parse(JSON.stringify(out))).not.toHaveProperty('manageRemoteManagement');
    }
  });

  it('remote management resolved false: legacy shape (key absent), not retained', () => {
    const out = buildSettingsDecisionFields(decided({ remoteManagement: { resolved: true, value: false } }));
    expect(JSON.parse(JSON.stringify(out))).not.toHaveProperty('manageRemoteManagement');
    expect('retainState' in out).toBe(false);
  });

  it('hierarchy not loaded: pam and helper are retained even when the resolvers returned values', () => {
    const out = buildSettingsDecisionFields(decided({
      policyHierarchyLoaded: false,
      pamSettings: { uacInterceptionEnabled: false },
      helperSettings: HELPER_OFF,
    }));
    expect(out.retainState).toEqual(['pam', 'helper']);
    const wire = JSON.parse(JSON.stringify(out));
    expect(wire).not.toHaveProperty('uacInterceptionEnabled');
    expect(wire).not.toHaveProperty('helperEnabled');
    expect(wire).not.toHaveProperty('helperSettings');
    // Remote management has its own `resolved` flag; the hierarchy gate does not touch it.
    expect(wire.manageRemoteManagement).toBe(true);
  });

  it('nothing decided: retains all three, in a fixed order', () => {
    const out = buildSettingsDecisionFields(decided({
      pamSettings: null,
      helperSettings: null,
      remoteManagement: { resolved: false, value: true },
    }));
    expect(out.retainState).toEqual(['pam', 'helper', 'remoteManagement']);
    expect(JSON.parse(JSON.stringify(out))).toEqual({ retainState: ['pam', 'helper', 'remoteManagement'] });
  });

  it('every retain-mode combination: a feature is either decided (keys sent) or listed, never both and never neither', () => {
    for (const input of allInputs({ retainProtocol: 1, enabled: true })) {
      const out = buildSettingsDecisionFields(input);
      const wire = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
      const retained = new Set((wire.retainState as string[] | undefined) ?? []);
      const pamDecided = input.policyHierarchyLoaded && input.pamSettings !== null;
      const helperDecided = input.policyHierarchyLoaded && input.helperSettings !== null;
      expect(retained.has('pam')).toBe(!pamDecided);
      expect('uacInterceptionEnabled' in wire).toBe(pamDecided);
      expect(retained.has('helper')).toBe(!helperDecided);
      expect('helperEnabled' in wire).toBe(helperDecided);
      expect('helperSettings' in wire).toBe(helperDecided);
      expect(retained.has('remoteManagement')).toBe(!input.remoteManagement.resolved);
      if (!input.remoteManagement.resolved) expect('manageRemoteManagement' in wire).toBe(false);
      // An empty list is never sent.
      if (retained.size === 0) expect('retainState' in wire).toBe(false);
    }
  });
});

describe('agentEchEnabled (#8869)', () => {
  it.each([
    [undefined, true],
    ['true', true],
    ['TRUE', true],
    ['', true],
    ['false', false],
  ])('AGENT_ECH_ENABLED=%s -> %s', (value, expected) => {
    expect(agentEchEnabled({ AGENT_ECH_ENABLED: value } as NodeJS.ProcessEnv)).toBe(expected);
  });
});
