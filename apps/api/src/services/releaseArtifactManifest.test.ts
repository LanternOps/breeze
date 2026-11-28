import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const { safeFetchFollowingRedirectsMock } = vi.hoisted(() => ({
  safeFetchFollowingRedirectsMock: vi.fn(),
}));

vi.mock("./urlSafety", () => ({
  safeFetchFollowingRedirects: safeFetchFollowingRedirectsMock,
}));

import {
  fetchVerifiedGithubReleaseArtifact,
  releaseArtifactDownloadDeadlineMs,
  verifyGithubReleaseArtifactBuffer,
  verifyReleaseArtifactManifestAsset,
  verifyReleaseArtifactBuffer,
  verifyReleaseArtifactManifestIntegrity,
  verifyManifestSignatureAgainstOfficialKeysOnly,
  ReleaseManifestTooOldError,
  ReleaseManifestAssetLookupError,
  ReleaseManifestMinOsMissingError,
  ReleaseAssetNotDistributableError,
  FIRST_RELEASE_WITH_MIN_OS,
} from "./releaseArtifactManifest";
import { requiredPlatformTrustFor } from "./releaseAssetTrust";

function makeSignedManifest(args: {
  assetName: string;
  assetBuffer: Buffer;
  release?: string;
  repository?: string;
  assetOverrides?: Record<string, unknown>;
  duplicate?: boolean;
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
        ...(args.duplicate ? [{
          name: args.assetName,
          sha256: createSha256(args.assetBuffer),
          size: args.assetBuffer.length,
          platformTrust: requiredPlatformTrustFor(args.assetName) ?? "release-workflow-produced",
          ...(args.assetOverrides ?? {}),
        }] : []),
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

  it("passes a 10 min overall deadline to the asset download (#12788)", async () => {
    const asset = Buffer.from("trusted-github-msi");
    const signed = makeSignedManifest({ assetName: "breeze-agent.msi", assetBuffer: asset });
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
    safeFetchFollowingRedirectsMock.mockImplementation(async (url: string) => {
      if (url.endsWith(".ed25519")) return new Response(signed.signature);
      if (url.endsWith("breeze-agent.msi")) return new Response(new Uint8Array(asset));
      return new Response(signed.manifest);
    });

    await fetchVerifiedGithubReleaseArtifact({
      assetName: "breeze-agent.msi",
      assetUrl: "https://example.com/breeze-agent.msi",
      manifestUrl: "https://example.com/release-artifact-manifest.json",
      signatureUrl: "https://example.com/release-artifact-manifest.json.ed25519",
      expectedRepository: "lanternops/breeze",
      expectedRelease: "v1.2.3",
      maxAssetBytes: 1024 * 1024,
    });

    expect(safeFetchFollowingRedirectsMock).toHaveBeenCalledWith(
      "https://example.com/breeze-agent.msi",
      expect.objectContaining({ deadlineMs: 600_000 }),
    );
  });

  it.each([
    // [size from the signed manifest, expected deadline]: 60 s for the redirect
    // chain plus the size at 64 KiB/s, within [10 min, 2 h].
    [1024 * 1024, 600_000],
    [16 * 1024 * 1024, 600_000],
    [128 * 1024 * 1024, 60_000 + 2048 * 1000],
    [256 * 1024 * 1024, 60_000 + 4096 * 1000],
    [1024 * 1024 * 1024, 2 * 60 * 60_000],
  ])("sizes the asset download deadline from the manifest size %i (#12788)", (size, expected) => {
    expect(releaseArtifactDownloadDeadlineMs(size)).toBe(expected);
  });

  it("a 256 MiB helper at 1 Mbit/s fits its deadline with room to spare (#12788)", () => {
    const size = 256 * 1024 * 1024;
    const atOneMegabit = (size / 125_000) * 1000;
    expect(releaseArtifactDownloadDeadlineMs(size)).toBeGreaterThan(1.5 * atOneMegabit);
  });

  it("passes the manifest-sized deadline to a large asset download (#12788)", async () => {
    const asset = Buffer.alloc(48 * 1024 * 1024, 7);
    const signed = makeSignedManifest({ assetName: "breeze-helper.msi", assetBuffer: asset });
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
    safeFetchFollowingRedirectsMock.mockImplementation(async (url: string) => {
      if (url.endsWith(".ed25519")) return new Response(signed.signature);
      if (url.endsWith("breeze-helper.msi")) return new Response(new Uint8Array(asset));
      return new Response(signed.manifest);
    });

    await fetchVerifiedGithubReleaseArtifact({
      assetName: "breeze-helper.msi",
      assetUrl: "https://example.com/breeze-helper.msi",
      manifestUrl: "https://example.com/release-artifact-manifest.json",
      signatureUrl: "https://example.com/release-artifact-manifest.json.ed25519",
      expectedRepository: "lanternops/breeze",
      expectedRelease: "v1.2.3",
      maxAssetBytes: 64 * 1024 * 1024,
    });

    expect(safeFetchFollowingRedirectsMock).toHaveBeenCalledWith(
      "https://example.com/breeze-helper.msi",
      expect.objectContaining({ maxBytes: asset.length, deadlineMs: 60_000 + 768 * 1000 }),
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

  // #7830: v0.105.0 is the first release whose manifest records `edition`.
  // A self-hoster pinning BINARY_VERSION to an older release got a 503
  // "edition mismatch … expected self-host, got undefined" on every
  // installer, because no pre-v0.105.0 manifest can ever carry the field.
  describe("manifests predating the edition field (#7830)", () => {
    const assetName = "breeze-agent-linux-amd64";
    const asset = Buffer.from("linux agent bytes");

    function verify(
      release: string,
      expectedEdition: string,
      assetOverrides: Record<string, unknown> = {},
      expectedRelease: string | null = release,
    ) {
      const signed = makeSignedManifest({ assetName, assetBuffer: asset, release, assetOverrides });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      return verifyReleaseArtifactBuffer({
        assetName,
        assetBuffer: asset,
        manifestBytes: signed.manifest,
        signatureBytes: signed.signature,
        expectedEdition,
        expectedRelease,
      });
    }

    it.each(["v0.104.0", "v0.103.0", "v0.104.0-rc.1", "v0.99.12"])(
      "accepts a pinned %s manifest with no edition as the self-host release it is",
      async (release) => {
        // edition stays null: the manifest made no claim, and nothing
        // downstream (e.g. the unsigned-MSI relaxation) may read one into it.
        await expect(verify(release, "self-host")).resolves.toMatchObject({ release, edition: null });
      },
    );

    // Downgrade guard: without an explicit pin (unpinned "latest", or the
    // local volume, which never pins), a replayed but genuinely signed old
    // manifest must not be served.
    it("refuses an UNPINNED pre-v0.105.0 manifest with no edition (no silent downgrade)", async () => {
      await expect(verify("v0.104.0", "self-host", {}, null)).rejects.toThrow(
        /edition mismatch.*predates the edition field.*only when BINARY_VERSION pins it explicitly/,
      );
    });

    it("still accepts a current (unpinned/latest) manifest that records edition self-host", async () => {
      await expect(verify("v0.120.0", "self-host", { edition: "self-host" }, null)).resolves.toMatchObject({
        edition: "self-host",
      });
    });

    it.each(["v0.105.0", "v0.105.0-rc.1", "v0.120.0"])(
      "refuses a pinned %s manifest with no edition — every release since v0.105.0 records one",
      async (release) => {
        await expect(verify(release, "self-host")).rejects.toThrow(
          /edition mismatch.*expected self-host.*records no edition.*v0\.105\.0/,
        );
      },
    );

    it("never assumes a legacy manifest is the hosted edition", async () => {
      await expect(verify("v0.104.0", "hosted")).rejects.toThrow(/edition mismatch/);
    });

    it("refuses a legacy release that explicitly claims a different edition", async () => {
      await expect(verify("v0.104.0", "self-host", { edition: "hosted" })).rejects.toThrow(
        /edition mismatch.*expected self-host, got hosted/,
      );
    });

    it("refuses a release tag it cannot order (no legacy assumption on a custom tag)", async () => {
      await expect(verify("nightly-2026-08-01", "self-host")).rejects.toThrow(/edition mismatch/);
    });

    describe("macOS publisher identity on old releases", () => {
      const pkgName = "breeze-agent-darwin-arm64.pkg";
      const pkg = Buffer.from("notarized pkg");

      function signedPkg(release: string, assetOverrides: Record<string, unknown> = {}) {
        // Releases from v0.105.0 on carry edition; older ones do not.
        const edition = releaseHasEdition(release) ? { edition: "self-host" } : {};
        const signed = makeSignedManifest({
          assetName: pkgName,
          assetBuffer: pkg,
          release,
          assetOverrides: { ...edition, ...assetOverrides },
        });
        process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
        return signed;
      }

      function releaseHasEdition(release: string) {
        return !["v0.104.0"].includes(release);
      }

      function viaBuffer(release: string, assetOverrides: Record<string, unknown> = {}) {
        const signed = signedPkg(release, assetOverrides);
        return verifyReleaseArtifactBuffer({
          assetName: pkgName,
          assetBuffer: pkg,
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
          expectedEdition: "self-host",
          expectedRelease: release,
          requireMacosPublisher: true,
        });
      }

      it.each(["v0.104.0", "v0.111.9"])(
        "refuses a %s pkg as too old, naming the release to pin",
        async (release) => {
          const result = viaBuffer(release);
          await expect(result).rejects.toBeInstanceOf(ReleaseManifestTooOldError);
          await expect(result).rejects.toThrow(
            new RegExp(`${release.replace(/\./g, "\\.")}.*BINARY_VERSION.*v0\\.112\\.0 or later`),
          );
        },
      );

      it("applies on the manifest-only verification path too", async () => {
        const signed = signedPkg("v0.104.0");
        await expect(
          verifyReleaseArtifactManifestAsset({
            assetName: pkgName,
            manifestBytes: signed.manifest,
            signatureBytes: signed.signature,
            expectedEdition: "self-host",
            expectedRelease: "v0.104.0",
            requireMacosPublisher: true,
          }),
        ).rejects.toBeInstanceOf(ReleaseManifestTooOldError);
      });

      it.each(["v0.112.0", "v0.112.0-rc.1", "v0.120.0"])(
        "keeps refusing a missing identity on %s as invalid, not too old",
        async (release) => {
          const result = viaBuffer(release);
          await expect(result).rejects.toThrow(/invalid macOS signing identity/);
          await expect(result).rejects.not.toBeInstanceOf(ReleaseManifestTooOldError);
        },
      );

      it("treats a partial identity on an old release as invalid, not too old", async () => {
        const result = viaBuffer("v0.104.0", {
          signingIdentity: "Developer ID Installer: LanternOps LLC (D8W6N2JYMA)",
        });
        await expect(result).rejects.toThrow(/invalid macOS signing identity/);
        await expect(result).rejects.not.toBeInstanceOf(ReleaseManifestTooOldError);
      });
    });
  });

  describe("macOS installer publisher identity", () => {
    const assetName = "breeze-agent-darwin-arm64.pkg";
    const asset = Buffer.from("signed-pkg");
    const identity = "Developer ID Installer: LanternOps LLC (D8W6N2JYMA)";

    it("returns the signed exact identity and Team ID", async () => {
      const signed = makeSignedManifest({
        assetName,
        assetBuffer: asset,
        assetOverrides: {
          edition: "self-host",
          signingIdentity: identity,
          signingTeamId: "D8W6N2JYMA",
        },
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      await expect(verifyReleaseArtifactBuffer({
        assetName,
        assetBuffer: asset,
        manifestBytes: signed.manifest,
        signatureBytes: signed.signature,
        expectedEdition: "self-host",
        requireMacosPublisher: true,
      })).resolves.toMatchObject({ signingIdentity: identity, signingTeamId: "D8W6N2JYMA" });
    });

    it.each([
      [{ signingIdentity: identity }, "missing Team ID"],
      [{ signingIdentity: identity, signingTeamId: "bad" }, "malformed Team ID"],
      [{ signingIdentity: "Developer ID Installer: Other (AAAAAAAAAA)", signingTeamId: "D8W6N2JYMA" }, "identity mismatch"],
    ])("rejects %s (%s)", async (assetOverrides, _reason) => {
      const signed = makeSignedManifest({
        assetName,
        assetBuffer: asset,
        assetOverrides: { edition: "self-host", ...assetOverrides },
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      await expect(verifyReleaseArtifactManifestAsset({
        assetName,
        manifestBytes: signed.manifest,
        signatureBytes: signed.signature,
        requireMacosPublisher: true,
      })).rejects.toThrow(/macOS signing identity/);
    });

    it("rejects duplicate canonical asset entries", async () => {
      const signed = makeSignedManifest({
        assetName,
        assetBuffer: asset,
        duplicate: true,
        assetOverrides: {
          edition: "self-host",
          signingIdentity: identity,
          signingTeamId: "D8W6N2JYMA",
        },
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      await expect(verifyReleaseArtifactManifestAsset({
        assetName,
        manifestBytes: signed.manifest,
        signatureBytes: signed.signature,
        requireMacosPublisher: true,
      })).rejects.toThrow(/duplicate entries/);
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

describe("per-asset minOs (#12169)", () => {
  const darwinAgent = "breeze-agent-darwin-arm64";
  const asset = Buffer.from("darwin agent bytes");
  const savedKeys = process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
  afterEach(() => {
    if (savedKeys === undefined) delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    else process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = savedKeys;
  });

  function verify(args: {
    assetName?: string;
    release: string;
    assetOverrides?: Record<string, unknown>;
    requireDarwinMinOs?: boolean;
  }) {
    const assetName = args.assetName ?? darwinAgent;
    const signed = makeSignedManifest({
      assetName,
      assetBuffer: asset,
      release: args.release,
      assetOverrides: { edition: "self-host", ...(args.assetOverrides ?? {}) },
    });
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
    return verifyReleaseArtifactManifestAsset({
      assetName,
      manifestBytes: signed.manifest,
      signatureBytes: signed.signature,
      requireDarwinMinOs: args.requireDarwinMinOs,
    });
  }

  it("verifyReleaseArtifactManifestAsset returns minOs for a stamped darwin asset", async () => {
    await expect(
      verify({ release: FIRST_RELEASE_WITH_MIN_OS, assetOverrides: { minOs: "12.0" }, requireDarwinMinOs: true }),
    ).resolves.toMatchObject({ minOs: "12.0" });
  });

  it("returns minOs null when the asset carries none", async () => {
    await expect(verify({ release: "v0.129.0" })).resolves.toMatchObject({ minOs: null });
  });

  it.each(["12.x", "", "13.0.0.0", 13, null])("rejects malformed minOs %j", async (minOs) => {
    await expect(verify({ release: "v0.129.0", assetOverrides: { minOs } })).rejects.toBeInstanceOf(
      ReleaseManifestAssetLookupError,
    );
  });

  it("requireDarwinMinOs refuses a post-threshold darwin asset without minOs", async () => {
    for (const release of [FIRST_RELEASE_WITH_MIN_OS, `${FIRST_RELEASE_WITH_MIN_OS}-rc.1`, "v9.0.0"]) {
      await expect(verify({ release, requireDarwinMinOs: true })).rejects.toBeInstanceOf(
        ReleaseManifestMinOsMissingError,
      );
    }
    // Subclass of the policy-refusal category, so callers that classify by it
    // keep treating it as "not distributable".
    await expect(verify({ release: FIRST_RELEASE_WITH_MIN_OS, requireDarwinMinOs: true })).rejects.toBeInstanceOf(
      ReleaseAssetNotDistributableError,
    );
  });

  it("requireDarwinMinOs also covers the darwin pkg and the other darwin components", async () => {
    for (const assetName of [
      "breeze-agent-darwin-amd64.pkg",
      "breeze-backup-darwin-arm64",
      "breeze-watchdog-darwin-amd64",
      "breeze-desktop-helper-darwin-arm64",
    ]) {
      await expect(
        verify({ assetName, release: FIRST_RELEASE_WITH_MIN_OS, requireDarwinMinOs: true }),
      ).rejects.toBeInstanceOf(ReleaseManifestMinOsMissingError);
    }
  });

  it("pre-threshold darwin asset without minOs verifies with minOs null", async () => {
    await expect(verify({ release: "v0.130.0-rc.1", requireDarwinMinOs: true })).resolves.toMatchObject({
      minOs: null,
    });
  });

  it("non-darwin assets are never required to carry minOs", async () => {
    await expect(
      verify({ assetName: "breeze-agent-linux-amd64", release: FIRST_RELEASE_WITH_MIN_OS, requireDarwinMinOs: true }),
    ).resolves.toMatchObject({ minOs: null });
  });

  it("the serving path (no requireDarwinMinOs) does not refuse a missing minOs", async () => {
    await expect(verify({ release: FIRST_RELEASE_WITH_MIN_OS })).resolves.toMatchObject({ minOs: null });
  });
});
