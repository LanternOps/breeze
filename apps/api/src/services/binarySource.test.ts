import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getGithubAgentUrl,
  getGithubHelperUrl,
  getGithubInstallerAppUrl,
  getGithubRegularMsiUrl,
  getGithubReleasePageUrl,
  getGithubReleaseRepository,
  getGithubViewerUrl,
} from './binarySource';

describe('binarySource release-source unification', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BINARY_GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO;
    delete process.env.BINARY_VERSION;
    delete process.env.BREEZE_VERSION;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('default URLs are unchanged (official repo, latest)', () => {
    expect(getGithubAgentUrl('windows', 'amd64')).toBe(
      'https://github.com/lanternops/breeze/releases/latest/download/breeze-agent-windows-amd64.exe',
    );
    expect(getGithubRegularMsiUrl()).toBe(
      'https://github.com/lanternops/breeze/releases/latest/download/breeze-agent.msi',
    );
    expect(getGithubReleasePageUrl()).toBe(
      'https://github.com/lanternops/breeze/releases/latest',
    );
  });

  it('every URL builder follows BINARY_GITHUB_REPOSITORY', () => {
    process.env.BINARY_GITHUB_REPOSITORY = 'acme/breeze-selfhost-signing';
    process.env.BINARY_VERSION = '1.2.3';
    const base = 'https://github.com/acme/breeze-selfhost-signing/releases/download/v1.2.3';
    expect(getGithubAgentUrl('linux', 'arm64')).toBe(`${base}/breeze-agent-linux-arm64`);
    expect(getGithubViewerUrl('windows')).toBe(`${base}/breeze-viewer-windows.msi`);
    expect(getGithubHelperUrl('darwin')).toBe(`${base}/breeze-helper-macos.dmg`);
    expect(getGithubInstallerAppUrl()).toBe(`${base}/Breeze.Installer.app.zip`);
    expect(getGithubReleaseRepository()).toBe('acme/breeze-selfhost-signing');
    expect(getGithubReleasePageUrl()).toBe(
      'https://github.com/acme/breeze-selfhost-signing/releases/tag/v1.2.3',
    );
  });

  it('rejects a malformed repository before building any URL', () => {
    process.env.BINARY_GITHUB_REPOSITORY = 'owner/repo/../evil';
    expect(() => getGithubAgentUrl('windows', 'amd64')).toThrow(
      /Invalid release source repository/,
    );
  });
});
