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

import { syncFromGitHub } from "./binarySync";

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
});
