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
  // Required by urlSafety's safeFetch (#1105 tripwire) now that binarySync
  // routes its downloads through it.
  assertOutsideHeldDbContext: vi.fn(),
}));

// binarySync's fetches go through the SSRF-guarded helper (#4262), which dials
// http/https directly and never touches global `fetch`. Bridge it back to the
// stubbed global or the `vi.stubGlobal("fetch", …)` below stops intercepting
// and this suite makes real network calls.
vi.mock("../services/urlSafety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/urlSafety")>()),
  // Typed against SafeFetchInit (not RequestInit) so a call site's `maxBytes` /
  // `timeoutMs` survive the bridge instead of being silently dropped, and a
  // vi.fn() so a suite CAN assert on what binarySync passed the helper.
  safeFetchFollowingRedirects: vi.fn(
    (url: string, init?: import("../services/urlSafety").SafeFetchInit) =>
      globalThis.fetch(url, init as RequestInit),
  ),
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
  getActiveTrustKeyset: vi.fn().mockResolvedValue([]),
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

import { syncBinaries, syncFromGitHub } from "../services/binarySync";
import { validateReleaseManifest } from "./agentVersions";
import { requiredPlatformTrustFor } from "../services/releaseAssetTrust";
import * as manifestSigning from "../services/manifestSigning";

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
    const row = (dbMocks.insertValues.mock.calls as unknown[][])[0]![0] as {
      version: string;
      component: string;
      platform: string;
      architecture: string;
      downloadUrl: string;
      checksum: string;
      fileSize: bigint;
      releaseManifest: string;
      manifestSignature: string;
      signingKeyId: string;
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
      // Task 2 (#3836): pass the real stamped signingKeyId through, matching
      // GET /:version/download's own call — this is now load-bearing, not
      // cosmetic. See the "key-ID-aware verification" suite below for the
      // negative case this makes possible.
      signingKeyId: row.signingKeyId,
    });

    expect(result).toEqual({ ok: true });
  });
});

// Task 2 (#3836): key-ID-aware verification. Extends the roundtrip above
// with the negative case that motivated it — a row can genuinely register
// via registerFromOfficialManifest (real stamp: signingKeyId =
// "release-artifact-manifest-ed25519"), and validateReleaseManifest must
// still refuse to serve it at download time if the bytes it is ACTUALLY
// asked to verify were not signed by the configured OFFICIAL key — even
// when a different key that IS otherwise trusted (a manifest_signing_keys /
// deploy-* row) made that signature. Before this task, validateReleaseManifest's
// legacy (non schema-v1) branch checked the UNION of env keys and every DB
// deployment key regardless of what signingKeyId claimed, so this exact
// combination would have passed the server while a real agent's exact-ID
// lookup (agent/internal/updater/updater.go verifyManifestSignature) would
// still reject it. See agentVersions.test.ts's "key-ID-aware dispatch"
// suite for the exhaustive unit-level cases (both directions, plus the
// schema-v1 defensive guard).
describe("Task 2 — key-ID-aware verification rejects an official-ID row not actually signed by the official key (#3836)", () => {
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

  it("rejects a legacy-shape manifest stamped with the genuinely-registered official key ID but signed by an otherwise-trusted deployment key", async () => {
    const assetName = "breeze-agent-windows-amd64.exe";
    const official = makeOfficialLocalManifest(assetName);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = official.publicKey;
    fsMocks.readdir.mockResolvedValue([assetName] as never);
    fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 18 } as never);
    mockReadFileWithOfficialManifest("1.2.3", official.manifest, official.signature);

    await syncBinaries();

    const row = (dbMocks.insertValues.mock.calls as unknown[][])[0]![0] as {
      version: string;
      component: string;
      platform: string;
      architecture: string;
      downloadUrl: string;
      checksum: string;
      fileSize: bigint;
      signingKeyId: string;
    };
    // Sanity: this really is the official-ID stamp the bug depends on.
    expect(row.signingKeyId).toBe("release-artifact-manifest-ed25519");

    // Simulate the exact bug this task closes: the row still claims the
    // official key ID, but the manifest bytes actually being verified were
    // signed by a per-deployment key that IS otherwise trusted (present in
    // manifest_signing_keys) — never a genuinely official signature.
    const deployKey = generateKeyPairSync("ed25519");
    const rawDeployPub = (
      deployKey.publicKey.export({ format: "der", type: "spki" }) as Buffer
    ).subarray(-32);
    const legacyManifest = JSON.stringify({
      version: row.version,
      component: row.component,
      platform: row.platform,
      arch: row.architecture,
      url: row.downloadUrl,
      checksum: row.checksum,
      size: Number(row.fileSize),
    });
    const deploySignature = sign(
      null,
      Buffer.from(legacyManifest, "utf8"),
      deployKey.privateKey,
    ).toString("base64");

    vi.spyOn(manifestSigning, "getActiveTrustKeyset").mockResolvedValue([
      {
        keyId: "deploy-2026-08-01-aaaa",
        publicKeyB64: rawDeployPub.toString("base64"),
        validFrom: new Date().toISOString(),
      },
    ]);

    const result = await validateReleaseManifest({
      manifest: legacyManifest,
      signature: deploySignature,
      version: row.version,
      platform: row.platform,
      arch: row.architecture,
      component: row.component,
      downloadUrl: row.downloadUrl,
      checksum: row.checksum,
      fileSize: row.fileSize,
      signingKeyId: row.signingKeyId,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_release_manifest_signature" });
  });
});

// Fix-round-1 controller correction (#3836): an earlier version of
// canonicalReleaseAssetName returned a non-null (WRONG) name for
// component="helper"/platform="macos", which would have WON over the
// correct URL-basename fallback and 409'd every real, currently-working
// BINARY_SOURCE=github helper row. This suite exercises the REAL
// syncFromGitHub helper registration path (HELPER_TARGETS,
// services/binarySync.ts ~line 59) exactly the way it registers a helper row
// in production, then feeds that row into the REAL validateReleaseManifest —
// pinning that GitHub-mode helper rows keep working byte-for-byte.
describe("D1 fix-round-1 — GitHub-mode helper registration stays byte-for-byte unchanged (#3836)", () => {
  const originalEnv = process.env;

  function makeSignedReleaseArtifactManifestFor(
    assetName: string,
    buffer: Buffer,
    release = "v1.2.3",
  ) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const rawPublicKey = publicDer.subarray(publicDer.length - 32).toString("base64");
    const checksum = createHash("sha256").update(buffer).digest("hex");
    const manifest = JSON.stringify({
      schemaVersion: 1,
      repository: "LanternOps/breeze",
      release,
      assets: [
        {
          name: assetName,
          sha256: checksum,
          size: buffer.length,
          platformTrust:
            requiredPlatformTrustFor(assetName) ?? "release-workflow-produced",
        },
      ],
    });
    const signature = sign(null, Buffer.from(manifest, "utf8"), privateKey).toString(
      "base64",
    );
    return { manifest, signature, publicKey: rawPublicKey, release };
  }

  function stubGitHubReleaseFetchForHelper(
    signed: { manifest: string; signature: string; release: string },
    assetName: string,
    assetBuffer: Buffer,
  ) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/releases/latest")) {
          return new Response(
            JSON.stringify({
              tag_name: signed.release,
              body: "release notes",
              assets: [
                {
                  name: assetName,
                  browser_download_url: `https://github.com/LanternOps/breeze/releases/download/${signed.release}/${assetName}`,
                  size: assetBuffer.length,
                },
                {
                  name: "release-artifact-manifest.json",
                  browser_download_url: `https://github.com/LanternOps/breeze/releases/download/${signed.release}/release-artifact-manifest.json`,
                  size: signed.manifest.length,
                },
                {
                  name: "release-artifact-manifest.json.ed25519",
                  browser_download_url: `https://github.com/LanternOps/breeze/releases/download/${signed.release}/release-artifact-manifest.json.ed25519`,
                  size: signed.signature.length,
                },
              ],
            }),
          );
        }
        if (url.endsWith("/release-artifact-manifest.json")) {
          return new Response(signed.manifest);
        }
        if (url.endsWith("/release-artifact-manifest.json.ed25519")) {
          return new Response(signed.signature);
        }
        return new Response("not found", { status: 404 });
      }),
    );
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.BINARY_SOURCE = "github";
    delete process.env.BINARY_GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO;
    delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    delete process.env.BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("registers a macOS helper row (breeze-helper-macos.dmg) via syncFromGitHub that validateReleaseManifest accepts", async () => {
    const assetName = "breeze-helper-macos.dmg";
    const assetBuffer = Buffer.from("helper dmg bytes");
    const signed = makeSignedReleaseArtifactManifestFor(assetName, assetBuffer);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
    stubGitHubReleaseFetchForHelper(signed, assetName, assetBuffer);

    await syncFromGitHub();

    const helperInsert = (dbMocks.insertValues.mock.calls as unknown[][]).find(
      (call) => (call[0] as { component: string }).component === "helper",
    );
    expect(helperInsert).toBeDefined();
    const row = helperInsert![0] as {
      version: string;
      component: string;
      platform: string;
      architecture: string;
      downloadUrl: string;
      checksum: string;
      fileSize: bigint;
      releaseManifest: string;
      manifestSignature: string;
      signingKeyId: string;
    };

    // Confirms this row really does carry the GitHub-sourced shape the
    // regression is about: the URL basename IS the real asset name, unlike
    // the local-mode row in the suite above.
    expect(row.downloadUrl).toBe(
      `https://github.com/LanternOps/breeze/releases/download/${signed.release}/${assetName}`,
    );

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
      signingKeyId: row.signingKeyId,
    });

    expect(result).toEqual({ ok: true });
  });
});
