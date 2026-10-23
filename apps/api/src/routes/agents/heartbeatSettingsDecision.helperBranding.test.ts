import { describe, expect, it } from 'vitest';
import { buildSettingsDecisionFields, type SettingsDecisionInput } from './heartbeatSettingsDecision';
import type { HelperSettings } from '../../services/helperSettings';
import { buildBrandingDecision, brandingScopeId } from '../../services/helperBranding';

// Helper branding on the heartbeat wire (Phase 2, Wave 1). Branding is a key
// of helperSettings, so it follows the helper's own decided/retained rules:
// a decided helper carries branding verbatim; a retained helper drops it.

const SCOPE = brandingScopeId('partner-1', 'org-1');
const BRANDED: HelperSettings = {
  enabled: true,
  showOpenPortal: true,
  showDeviceInfo: true,
  showRequestSupport: true,
  branding: buildBrandingDecision({ displayName: 'Example Assist', primaryColor: '#2255AA' }, SCOPE),
};
const CLEARED: HelperSettings = {
  enabled: true,
  showOpenPortal: true,
  showDeviceInfo: true,
  showRequestSupport: true,
  branding: { state: 'cleared' },
};

const base = (over: Partial<SettingsDecisionInput> = {}): SettingsDecisionInput => ({
  retainProtocol: 1,
  enabled: true,
  policyHierarchyLoaded: true,
  pamSettings: { uacInterceptionEnabled: true },
  helperSettings: BRANDED,
  remoteManagement: { resolved: true, value: true },
  ...over,
});

describe('heartbeat helper branding wire (Phase 2 Wave 1)', () => {
  it('a decided set branding is sent verbatim inside helperSettings and is not retained', () => {
    const out = buildSettingsDecisionFields(base());
    expect('retainState' in out).toBe(false);
    const wire = JSON.parse(JSON.stringify(out));
    expect(wire.helperSettings.branding).toEqual({
      state: 'set',
      scopeId: SCOPE,
      values: { displayName: 'Example Assist', primaryColor: '#2255AA' },
    });
  });

  it('a decided cleared branding is sent explicitly as state cleared, not omitted', () => {
    const out = buildSettingsDecisionFields(base({ helperSettings: CLEARED }));
    expect('retainState' in out).toBe(false);
    const wire = JSON.parse(JSON.stringify(out));
    expect(wire.helperSettings.branding).toEqual({ state: 'cleared' });
  });

  it('a helper with no branding key stays without the key (no decision on the wire)', () => {
    const { branding: _omit, ...noBranding } = BRANDED;
    const out = buildSettingsDecisionFields(base({ helperSettings: noBranding }));
    const wire = JSON.parse(JSON.stringify(out));
    expect(wire.helperSettings).not.toHaveProperty('branding');
  });

  it('helper retained (no decision): helperSettings and its branding are both omitted', () => {
    const out = buildSettingsDecisionFields(base({ helperSettings: null }));
    expect(out.retainState).toEqual(['helper']);
    const wire = JSON.parse(JSON.stringify(out));
    expect(wire).not.toHaveProperty('helperSettings');
  });

  it('hierarchy not loaded: branding is retained with the helper, not sent', () => {
    const out = buildSettingsDecisionFields(base({ policyHierarchyLoaded: false }));
    expect(out.retainState).toEqual(['pam', 'helper']);
    const wire = JSON.parse(JSON.stringify(out));
    expect(wire).not.toHaveProperty('helperSettings');
  });

  it('legacy protocol 0: branding passes through unchanged, like every other helper field', () => {
    const out = buildSettingsDecisionFields(base({ retainProtocol: 0 }));
    expect('retainState' in out).toBe(false);
    expect(JSON.parse(JSON.stringify(out)).helperSettings).toEqual(JSON.parse(JSON.stringify(BRANDED)));
  });
});
