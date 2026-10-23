import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTALL_FALLBACK_ASSETS, parseInstallFallback } from '@breeze/shared';
import {
  buildInstallFallback,
  computeInstallFallbackValidUntil,
  type InstallFallbackBuildInput,
} from './build';
import {
  readVerifiedManifestDistribution,
  readVerifiedManifestInstallFallbackInterface,
} from '../releaseArtifactManifest';

// ---------------------------------------------------------------------------
// Fixtures. An in-test Ed25519 key signs every manifest; its raw public key is
// injected through RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS, the same pattern as
// releaseArtifactManifest.test.ts. Hosts and repositories are placeholders.
// ---------------------------------------------------------------------------

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const RAW_PUBLIC_KEY = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
  .subarray(-32)
  .toString('base64');
const OTHER_KEY = generateKeyPairSync('ed25519').privateKey;

const REPO = 'example-owner/example-repo';
const RELEASE = 'v0.124.0';
const TEAM_ID = 'ABCDE12345';
const IDENTITY = `Developer ID Installer: Example Corp (${TEAM_ID})`;
const IDENTITY_B64 = Buffer.from(IDENTITY, 'utf8').toString('base64');

// Fixed, distinct digests so the expected anchors below are literal.
const SHA: Record<string, string> = {
  'install.sh': '11'.repeat(32),
  'breeze-agent-windows-amd64.exe': '22'.repeat(32),
  'breeze-agent-linux-amd64': '33'.repeat(32),
  'breeze-agent-linux-arm64': '44'.repeat(32),
  'breeze-backup-linux-amd64': '55'.repeat(32),
  'breeze-backup-linux-arm64': '66'.repeat(32),
  'breeze-agent-darwin-amd64.pkg': '77'.repeat(32),
  'breeze-agent-darwin-arm64.pkg': '88'.repeat(32),
  // Raw darwin agent binaries: not consumed by the anchor, but the macos
  // agent_versions rows carry THEIR checksum.
  'breeze-agent-darwin-amd64': '99'.repeat(32),
  'breeze-agent-darwin-arm64': 'aa'.repeat(32),
};

type Entry = Record<string, unknown>;
type Manifest = Record<string, unknown> & { assets: Entry[] };

function entryFor(name: string, edition = 'self-host'): Entry {
  const entry: Entry = { name, sha256: SHA[name], size: 1024, edition };
  if (name.endsWith('.exe')) {
    // The stock public self-host release ships the Windows exes unsigned.
    entry.platformTrust = edition === 'self-host' ? 'none' : 'windows-authenticode-required';
  } else if (name.endsWith('.pkg') || /^breeze-agent-darwin-(amd64|arm64)$/.test(name)) {
    entry.platformTrust = 'macos-developer-id-notarization-required';
  } else {
    entry.platformTrust = 'release-workflow-produced';
  }
  if (name.endsWith('.pkg')) {
    entry.signingIdentity = IDENTITY;
    entry.signingTeamId = TEAM_ID;
  }
  return entry;
}

function baseManifest(edition = 'self-host'): Manifest {
  return {
    schemaVersion: 1,
    repository: REPO,
    release: RELEASE,
    sourceCommit: 'c'.repeat(40),
    installFallbackInterface: 1,
    assets: [
      ...Object.keys(SHA).map((name) => entryFor(name, edition)),
      { name: 'checksums.txt', sha256: 'bb'.repeat(32), size: 10, platformTrust: 'release-workflow-produced', edition },
    ],
  };
}

function signed(manifest: Manifest, key = privateKey): { bytes: Buffer; signature: Buffer } {
  const bytes = Buffer.from(JSON.stringify(manifest));
  return { bytes, signature: Buffer.from(sign(null, bytes, key).toString('base64')) };
}

function asset(manifest: Manifest, name: string): Entry {
  const found = manifest.assets.find((e) => e.name === name);
  if (!found) throw new Error(`fixture has no ${name}`);
  return found;
}

function rows(version = '0.124.0'): InstallFallbackBuildInput['promotedRows'] {
  return [
    { platform: 'windows', architecture: 'amd64', version, checksum: SHA['breeze-agent-windows-amd64.exe']! },
    { platform: 'linux', architecture: 'amd64', version, checksum: SHA['breeze-agent-linux-amd64']! },
    { platform: 'linux', architecture: 'arm64', version, checksum: SHA['breeze-agent-linux-arm64']! },
    { platform: 'macos', architecture: 'amd64', version, checksum: SHA['breeze-agent-darwin-amd64']! },
    { platform: 'macos', architecture: 'arm64', version, checksum: SHA['breeze-agent-darwin-arm64']! },
  ];
}

const NOW = new Date('2026-10-22T12:00:00.750Z');
const TOKEN_EXPIRES = new Date('2026-10-29T12:00:00.250Z');

function input(overrides: Partial<InstallFallbackBuildInput> = {}): InstallFallbackBuildInput {
  return {
    source: { kind: 'github', repository: REPO },
    edition: 'self-host',
    manifest: signed(baseManifest()),
    promotedRows: rows(),
    tokenExpiresAt: TOKEN_EXPIRES,
    now: NOW,
    ...overrides,
  };
}

function withManifest(mutate: (m: Manifest) => void, overrides: Partial<InstallFallbackBuildInput> = {}) {
  const m = baseManifest();
  mutate(m);
  return input({ manifest: signed(m), ...overrides });
}

const EXPECTED_ASSETS = {
  'install.sh': SHA['install.sh'],
  'breeze-agent-windows-amd64.exe': SHA['breeze-agent-windows-amd64.exe'],
  'breeze-agent-linux-amd64': SHA['breeze-agent-linux-amd64'],
  'breeze-agent-linux-arm64': SHA['breeze-agent-linux-arm64'],
  'breeze-backup-linux-amd64': SHA['breeze-backup-linux-amd64'],
  'breeze-backup-linux-arm64': SHA['breeze-backup-linux-arm64'],
  'breeze-agent-darwin-amd64.pkg': SHA['breeze-agent-darwin-amd64.pkg'],
  'breeze-agent-darwin-arm64.pkg': SHA['breeze-agent-darwin-arm64.pkg'],
};

beforeEach(() => {
  vi.stubEnv('RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS', RAW_PUBLIC_KEY);
  vi.stubEnv('BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS', '');
  // selectManifestAsset warns once per unsigned self-host asset.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('buildInstallFallback — happy paths', () => {
  it('self-host github: a fixed expected anchor that passes parseInstallFallback', async () => {
    const result = await buildInstallFallback(input());
    expect(result).toEqual({
      reason: null,
      anchor: {
        schema: 1,
        release: 'v0.124.0',
        baseUrl: 'https://github.com/example-owner/example-repo/releases/download/v0.124.0/',
        validUntil: '2026-10-29T12:00:00Z',
        assets: EXPECTED_ASSETS,
        macosPkgPublisher: { teamId: TEAM_ID, signingIdentityB64: IDENTITY_B64 },
      },
    });
    expect(result.anchor!.validUntil).toBe(computeInstallFallbackValidUntil(TOKEN_EXPIRES, NOW));
    expect(parseInstallFallback(result.anchor)).toEqual(result.anchor);
  });

  it('self-host mirror: baseUrl is <base><tag>/', async () => {
    const result = await buildInstallFallback(input({ source: { kind: 'mirror', base: 'https://mirror.example/breeze/' } }));
    expect(result).toEqual({
      reason: null,
      anchor: {
        schema: 1,
        release: 'v0.124.0',
        baseUrl: 'https://mirror.example/breeze/v0.124.0/',
        validUntil: '2026-10-29T12:00:00Z',
        assets: EXPECTED_ASSETS,
        macosPkgPublisher: { teamId: TEAM_ID, signingIdentityB64: IDENTITY_B64 },
      },
    });
    expect(parseInstallFallback(result.anchor)).toEqual(result.anchor);
  });

  it('rows store 0.124.0 (no v) and the manifest says v0.124.0 → anchor (real-shape fixture)', async () => {
    expect(rows()[0]!.version).toBe('0.124.0');
    expect((await buildInstallFallback(input())).reason).toBeNull();
  });

  it('rows that already carry the v prefix are normalized the same way', async () => {
    expect((await buildInstallFallback(input({ promotedRows: rows('v0.124.0') }))).reason).toBeNull();
  });

  it('the manifest repository is compared case-insensitively against the source', async () => {
    const result = await buildInstallFallback(withManifest((m) => { m.repository = 'Example-Owner/Example-Repo'; }));
    expect(result.reason).toBeNull();
    expect(result.anchor!.baseUrl).toBe('https://github.com/example-owner/example-repo/releases/download/v0.124.0/');
  });

  it('a subset of platforms promoted still yields an anchor (every row present must agree)', async () => {
    expect((await buildInstallFallback(input({ promotedRows: rows().slice(1, 3) }))).reason).toBeNull();
  });

  it('a 365-day token is capped at mint + 30 days', async () => {
    const result = await buildInstallFallback(input({ tokenExpiresAt: new Date('2027-10-22T12:00:00Z') }));
    expect(result.anchor!.validUntil).toBe('2026-11-21T12:00:00Z');
  });
});

describe('buildInstallFallback — null reasons', () => {
  function expectNull(result: Awaited<ReturnType<typeof buildInstallFallback>>, reason: string) {
    expect(result).toEqual({ anchor: null, reason });
  }

  it('source off → source_off', async () => {
    expectNull(await buildInstallFallback(input({ source: { kind: 'off' } })), 'source_off');
  });

  it('null manifest → no_manifest', async () => {
    expectNull(await buildInstallFallback(input({ manifest: null })), 'no_manifest');
  });

  it('bad signature → signature', async () => {
    expectNull(await buildInstallFallback(input({ manifest: signed(baseManifest(), OTHER_KEY) })), 'signature');
  });

  it('tampered bytes under a valid signature → signature', async () => {
    const good = signed(baseManifest());
    const tampered = Buffer.from(good.bytes.toString('utf8').replace('11111111', '11111112'));
    expectNull(await buildInstallFallback(input({ manifest: { bytes: tampered, signature: good.signature } })), 'signature');
  });

  it('no trust root configured → signature', async () => {
    vi.stubEnv('RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS', '');
    expectNull(await buildInstallFallback(input()), 'signature');
  });

  it('a signed manifest with an invalid schema → schema', async () => {
    expectNull(await buildInstallFallback(withManifest((m) => { m.schemaVersion = 2; })), 'schema');
  });

  it('releaseKind server-only → not_binaries_release', async () => {
    expectNull(
      await buildInstallFallback(withManifest((m) => {
        m.releaseKind = 'server-only';
        m.binariesRelease = 'v0.123.0';
        m.binariesSourceCommit = 'd'.repeat(40);
      })),
      'not_binaries_release',
    );
  });

  it('an unknown releaseKind → not_binaries_release', async () => {
    expectNull(await buildInstallFallback(withManifest((m) => { m.releaseKind = 'partial'; })), 'not_binaries_release');
  });

  it.each([
    ['absent', undefined],
    ['2', 2],
    ['"1" as a string', '1'],
    ['true', true],
  ])('installFallbackInterface %s → interface_missing', async (_label, value) => {
    expectNull(
      await buildInstallFallback(withManifest((m) => {
        if (value === undefined) delete m.installFallbackInterface;
        else m.installFallbackInterface = value;
      })),
      'interface_missing',
    );
  });

  it('rows disagree (0.124.0 and 0.123.0) → version_disagreement', async () => {
    const mixed = rows();
    mixed[2] = { ...mixed[2]!, version: '0.123.0' };
    expectNull(await buildInstallFallback(input({ promotedRows: mixed })), 'version_disagreement');
  });

  it('rows all 0.123.0, manifest release v0.124.0 → version_disagreement', async () => {
    expectNull(await buildInstallFallback(input({ promotedRows: rows('0.123.0') })), 'version_disagreement');
  });

  it('no promoted rows → version_disagreement (nothing to pin the manifest to)', async () => {
    expectNull(await buildInstallFallback(input({ promotedRows: [] })), 'version_disagreement');
  });

  it("linux/arm64 row checksum differs from the manifest's breeze-agent-linux-arm64 entry → row_checksum_mismatch", async () => {
    const drifted = rows();
    drifted[2] = { ...drifted[2]!, checksum: 'ef'.repeat(32) };
    expectNull(await buildInstallFallback(input({ promotedRows: drifted })), 'row_checksum_mismatch');
  });

  it("macos/arm64 row checksum is compared against the raw breeze-agent-darwin-arm64 entry, not the pkg", async () => {
    const pkgHash = rows();
    pkgHash[4] = { ...pkgHash[4]!, checksum: SHA['breeze-agent-darwin-arm64.pkg']! };
    expectNull(await buildInstallFallback(input({ promotedRows: pkgHash })), 'row_checksum_mismatch');
  });

  it('a row whose raw agent asset is absent from the manifest → row_checksum_mismatch', async () => {
    expectNull(
      await buildInstallFallback(withManifest((m) => {
        m.assets = m.assets.filter((e) => e.name !== 'breeze-agent-darwin-amd64');
      })),
      'row_checksum_mismatch',
    );
  });

  it('github source repo ≠ manifest.repository → repository_mismatch', async () => {
    expectNull(
      await buildInstallFallback(input({ source: { kind: 'github', repository: 'example-owner/other-repo' } })),
      'repository_mismatch',
    );
  });

  it.each(INSTALL_FALLBACK_ASSETS)('consumed asset %s missing → asset_missing', async (name) => {
    expectNull(
      await buildInstallFallback(withManifest((m) => { m.assets = m.assets.filter((e) => e.name !== name); })),
      'asset_missing',
    );
  });

  it('duplicate entry → asset_duplicate', async () => {
    expectNull(
      await buildInstallFallback(withManifest((m) => { m.assets.push({ ...asset(m, 'breeze-backup-linux-amd64') }); })),
      'asset_duplicate',
    );
  });

  it('self-host deployment + a hosted asset → edition_mismatch', async () => {
    expectNull(
      await buildInstallFallback(withManifest((m) => { asset(m, 'breeze-agent-linux-amd64').edition = 'hosted'; })),
      'edition_mismatch',
    );
  });

  it('self-host deployment + an asset with no edition → edition_mismatch', async () => {
    expectNull(
      await buildInstallFallback(withManifest((m) => { delete asset(m, 'install.sh').edition; })),
      'edition_mismatch',
    );
  });

  it('hosted deployment + a self-host asset → edition_mismatch', async () => {
    expectNull(await buildInstallFallback(input({ edition: 'hosted' })), 'edition_mismatch');
  });

  it('windows exe with platformTrust none on a hosted edition → platform_trust', async () => {
    expectNull(
      await buildInstallFallback(withManifest((m) => {
        const exe = asset(m, 'breeze-agent-windows-amd64.exe');
        exe.edition = 'hosted';
        exe.platformTrust = 'none';
      })),
      'platform_trust',
    );
  });

  it('a pkg without the macOS platform-trust label → platform_trust', async () => {
    expectNull(
      await buildInstallFallback(withManifest((m) => { asset(m, 'breeze-agent-darwin-amd64.pkg').platformTrust = 'release-workflow-produced'; })),
      'platform_trust',
    );
  });

  it('asset with intendedUse signing-input → signing_input', async () => {
    expectNull(
      await buildInstallFallback(withManifest((m) => { asset(m, 'breeze-agent-linux-arm64').intendedUse = 'signing-input'; })),
      'signing_input',
    );
  });

  it('pkg without signingTeamId → publisher_missing', async () => {
    expectNull(
      await buildInstallFallback(withManifest((m) => { delete asset(m, 'breeze-agent-darwin-arm64.pkg').signingTeamId; })),
      'publisher_missing',
    );
  });

  it('pkg without any publisher fields → publisher_missing', async () => {
    expectNull(
      await buildInstallFallback(withManifest((m) => {
        const pkg = asset(m, 'breeze-agent-darwin-amd64.pkg');
        delete pkg.signingTeamId;
        delete pkg.signingIdentity;
      })),
      'publisher_missing',
    );
  });

  it('pkg identity that does not name its team → publisher_missing', async () => {
    expectNull(
      await buildInstallFallback(withManifest((m) => { asset(m, 'breeze-agent-darwin-amd64.pkg').signingIdentity = 'Developer ID Installer: Example Corp (ZZZZZ99999)'; })),
      'publisher_missing',
    );
  });

  it('the two pkgs name different publishers → publisher_missing (the anchor carries one)', async () => {
    const otherTeam = 'QWERT67890';
    expectNull(
      await buildInstallFallback(withManifest((m) => {
        const pkg = asset(m, 'breeze-agent-darwin-arm64.pkg');
        pkg.signingTeamId = otherTeam;
        pkg.signingIdentity = `Developer ID Installer: Example Corp (${otherTeam})`;
      })),
      'publisher_missing',
    );
  });

  it('an asset with a malformed sha256 → schema', async () => {
    expectNull(
      await buildInstallFallback(withManifest((m) => { asset(m, 'breeze-backup-linux-arm64').sha256 = 'AB'.repeat(32); })),
      'schema',
    );
  });

  it.each([
    ['github', { kind: 'github', repository: REPO }],
    ['mirror', { kind: 'mirror', base: 'https://mirror.example/breeze/' }],
  ] as const)('hosted edition, %s source → hosted_not_enabled', async (_label, source) => {
    const result = await buildInstallFallback(input({ edition: 'hosted', source, manifest: signed(baseManifest('hosted')) }));
    expectNull(result, 'hosted_not_enabled');
  });

  it('token already expired → expired', async () => {
    expectNull(await buildInstallFallback(input({ tokenExpiresAt: new Date('2026-10-22T11:59:59Z') })), 'expired');
  });

  it('token expiring within the current second → expired (truncation never extends past now)', async () => {
    expectNull(await buildInstallFallback(input({ tokenExpiresAt: new Date('2026-10-22T12:00:00.900Z') })), 'expired');
  });

  it('an invalid token expiry → expired', async () => {
    expectNull(await buildInstallFallback(input({ tokenExpiresAt: new Date(Number.NaN) })), 'expired');
  });

  it('a release tag outside the wire grammar → schema (never an unvalidated anchor)', async () => {
    // Rows carry the same odd tag so every earlier check passes and only the
    // final parseInstallFallback gate can refuse it.
    const odd = await buildInstallFallback(
      withManifest((m) => { m.release = 'v0.124.0+build'; }, { promotedRows: rows('0.124.0+build') }),
    );
    expectNull(odd, 'schema');
  });
});

describe('computeInstallFallbackValidUntil', () => {
  const mint = new Date('2026-10-22T12:00:00Z');

  it('a token expiring in 365 d gives mint + 30 d', async () => {
    expect(computeInstallFallbackValidUntil(new Date('2027-10-22T12:00:00Z'), mint)).toBe('2026-11-21T12:00:00Z');
  });

  it('a token expiring in 2 h gives the token expiry', async () => {
    expect(computeInstallFallbackValidUntil(new Date('2026-10-22T14:00:00Z'), mint)).toBe('2026-10-22T14:00:00Z');
  });

  it('fractional seconds are truncated, never rounded up', async () => {
    expect(computeInstallFallbackValidUntil(new Date('2026-10-22T14:00:00.999Z'), mint)).toBe('2026-10-22T14:00:00Z');
    expect(computeInstallFallbackValidUntil(new Date('2027-01-01T00:00:00Z'), new Date('2026-10-22T12:00:00.999Z'))).toBe(
      '2026-11-21T12:00:00Z',
    );
  });

  it('the output is a whole-second …Z string', async () => {
    expect(computeInstallFallbackValidUntil(new Date('2026-10-23T01:02:03.456Z'), mint)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
  });
});

describe('readVerifiedManifestDistribution', () => {
  it('absent → null', async () => {
    const { bytes, signature } = signed(baseManifest());
    expect(readVerifiedManifestDistribution(bytes, signature)).toBeNull();
  });

  it('valid → object', async () => {
    const m = baseManifest('hosted');
    m.distribution = { repository: 'example-owner/example-dist', release: 'v0.124.0' };
    const { bytes, signature } = signed(m);
    expect(readVerifiedManifestDistribution(bytes, signature)).toEqual({
      repository: 'example-owner/example-dist',
      release: 'v0.124.0',
    });
  });

  it.each([
    ['repository "../x"', { repository: '../x', release: 'v0.124.0' }],
    ['repository "owner/.."', { repository: 'owner/..', release: 'v0.124.0' }],
    ['repository with a scheme', { repository: 'https://github.com/o/r', release: 'v0.124.0' }],
    ['release without v', { repository: 'example-owner/example-dist', release: '0.124.0' }],
    ['release missing', { repository: 'example-owner/example-dist' }],
    ['a string', 'example-owner/example-dist'],
    ['an array', ['example-owner/example-dist', 'v0.124.0']],
    ['null', null],
  ])('malformed (%s) → null', async (_label, distribution) => {
    const m = baseManifest('hosted');
    m.distribution = distribution;
    const { bytes, signature } = signed(m);
    expect(readVerifiedManifestDistribution(bytes, signature)).toBeNull();
  });

  it('bad signature → null', async () => {
    const m = baseManifest('hosted');
    m.distribution = { repository: 'example-owner/example-dist', release: 'v0.124.0' };
    const { bytes, signature } = signed(m, OTHER_KEY);
    expect(readVerifiedManifestDistribution(bytes, signature)).toBeNull();
  });
});

describe('readVerifiedManifestInstallFallbackInterface', () => {
  it('reads the signed integer', async () => {
    const { bytes, signature } = signed(baseManifest());
    expect(readVerifiedManifestInstallFallbackInterface(bytes, signature)).toBe(1);
  });

  it.each([
    ['absent', undefined],
    ['a string', '1'],
    ['a fraction', 1.5],
    ['null', null],
  ])('%s → null', async (_label, value) => {
    const m = baseManifest();
    if (value === undefined) delete m.installFallbackInterface;
    else m.installFallbackInterface = value;
    const { bytes, signature } = signed(m);
    expect(readVerifiedManifestInstallFallbackInterface(bytes, signature)).toBeNull();
  });

  it('bad signature → null (nothing is read from an unverified manifest)', async () => {
    const { bytes, signature } = signed(baseManifest(), OTHER_KEY);
    expect(readVerifiedManifestInstallFallbackInterface(bytes, signature)).toBeNull();
  });
});
