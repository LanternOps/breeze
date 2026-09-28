import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./urlSafety", () => ({
  safeFetchFollowingRedirects: vi.fn(),
}));

import {
  ReleaseManifestAssetLookupError,
  ReleaseManifestSignatureError,
  verifyReleaseArtifactManifestAsset,
  verifyReleaseArtifactManifestIdentity,
  verifyReleaseArtifactManifestIntegrity,
} from "./releaseArtifactManifest";

const BASE_SHA = "a".repeat(40);
const SERVER_SHA = "b".repeat(40);
const AGENT = "breeze-agent-linux-amd64";
const AGENT_BYTES = Buffer.from("agent bytes");

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    publicKey: der.subarray(der.length - 32).toString("base64"),
    sign(obj: unknown) {
      const manifestBytes = Buffer.from(JSON.stringify(obj));
      return {
        manifestBytes,
        signatureBytes: Buffer.from(
          sign(null, manifestBytes, privateKey).toString("base64"),
        ),
      };
    },
  };
}

function fullManifest(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    repository: "LanternOps/breeze",
    release: "v0.118.0",
    sourceCommit: BASE_SHA,
    assets: [
      {
        name: AGENT,
        sha256: createHash("sha256").update(AGENT_BYTES).digest("hex"),
        size: AGENT_BYTES.length,
        platformTrust: "release-workflow-produced",
      },
    ],
    ...extra,
  };
}

function serverOnlyManifest(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    repository: "LanternOps/breeze",
    release: "v0.118.2",
    sourceCommit: SERVER_SHA,
    releaseKind: "server-only",
    binariesRelease: "v0.118.0",
    binariesSourceCommit: BASE_SHA,
    carriedImages: [
      {
        name: "binaries",
        repository: "ghcr.io/lanternops/breeze/binaries",
        digest: `sha256:${"c".repeat(64)}`,
        fromRelease: "v0.118.0",
        fromSourceCommit: BASE_SHA,
      },
    ],
    assets: [],
    ...extra,
  };
}

describe("verifyReleaseArtifactManifestIdentity", () => {
  const originalEnv = process.env;
  let s: ReturnType<typeof signer>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    s = signer();
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = s.publicKey;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const verify = (
    signed: { manifestBytes: Buffer; signatureBytes: Buffer },
    expectedRelease: string,
    expectedRepository = "lanternops/breeze",
  ) =>
    verifyReleaseArtifactManifestIdentity({
      ...signed,
      expectedRepository,
      expectedRelease,
    });

  it("a manifest without releaseKind is a full release", () => {
    const identity = verify(s.sign(fullManifest()), "v0.118.0");
    expect(identity).toEqual({
      release: "v0.118.0",
      repository: "LanternOps/breeze",
      sourceCommit: BASE_SHA,
      releaseKind: "full",
    });
  });

  it("an explicit releaseKind full is a full release", () => {
    expect(
      verify(s.sign(fullManifest({ releaseKind: "full" })), "v0.118.0").releaseKind,
    ).toBe("full");
  });

  it("a full manifest predating sourceCommit still verifies (no new refusal for old releases)", () => {
    const { sourceCommit: _omit, ...legacy } = fullManifest();
    const identity = verify(s.sign(legacy), "v0.118.0");
    expect(identity.releaseKind).toBe("full");
    expect(identity.sourceCommit).toBeNull();
  });

  it("returns the binaries pairing for a server-only manifest", () => {
    const identity = verify(s.sign(serverOnlyManifest()), "v0.118.2");
    expect(identity).toEqual({
      release: "v0.118.2",
      repository: "LanternOps/breeze",
      sourceCommit: SERVER_SHA,
      releaseKind: "server-only",
      binariesRelease: "v0.118.0",
      binariesSourceCommit: BASE_SHA,
    });
  });

  it("checks the signature before reading any field (garbage releaseKind + bad signature → signature error)", () => {
    const signed = s.sign(serverOnlyManifest({ releaseKind: "garbage" }));
    const other = signer().sign(serverOnlyManifest({ releaseKind: "garbage" }));
    expect(() =>
      verify(
        { manifestBytes: signed.manifestBytes, signatureBytes: other.signatureBytes },
        "v0.118.2",
      ),
    ).toThrow(ReleaseManifestSignatureError);
  });

  it("refuses a repository mismatch (case-insensitive equality)", () => {
    expect(() =>
      verify(s.sign(serverOnlyManifest()), "v0.118.2", "acme/breeze-fork"),
    ).toThrow(/repository mismatch/);
    expect(verify(s.sign(serverOnlyManifest()), "v0.118.2", "LANTERNOPS/BREEZE").release).toBe(
      "v0.118.2",
    );
  });

  it("refuses a release identity mismatch", () => {
    expect(() => verify(s.sign(serverOnlyManifest()), "v0.118.3")).toThrow(
      /release mismatch/,
    );
  });

  it("refuses an unknown releaseKind", () => {
    expect(() =>
      verify(s.sign(serverOnlyManifest({ releaseKind: "agent-only" })), "v0.118.2"),
    ).toThrow(ReleaseManifestAssetLookupError);
  });

  it.each([
    ["missing binariesRelease", { binariesRelease: undefined }],
    ["prerelease binariesRelease", { binariesRelease: "v0.118.0-rc.1" }],
    ["unprefixed binariesRelease", { binariesRelease: "0.118.0" }],
    ["binariesRelease equal to the release itself", { binariesRelease: "v0.118.2" }],
    ["missing binariesSourceCommit", { binariesSourceCommit: undefined }],
    ["short binariesSourceCommit", { binariesSourceCommit: "abc123" }],
  ])("refuses a server-only manifest with %s", (_label, override) => {
    expect(() =>
      verify(s.sign(serverOnlyManifest(override)), "v0.118.2"),
    ).toThrow(ReleaseManifestAssetLookupError);
  });

  describe("reader compatibility with the new top-level keys", () => {
    it("a full manifest carrying releaseKind: full passes integrity and asset verification unchanged", async () => {
      const signed = s.sign(fullManifest({ releaseKind: "full" }));
      expect(
        verifyReleaseArtifactManifestIntegrity(signed.manifestBytes, signed.signatureBytes),
      ).toEqual({ release: "v0.118.0", repository: "LanternOps/breeze" });
      const asset = await verifyReleaseArtifactManifestAsset({
        assetName: AGENT,
        manifestBytes: signed.manifestBytes,
        signatureBytes: signed.signatureBytes,
        expectedRepository: "lanternops/breeze",
        expectedRelease: "v0.118.0",
      });
      expect(asset.size).toBe(AGENT_BYTES.length);
    });

    it("a server-only manifest with carriedImages passes integrity verification", () => {
      const signed = s.sign(serverOnlyManifest());
      expect(
        verifyReleaseArtifactManifestIntegrity(signed.manifestBytes, signed.signatureBytes),
      ).toEqual({ release: "v0.118.2", repository: "LanternOps/breeze" });
    });

    it("asset verification against a server-only manifest reports the agent as absent, not a crash", async () => {
      const signed = s.sign(serverOnlyManifest());
      await expect(
        verifyReleaseArtifactManifestAsset({
          assetName: AGENT,
          manifestBytes: signed.manifestBytes,
          signatureBytes: signed.signatureBytes,
          expectedRepository: "lanternops/breeze",
          expectedRelease: "v0.118.2",
        }),
      ).rejects.toThrow(/does not include breeze-agent-linux-amd64/);
    });
  });
});
