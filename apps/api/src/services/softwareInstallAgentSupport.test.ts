import { describe, expect, it } from 'vitest';
import {
  AGENT_UPDATE_REQUIRED_INSTALL_PREFIX,
  MIN_AGENT_VERSION_INSTALL_SCRIPTS,
  MIN_AGENT_VERSION_SERVICE_RUNNING_RULE,
  agentSupportsInstallScripts,
  agentSupportsServiceRunningRule,
  agentUpdateRequiredInstallMessage,
  payloadNeedsInstallScriptSupport,
  stripUnsupportedDetectionClauses,
  versionNeedsInstallScriptSupport,
} from './softwareInstallAgentSupport';

// MIN minus one patch / plus one minor, derived from the constant so the test
// follows a release-cut bump without edits.
function bump(version: string, index: 0 | 1 | 2, delta: number): string {
  const parts = version.split('.').map((p) => Number.parseInt(p, 10));
  parts[index] = (parts[index] ?? 0) + delta;
  return parts.join('.');
}

describe('install-script agent gates (#6958)', () => {
  it('pins both minimums to the first agent release carrying PR B (0.125.0)', () => {
    expect(MIN_AGENT_VERSION_INSTALL_SCRIPTS).toBe('0.125.0');
    expect(MIN_AGENT_VERSION_SERVICE_RUNNING_RULE).toBe(MIN_AGENT_VERSION_INSTALL_SCRIPTS);
  });

  it.each([
    [undefined],
    [null],
    [''],
    ['   '],
    ['dev'],
    ['dev-1729000000'],
    ['not-a-version'],
    [125],
    [{}],
    ['0.124.0'],
  ])('fails closed for %j', (version) => {
    expect(agentSupportsInstallScripts(version)).toBe(false);
    expect(agentSupportsServiceRunningRule(version)).toBe(false);
  });

  it('is false one patch below the minimum (when the minimum has a patch to step down)', () => {
    // 0.125.0 has patch 0, so "one below" is the prior minor's last patch.
    expect(agentSupportsInstallScripts('0.124.99')).toBe(false);
    expect(agentSupportsInstallScripts(bump(MIN_AGENT_VERSION_INSTALL_SCRIPTS, 1, -1))).toBe(false);
  });

  it.each([
    [MIN_AGENT_VERSION_INSTALL_SCRIPTS],
    [`${MIN_AGENT_VERSION_INSTALL_SCRIPTS}-rc.1`],
    [` ${MIN_AGENT_VERSION_INSTALL_SCRIPTS} `],
    [bump(MIN_AGENT_VERSION_INSTALL_SCRIPTS, 2, 1)],
    [bump(MIN_AGENT_VERSION_INSTALL_SCRIPTS, 1, 1)],
    ['1.0.0'],
  ])('passes %j', (version) => {
    expect(agentSupportsInstallScripts(version)).toBe(true);
    expect(agentSupportsServiceRunningRule(version)).toBe(true);
  });

  it('builds the agent_update_required failure message with the minimum', () => {
    expect(AGENT_UPDATE_REQUIRED_INSTALL_PREFIX).toBe('agent_update_required');
    expect(agentUpdateRequiredInstallMessage()).toBe(
      `agent_update_required (minimum agent ${MIN_AGENT_VERSION_INSTALL_SCRIPTS})`,
    );
  });
});

describe('versionNeedsInstallScriptSupport', () => {
  const base = { fileType: 'exe', installScriptsEnabled: false, preInstallScript: null, postInstallScript: null };

  it('is true for a zip whatever the scripts', () => {
    expect(versionNeedsInstallScriptSupport({ ...base, fileType: 'zip' })).toBe(true);
  });

  it('is true for an enabled non-blank pre or post script', () => {
    expect(versionNeedsInstallScriptSupport({ ...base, installScriptsEnabled: true, preInstallScript: 'echo hi' })).toBe(true);
    expect(versionNeedsInstallScriptSupport({ ...base, installScriptsEnabled: true, postInstallScript: 'echo hi' })).toBe(true);
  });

  it('is false for a stored script that is not enabled (dormant)', () => {
    expect(versionNeedsInstallScriptSupport({ ...base, preInstallScript: 'echo hi', postInstallScript: 'echo hi' })).toBe(false);
  });

  it('is false for enabled but blank scripts and for a plain installer', () => {
    expect(versionNeedsInstallScriptSupport({ ...base, installScriptsEnabled: true, preInstallScript: '   ', postInstallScript: '' })).toBe(false);
    expect(versionNeedsInstallScriptSupport(base)).toBe(false);
    expect(versionNeedsInstallScriptSupport({ ...base, fileType: null })).toBe(false);
  });
});

describe('payloadNeedsInstallScriptSupport (claim-time check)', () => {
  it('is true for a payload carrying either script key or fileType zip', () => {
    expect(payloadNeedsInstallScriptSupport({ preInstallScript: { content: 'x' } })).toBe(true);
    expect(payloadNeedsInstallScriptSupport({ postInstallScript: { content: 'x' } })).toBe(true);
    expect(payloadNeedsInstallScriptSupport({ fileType: 'zip' })).toBe(true);
  });

  it('is false for a plain payload, a null script key, or a non-object payload', () => {
    expect(payloadNeedsInstallScriptSupport({ fileType: 'msi', downloadUrl: 'https://x' })).toBe(false);
    expect(payloadNeedsInstallScriptSupport({ preInstallScript: null })).toBe(false);
    expect(payloadNeedsInstallScriptSupport(null)).toBe(false);
    expect(payloadNeedsInstallScriptSupport('zip')).toBe(false);
  });
});

describe('stripUnsupportedDetectionClauses', () => {
  const fileExists = { type: 'file_exists', path: 'C:\\ControlD\\ctrld.exe' };
  const serviceRunning = { type: 'service_running', serviceName: 'ctrld' };

  it('drops service_running for an old agent and keeps the rest', () => {
    expect(stripUnsupportedDetectionClauses([fileExists, serviceRunning], '0.124.0')).toEqual([fileExists]);
  });

  it('returns undefined (send no rules) when only service_running remains', () => {
    expect(stripUnsupportedDetectionClauses([serviceRunning], '0.124.0')).toBeUndefined();
  });

  it('returns the rules unchanged for a new agent', () => {
    const rules = [fileExists, serviceRunning];
    expect(stripUnsupportedDetectionClauses(rules, MIN_AGENT_VERSION_SERVICE_RUNNING_RULE)).toEqual(rules);
  });

  it('returns undefined for a non-array or empty array, as the dispatch did before', () => {
    expect(stripUnsupportedDetectionClauses(null, '1.0.0')).toBeUndefined();
    expect(stripUnsupportedDetectionClauses({ all: [] }, '1.0.0')).toBeUndefined();
    expect(stripUnsupportedDetectionClauses([], '1.0.0')).toEqual([]);
  });
});
