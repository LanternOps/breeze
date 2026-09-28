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

// Server-only hotfix groundwork: a server-only API image carries the binaries
// release it pairs with in BREEZE_BINARIES_VERSION (baked at image build time,
// empty for full releases). Every binaries lookup must follow the pairing, and
// a full-release image (pairing empty) must resolve exactly as before.
describe('binaries version pairing', () => {
  const originalEnv = process.env;
  const legacy = () =>
    process.env.BINARY_VERSION || process.env.BREEZE_VERSION || 'latest';

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BINARY_GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO;
    delete process.env.BINARY_VERSION;
    delete process.env.BREEZE_VERSION;
    delete process.env.BREEZE_BINARIES_VERSION;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function setEnv(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  it.each([
    // [BINARY_VERSION, BREEZE_BINARIES_VERSION, BREEZE_VERSION, expected]
    [undefined, undefined, undefined, 'latest'],
    [undefined, undefined, '0.118.2', '0.118.2'],
    [undefined, '0.118.0', '0.118.2', '0.118.0'],
    ['0.117.5', '0.118.0', '0.118.2', '0.117.5'],
    ['', '0.118.0', '0.118.2', '0.118.0'],
    ['  ', '0.118.0', '0.118.2', '0.118.0'],
    [undefined, '', '0.118.2', '0.118.2'],
    [undefined, '   ', '0.118.2', '0.118.2'],
    [undefined, ' 0.118.0 ', '0.118.2', '0.118.0'],
    [undefined, 'v0.118.0', '0.118.2', 'v0.118.0'],
    [undefined, '0.118.0', undefined, '0.118.0'],
    [undefined, undefined, '  ', 'latest'],
    [undefined, undefined, 'latest', 'latest'],
  ])(
    'BINARY_VERSION=%j BREEZE_BINARIES_VERSION=%j BREEZE_VERSION=%j → %s',
    async (binaryVersion, paired, server, expected) => {
      const { getBinariesVersion } = await import('./binarySource');
      setEnv('BINARY_VERSION', binaryVersion);
      setEnv('BREEZE_BINARIES_VERSION', paired);
      setEnv('BREEZE_VERSION', server);
      expect(getBinariesVersion()).toBe(expected);
    },
  );

  it('getPairedBinariesVersion is undefined when unset, empty or whitespace', async () => {
    const { getPairedBinariesVersion } = await import('./binarySource');
    expect(getPairedBinariesVersion()).toBeUndefined();
    process.env.BREEZE_BINARIES_VERSION = '';
    expect(getPairedBinariesVersion()).toBeUndefined();
    process.env.BREEZE_BINARIES_VERSION = '  ';
    expect(getPairedBinariesVersion()).toBeUndefined();
    process.env.BREEZE_BINARIES_VERSION = ' 0.118.0 ';
    expect(getPairedBinariesVersion()).toBe('0.118.0');
  });

  // Full-release images bake BREEZE_BINARIES_VERSION="" — every lookup must
  // evaluate exactly like the pre-pairing expression.
  const values = [undefined, '', '0.117.5', 'v0.118.1', 'latest'];
  const combos: [string | undefined, string | undefined, string | undefined][] = [];
  for (const b of values) for (const s of values) for (const p of [undefined, '']) combos.push([b, p, s]);
  it.each(combos)(
    'no-op for full releases: BINARY_VERSION=%j BREEZE_BINARIES_VERSION=%j BREEZE_VERSION=%j',
    async (binaryVersion, paired, server) => {
      const { getBinariesVersion, getGithubReleaseVersion } = await import('./binarySource');
      setEnv('BINARY_VERSION', binaryVersion);
      setEnv('BREEZE_BINARIES_VERSION', paired);
      setEnv('BREEZE_VERSION', server);
      expect(getBinariesVersion()).toBe(legacy());
      expect(getGithubReleaseVersion()).toBe(legacy());
    },
  );

  it('getGithubReleaseVersion is the same function as getBinariesVersion', async () => {
    const mod = await import('./binarySource');
    expect(mod.getGithubReleaseVersion).toBe(mod.getBinariesVersion);
  });

  it('server-only image: every release URL points at the paired binaries release, not the server version', async () => {
    const mod = await import('./binarySource');
    process.env.BREEZE_VERSION = '0.118.2';
    process.env.BREEZE_BINARIES_VERSION = '0.118.0';

    expect(mod.getGithubReleasePageUrl()).toBe(
      'https://github.com/lanternops/breeze/releases/tag/v0.118.0',
    );
    for (const url of [
      mod.getGithubAgentUrl('windows', 'amd64'),
      mod.getGithubViewerUrl('windows'),
      mod.getGithubReleaseArtifactManifestUrl(),
      mod.getGithubReleaseArtifactManifestSignatureUrl(),
      mod.getGithubRecoveryIsoUrl('amd64'),
    ]) {
      expect(url).toContain('/releases/download/v0.118.0/');
      expect(url).not.toContain('0.118.2');
    }
    expect(mod.getGithubExpectedReleaseTag()).toBe('v0.118.0');
  });
});
