import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const { safeFetchFollowingRedirectsMock } = vi.hoisted(() => ({
  safeFetchFollowingRedirectsMock: vi.fn(),
}));

vi.mock("./urlSafety", () => ({
  safeFetchFollowingRedirects: safeFetchFollowingRedirectsMock,
}));

import {
  verifyGithubReleaseArtifactBuffer,
  verifyReleaseArtifactManifestAsset,
  verifyReleaseArtifactBuffer,
  verifyReleaseArtifactManifestIntegrity,
  verifyManifestSignatureAgainstOfficialKeysOnly,
} from "./releaseArtifactManifest";
import { requiredPlatformTrustFor } from "./releaseAssetTrust";

function makeSignedManifest(args: {
  assetName: string;
  assetBuffer: Buffer;
  release?: string;
  repository?: string;
  assetOverrides?: Record<string, unknown>;
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
          platformTrust:
            requiredPlatformTrustFor(args.assetName) ??
            "release-workflow-produced",
          ...(args.assetOverrides ?? {}),
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
    safeFetchFollowingRedirectsMock.mockReset();
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

  it("accepts a repository mismatch that differs only in case", async () => {
    // GitHub repo names are case-insensitive for routing, and the manifest's
    // repository field reflects whatever case the org had at repo-create time
    // (GITHUB_REPOSITORY env var in release.yml). A strict comparison against
    // a lowercased default like "lanternops/breeze" rejects manifests written
    // as "LanternOps/breeze", which is exactly the bug self-hosters hit when
    // generating an MSI installer link.
    const asset = Buffer.from("trusted-msi");
    const signed = makeSignedManifest({
      assetName: "breeze-agent.msi",
      assetBuffer: asset,
      repository: "LanternOps/breeze",
    });
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    await expect(
      verifyReleaseArtifactBuffer({
        assetName: "breeze-agent.msi",
        assetBuffer: asset,
        manifestBytes: signed.manifest,
        signatureBytes: signed.signature,
        expectedRepository: "lanternops/breeze",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        repository: "LanternOps/breeze",
      }),
    );
  });

  it("still rejects a repository mismatch beyond case differences", async () => {
    const asset = Buffer.from("trusted-msi");
    const signed = makeSignedManifest({
      assetName: "breeze-agent.msi",
      assetBuffer: asset,
      repository: "evilorg/breeze",
    });
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    await expect(
      verifyReleaseArtifactBuffer({
        assetName: "breeze-agent.msi",
        assetBuffer: asset,
        manifestBytes: signed.manifest,
        signatureBytes: signed.signature,
        expectedRepository: "lanternops/breeze",
      }),
    ).rejects.toThrow("repository mismatch");
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

  // D4 (#3836) fix round 1: binarySync.ts's registerFromOfficialManifest
  // needs to tell "asset genuinely absent from the manifest" (legitimate
  // local/BYO fallback case) apart from "asset present but its entry is
  // wrong" (must fail closed) WITHOUT matching on `.message` text, which is
  // not a contract. These two tests pin the typed discriminant that makes
  // that safe: only the true not-found case is ReleaseManifestAssetAbsentError;
  // every other ReleaseManifestAssetLookupError variant (e.g. a malformed
  // sha256 on a PRESENT entry) is deliberately NOT that subclass, even
  // though its message text could say anything.
  describe("asset lookup error typing (D4, #3836 fix round 1)", () => {
    it("an asset name absent from the manifest's assets array throws ReleaseManifestAssetAbsentError", async () => {
      const { ReleaseManifestAssetAbsentError } = await import("./releaseArtifactManifest");
      const asset = Buffer.from("trusted-agent-binary");
      const signed = makeSignedManifest({
        assetName: "breeze-agent-linux-amd64",
        assetBuffer: asset,
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      await expect(
        verifyReleaseArtifactManifestAsset({
          assetName: "breeze-agent-windows-amd64.exe", // not in the manifest
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
        }),
      ).rejects.toThrow(ReleaseManifestAssetAbsentError);
    });

    it("an asset PRESENT with a malformed sha256 throws the base ReleaseManifestAssetLookupError, NOT the absent subclass", async () => {
      const { ReleaseManifestAssetAbsentError, ReleaseManifestAssetLookupError } =
        await import("./releaseArtifactManifest");
      const asset = Buffer.from("trusted-agent-binary");
      const signed = makeSignedManifest({
        assetName: "breeze-agent-linux-amd64",
        assetBuffer: asset,
        assetOverrides: { sha256: "not-a-valid-sha256" },
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      expect.assertions(3);
      try {
        await verifyReleaseArtifactManifestAsset({
          assetName: "breeze-agent-linux-amd64", // present, just malformed
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ReleaseManifestAssetLookupError);
        // This is the tripwire: even though the base-class instance's
        // message ("...has invalid sha256 for...") does not currently
        // contain "does not include", a caller distinguishing by message
        // text alone would be one coincidental wording change away from
        // misclassifying this as absent. instanceof must reject it
        // regardless of message content.
        expect(err).not.toBeInstanceOf(ReleaseManifestAssetAbsentError);
        expect((err as Error).message).toMatch(/invalid sha256/);
      }
    });
  });

  it("skips GitHub manifest fetches when no API trust root is configured", async () => {
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
    expect(safeFetchFollowingRedirectsMock).not.toHaveBeenCalled();
  });

  it("fails closed for GitHub fallback verification in production without a trust root", async () => {
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
    expect(safeFetchFollowingRedirectsMock).not.toHaveBeenCalled();
  });

  it("fetches and verifies GitHub manifest assets when a trust root is configured", async () => {
    const asset = Buffer.from("trusted-github-msi");
    const signed = makeSignedManifest({
      assetName: "breeze-agent.msi",
      assetBuffer: asset,
    });
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
    safeFetchFollowingRedirectsMock.mockImplementation(async (url: string) => {
      if (url.endsWith(".ed25519")) return new Response(signed.signature);
      return new Response(signed.manifest);
    });

    const manifestUrl =
      "https://example.com/release-artifact-manifest.json";
    const signatureUrl =
      "https://example.com/release-artifact-manifest.json.ed25519";

    await expect(
      verifyGithubReleaseArtifactBuffer({
        assetName: "breeze-agent.msi",
        assetBuffer: asset,
        manifestUrl,
        signatureUrl,
        expectedRepository: "lanternops/breeze",
        expectedRelease: "v1.2.3",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(safeFetchFollowingRedirectsMock).toHaveBeenNthCalledWith(
      1,
      manifestUrl,
      { maxBytes: 1024 * 1024 },
    );
    expect(safeFetchFollowingRedirectsMock).toHaveBeenNthCalledWith(
      2,
      signatureUrl,
      { maxBytes: 1024 * 1024 },
    );
  });

  describe("positive trust enforcement (spec 3c)", () => {
    it("rejects verification of a signing-input asset", async () => {
      const asset = Buffer.from("unsigned input bytes");
      const signed = makeSignedManifest({
        assetName: "breeze-agent-windows-amd64-unsigned.exe",
        assetBuffer: asset,
        assetOverrides: { platformTrust: "none", intendedUse: "signing-input" },
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      await expect(
        verifyReleaseArtifactManifestAsset({
          assetName: "breeze-agent-windows-amd64-unsigned.exe",
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
        }),
      ).rejects.toThrow(/not distributable/);
    });

    it("rejects an unknown platformTrust value", async () => {
      const asset = Buffer.from("linux agent bytes");
      const signed = makeSignedManifest({
        assetName: "breeze-agent-linux-amd64",
        assetBuffer: asset,
        assetOverrides: { platformTrust: "mystery-trust" },
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      await expect(
        verifyReleaseArtifactManifestAsset({
          assetName: "breeze-agent-linux-amd64",
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
        }),
      ).rejects.toThrow(/unknown platformTrust/);
    });

    it("rejects a canonical Windows exe without windows-authenticode-required", async () => {
      const asset = Buffer.from("windows agent bytes");
      const signed = makeSignedManifest({
        assetName: "breeze-agent-windows-amd64.exe",
        assetBuffer: asset,
        assetOverrides: { platformTrust: "release-workflow-produced" },
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      await expect(
        verifyReleaseArtifactManifestAsset({
          assetName: "breeze-agent-windows-amd64.exe",
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
        }),
      ).rejects.toThrow(/windows-authenticode-required/);
    });

    it("returns intendedUse: null and the required trust for ordinary assets", async () => {
      const asset = Buffer.from("windows agent bytes");
      const signed = makeSignedManifest({
        assetName: "breeze-agent-windows-amd64.exe",
        assetBuffer: asset,
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      await expect(
        verifyReleaseArtifactManifestAsset({
          assetName: "breeze-agent-windows-amd64.exe",
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
        }),
      ).resolves.toMatchObject({
        platformTrust: "windows-authenticode-required",
        intendedUse: null,
      });
    });

    // assertDistributableReleaseAsset rejects ANY non-null intendedUse
    // precisely so unknown future values cannot slip through. Coercing a
    // present-but-non-string value to null defeated that: the asset read as
    // "no intendedUse" and became registrable and servable, with only the
    // name regex left as a backstop.
    it.each([
      ["a number", 1],
      ["an array", ["signing-input"]],
      ["an object", { kind: "signing-input" }],
      ["a boolean", true],
    ])(
      "rejects a manifest whose intendedUse is %s rather than reading it as absent",
      async (_label, value) => {
        const asset = Buffer.from("linux agent bytes");
        const signed = makeSignedManifest({
          assetName: "breeze-agent-linux-amd64",
          assetBuffer: asset,
          assetOverrides: { intendedUse: value as unknown as string },
        });
        process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
        await expect(
          verifyReleaseArtifactManifestAsset({
            assetName: "breeze-agent-linux-amd64",
            manifestBytes: signed.manifest,
            signatureBytes: signed.signature,
          }),
        ).rejects.toThrow(/non-string intendedUse/);
      },
    );
  });

  it("rejects intendedUse signing inputs even when sourceCommit is present", async () => {
    // Deliverable 1 of the self-host BYO-signing design adds a top-level
    // sourceCommit and per-asset intendedUse/platformTrust:"none" for
    // -unsigned signing-input assets. The parser remains tolerant of the
    // top-level sourceCommit field, while distribution fails closed on the
    // per-asset intendedUse marker.
    const asset = Buffer.from("unsigned-signing-input");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicDer = publicKey.export({
      format: "der",
      type: "spki",
    }) as Buffer;
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = publicDer
      .subarray(publicDer.length - 32)
      .toString("base64");
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        repository: "lanternops/breeze",
        release: "v1.2.3",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        assets: [
          {
            name: "breeze-agent-windows-amd64-unsigned.exe",
            sha256: createSha256(asset),
            size: asset.length,
            platformTrust: "none",
            intendedUse: "signing-input",
          },
        ],
      }),
    );
    const signature = Buffer.from(
      sign(null, manifest, privateKey).toString("base64"),
    );

    await expect(
      verifyReleaseArtifactBuffer({
        assetName: "breeze-agent-windows-amd64-unsigned.exe",
        assetBuffer: asset,
        manifestBytes: manifest,
        signatureBytes: signature,
        expectedRepository: "lanternops/breeze",
        expectedRelease: "v1.2.3",
      }),
    ).rejects.toThrow(/not distributable/);
  });

  it("rejects a signing-input entry when the caller expects authenticode trust", async () => {
    // The positive allowlist is enforced before the caller-supplied stricter
    // expectedPlatformTrust check, so signing inputs fail at the central
    // distributability baseline.
    const asset = Buffer.from("unsigned-signing-input");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicDer = publicKey.export({
      format: "der",
      type: "spki",
    }) as Buffer;
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = publicDer
      .subarray(publicDer.length - 32)
      .toString("base64");
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        repository: "lanternops/breeze",
        release: "v1.2.3",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        assets: [
          {
            name: "breeze-agent-windows-amd64-unsigned.exe",
            sha256: createSha256(asset),
            size: asset.length,
            platformTrust: "none",
            intendedUse: "signing-input",
          },
        ],
      }),
    );
    const signature = Buffer.from(
      sign(null, manifest, privateKey).toString("base64"),
    );

    await expect(
      verifyReleaseArtifactBuffer({
        assetName: "breeze-agent-windows-amd64-unsigned.exe",
        assetBuffer: asset,
        manifestBytes: manifest,
        signatureBytes: signature,
        expectedRepository: "lanternops/breeze",
        expectedPlatformTrust: "windows-authenticode-required",
      }),
    ).rejects.toThrow(/not distributable/);
  });

  describe("edition field (BYO signing follow-up)", () => {
    it("surfaces edition on the verified result when present", async () => {
      const asset = Buffer.from("unsigned self-host msi");
      const signed = makeSignedManifest({
        assetName: "breeze-agent.msi",
        assetBuffer: asset,
        assetOverrides: { platformTrust: "none", edition: "self-host" },
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      await expect(
        verifyReleaseArtifactBuffer({
          assetName: "breeze-agent.msi",
          assetBuffer: asset,
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
        }),
      ).resolves.toMatchObject({ edition: "self-host", platformTrust: "none" });
    });

    it("returns edition: null when the manifest predates the field", async () => {
      const asset = Buffer.from("trusted-msi");
      const signed = makeSignedManifest({
        assetName: "breeze-agent.msi",
        assetBuffer: asset,
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      await expect(
        verifyReleaseArtifactManifestAsset({
          assetName: "breeze-agent.msi",
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
        }),
      ).resolves.toMatchObject({ edition: null });
    });

    it("rejects an unsigned breeze-agent.msi with no edition claim (backward compatible)", async () => {
      const asset = Buffer.from("unsigned msi, no edition claim");
      const signed = makeSignedManifest({
        assetName: "breeze-agent.msi",
        assetBuffer: asset,
        assetOverrides: { platformTrust: "none" },
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      await expect(
        verifyReleaseArtifactBuffer({
          assetName: "breeze-agent.msi",
          assetBuffer: asset,
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
        }),
      ).rejects.toThrow(/windows-authenticode-required/);
    });

    it("accepts an unsigned breeze-agent.msi labeled edition self-host", async () => {
      const asset = Buffer.from("unsigned self-host msi bytes");
      const signed = makeSignedManifest({
        assetName: "breeze-agent.msi",
        assetBuffer: asset,
        assetOverrides: { platformTrust: "none", edition: "self-host" },
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      await expect(
        verifyReleaseArtifactBuffer({
          assetName: "breeze-agent.msi",
          assetBuffer: asset,
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
        }),
      ).resolves.toMatchObject({ edition: "self-host", platformTrust: "none" });
    });

    it("rejects an unsigned breeze-agent.msi labeled edition hosted", async () => {
      const asset = Buffer.from("unsigned hosted msi bytes");
      const signed = makeSignedManifest({
        assetName: "breeze-agent.msi",
        assetBuffer: asset,
        assetOverrides: { platformTrust: "none", edition: "hosted" },
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      await expect(
        verifyReleaseArtifactBuffer({
          assetName: "breeze-agent.msi",
          assetBuffer: asset,
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
        }),
      ).rejects.toThrow(/windows-authenticode-required/);
    });

    it("rejects an unknown edition value", async () => {
      const asset = Buffer.from("linux agent bytes");
      const signed = makeSignedManifest({
        assetName: "breeze-agent-linux-amd64",
        assetBuffer: asset,
        assetOverrides: { edition: "enterprise" },
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      await expect(
        verifyReleaseArtifactManifestAsset({
          assetName: "breeze-agent-linux-amd64",
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
        }),
      ).rejects.toThrow(/unknown edition/);
    });
  });

  describe("verifyReleaseArtifactManifestIntegrity", () => {
    it("returns release/repository for a validly-signed manifest without a per-asset lookup", () => {
      const asset = Buffer.from("agent bytes");
      const signed = makeSignedManifest({
        assetName: "breeze-agent-linux-amd64",
        assetBuffer: asset,
        release: "v9.9.9",
        repository: "acme/breeze-selfhost",
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      expect(
        verifyReleaseArtifactManifestIntegrity(signed.manifest, signed.signature),
      ).toEqual({ release: "v9.9.9", repository: "acme/breeze-selfhost" });
    });

    it("throws on a tampered signature", () => {
      const asset = Buffer.from("agent bytes");
      const signed = makeSignedManifest({
        assetName: "breeze-agent-linux-amd64",
        assetBuffer: asset,
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      const tampered = Buffer.from(
        signed.manifest.toString("utf8").replace("v1.2.3", "v9.9.9"),
      );

      expect(() =>
        verifyReleaseArtifactManifestIntegrity(tampered, signed.signature),
      ).toThrow(/signature verification failed/);
    });

    it("throws when no trust root is configured", () => {
      const asset = Buffer.from("agent bytes");
      const signed = makeSignedManifest({
        assetName: "breeze-agent-linux-amd64",
        assetBuffer: asset,
      });
      delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
      delete process.env.BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;

      expect(() =>
        verifyReleaseArtifactManifestIntegrity(signed.manifest, signed.signature),
      ).toThrow(/public key is not configured/);
    });
  });

  // Task 2 (#3836): agentVersions.ts's legacy (non schema-v1) manifest
  // verification dispatches an official-signingKeyId row here instead of
  // the whole-set (env + DB deployment keys) check it used before. This
  // function is the "official keys ONLY, no DB access" primitive that
  // makes that narrowing possible.
  describe("verifyManifestSignatureAgainstOfficialKeysOnly (Task 2, #3836)", () => {
    it("returns true for a signature that verifies under a configured official key", () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
      const rawPublicKey = publicDer.subarray(publicDer.length - 32).toString("base64");
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = rawPublicKey;
      const manifest = JSON.stringify({ foo: "bar" });
      const signature = sign(null, Buffer.from(manifest, "utf8"), privateKey).toString("base64");

      expect(verifyManifestSignatureAgainstOfficialKeysOnly(manifest, signature)).toBe(true);
    });

    it("returns false for a signature made by a DIFFERENT key, even one otherwise present in the process (not falling back to any other trust store)", () => {
      const official = generateKeyPairSync("ed25519");
      const officialDer = official.publicKey.export({ format: "der", type: "spki" }) as Buffer;
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = officialDer
        .subarray(officialDer.length - 32)
        .toString("base64");

      const other = generateKeyPairSync("ed25519");
      const manifest = JSON.stringify({ foo: "bar" });
      const signature = sign(null, Buffer.from(manifest, "utf8"), other.privateKey).toString(
        "base64",
      );

      expect(verifyManifestSignatureAgainstOfficialKeysOnly(manifest, signature)).toBe(false);
    });

    it("returns false (no soft-pass) when no official key is configured", () => {
      delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
      delete process.env.BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;

      expect(
        verifyManifestSignatureAgainstOfficialKeysOnly("{}", "A".repeat(88)),
      ).toBe(false);
    });

    it("returns false (never throws) when the configured official key value is malformed", () => {
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = "not-a-valid-key===";

      expect(() =>
        verifyManifestSignatureAgainstOfficialKeysOnly("{}", "A".repeat(88)),
      ).not.toThrow();
      expect(verifyManifestSignatureAgainstOfficialKeysOnly("{}", "A".repeat(88))).toBe(false);
    });

    it("returns false for a malformed (wrong-length) signature", () => {
      const { publicKey } = generateKeyPairSync("ed25519");
      const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = publicDer
        .subarray(publicDer.length - 32)
        .toString("base64");

      expect(
        verifyManifestSignatureAgainstOfficialKeysOnly("{}", "too-short"),
      ).toBe(false);
    });
  });
});
