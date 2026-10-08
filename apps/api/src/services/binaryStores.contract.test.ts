import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// #7515 contract: in BINARY_SOURCE=local mode every S3 key a download path
// READS must be a key that syncBinaries() WRITES on boot. Before this test the
// sync wrote the whole agent binaries dir under `agent/` while the backup,
// watchdog, user-helper and recovery-iso routes read `backup/`, `watchdog/`,
// `user-helper/` and `recovery-iso/` — prefixes nothing ever wrote. Every
// download of those components missed S3 and streamed through the API process
// from disk, and hand-copied objects under those prefixes went stale on the
// next deploy (served old bytes under the new checksum — the #7516 loop).
//
// The S3 mock below is a fake bucket: syncDirectory() records exactly the keys
// the real one would upload (`<prefix>/<file>` for each file in the dir), and
// every reader (presign / getObjectStream) misses unless its key is in that
// set. A route that reads a key sync never wrote therefore falls back to disk
// and the assertions below fail.

const bucket = vi.hoisted(() => ({
  objects: new Map<string, string>(), // key -> local source path
  reads: [] as string[],
  syncCalls: [] as Array<{ dir: string; prefix: string }>,
}));

vi.mock('./s3Storage', () => {
  const notFound = () => Object.assign(new Error('NotFound'), { name: 'NotFound' });
  return {
    isS3Configured: () => true,
    isS3NotFound: (err: unknown) => (err as { name?: string })?.name === 'NotFound',
    syncDirectory: async (dir: string, prefix: string) => {
      bucket.syncCalls.push({ dir, prefix });
      let uploaded = 0;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        bucket.objects.set(`${prefix}/${entry.name}`, join(dir, entry.name));
        uploaded++;
      }
      return { uploaded, skipped: 0, errors: [], failedKeys: [] };
    },
    getPresignedUrl: async (key: string) => {
      bucket.reads.push(key);
      if (!bucket.objects.has(key)) throw notFound();
      return `https://bucket.test/${key}`;
    },
    getObjectStream: async (key: string) => {
      bucket.reads.push(key);
      const source = bucket.objects.get(key);
      if (!source) return { body: null, contentLength: null };
      const bytes = readFileSync(source);
      return { body: Readable.from(bytes), contentLength: bytes.length };
    },
  };
});

// syncBinaries() runs the server-only boot path below, which only reads
// agent_versions (best-effort, never throws) before syncing to S3.
vi.mock('../db', () => ({
  db: {
    select: () => {
      throw new Error('no database in this test');
    },
  },
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
  assertOutsideHeldDbContext: () => {},
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./manifestSigning', () => ({
  ensureActiveSigningKey: vi.fn(),
  signManifest: vi.fn(),
}));

// Route plumbing unrelated to key selection.
vi.mock('./index', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('./rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, remaining: 99, resetAt: new Date() })),
}));
vi.mock('./promotedAgentVersion', () => ({
  getPromotedComponentVersion: vi.fn(async () => null),
  getRegisteredComponentVersion: vi.fn(async () => null),
}));

// The Helper/.pkg verified fetch checks a signed manifest before it reads any
// bytes; stub the signature layer so the test exercises only key selection.
vi.mock('./releaseArtifactManifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./releaseArtifactManifest')>();
  return {
    ...actual,
    verifyReleaseArtifactManifestAsset: vi.fn(async ({ assetName }: { assetName: string }) => ({
      name: assetName,
      size: FILE_BYTES.length,
    })),
    verifyReleaseArtifactBuffer: vi.fn(async ({ assetName }: { assetName: string }) => ({
      name: assetName,
      sha256: 'x',
      release: 'v0.119.0',
    })),
  };
});

const FILE_BYTES = Buffer.from('staged binary bytes');

import { syncBinaries } from './binarySync';
import { downloadRoutes } from '../routes/agents/download';
import { viewerDownloadRoutes } from '../routes/viewers/download';
import {
  __resetVerifiedHelperInstallerCache,
  __resetVerifiedMacosPkgCache,
  fetchVerifiedHelperInstaller,
  fetchVerifiedMacosPkg,
} from './installerBuilder';
import { HELPER_FILENAMES, VIEWER_FILENAMES } from './binarySource';

// Every S3-offloaded download in local mode, with the file it reads and how
// the object reaches the caller: a presigned 302, or streamed from the API
// origin (the watchdog, #7576).
const COMPONENT_ROUTES = [
  { component: 'agent', path: '/download/linux/amd64', file: 'breeze-agent-linux-amd64', delivery: 'redirect' },
  { component: 'agent (windows)', path: '/download/windows/amd64', file: 'breeze-agent-windows-amd64.exe', delivery: 'redirect' },
  { component: 'watchdog', path: '/download/watchdog/linux/amd64', file: 'breeze-watchdog-linux-amd64', delivery: 'stream' },
  { component: 'backup', path: '/download/backup/linux/amd64', file: 'breeze-backup-linux-amd64', delivery: 'redirect' },
  { component: 'user-helper', path: '/download/user-helper/windows/amd64', file: 'breeze-user-helper-windows-amd64.exe', delivery: 'redirect' },
  { component: 'recovery-iso', path: '/download/recovery-iso/linux/amd64', file: 'breeze-recovery-linux-amd64.iso', delivery: 'redirect' },
] as const;

const ENV_KEYS = [
  'BINARY_SOURCE',
  'BREEZE_BINARIES_VERSION',
  'BINARY_VERSION_FILE',
  'AGENT_BINARY_DIR',
  'VIEWER_BINARY_DIR',
  'HELPER_BINARY_DIR',
] as const;

function stageVolume(root: string, { sharedHelperDir }: { sharedHelperDir: boolean }) {
  const agentDir = join(root, 'agent');
  const viewerDir = join(root, 'viewer');
  const helperDir = sharedHelperDir ? agentDir : join(root, 'helper');
  for (const dir of [agentDir, viewerDir, helperDir]) mkdirSync(dir, { recursive: true });

  for (const { file } of COMPONENT_ROUTES) writeFileSync(join(agentDir, file), FILE_BYTES);
  writeFileSync(join(agentDir, 'breeze-agent-darwin-arm64.pkg'), FILE_BYTES);
  for (const file of Object.values(VIEWER_FILENAMES)) writeFileSync(join(viewerDir, file), FILE_BYTES);
  for (const file of Object.values(HELPER_FILENAMES)) writeFileSync(join(helperDir, file), FILE_BYTES);
  // Signed manifest pairs (contents are stubbed out by the mock above).
  for (const dir of [root, helperDir]) {
    writeFileSync(join(dir, 'release-artifact-manifest.json'), '{}');
    writeFileSync(join(dir, 'release-artifact-manifest.json.ed25519'), 'sig');
  }
  writeFileSync(join(root, 'VERSION'), '0.119.0');

  process.env.BINARY_SOURCE = 'local';
  process.env.BREEZE_BINARIES_VERSION = '0.119.0';
  process.env.BINARY_VERSION_FILE = join(root, 'VERSION');
  process.env.AGENT_BINARY_DIR = agentDir;
  process.env.VIEWER_BINARY_DIR = viewerDir;
  process.env.HELPER_BINARY_DIR = helperDir;
  return { agentDir, viewerDir, helperDir };
}

describe.each([
  { layout: 'compose layout (separate helper dir)', sharedHelperDir: false },
  { layout: 'HELPER_BINARY_DIR sharing the agent dir', sharedHelperDir: true },
])('local-mode S3 keys: sync writes what downloads read — $layout', ({ sharedHelperDir }) => {
  const savedEnv: Record<string, string | undefined> = {};
  let root: string;

  beforeAll(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    root = mkdtempSync(join(tmpdir(), 'breeze-7515-'));
    stageVolume(root, { sharedHelperDir });
    bucket.objects.clear();
    bucket.syncCalls.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await syncBinaries();
    expect(bucket.objects.size).toBeGreaterThan(0);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    bucket.reads.length = 0;
    __resetVerifiedHelperInstallerCache();
    __resetVerifiedMacosPkgCache();
  });

  afterEach(() => {
    // Every key any reader asked for must be one sync wrote.
    const unsynced = bucket.reads.filter((key) => !bucket.objects.has(key));
    expect(unsynced, 'S3 keys read by a download path that syncBinaries() never writes').toEqual([]);
  });

  it.each(COMPONENT_ROUTES)('$component download serves the object sync uploaded ($delivery)', async ({ path, file, delivery }) => {
    const res = await downloadRoutes.request(path);
    if (delivery === 'stream') {
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      expect(Buffer.from(await res.arrayBuffer()).equals(FILE_BYTES)).toBe(true);
      expect(bucket.reads).toHaveLength(1);
      expect(bucket.reads[0]!.endsWith(`/${file}`)).toBe(true);
      return;
    }
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith('https://bucket.test/')).toBe(true);
    expect(location.endsWith(`/${file}`)).toBe(true);
  });

  it.each(Object.keys(VIEWER_FILENAMES))('viewer (%s) download redirects to the object sync uploaded', async (platform) => {
    const res = await viewerDownloadRoutes.request(`/download/${platform}`);
    expect(res.status).toBe(302);
    expect(bucket.reads).toHaveLength(1);
    expect(res.headers.get('location')).toBe(`https://bucket.test/${bucket.reads[0]}`);
    expect(bucket.reads[0]!.endsWith(`/${VIEWER_FILENAMES[platform]}`)).toBe(true);
  });

  it('Helper installer verified fetch reads the object sync uploaded', async () => {
    await fetchVerifiedHelperInstaller('linux');
    expect(bucket.reads).toHaveLength(1);
  });

  it('macOS .pkg verified fetch reads the object sync uploaded', async () => {
    await fetchVerifiedMacosPkg('arm64');
    expect(bucket.reads).toHaveLength(1);
  });

  it('syncs each binaries directory exactly once', () => {
    const dirs = bucket.syncCalls.map((call) => call.dir);
    expect(new Set(dirs).size).toBe(dirs.length);
    const prefixes = bucket.syncCalls.map((call) => call.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    // agent + viewer + helper, or agent + viewer when the helper shares the agent dir.
    expect(dirs).toHaveLength(sharedHelperDir ? 2 : 3);
  });
});

// Static guard: a staged binary's S3 key must come from binaryS3Key(), never a
// hand-written template — that is how #7515's per-component prefixes drifted
// from the sync. (Keys read from a DB row — uploaded software, blobs — are
// variables, not templates, so they are unaffected.)
describe('no hand-built S3 keys for staged binaries', () => {
  it('no source file passes a template-literal key to an S3 reader', () => {
    const srcRoot = join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        readFileSync(full, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (/(getPresignedUrl|getObjectStream)\(\s*`|\bs3Key:\s*`/.test(line)) {
              offenders.push(`${full.slice(srcRoot.length + 1)}:${i + 1}`);
            }
          });
      }
    };
    walk(srcRoot);
    expect(offenders, 'use binaryS3Key(store, filename) from services/binaryStores.ts').toEqual([]);
  });
});
