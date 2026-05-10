import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const txUpdate = vi.fn(() => ({ set: updateSet }));
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn(() => ({ onConflictDoUpdate }));
  const txInsert = vi.fn(() => ({ values: insertValues }));
  const tx = { update: txUpdate, insert: txInsert };
  return {
    updateWhere,
    updateSet,
    txUpdate,
    onConflictDoUpdate,
    insertValues,
    txInsert,
    tx,
    transaction: vi.fn(async (fn: (tx: any) => Promise<void>) => fn(tx)),
  };
});

vi.mock("../db", () => ({
  db: {
    transaction: dbMocks.transaction,
  },
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

vi.mock("./s3Storage", () => ({
  isS3Configured: () => false,
  syncDirectory: vi.fn(),
}));

const manifestSigningMocks = vi.hoisted(() => ({
  ensureActiveSigningKey: vi.fn(async () => ({
    keyId: "deploy-test-aaaaaaaa",
    publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  })),
  signManifest: vi.fn(async () => "test-signature-base64"),
}));

vi.mock("./manifestSigning", () => manifestSigningMocks);

import { syncBinaries, syncFromGitHub } from "./binarySync";

function makeSignedReleaseManifest(assetName: string, assetBuffer: Buffer) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPublicKey = publicDer
    .subarray(publicDer.length - 32)
    .toString("base64");
  const checksum = createHash("sha256").update(assetBuffer).digest("hex");
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      repository: "LanternOps/breeze",
      release: "v1.2.3",
      assets: [
        {
          name: assetName,
          sha256: checksum,
          size: assetBuffer.length,
          platformTrust: "release-workflow-produced",
        },
      ],
    }),
  );

  return {
    checksum,
    manifest,
    signature: Buffer.from(sign(null, manifest, privateKey).toString("base64")),
    publicKey: rawPublicKey,
  };
}

describe("binarySync", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("syncs GitHub agent versions from the signed release artifact manifest", async () => {
    const assetName = "breeze-agent-linux-amd64";
    const asset = Buffer.from("trusted linux agent");
    const signed = makeSignedReleaseManifest(assetName, asset);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/releases/latest")) {
          return new Response(
            JSON.stringify({
              tag_name: "v1.2.3",
              body: "release notes",
              assets: [
                {
                  name: assetName,
                  browser_download_url: `https://github.com/LanternOps/breeze/releases/download/v1.2.3/${assetName}`,
                  size: asset.length,
                },
                {
                  name: "release-artifact-manifest.json",
                  browser_download_url:
                    "https://github.com/LanternOps/breeze/releases/download/v1.2.3/release-artifact-manifest.json",
                  size: signed.manifest.length,
                },
                {
                  name: "release-artifact-manifest.json.ed25519",
                  browser_download_url:
                    "https://github.com/LanternOps/breeze/releases/download/v1.2.3/release-artifact-manifest.json.ed25519",
                  size: signed.signature.length,
                },
              ],
            }),
          );
        }
        if (url.endsWith("/release-artifact-manifest.json"))
          return new Response(signed.manifest);
        if (url.endsWith("/release-artifact-manifest.json.ed25519"))
          return new Response(signed.signature);
        return new Response("not found", { status: 404 });
      }),
    );

    const result = await syncFromGitHub();

    expect(result).toEqual({ version: "1.2.3", synced: ["agent:linux/amd64"] });
    expect(dbMocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "1.2.3",
        platform: "linux",
        architecture: "amd64",
        checksum: signed.checksum,
        releaseManifest: signed.manifest.toString("utf8"),
        manifestSignature: signed.signature.toString("utf8").trim(),
        signingKeyId: "release-artifact-manifest-ed25519",
        fileSize: BigInt(asset.length),
        isLatest: true,
        component: "agent",
      }),
    );
    expect(dbMocks.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          checksum: signed.checksum,
          releaseManifest: signed.manifest.toString("utf8"),
          manifestSignature: signed.signature.toString("utf8").trim(),
        }),
      }),
    );
  });

  it("populates releaseManifest, manifestSignature, signingKeyId in local-binary mode (closes: #625)", async () => {
    // v0.65.8 broke self-host updates by hard-rejecting null manifest fields
    // in /agent-versions/:v/download. The local-binary path now signs every
    // upserted row with the per-deployment Ed25519 key.
    process.env.BINARY_SOURCE = "local";
    process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
    process.env.BINARY_VERSION_FILE = "/fake/version";
    delete process.env.BREEZE_VERSION;

    fsMocks.readdir.mockResolvedValue(["breeze-agent-linux-amd64"] as any);
    fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 4096 } as any);
    fsMocks.readFile.mockResolvedValue("0.65.9" as any);

    await syncBinaries();

    expect(manifestSigningMocks.ensureActiveSigningKey).toHaveBeenCalled();
    expect(manifestSigningMocks.signManifest).toHaveBeenCalled();

    const insertCalls = dbMocks.insertValues.mock.calls.map(
      (call: any[]) => call[0] as Record<string, unknown>,
    );
    expect(insertCalls.length).toBeGreaterThan(0);
    for (const values of insertCalls) {
      expect(values.releaseManifest).toEqual(expect.any(String));
      expect(values.manifestSignature).toBe("test-signature-base64");
      expect(values.signingKeyId).toBe("deploy-test-aaaaaaaa");
      // Manifest must include the canonical fields validated by
      // /agent-versions/:v/download's validateReleaseManifest().
      const manifest = JSON.parse(values.releaseManifest as string);
      expect(manifest).toMatchObject({
        version: "0.65.9",
        component: "agent",
        platform: "linux",
        arch: "amd64",
      });
      expect(manifest.url).toContain("/agents/download/linux/amd64");
      expect(manifest.checksum).toEqual(expect.any(String));
    }

    const conflictSets = dbMocks.onConflictDoUpdate.mock.calls.map(
      (call: any[]) => (call[0] as { set: Record<string, unknown> }).set,
    );
    for (const set of conflictSets) {
      expect(set.releaseManifest).toEqual(expect.any(String));
      expect(set.manifestSignature).toBe("test-signature-base64");
      expect(set.signingKeyId).toBe("deploy-test-aaaaaaaa");
    }
  });

  it("upserts local agent binaries with the full 4-column conflict target (regression: #617)", async () => {
    // The agent_versions table has a UNIQUE constraint on
    // (version, platform, architecture, component). The local-binary path used
    // to omit `component`, so Postgres rejected the upsert with
    // "no unique or exclusion constraint matching the ON CONFLICT
    // specification" and the wrapping transaction rolled back, leaving
    // agent_versions empty after every API restart.
    process.env.BINARY_SOURCE = "local";
    process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
    process.env.BINARY_VERSION_FILE = "/fake/version";
    delete process.env.BREEZE_VERSION;

    fsMocks.readdir.mockResolvedValue(["breeze-agent-linux-amd64"] as any);
    fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 1234 } as any);
    fsMocks.readFile.mockResolvedValue("0.65.7" as any);

    await syncBinaries();

    const targets = dbMocks.onConflictDoUpdate.mock.calls.map(
      (call: any[]) => (call[0] as { target: unknown[] }).target,
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target).toHaveLength(4);
    }
  });
});
