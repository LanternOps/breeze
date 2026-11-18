import { describe, it, expect } from 'vitest';
import { derivePromptRenderer, helperInstallIssueKey } from './promptRenderer';

// #10190 W01 (P1): the device page derives Breeze Assist's state from the
// persisted helper columns. It describes the installed / last-reported state,
// not the live per-session renderer (that observation arrives in W02).
describe('derivePromptRenderer', () => {
  it.each([
    [{ helperVersion: '0.125.0', helperInstallIssue: null }, { status: 'installed' }],
    [{ helperVersion: ' 0.125.0 ', helperInstallIssue: undefined }, { status: 'installed' }],
    [{ helperVersion: null, helperInstallIssue: null }, { status: 'notDeployed' }],
    [{ helperVersion: '   ', helperInstallIssue: '' }, { status: 'notDeployed' }],
    [{ helperVersion: '0.125.0', helperInstallIssue: 'webview2_outdated' }, { status: 'unavailable', issue: 'webview2_outdated' }],
    [{ helperVersion: '0.125.0', helperInstallIssue: 'crash_loop' }, { status: 'unavailable', issue: 'crash_loop' }],
    [{ helperVersion: '0.125.0', helperInstallIssue: 'unmanaged_install' }, { status: 'unavailable', issue: 'unmanaged_install' }],
    [{ helperVersion: null, helperInstallIssue: 'awaiting_server_offer' }, { status: 'unavailable', issue: 'awaiting_server_offer' }],
    [{ helperVersion: null, helperInstallIssue: 'some_future_code' }, { status: 'unavailable', issue: 'some_future_code' }],
  ])('%j → %j', (input, want) => {
    expect(derivePromptRenderer(input)).toEqual(want);
  });
});

describe('helperInstallIssueKey', () => {
  it.each([
    ['awaiting_server_offer', 'awaitingServerOffer'],
    ['install_abandoned', 'installAbandoned'],
    ['webview2_outdated', 'webview2Outdated'],
    ['crash_loop', 'crashLoop'],
    ['unmanaged_install', 'unmanagedInstall'],
    ['some_future_code', 'unknown'],
  ])('%s → %s', (code, key) => {
    expect(helperInstallIssueKey(code)).toBe(key);
  });

  // The device list's pill must not say "Not installed" when Assist is on
  // disk and the agent only declines to run it.
  it('marks which codes mean Assist is installed', async () => {
    const { helperInstalledDespiteIssue } = await import('./promptRenderer');
    expect(helperInstalledDespiteIssue('webview2_outdated')).toBe(true);
    expect(helperInstalledDespiteIssue('crash_loop')).toBe(true);
    expect(helperInstalledDespiteIssue('unmanaged_install')).toBe(true);
    expect(helperInstalledDespiteIssue('awaiting_server_offer')).toBe(false);
    expect(helperInstalledDespiteIssue('install_abandoned')).toBe(false);
    expect(helperInstalledDespiteIssue('some_future_code')).toBe(false);
  });
});
