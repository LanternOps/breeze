import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  verifyGithubReleaseArtifactBuffer,
  verifyReleaseArtifactManifestAsset,
  verifyReleaseArtifactBuffer,
} from "./releaseArtifactManifest";

function makeSignedManifest(args: {
  assetName: string;
  assetBuffer: Buffer;
  release?: string;
  repository?: string;
}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPublicKey = publicDer
    .subarray(publicDer.length - 32)
    .toString("base64");
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      repository: args.repository ?? "lanternops/breeze",
      release: args.release ?? "v1.2.3",
      assets: [
        {
          name: args.assetName,
          sha256: "placeholder",
          size: args.assetBuffer.length,
          platformTrust: "release-workflow-produced",
        },
      ],
    }).replace("placeholder", createSha256(args.assetBuffer)),
  );

  return {
    manifest,
    signature: Buffer.from(sign(null, manifest, privateKey).toString("base64")),
    publicKey: rawPublicKey,
  };
}

function createSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("releaseArtifactManifest", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("verifies a selected asset against a trusted Ed25519 manifest", async () => {
    const asset = Buffer.from("trusted-msi");
    const signed = makeSignedManifest({
      assetName: "breeze-agent.msi",
      assetBuffer: asset,
    });
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    await expect(
      verifyReleaseArtifactBuffer({
        assetName: "breeze-agent.msi",
        assetBuffer: asset,
        manifestBytes: signed.manifest,
        signatureBytes: signed.signature,
        expectedRepository: "lanternops/breeze",
        expectedRelease: "v1.2.3",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        assetName: "breeze-agent.msi",
        size: asset.length,
        release: "v1.2.3",
        repository: "lanternops/breeze",
      }),
    );
  });

  it("rejects a tampered manifest signature", async () => {
    const asset = Buffer.from("trusted-pkg");
    const signed = makeSignedManifest({
      assetName: "breeze-agent-darwin-arm64.pkg",
      assetBuffer: asset,
    });
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    await expect(
      verifyReleaseArtifactBuffer({
        assetName: "breeze-agent-darwin-arm64.pkg",
        assetBuffer: asset,
        manifestBytes: Buffer.from(
          signed.manifest.toString("utf8").replace("v1.2.3", "v9.9.9"),
        ),
        signatureBytes: signed.signature,
      }),
    ).rejects.toThrow("signature verification failed");
  });

  it("rejects digest mismatches for the selected asset", async () => {
    const asset = Buffer.from("original-app-zip");
    const signed = makeSignedManifest({
      assetName: "Breeze Installer.app.zip",
      assetBuffer: asset,
    });
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    await expect(
      verifyReleaseArtifactBuffer({
        assetName: "Breeze Installer.app.zip",
        assetBuffer: Buffer.from("tampered-app-zip"),
        manifestBytes: signed.manifest,
        signatureBytes: signed.signature,
      }),
    ).rejects.toThrow("Release artifact digest mismatch");
  });

  it("verifies a selected asset checksum from a trusted manifest without downloading the asset", async () => {
    const asset = Buffer.from("trusted-agent-binary");
    const signed = makeSignedManifest({
      assetName: "breeze-agent-linux-amd64",
      assetBuffer: asset,
      release: "v1.2.3",
      repository: "lanternops/breeze",
    });
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    await expect(
      verifyReleaseArtifactManifestAsset({
        assetName: "breeze-agent-linux-amd64",
        manifestBytes: signed.manifest,
        signatureBytes: signed.signature,
        expectedRepository: "lanternops/breeze",
        expectedRelease: "v1.2.3",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        assetName: "breeze-agent-linux-amd64",
        sha256: createSha256(asset),
        size: asset.length,
        release: "v1.2.3",
      }),
    );
  });

  it("skips GitHub manifest fetches when no API trust root is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.NODE_ENV = "test";

    await expect(
      verifyGithubReleaseArtifactBuffer({
        assetName: "breeze-agent.msi",
        assetBuffer: Buffer.from("asset"),
        manifestUrl: "https://example.com/release-artifact-manifest.json",
        signatureUrl:
          "https://example.com/release-artifact-manifest.json.ed25519",
      }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for GitHub fallback verification in production without a trust root", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.NODE_ENV = "production";

    await expect(
      verifyGithubReleaseArtifactBuffer({
        assetName: "breeze-agent.msi",
        assetBuffer: Buffer.from("asset"),
        manifestUrl: "https://example.com/release-artifact-manifest.json",
        signatureUrl:
          "https://example.com/release-artifact-manifest.json.ed25519",
      }),
    ).rejects.toThrow("public key is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches and verifies GitHub manifest assets when a trust root is configured", async () => {
    const asset = Buffer.from("trusted-github-msi");
    const signed = makeSignedManifest({
      assetName: "breeze-agent.msi",
      assetBuffer: asset,
    });
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(".ed25519")) return new Response(signed.signature);
        return new Response(signed.manifest);
      }),
    );

    await expect(
      verifyGithubReleaseArtifactBuffer({
        assetName: "breeze-agent.msi",
        assetBuffer: asset,
        manifestUrl: "https://example.com/release-artifact-manifest.json",
        signatureUrl:
          "https://example.com/release-artifact-manifest.json.ed25519",
        expectedRepository: "lanternops/breeze",
        expectedRelease: "v1.2.3",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });
});
