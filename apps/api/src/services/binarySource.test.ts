import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getGithubAgentUrl,
  getGithubBackupUrl,
  getGithubHelperUrl,
  getGithubInstallerAppUrl,
  getGithubRegularMsiUrl,
  getGithubReleasePageUrl,
  getGithubReleaseRepository,
  getGithubUserHelperUrl,
  getGithubViewerUrl,
  getGithubWatchdogUrl,
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

  it('serving-surface guard: refuses to build URLs for signing-input asset names', async () => {
    const { HELPER_FILENAMES } = await import('./binarySource');
    // Simulate a future registry mistake by direct call through a builder that
    // takes caller-controlled filename mapping.
    HELPER_FILENAMES.windows = 'breeze-helper-windows-unsigned.msi';
    try {
      const { getGithubHelperUrl } = await import('./binarySource');
      expect(() => getGithubHelperUrl('windows')).toThrow(/signing-input/);
    } finally {
      HELPER_FILENAMES.windows = 'breeze-helper-windows.msi';
    }
  });

  it('rejects a malformed repository before building any URL', () => {
    process.env.BINARY_GITHUB_REPOSITORY = 'owner/repo/../evil';
    expect(() => getGithubAgentUrl('windows', 'amd64')).toThrow(
      /Invalid release source repository/,
    );
  });

  // Issue #3499. The component-download routes resolve the promoted
  // agent_versions row and pass its version here, so the bytes come from the
  // same release as the checksum GET /agent-versions/latest handed the client.
  // Without these assertions the builders could accept the argument and ignore
  // it — the routes would still "pass a version", every route test would still
  // pass, and the bug would be back.
  describe('explicit version overrides the env-resolved release (#3499)', () => {
    it('pins the release tag to the version passed, not BINARY_VERSION', () => {
      // The exact production divergence: env says 0.105.1, the promoted row
      // says 0.104.0. The bytes must come from 0.104.0.
      process.env.BINARY_VERSION = '0.105.1';

      const url = getGithubAgentUrl('linux', 'amd64', '0.104.0');

      expect(url).toBe(
        'https://github.com/lanternops/breeze/releases/download/v0.104.0/breeze-agent-linux-amd64',
      );
      expect(url).not.toContain('0.105.1');
    });

    it('pins every component builder, not just the agent', () => {
      process.env.BINARY_VERSION = '0.105.1';
      const base = 'https://github.com/lanternops/breeze/releases/download/v0.104.0';

      expect(getGithubBackupUrl('linux', 'amd64', '0.104.0')).toBe(
        `${base}/breeze-backup-linux-amd64`,
      );
      expect(getGithubWatchdogUrl('windows', 'amd64', '0.104.0')).toBe(
        `${base}/breeze-watchdog-windows-amd64.exe`,
      );
      expect(getGithubUserHelperUrl('windows', 'amd64', '0.104.0')).toBe(
        `${base}/breeze-user-helper-windows-amd64.exe`,
      );
      expect(getGithubHelperUrl('darwin', '0.104.0')).toBe(
        `${base}/breeze-helper-macos.dmg`,
      );
    });

    it('overrides even the floating "latest" default when no version is pinned', () => {
      // With BINARY_VERSION unset the env resolution is the literal "latest",
      // i.e. whatever GitHub published most recently — an unbounded external
      // value. A promoted row must still win.
      expect(getGithubAgentUrl('linux', 'amd64', '0.104.0')).toBe(
        'https://github.com/lanternops/breeze/releases/download/v0.104.0/breeze-agent-linux-amd64',
      );
    });

    it('accepts an already-v-prefixed version without doubling the prefix', () => {
      expect(getGithubAgentUrl('linux', 'amd64', 'v0.104.0')).toBe(
        'https://github.com/lanternops/breeze/releases/download/v0.104.0/breeze-agent-linux-amd64',
      );
    });

    it('omitting the version preserves the historical env-resolved behavior', () => {
      process.env.BINARY_VERSION = '0.105.1';
      expect(getGithubAgentUrl('linux', 'amd64')).toBe(
        'https://github.com/lanternops/breeze/releases/download/v0.105.1/breeze-agent-linux-amd64',
      );
    });

    it('refuses a malformed version rather than 404ing mysteriously', () => {
      // agent_versions.version has no format constraint and rows are creatable
      // via POST /agent-versions, so this string is no longer env-only.
      expect(() => getGithubAgentUrl('linux', 'amd64', '../../evil')).toThrow(
        /malformed release tag/,
      );
      expect(() => getGithubAgentUrl('linux', 'amd64', 'unknown/../x')).toThrow(
        /malformed release tag/,
      );
    });
  });
});
