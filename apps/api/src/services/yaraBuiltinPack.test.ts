import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildYaraBundleJson, YARA_BUILTIN_RULE_SET_ID } from '@breeze/shared';

const precheckMock = vi.fn();
const versionMock = vi.fn();
vi.mock('./yaraPrecheck', async (importOriginal) => ({
  yaraLintOnlyAllowed: (await importOriginal<typeof import('./yaraPrecheck')>()).yaraLintOnlyAllowed,
  precheckYaraBundle: (json: string, opts: unknown) => precheckMock(json, opts),
  yaracVersion: () => versionMock(),
}));

const readRowMock = vi.fn();
const applyMock = vi.fn();
const setEnabledMock = vi.fn();
vi.mock('./yaraBuiltinPackStore', () => ({
  readBuiltinPackRow: () => readRowMock(),
  setBuiltinPackEnabled: (enabled: boolean) => setEnabledMock(enabled),
  applyBuiltinPack: (w: unknown, decide: unknown) => applyMock(w, decide),
}));

const githubFetchMock = vi.fn();
vi.mock('./releaseArtifactManifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./releaseArtifactManifest')>()),
  fetchVerifiedGithubReleaseArtifact: (args: unknown) => githubFetchMock(args),
}));

import {
  BUILTIN_PACK_PRECHECK_TIMEOUT_MS,
  BuiltinPackRejectedError,
  decideBuiltinPackAction,
  loadVerifiedBuiltinPack,
  parseBuiltinPack,
  syncBuiltinYaraPack,
} from './yaraBuiltinPack';
import { ReleaseManifestAssetAbsentError } from './releaseArtifactManifest';

const ASSET = 'breeze-yara-builtin.json';
const R1 = { id: '11111111-1111-5111-8111-111111111111', name: 'rule_one', severity: 'high' as const, source: 'rule rule_one { condition: true }' };
const R2 = { id: '22222222-2222-5222-8222-222222222222', name: 'rule_two', severity: 'critical' as const, source: 'rule rule_two { strings: $a = "<x> & \\"y\\"" condition: $a }' };

function packJson(version = 3, rules = [R1, R2], autoQuarantine = true, ruleSetId = YARA_BUILTIN_RULE_SET_ID): string {
  return buildYaraBundleJson({ ruleSetId, version, autoQuarantine, rules });
}
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// ---- signed-manifest fixture (real Ed25519, local binaries volume) ---------

let tmp: string;
let privateKey: KeyObject;
const savedEnv = { ...process.env };

function stage(bytes: Buffer, opts: { manifestBytes?: Buffer; entry?: Record<string, unknown>; omitAsset?: boolean } = {}) {
  const agentDir = join(tmp, 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, ASSET), bytes);
  const manifest = opts.manifestBytes ?? Buffer.from(JSON.stringify({
    schemaVersion: 1,
    repository: 'LanternOps/breeze',
    release: 'v9.9.9',
    assets: opts.omitAsset ? [] : [{
      name: ASSET, sha256: sha(bytes), size: bytes.length, platformTrust: 'release-workflow-produced', edition: 'self-host',
      ...(opts.entry ?? {}),
    }],
  }));
  writeFileSync(join(tmp, 'release-artifact-manifest.json'), manifest);
  writeFileSync(join(tmp, 'release-artifact-manifest.json.ed25519'), sign(null, manifest, privateKey).toString('base64'));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'yara-builtin-'));
  const kp = generateKeyPairSync('ed25519');
  privateKey = kp.privateKey;
  const der = kp.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = der.subarray(der.length - 32).toString('base64');
  process.env.BINARY_SOURCE = 'local';
  process.env.AGENT_BINARY_DIR = join(tmp, 'agent');
  delete process.env.HELPER_BINARY_DIR;
  delete process.env.BINARY_EDITION;
  delete process.env.BREEZE_YARA_LINT_ONLY;
  precheckMock.mockReset().mockResolvedValue({ ok: true });
  versionMock.mockReset().mockResolvedValue({ engine: 'v1.1.0', policy: 1 });
  readRowMock.mockReset().mockResolvedValue(null);
  applyMock.mockReset().mockResolvedValue({ applied: true, decision: 'apply' });
  setEnabledMock.mockReset().mockResolvedValue(false);
  delete process.env.BREEZE_YARA_BUILTIN_PACK_DISABLED;
  githubFetchMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

// ---- parseBuiltinPack ------------------------------------------------------

describe('parseBuiltinPack', () => {
  it('accepts a canonical built-in bundle', () => {
    const json = packJson(5);
    const p = parseBuiltinPack(Buffer.from(json));
    expect(p.version).toBe(5);
    expect(p.json).toBe(json);
    expect(p.rules.map((r) => r.name)).toEqual(['rule_one', 'rule_two']);
  });

  it('accepts the Go pack builder golden fixture byte for byte (cross-language canonical parity)', () => {
    const golden = readFileSync(resolve(__dirname, '../../../../scripts/security/yara-pack/testdata/expected-bundle.json'));
    const p = parseBuiltinPack(golden);
    expect(Buffer.from(p.json, 'utf8').equals(golden)).toBe(true);
    expect(p.rules.length).toBeGreaterThan(5);
  });

  const reject = (label: string, bytes: Buffer | string, reason: RegExp) =>
    it(`rejects ${label}`, () => {
      expect(() => parseBuiltinPack(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))).toThrow(BuiltinPackRejectedError);
      expect(() => parseBuiltinPack(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))).toThrow(reason);
    });

  reject('non-canonical whitespace', JSON.stringify(JSON.parse(packJson()), null, 1), /canonical/);
  reject('rules out of id order', packJson().replace(/^/, '').replace(JSON.stringify(R1), '§').replace(JSON.stringify(R2), JSON.stringify(R1)).replace('§', JSON.stringify(R2)), /canonical/);
  reject('an extra key', packJson().replace('"rules":', '"extra":1,"rules":'), /canonical/);
  reject('another rule set id', packJson(3, [R1], true, '00000000-0000-4000-8000-000000000001'), /ruleSetId/);
  reject('autoQuarantine false (D7: the built-in pack quarantines)', packJson(3, [R1], false), /autoQuarantine/);
  reject('version 0', packJson(1).replace('"version":1', '"version":0'), /version/);
  reject('a fractional version', packJson(1).replace('"version":1', '"version":1.5'), /version/);
  reject('a version beyond int4', packJson(1).replace('"version":1', '"version":2147483648'), /version/);
  reject('zero rules', packJson(3, []), /rules/);
  reject('a duplicate rule name', packJson(3, [R1, { ...R2, name: 'rule_one' }]), /duplicate/);
  reject('a bad severity', packJson().replace('"critical"', '"extreme"'), /severity/);
  reject('a malformed rule name', packJson(3, [{ ...R1, name: 'bad-name' }]), /name/);
  reject('invalid UTF-8', Buffer.concat([Buffer.from(packJson().slice(0, -3)), Buffer.from([0xff]), Buffer.from(']}')]), /UTF-8/);
  reject('a byte-order mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(packJson())]), /canonical|JSON/);
  reject('not JSON', 'nope', /JSON/);
});

// ---- decideBuiltinPackAction -----------------------------------------------

describe('decideBuiltinPackAction', () => {
  const row = (publishedVersion: number, publishedSha256: string | null = 'a'.repeat(64), isBuiltin = true) =>
    ({ isBuiltin, enabled: true, publishedVersion, publishedSha256, currentVersion: publishedVersion });
  it.each([
    ['no row yet', null, 3, 'apply'],
    ['never published', row(0, null), 3, 'apply'],
    ['newer pack', row(2), 3, 'apply'],
    ['same version, same bytes', row(3), 3, 'current'],
    ['same version, different bytes', row(3, 'b'.repeat(64)), 3, 'same_version_conflict'],
    ['older pack (rollback must never clobber)', row(4), 3, 'older'],
    ['the id is held by a non-built-in row', row(1, 'a'.repeat(64), false), 3, 'not_builtin'],
  ] as const)('%s -> %s', (_label, current, version, want) => {
    expect(decideBuiltinPackAction(current, { version, sha256: 'a'.repeat(64) })).toBe(want);
  });
});

// ---- loadVerifiedBuiltinPack -----------------------------------------------

describe('loadVerifiedBuiltinPack (BINARY_SOURCE=local)', () => {
  it('returns the staged bytes when they verify against the signed manifest', async () => {
    const bytes = Buffer.from(packJson());
    stage(bytes);
    const got = await loadVerifiedBuiltinPack();
    expect(got?.bytes.equals(bytes)).toBe(true);
    expect(got?.sha256).toBe(sha(bytes));
    expect(got?.release).toBe('v9.9.9');
  });

  it('a tampered pack (bytes differ from the signed sha256) is refused', async () => {
    const bytes = Buffer.from(packJson());
    stage(bytes);
    writeFileSync(join(tmp, 'agent', ASSET), Buffer.from(packJson().replace('rule_one {', 'rule_one  {')));
    await expect(loadVerifiedBuiltinPack()).rejects.toThrow(/does not verify/);
  });

  it('a manifest signed by an untrusted key is refused', async () => {
    const bytes = Buffer.from(packJson());
    stage(bytes);
    const other = generateKeyPairSync('ed25519');
    const der = other.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = der.subarray(der.length - 32).toString('base64');
    await expect(loadVerifiedBuiltinPack()).rejects.toThrow(/does not verify/);
  });

  it('a hosted-edition manifest entry is refused (the pack is public-release content)', async () => {
    const bytes = Buffer.from(packJson());
    stage(bytes, { entry: { edition: 'hosted' } });
    await expect(loadVerifiedBuiltinPack()).rejects.toThrow(/does not verify/);
  });

  it('a staged pack with no signed manifest pair is refused, never trusted bare', async () => {
    const agentDir = join(tmp, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, ASSET), packJson());
    await expect(loadVerifiedBuiltinPack()).rejects.toThrow(/no signed manifest/);
  });

  it('not staged on a hosted deployment: null, and no public GitHub fetch', async () => {
    process.env.BINARY_EDITION = 'hosted';
    await expect(loadVerifiedBuiltinPack()).resolves.toBeNull();
    expect(githubFetchMock).not.toHaveBeenCalled();
  });

  it('not staged on hosted in production is an error, not a warning', async () => {
    process.env.BINARY_EDITION = 'hosted';
    process.env.NODE_ENV = 'production';
    await expect(loadVerifiedBuiltinPack()).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('NOT loaded'));
  });

  it('hosted + local with no pack: logs an ERROR (any NODE_ENV) naming the expected absolute paths and the selecting env (#9166)', async () => {
    process.env.BINARY_EDITION = 'hosted';
    process.env.NODE_ENV = 'test';
    await expect(syncBuiltinYaraPack()).resolves.toBe('skipped');
    const agentDir = resolve(tmp, 'agent');
    const msg = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain(join(agentDir, ASSET));
    expect(msg).toContain(join(agentDir, 'release-artifact-manifest.json'));
    expect(msg).toContain(join(agentDir, 'release-artifact-manifest.json.ed25519'));
    expect(msg).toContain('BINARY_SOURCE=local');
    expect(msg).toContain('BINARY_EDITION=hosted');
    expect(githubFetchMock).not.toHaveBeenCalled();
  });

  it('self-host fallback to GitHub logs no error', async () => {
    const bytes = Buffer.from(packJson());
    githubFetchMock.mockResolvedValue({ buffer: bytes, verified: { sha256: sha(bytes), release: 'v1.2.3', edition: 'self-host' } });
    await loadVerifiedBuiltinPack();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('not staged on self-host local mode: falls back to the signed GitHub release', async () => {
    const bytes = Buffer.from(packJson());
    githubFetchMock.mockResolvedValue({ buffer: bytes, verified: { sha256: sha(bytes), release: 'v1.2.3', edition: 'self-host' } });
    const got = await loadVerifiedBuiltinPack();
    expect(got?.bytes.equals(bytes)).toBe(true);
    expect(githubFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('loadVerifiedBuiltinPack (BINARY_SOURCE=github)', () => {
  beforeEach(() => {
    process.env.BINARY_SOURCE = 'github';
    process.env.BREEZE_VERSION = '0.124.0';
    delete process.env.BINARY_VERSION;
  });

  it('fetches the asset of the server\'s own release, pinned to the signed manifest, self-host edition', async () => {
    const bytes = Buffer.from(packJson());
    githubFetchMock.mockResolvedValue({ buffer: bytes, verified: { sha256: sha(bytes), release: 'v0.124.0', edition: 'self-host' } });
    await loadVerifiedBuiltinPack();
    const args = githubFetchMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.assetName).toBe(ASSET);
    expect(String(args.assetUrl)).toMatch(/\/download\/v0\.124\.0\/breeze-yara-builtin\.json$/);
    expect(String(args.manifestUrl)).toMatch(/\/download\/v0\.124\.0\/release-artifact-manifest\.json$/);
    expect(args.expectedRelease).toBe('v0.124.0');
    expect(args.expectedEdition).toBe('self-host');
    expect(args.expectedPlatformTrust).toBe('release-workflow-produced');
    expect(args.maxAssetBytes).toBe(16 * 1024 * 1024);
    expect(args.signal).toBeInstanceOf(AbortSignal);
  });

  it('a release that predates the pack (asset absent from its manifest) -> null', async () => {
    githubFetchMock.mockRejectedValue(new ReleaseManifestAssetAbsentError('Release artifact manifest does not include breeze-yara-builtin.json'));
    await expect(loadVerifiedBuiltinPack()).resolves.toBeNull();
  });

  it('no manifest trust root configured -> null without fetching (never an unverified fallback)', async () => {
    delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    await expect(loadVerifiedBuiltinPack()).resolves.toBeNull();
    expect(githubFetchMock).not.toHaveBeenCalled();
  });
});

// ---- syncBuiltinYaraPack ---------------------------------------------------

describe('syncBuiltinYaraPack', () => {
  it('first boot: pre-checks, then publishes the shipped bytes exactly as staged', async () => {
    const bytes = Buffer.from(packJson(3));
    stage(bytes);
    await expect(syncBuiltinYaraPack()).resolves.toBe('updated');
    expect(precheckMock).toHaveBeenCalledWith(bytes.toString('utf8'), { timeoutMs: BUILTIN_PACK_PRECHECK_TIMEOUT_MS });
    const w = applyMock.mock.calls[0]![0] as { bytes: Buffer; sha256: string; version: number; engine: string; policy: number; rules: unknown[] };
    expect(w.bytes.equals(bytes)).toBe(true);
    expect(w.sha256).toBe(sha(bytes));
    expect(w.version).toBe(3);
    expect(w.rules).toHaveLength(2);
    expect(w.engine).toBe('v1.1.0');
    expect(w.policy).toBe(1);
  });

  it('same version already published: unchanged, no pre-check, no write', async () => {
    const bytes = Buffer.from(packJson(3));
    stage(bytes);
    readRowMock.mockResolvedValue({ isBuiltin: true, enabled: true, publishedVersion: 3, publishedSha256: sha(bytes), currentVersion: 3 });
    await expect(syncBuiltinYaraPack()).resolves.toBe('unchanged');
    expect(precheckMock).not.toHaveBeenCalled();
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('an older pack never replaces a newer published version, and says so', async () => {
    stage(Buffer.from(packJson(2)));
    readRowMock.mockResolvedValue({ isBuiltin: true, enabled: true, publishedVersion: 5, publishedSha256: 'c'.repeat(64), currentVersion: 5 });
    await expect(syncBuiltinYaraPack()).resolves.toBe('unchanged');
    expect(applyMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('older'), expect.objectContaining({ version: 2, publishedVersion: 5 }));
  });

  it('a clean pre-check whose engine-version probe fails still publishes, with a warning', async () => {
    stage(Buffer.from(packJson(3)));
    versionMock.mockResolvedValue(null);
    await expect(syncBuiltinYaraPack()).resolves.toBe('updated');
    expect(applyMock.mock.calls[0]![0]).toMatchObject({ engine: null, policy: null });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('version probe'), expect.anything());
  });

  it('kill switch: BREEZE_YARA_BUILTIN_PACK_DISABLED=1 disables the published set and loads nothing', async () => {
    process.env.BREEZE_YARA_BUILTIN_PACK_DISABLED = '1';
    stage(Buffer.from(packJson(9)));
    setEnabledMock.mockResolvedValue(true);
    await expect(syncBuiltinYaraPack()).resolves.toBe('updated');
    expect(setEnabledMock).toHaveBeenCalledWith(false);
    expect(readRowMock).not.toHaveBeenCalled();
    expect(precheckMock).not.toHaveBeenCalled();
    expect(applyMock).not.toHaveBeenCalled();
    setEnabledMock.mockResolvedValue(false);
    await expect(syncBuiltinYaraPack()).resolves.toBe('unchanged');
  });

  it('kill switch lifted: a set it disabled is re-enabled even when the pack is unchanged', async () => {
    const bytes = Buffer.from(packJson(3));
    stage(bytes);
    readRowMock.mockResolvedValue({ isBuiltin: true, enabled: false, publishedVersion: 3, publishedSha256: sha(bytes), currentVersion: 3 });
    setEnabledMock.mockResolvedValue(true);
    await expect(syncBuiltinYaraPack()).resolves.toBe('updated');
    expect(setEnabledMock).toHaveBeenCalledWith(true);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('same version with different bytes: unchanged, loud warning, existing row kept', async () => {
    stage(Buffer.from(packJson(3)));
    readRowMock.mockResolvedValue({ isBuiltin: true, enabled: true, publishedVersion: 3, publishedSha256: 'd'.repeat(64), currentVersion: 3 });
    await expect(syncBuiltinYaraPack()).resolves.toBe('unchanged');
    expect(applyMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('same version'), expect.anything());
  });

  it('a tampered pack: skipped with an error log, nothing written', async () => {
    stage(Buffer.from(packJson(3)));
    writeFileSync(join(tmp, 'agent', ASSET), packJson(9));
    await expect(syncBuiltinYaraPack()).resolves.toBe('skipped');
    expect(applyMock).not.toHaveBeenCalled();
    expect(readRowMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('pre-check unavailable in production: refuses (skipped), nothing written', async () => {
    process.env.NODE_ENV = 'production';
    stage(Buffer.from(packJson(3)));
    precheckMock.mockResolvedValue({ ok: false, unavailable: 'ENOENT' });
    await expect(syncBuiltinYaraPack()).resolves.toBe('skipped');
    expect(applyMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('pre-check unavailable'), expect.anything());
  });

  it('pre-check unavailable even with BREEZE_YARA_LINT_ONLY=1 in production: still refuses', async () => {
    process.env.NODE_ENV = 'production';
    process.env.BREEZE_YARA_LINT_ONLY = '1';
    stage(Buffer.from(packJson(3)));
    precheckMock.mockResolvedValue({ ok: false, unavailable: 'timeout' });
    await expect(syncBuiltinYaraPack()).resolves.toBe('skipped');
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('pre-check unavailable in test with BREEZE_YARA_LINT_ONLY=1: publishes as lint-only', async () => {
    process.env.NODE_ENV = 'test';
    process.env.BREEZE_YARA_LINT_ONLY = '1';
    stage(Buffer.from(packJson(3)));
    precheckMock.mockResolvedValue({ ok: false, unavailable: 'ENOENT' });
    await expect(syncBuiltinYaraPack()).resolves.toBe('updated');
    expect(applyMock.mock.calls[0]![0]).toMatchObject({ engine: 'lint-only', policy: null });
  });

  it('the pre-check rejects rules: skipped, nothing written (the shipped pack must be fully valid)', async () => {
    stage(Buffer.from(packJson(3)));
    precheckMock.mockResolvedValue({ ok: false, errors: [{ ruleId: R1.id, name: R1.name, code: 'compile', message: 'bad' }] });
    await expect(syncBuiltinYaraPack()).resolves.toBe('skipped');
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('a non-canonical pack: skipped before any DB read', async () => {
    const bytes = Buffer.from(JSON.stringify(JSON.parse(packJson(3)), null, 2));
    stage(bytes);
    await expect(syncBuiltinYaraPack()).resolves.toBe('skipped');
    expect(readRowMock).not.toHaveBeenCalled();
  });

  it('lost a race to another replica inside the lock: unchanged', async () => {
    stage(Buffer.from(packJson(3)));
    applyMock.mockResolvedValue({ applied: false, decision: 'current' });
    await expect(syncBuiltinYaraPack()).resolves.toBe('unchanged');
  });

  it('the id is held by a non-built-in row: skipped', async () => {
    stage(Buffer.from(packJson(3)));
    readRowMock.mockResolvedValue({ isBuiltin: false, enabled: true, publishedVersion: 0, publishedSha256: null, currentVersion: 0 });
    await expect(syncBuiltinYaraPack()).resolves.toBe('skipped');
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('never throws: a DB failure becomes skipped', async () => {
    stage(Buffer.from(packJson(3)));
    applyMock.mockRejectedValue(new Error('connection reset'));
    await expect(syncBuiltinYaraPack()).resolves.toBe('skipped');
    readRowMock.mockRejectedValue(new Error('connection reset'));
    await expect(syncBuiltinYaraPack()).resolves.toBe('skipped');
  });

  it('nothing to load (release predates the pack): skipped quietly', async () => {
    process.env.BINARY_EDITION = 'hosted';
    await expect(syncBuiltinYaraPack()).resolves.toBe('skipped');
    expect(readRowMock).not.toHaveBeenCalled();
  });
});

// ---- boot wiring (source contract) -----------------------------------------

describe('index.ts boot wiring', () => {
  const src = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');
  it('calls syncBuiltinYaraPack after syncBinaries, fire-and-forget (a pack problem must never block boot)', () => {
    const call = src.indexOf('void syncBuiltinYaraPack()');
    expect(call).toBeGreaterThan(-1);
    expect(src.indexOf('await syncBinaries()')).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(src.indexOf('await syncBinaries()'));
    expect(src).not.toMatch(/await\s+syncBuiltinYaraPack\s*\(/);
  });
});
