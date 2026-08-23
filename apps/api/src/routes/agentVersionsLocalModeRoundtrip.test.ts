import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

// This suite exercises the REAL local-mode registration path
// (binarySync.syncBinaries -> registerFromOfficialManifest) and feeds its
// exact output into the REAL validateReleaseManifest (agentVersions.ts) — a
// true end-to-end roundtrip of what production sees under
// BINARY_SOURCE=local, rather than a hand-constructed fixture that only
// tests my understanding of the two modules' contract.
//
// Bug (#3836): BINARY_SOURCE=local stores a server-relative downloadUrl
// (".../api/v1/agents/download/{os}/{arch}" — see
// buildServerRelativeAgentDownloadUrl / registerFromOfficialManifest in
// binarySync.ts) whose last path segment is the ARCH, not an asset name.
// validateReleaseManifest's schema-v1 branch used to derive the manifest
// asset name from that URL basename (assetNameFromDownloadUrl), so it looked
// up "amd64" in the manifest's asset list instead of
// "breeze-agent-windows-amd64.exe", threw, and the catch collapsed that into
// `invalid_release_manifest_signature` — a fleet-wide 409 on every agent
// heartbeat for a perfectly valid, correctly-signed row.

const dbMocks = vi.hoisted(() => {
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const txUpdate = vi.fn(() => ({ set: updateSet }));
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn(() => ({ onConflictDoUpdate }));
  const txInsert = vi.fn(() => ({ values: insertValues }));
  const tx = { update: txUpdate, insert: txInsert };
  const select = vi.fn();
  return {
    insertValues,
    select,
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn(tx)),
  };
});

vi.mock("../db", () => ({
  db: { transaction: dbMocks.transaction, select: dbMocks.select },
}));

// agentVersions.ts imports these middlewares/services at module scope; stub
// them out (same shape as agentVersions.test.ts) so this file doesn't need
// to drag in real auth/audit machinery just to reach the pure
// validateReleaseManifest export.
vi.mock("../middleware/auth", () => ({
  authMiddleware: vi.fn(async (_c: unknown, next: () => unknown) => next()),
  requireScope: () => vi.fn(async (_c: unknown, next: () => unknown) => next()),
  requirePermission: () => vi.fn(async (_c: unknown, next: () => unknown) => next()),
  requireMfa: () => vi.fn(async (_c: unknown, next: () => unknown) => next()),
}));
vi.mock("../middleware/platformAdmin", () => ({
  platformAdminMiddleware: vi.fn(async (_c: unknown, next: () => unknown) => next()),
}));
vi.mock("../services/auditEvents", () => ({
  writeRouteAudit: vi.fn(),
}));
vi.mock("../services/manifestSigning", () => ({
  getActivePublicKeys: vi.fn().mockResolvedValue([]),
  ensureActiveSigningKey: vi
    .fn()
    .mockResolvedValue({ keyId: "test-key", publicKeyB64: "" }),
  signManifest: vi.fn().mockResolvedValue("test-signature"),
}));
vi.mock("../services/s3Storage", () => ({
  isS3Configured: () => false,
  syncDirectory: vi.fn(),
}));

const fsMocks = vi.hoisted(() => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("node:fs/promises", () => fsMocks);
vi.mock("node:fs", () => ({
  createReadStream: () => {
    const { Readable } = require("node:stream");
    return Readable.from(Buffer.from("local agent bytes"));
  },
}));

import { syncBinaries } from "../services/binarySync";
import { validateReleaseManifest } from "./agentVersions";
import { requiredPlatformTrustFor } from "../services/releaseAssetTrust";

function localAssetChecksum(): string {
  return createHash("sha256").update("local agent bytes").digest("hex");
}

function makeOfficialLocalManifest(assetName: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPublicKey = publicDer.subarray(publicDer.length - 32).toString("base64");
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      repository: "LanternOps/breeze",
      release: "v1.2.3",
      assets: [
        {
          name: assetName,
          sha256: localAssetChecksum(),
          size: 18, // Buffer.byteLength("local agent bytes")
          platformTrust: requiredPlatformTrustFor(assetName) ?? "release-workflow-produced",
          edition: "self-host",
        },
      ],
    }),
  );
  const signature = Buffer.from(sign(null, manifest, privateKey).toString("base64"));
  return { manifest, signature, publicKey: rawPublicKey };
}

function mockReadFileWithOfficialManifest(
  versionFileContent: string,
  manifest: Buffer,
  signature: Buffer,
) {
  fsMocks.readFile.mockImplementation((path: unknown) => {
    if (typeof path === "string" && path.endsWith("release-artifact-manifest.json.ed25519")) {
      return Promise.resolve(signature);
    }
    if (typeof path === "string" && path.endsWith("release-artifact-manifest.json")) {
      return Promise.resolve(manifest);
    }
    return Promise.resolve(versionFileContent);
  });
}

describe("D1 — local-mode registration roundtrip survives validateReleaseManifest (#3836)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.BINARY_SOURCE = "local";
    process.env.AGENT_BINARY_DIR = "/data/binaries/agent";
    process.env.BINARY_VERSION_FILE = "/fake/version";
    delete process.env.BREEZE_VERSION;
    delete process.env.PUBLIC_API_URL;
    delete process.env.PUBLIC_APP_URL;
    delete process.env.BREEZE_SERVER;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("windows agent binary registered via registerFromOfficialManifest validates ok:true", async () => {
    const assetName = "breeze-agent-windows-amd64.exe";
    const official = makeOfficialLocalManifest(assetName);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = official.publicKey;
    fsMocks.readdir.mockResolvedValue([assetName] as never);
    fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 18 } as never);
    mockReadFileWithOfficialManifest("1.2.3", official.manifest, official.signature);

    await syncBinaries();

    // Sanity: the row actually registered from the OFFICIAL manifest path
    // (registerFromOfficialManifest), not the per-deployment re-sign
    // fallback — otherwise this wouldn't be exercising the local-mode
    // server-relative-downloadUrl shape the bug is about.
    expect(dbMocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ signingKeyId: "release-artifact-manifest-ed25519" }),
    );
    const row = dbMocks.insertValues.mock.calls[0]![0] as {
      version: string;
      component: string;
      platform: string;
      architecture: string;
      downloadUrl: string;
      checksum: string;
      fileSize: bigint;
      releaseManifest: string;
      manifestSignature: string;
    };

    // Confirms this row really does carry the server-relative shape the
    // production bug depends on — the last path segment is the ARCH, not an
    // asset name.
    expect(row.downloadUrl).toMatch(/\/api\/v1\/agents\/download\/windows\/amd64$/);

    const result = await validateReleaseManifest({
      manifest: row.releaseManifest,
      signature: row.manifestSignature,
      version: row.version,
      platform: row.platform,
      arch: row.architecture,
      component: row.component,
      downloadUrl: row.downloadUrl,
      checksum: row.checksum,
      fileSize: row.fileSize,
    });

    expect(result).toEqual({ ok: true });
  });
});
