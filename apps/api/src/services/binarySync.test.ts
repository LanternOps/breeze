import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const txUpdate = vi.fn(() => ({ set: updateSet }));
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn(() => ({ onConflictDoUpdate }));
  const txInsert = vi.fn(() => ({ values: insertValues }));
  const tx = { update: txUpdate, insert: txInsert };
  // Unconfigured by default (no tests exercise it unless they set
  // BREEZE_VERSION/APP_VERSION, which is the only way ensureCurrentVersionRegistered
  // reaches db.select — see the "ensureCurrentVersionRegistered companion
  // check" describe block below for the tests that configure it).
  const select = vi.fn();
  return {
    updateWhere,
    updateSet,
    txUpdate,
    onConflictDoUpdate,
    insertValues,
    txInsert,
    tx,
    select,
    transaction: vi.fn(async (fn: (tx: any) => Promise<void>) => fn(tx)),
  };
});

vi.mock("../db", () => ({
  db: {
    transaction: dbMocks.transaction,
    select: dbMocks.select,
  },
  // urlSafety's safeFetch calls this (#1105 tripwire); the real `../db` is
  // mocked away, so the named export has to exist or the import fails.
  assertOutsideHeldDbContext: vi.fn(),
}));

// binarySync's outbound calls now go through the SSRF-guarded
// `safeFetchFollowingRedirects` (#4262), which dials Node's http/https directly
// so it can DNS-resolve and IP-pin each hop — it never touches global `fetch`.
// Without this bridge every `vi.stubGlobal("fetch", …)` below would stop
// intercepting and these cases would make REAL network calls (that is exactly
// how PR #4255's installerBuilder cases went unhooked). Route the helper back
// to the stubbed global; the guard's real redirect/SSRF semantics are covered
// by `binarySync.redirect.test.ts` and `urlSafety.test.ts`, and that binarySync
// actually adopts it by the source scan in `binarySync.redirect.test.ts`.
vi.mock("./urlSafety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./urlSafety")>()),
  // Typed against SafeFetchInit (not RequestInit) so a call site's `maxBytes` /
  // `timeoutMs` survive the bridge instead of being silently dropped, and a
  // vi.fn() so a suite CAN assert on what binarySync passed the helper.
  safeFetchFollowingRedirects: vi.fn(
    (url: string, init?: import("./urlSafety").SafeFetchInit) =>
      globalThis.fetch(url, init as RequestInit),
  ),
}));

// Capture eq/and so a test can inspect the WHERE built for the per-component
// isLatest demote (#1802). Preserve every other drizzle-orm export so the real
// schema (pgTable/varchar/...) still loads.
const drizzleSpies = vi.hoisted(() => ({
  eq: vi.fn((column: unknown, value: unknown) => ({ __op: "eq", column, value })),
  and: vi.fn((...clauses: unknown[]) => ({ __op: "and", clauses })),
}));

vi.mock("drizzle-orm", async (importActual) => {
  const actual = await importActual<typeof import("drizzle-orm")>();
  return { ...actual, eq: drizzleSpies.eq, and: drizzleSpies.and };
});

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
  signManifest: vi.fn(async (_manifestJson: string) => "test-signature-base64"),
}));

vi.mock("./manifestSigning", () => manifestSigningMocks);

vi.mock("./sentry", () => ({ captureException: vi.fn() }));

import {
  __resetRefusedManifestAssetWarnCache,
  syncBinaries,
  syncFromGitHub,
} from "./binarySync";
import { requiredPlatformTrustFor } from "./releaseAssetTrust";

function fixturePlatformTrust(name: string): string {
  return requiredPlatformTrustFor(name) ?? "release-workflow-produced";
}

// fsMocks.readFile now also backs loadOfficialLocalManifestPair's read of
// release-artifact-manifest.json[.ed25519] at the binaries volume root — a
// blanket `.mockResolvedValue(versionFileContent)` would make THAT read
// resolve with the version-file string too, which then fails manifest
// verification (bad JSON) and (for BINARY_EDITION=hosted tests) becomes
// fatal. Path-aware: only the BINARY_VERSION_FILE read resolves; the
// official-manifest pair ENOENTs by default (self-host local-mode unchanged
// unless a test explicitly stages it — see "official manifest" describe
// block below).
function mockReadFileVersionOnly(versionFileContent: string) {
  fsMocks.readFile.mockImplementation((path: unknown) => {
    if (
      typeof path === "string" &&
      (path.endsWith("release-artifact-manifest.json") ||
        path.endsWith("release-artifact-manifest.json.ed25519"))
    ) {
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Promise.reject(err);
    }
    return Promise.resolve(versionFileContent);
  });
}

function makeSignedReleaseManifest(
  assetName: string,
  assetBuffer: Buffer,
  repository = "LanternOps/breeze",
) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPublicKey = publicDer
    .subarray(publicDer.length - 32)
    .toString("base64");
  const checksum = createHash("sha256").update(assetBuffer).digest("hex");
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      repository,
      release: "v1.2.3",
      assets: [
        {
          name: assetName,
          sha256: checksum,
          size: assetBuffer.length,
          platformTrust: fixturePlatformTrust(assetName),
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

// Multi-asset variant for tests that need the same signed manifest to cover
// both the agent and the user-helper sync loops (issue #816 / PR #845).
function makeSignedReleaseManifestMulti(
  assets: { name: string; buffer: Buffer }[],
  release = "v1.2.3",
  repository = "LanternOps/breeze",
) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPublicKey = publicDer
    .subarray(publicDer.length - 32)
    .toString("base64");
  const checksums = new Map<string, string>();
  for (const a of assets) {
    checksums.set(a.name, createHash("sha256").update(a.buffer).digest("hex"));
  }
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      repository,
      release,
      assets: assets.map((a) => ({
        name: a.name,
        sha256: checksums.get(a.name)!,
        size: a.buffer.length,
        platformTrust: fixturePlatformTrust(a.name),
      })),
    }),
  );
  return {
    checksums,
    manifest,
    signature: Buffer.from(sign(null, manifest, privateKey).toString("base64")),
    publicKey: rawPublicKey,
    release,
  };
}

// Sign an arbitrary manifest object with a fresh key. Lets a test mutate a
// manifest (e.g. downgrade one asset's platformTrust) and still present a
// VALID signature, so the assertion under test is the trust check rather than
// the signature check.
function makeSignedReleaseManifestMultiFrom(manifestObject: unknown) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const manifest = Buffer.from(JSON.stringify(manifestObject));
  return {
    manifest,
    signature: Buffer.from(sign(null, manifest, privateKey).toString("base64")),
    publicKey: publicDer.subarray(publicDer.length - 32).toString("base64"),
  };
}

describe("binarySync", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BINARY_GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO;
    vi.clearAllMocks();
    // Clear the per-(component/assetName) refused-manifest-asset capture
    // dedup so a prior test's Sentry assertion doesn't suppress this one's.
    __resetRefusedManifestAssetWarnCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  describe("release-source unification (spec 3a)", () => {
    function stubOverriddenRepoFetch(
      repo: string,
      assetName: string,
      asset: Buffer,
      signed: ReturnType<typeof makeSignedReleaseManifest>,
    ) {
      const fetchSpy = vi.fn(async (url: string) => {
        if (url === `https://api.github.com/repos/${repo}/releases/latest`) {
          return new Response(
            JSON.stringify({
              tag_name: "v1.2.3",
              body: "release notes",
              assets: [
                {
                  name: assetName,
                  browser_download_url: `https://github.com/${repo}/releases/download/v1.2.3/${assetName}`,
                  size: asset.length,
                },
                {
                  name: "release-artifact-manifest.json",
                  browser_download_url: `https://github.com/${repo}/releases/download/v1.2.3/release-artifact-manifest.json`,
                  size: signed.manifest.length,
                },
                {
                  name: "release-artifact-manifest.json.ed25519",
                  browser_download_url: `https://github.com/${repo}/releases/download/v1.2.3/release-artifact-manifest.json.ed25519`,
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
      });
      vi.stubGlobal("fetch", fetchSpy);
      return fetchSpy;
    }

    it("queries the GitHub API for the overridden repository and accepts its manifest", async () => {
      const repo = "acme/breeze-selfhost-signing";
      process.env.BINARY_GITHUB_REPOSITORY = repo;
      const assetName = "breeze-agent-linux-amd64";
      const asset = Buffer.from("self-hosted agent bytes");
      const signed = makeSignedReleaseManifest(assetName, asset, repo);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      const fetchSpy = stubOverriddenRepoFetch(repo, assetName, asset, signed);

      const result = await syncFromGitHub();

      expect(fetchSpy).toHaveBeenCalledWith(
        `https://api.github.com/repos/${repo}/releases/latest`,
        expect.anything(),
      );
      expect(result.synced).toContain("agent:linux/amd64");
    });

    it("rejects a manifest whose repository does not match the overridden source", async () => {
      const repo = "acme/breeze-selfhost-signing";
      process.env.BINARY_GITHUB_REPOSITORY = repo;
      const assetName = "breeze-agent-linux-amd64";
      const asset = Buffer.from("self-hosted agent bytes");
      // Manifest still claims the OFFICIAL repository — must not register.
      const signed = makeSignedReleaseManifest(assetName, asset, "LanternOps/breeze");
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      stubOverriddenRepoFetch(repo, assetName, asset, signed);

      await expect(syncFromGitHub()).rejects.toThrow(/repository mismatch/);
      expect(dbMocks.insertValues).not.toHaveBeenCalled();
    });

    it("honors the legacy GITHUB_REPO alias", async () => {
      const repo = "legacyorg/breeze-mirror";
      process.env.GITHUB_REPO = repo;
      const assetName = "breeze-agent-linux-amd64";
      const asset = Buffer.from("legacy alias bytes");
      const signed = makeSignedReleaseManifest(assetName, asset, repo);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      const fetchSpy = stubOverriddenRepoFetch(repo, assetName, asset, signed);
      await syncFromGitHub();
      expect(fetchSpy).toHaveBeenCalledWith(
        `https://api.github.com/repos/${repo}/releases/latest`,
        expect.anything(),
      );
    });
  });

  describe("deployment re-signing on overridden repos (spec 3b)", () => {
    const repo = "acme/breeze-selfhost-signing";
    const assetName = "breeze-agent-linux-amd64";

    function stubRepoFetch(
      asset: Buffer,
      signed: ReturnType<typeof makeSignedReleaseManifest>,
    ) {
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
                    browser_download_url: `https://github.com/${repo}/releases/download/v1.2.3/${assetName}`,
                    size: asset.length,
                  },
                  {
                    name: "release-artifact-manifest.json",
                    browser_download_url: `https://github.com/${repo}/releases/download/v1.2.3/release-artifact-manifest.json`,
                    size: signed.manifest.length,
                  },
                  {
                    name: "release-artifact-manifest.json.ed25519",
                    browser_download_url: `https://github.com/${repo}/releases/download/v1.2.3/release-artifact-manifest.json.ed25519`,
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
    }

    it("stamps the deploy-* key ID and a normalized manifest that verifies against the deployment key", async () => {
      process.env.BINARY_GITHUB_REPOSITORY = repo;
      const asset = Buffer.from("self-hoster signed agent bytes");
      const signed = makeSignedReleaseManifest(assetName, asset, repo);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      // Real deployment key: signManifest signs with it so the test can
      // assert the stored signature verifies against the deployment pubkey.
      const { publicKey: deployPub, privateKey: deployPriv } =
        generateKeyPairSync("ed25519");
      manifestSigningMocks.signManifest.mockImplementation(
        async (json: string) =>
          sign(null, Buffer.from(json, "utf8"), deployPriv).toString("base64"),
      );

      try {
        stubRepoFetch(asset, signed);
        const result = await syncFromGitHub();
        expect(result.synced).toContain("agent:linux/amd64");

        expect(manifestSigningMocks.ensureActiveSigningKey).toHaveBeenCalled();
        const insert = (dbMocks.insertValues.mock.calls[0] as any[])[0] as Record<string, unknown>;
        expect(insert.signingKeyId).toBe("deploy-test-aaaaaaaa");
        // NOT the raw release manifest: a normalized per-asset update manifest.
        expect(JSON.parse(insert.releaseManifest as string)).toEqual({
          version: "1.2.3",
          component: "agent",
          platform: "linux",
          arch: "amd64",
          url: `https://github.com/${repo}/releases/download/v1.2.3/${assetName}`,
          checksum: signed.checksum,
          size: asset.length,
        });
        expect(
          verify(
            null,
            Buffer.from(insert.releaseManifest as string, "utf8"),
            deployPub,
            Buffer.from(insert.manifestSignature as string, "base64"),
          ),
        ).toBe(true);

        // Conflict-update path carries the same re-signed fields.
        const set = (dbMocks.onConflictDoUpdate.mock.calls[0]![0] as any).set;
        expect(set.signingKeyId).toBe("deploy-test-aaaaaaaa");
        expect(set.releaseManifest).toBe(insert.releaseManifest);
      } finally {
        // vi.clearAllMocks() clears CALLS, not implementations — restore the
        // hoisted default so later tests keep the canned signature.
        manifestSigningMocks.signManifest.mockImplementation(
          async () => "test-signature-base64",
        );
      }
    });

    it("official-repo path is untouched: raw manifest, official key ID, no deployment key provisioning", async () => {
      // No override env set.
      const asset = Buffer.from("official agent bytes");
      const signed = makeSignedReleaseManifest(assetName, asset);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/releases/latest")) {
            return new Response(
              JSON.stringify({
                tag_name: "v1.2.3",
                body: null,
                assets: [
                  {
                    name: assetName,
                    browser_download_url: `https://github.com/LanternOps/breeze/releases/download/v1.2.3/${assetName}`,
                    size: asset.length,
                  },
                  {
                    name: "release-artifact-manifest.json",
                    browser_download_url: "https://github.com/LanternOps/breeze/releases/download/v1.2.3/release-artifact-manifest.json",
                    size: signed.manifest.length,
                  },
                  {
                    name: "release-artifact-manifest.json.ed25519",
                    browser_download_url: "https://github.com/LanternOps/breeze/releases/download/v1.2.3/release-artifact-manifest.json.ed25519",
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

      await syncFromGitHub();

      expect(manifestSigningMocks.ensureActiveSigningKey).not.toHaveBeenCalled();
      expect(manifestSigningMocks.signManifest).not.toHaveBeenCalled();
      const insert = (dbMocks.insertValues.mock.calls[0] as any[])[0] as Record<string, unknown>;
      expect(insert.signingKeyId).toBe("release-artifact-manifest-ed25519");
      expect(insert.releaseManifest).toBe(signed.manifest.toString("utf8"));
    });

    // A re-signing failure is a deployment-wide fault (rotated
    // APP_ENCRYPTION_KEY, undecryptable signing key — the #625 class). It used
    // to be swallowed by the per-target log-and-continue catch around
    // upsertVersion, so sync returned { synced: [] } and the route answered 200
    // while the fleet silently stayed on the old version.
    it("aborts the whole sync when deployment re-signing fails, writing nothing", async () => {
      process.env.BINARY_GITHUB_REPOSITORY = repo;
      const asset = Buffer.from("self-hoster signed agent bytes");
      const signed = makeSignedReleaseManifest(assetName, asset, repo);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      stubRepoFetch(asset, signed);

      manifestSigningMocks.signManifest.mockRejectedValueOnce(
        new Error("decryptSecret returned null for active signing key"),
      );

      await expect(syncFromGitHub()).rejects.toThrow(
        /decryptSecret returned null/,
      );
      expect(dbMocks.insertValues).not.toHaveBeenCalled();
    });

    it("aborts before any write when ensureActiveSigningKey fails", async () => {
      process.env.BINARY_GITHUB_REPOSITORY = repo;
      const asset = Buffer.from("self-hoster signed agent bytes");
      const signed = makeSignedReleaseManifest(assetName, asset, repo);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      stubRepoFetch(asset, signed);

      manifestSigningMocks.ensureActiveSigningKey.mockRejectedValueOnce(
        new Error("encryptSecret returned null for Ed25519 seed"),
      );

      await expect(syncFromGitHub()).rejects.toThrow(/encryptSecret returned null/);
      expect(dbMocks.insertValues).not.toHaveBeenCalled();
    });
  });

  // AGENT_TARGETS ends with windows/amd64, so a Windows trust failure used to
  // land after the four linux/darwin agents had already been committed AND
  // promoted, and it escaped syncFromGitHub before the helper, user-helper and
  // watchdog loops ran at all — upgraded agents, frozen watchdogs (#1802's
  // failure mode). All verification now happens before any write.
  describe("trust failures leave no partial state", () => {
    it("writes nothing when a late-ordered asset fails the trust check", async () => {
      const linuxAgent = Buffer.from("linux agent bytes");
      const windowsAgent = Buffer.from("windows agent bytes");
      const watchdog = Buffer.from("linux watchdog bytes");
      const assets = [
        { name: "breeze-agent-linux-amd64", buffer: linuxAgent },
        { name: "breeze-agent-windows-amd64.exe", buffer: windowsAgent },
        { name: "breeze-watchdog-linux-amd64", buffer: watchdog },
      ];
      const signed = makeSignedReleaseManifestMulti(assets);

      // Downgrade ONLY the Windows agent's label: a self-hoster whose fork
      // generates manifests but skips Authenticode signing produces exactly
      // this. It is the last agent target and the trust assert rejects it.
      const parsed = JSON.parse(signed.manifest.toString("utf8"));
      const win = parsed.assets.find(
        (a: { name: string }) => a.name === "breeze-agent-windows-amd64.exe",
      );
      win.platformTrust = "release-workflow-produced";
      const tampered = makeSignedReleaseManifestMultiFrom(parsed);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = tampered.publicKey;

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/releases/latest")) {
            return new Response(
              JSON.stringify({
                tag_name: "v1.2.3",
                body: "release notes",
                assets: [
                  ...assets.map((a) => ({
                    name: a.name,
                    browser_download_url: `https://github.com/LanternOps/breeze/releases/download/v1.2.3/${a.name}`,
                    size: a.buffer.length,
                  })),
                  {
                    name: "release-artifact-manifest.json",
                    browser_download_url:
                      "https://github.com/LanternOps/breeze/releases/download/v1.2.3/release-artifact-manifest.json",
                    size: tampered.manifest.length,
                  },
                  {
                    name: "release-artifact-manifest.json.ed25519",
                    browser_download_url:
                      "https://github.com/LanternOps/breeze/releases/download/v1.2.3/release-artifact-manifest.json.ed25519",
                    size: tampered.signature.length,
                  },
                ],
              }),
            );
          }
          if (url.endsWith("/release-artifact-manifest.json"))
            return new Response(tampered.manifest);
          if (url.endsWith("/release-artifact-manifest.json.ed25519"))
            return new Response(tampered.signature);
          const hit = assets.find((a) => url.endsWith(a.name));
          if (hit) return new Response(hit.buffer);
          return new Response("not found", { status: 404 });
        }),
      );

      await expect(syncFromGitHub()).rejects.toThrow(/platform trust|platformTrust/i);
      // The point of the fix: the four earlier targets are NOT committed, and
      // the watchdog loop is not silently skipped.
      expect(dbMocks.insertValues).not.toHaveBeenCalled();
    });
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

    expect(result).toEqual({ version: "1.2.3", synced: ["agent:linux/amd64"], failed: [] });
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
    mockReadFileVersionOnly("0.65.9");

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

  describe("BINARY_EDITION=hosted fail-closed (local-mode GitHub fallbacks)", () => {
    it("throws instead of falling back to GitHub on a stale binaries volume", async () => {
      process.env.BINARY_SOURCE = "local";
      process.env.BINARY_EDITION = "hosted";
      process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
      process.env.BINARY_VERSION_FILE = "/fake/version";
      process.env.BREEZE_VERSION = "0.65.9";

      mockReadFileVersionOnly("0.65.8"); // stale: != BREEZE_VERSION

      await expect(syncBinaries()).rejects.toThrow(
        /BINARY_EDITION=hosted refuses to fall back to the public GitHub release/,
      );
      expect(fsMocks.readdir).not.toHaveBeenCalled();
    });

    it("throws instead of falling back to GitHub when no local agent binaries are found", async () => {
      process.env.BINARY_SOURCE = "local";
      process.env.BINARY_EDITION = "hosted";
      process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
      process.env.BINARY_VERSION_FILE = "/fake/version";
      delete process.env.BREEZE_VERSION;

      mockReadFileVersionOnly("0.65.9");
      fsMocks.readdir.mockResolvedValue([] as any); // empty dir -> no binaries found

      await expect(syncBinaries()).rejects.toThrow(
        /BINARY_EDITION=hosted refuses to fall back to the public GitHub release/,
      );
    });

    it("still falls back to GitHub normally when BINARY_EDITION is self-host (default)", async () => {
      process.env.BINARY_SOURCE = "local";
      process.env.BINARY_EDITION = "self-host";
      process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
      process.env.BINARY_VERSION_FILE = "/fake/version";
      delete process.env.BREEZE_VERSION;

      mockReadFileVersionOnly("0.65.9");
      fsMocks.readdir.mockResolvedValue([] as any);

      const fetchSpy = vi.fn(async (url: string) => {
        if (url.includes("/releases/latest")) {
          return new Response(
            JSON.stringify({
              tag_name: "v1.2.3",
              body: "",
              assets: [
                {
                  name: "checksums.txt",
                  browser_download_url: "https://example.com/checksums.txt",
                  size: 0,
                },
              ],
            }),
          );
        }
        if (url.endsWith("/checksums.txt")) return new Response("");
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchSpy);

      await expect(syncBinaries()).resolves.toBeUndefined();
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  // #1802: the local-binary path historically registered ONLY the agent
  // component, so self-hosters on BINARY_SOURCE=local never got watchdog
  // auto-update. It now also scans + registers breeze-watchdog-* siblings.
  describe("local-binary watchdog registration (#1802)", () => {
    function setLocalEnv() {
      process.env.BINARY_SOURCE = "local";
      process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
      process.env.BINARY_VERSION_FILE = "/fake/version";
      delete process.env.BREEZE_VERSION;
      fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 4096 } as any);
      mockReadFileVersionOnly("0.65.9");
    }

    it("registers a component=watchdog row alongside the agent when the binary is present", async () => {
      setLocalEnv();
      fsMocks.readdir.mockResolvedValue([
        "breeze-agent-linux-amd64",
        "breeze-watchdog-linux-amd64",
      ] as any);

      await syncBinaries();

      const insertCalls = dbMocks.insertValues.mock.calls.map(
        (call: any[]) => call[0] as Record<string, unknown>,
      );
      // Agent still registered (regression guard for the refactor).
      expect(insertCalls.some((v) => v.component === "agent")).toBe(true);

      const watchdogInsert = insertCalls.find((v) => v.component === "watchdog");
      expect(watchdogInsert).toBeDefined();
      expect(watchdogInsert).toMatchObject({
        version: "0.65.9",
        platform: "linux",
        architecture: "amd64",
        component: "watchdog",
        isLatest: true,
      });
      // Must resolve to the dedicated watchdog download route, not the agent one.
      expect(watchdogInsert!.downloadUrl).toContain(
        "/agents/download/watchdog/linux/amd64",
      );
      const manifest = JSON.parse(watchdogInsert!.releaseManifest as string);
      expect(manifest).toMatchObject({
        version: "0.65.9",
        component: "watchdog",
        platform: "linux",
        arch: "amd64",
      });
    });

    it("scopes the isLatest demote per-component so registering watchdog never clobbers the agent", async () => {
      // The whole reason registerLocalBinaries exists: its demote
      // (UPDATE ... SET isLatest=false WHERE ... component=?) MUST be
      // component-scoped, or registering the watchdog would clear the agent's
      // isLatest row for the same platform/arch and break agent auto-update
      // fleet-wide. Assert each component's demote carries its own component eq.
      setLocalEnv();
      fsMocks.readdir.mockResolvedValue([
        "breeze-agent-linux-amd64",
        "breeze-watchdog-linux-amd64",
      ] as any);

      await syncBinaries();

      // Bind the assertion to the DEMOTE specifically: each demote is
      // `UPDATE ... SET isLatest=false WHERE and(eq(platform), eq(arch),
      // eq(component), eq(isLatest=true))`. Each and() call captures one demote
      // WHERE's eq clauses. Keep only the wheres scoped by isLatest=true (the
      // demotes) and read their component eq — so a stray eq(component, ...)
      // elsewhere can't mask a dropped filter, and removing the component eq
      // from the demote fails this test.
      type EqClause = { __op: string; column: unknown; value: unknown };
      const scopedComponents = (
        drizzleSpies.and.mock.calls as unknown as EqClause[][]
      )
        .filter((clauses) =>
          clauses.some((c) => c?.__op === "eq" && c.value === true),
        )
        .map(
          (clauses) =>
            clauses.find((c) => c?.value === "agent" || c?.value === "watchdog")
              ?.value,
        )
        .filter(Boolean);

      expect(scopedComponents).toContain("agent");
      expect(scopedComponents).toContain("watchdog");
    });

    it("warns and skips watchdog registration when no watchdog binary is present", async () => {
      setLocalEnv();
      fsMocks.readdir.mockResolvedValue(["breeze-agent-linux-amd64"] as any);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await syncBinaries();

      const insertCalls = dbMocks.insertValues.mock.calls.map(
        (call: any[]) => call[0] as Record<string, unknown>,
      );
      expect(insertCalls.some((v) => v.component === "agent")).toBe(true);
      expect(insertCalls.some((v) => v.component === "watchdog")).toBe(false);
      expect(
        warnSpy.mock.calls.some((a) =>
          String(a[0] ?? "").includes("No local watchdog binaries found"),
        ),
      ).toBe(true);
      warnSpy.mockRestore();
    });
  });

  // Mirrors the watchdog local-registration coverage above (#1802) for the
  // breeze-backup component.
  describe("local-binary backup registration", () => {
    function setLocalEnv() {
      process.env.BINARY_SOURCE = "local";
      process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
      process.env.BINARY_VERSION_FILE = "/fake/version";
      delete process.env.BREEZE_VERSION;
      fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 4096 } as any);
      fsMocks.readFile.mockResolvedValue("0.65.9" as any);
    }

    it("registers a component=backup row alongside the agent when the binary is present", async () => {
      setLocalEnv();
      fsMocks.readdir.mockResolvedValue([
        "breeze-agent-linux-amd64",
        "breeze-backup-linux-amd64",
      ] as any);

      await syncBinaries();

      const insertCalls = dbMocks.insertValues.mock.calls.map(
        (call: any[]) => call[0] as Record<string, unknown>,
      );
      expect(insertCalls.some((v) => v.component === "agent")).toBe(true);

      const backupInsert = insertCalls.find((v) => v.component === "backup");
      expect(backupInsert).toBeDefined();
      expect(backupInsert).toMatchObject({
        version: "0.65.9",
        platform: "linux",
        architecture: "amd64",
        component: "backup",
        isLatest: true,
      });
      // Must resolve to the dedicated backup download route.
      expect(backupInsert!.downloadUrl).toContain(
        "/agents/download/backup/linux/amd64",
      );
    });

    it("warns and skips backup registration when no backup binary is present", async () => {
      setLocalEnv();
      fsMocks.readdir.mockResolvedValue(["breeze-agent-linux-amd64"] as any);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await syncBinaries();

      const insertCalls = dbMocks.insertValues.mock.calls.map(
        (call: any[]) => call[0] as Record<string, unknown>,
      );
      expect(insertCalls.some((v) => v.component === "backup")).toBe(false);
      expect(
        warnSpy.mock.calls.some((a) =>
          String(a[0] ?? "").includes("No local backup binaries found"),
        ),
      ).toBe(true);
      warnSpy.mockRestore();
    });
  });

  // ensureCurrentVersionRegistered() is the safety net that catches stale
  // Docker volumes, missed CI syncs, and fresh deployments. Before this fix
  // it only checked for a component="agent" row at the current version and
  // returned early — so a server that registered agent rows before backup
  // component support shipped would NEVER backfill the backup row for that
  // version, permanently starving breeze-backup auto-update on that install.
  describe("ensureCurrentVersionRegistered companion check (backup)", () => {
    function setLocalEnvWithVersion(version: string) {
      process.env.BINARY_SOURCE = "local";
      process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
      process.env.BINARY_VERSION_FILE = "/fake/version";
      // Matches the on-disk VERSION file so the stale-volume detection branch
      // doesn't short-circuit before reaching ensureCurrentVersionRegistered.
      process.env.BREEZE_VERSION = version;
      fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 4096 } as any);
      fsMocks.readFile.mockResolvedValue(version as any);
      fsMocks.readdir.mockResolvedValue([
        "breeze-agent-linux-amd64",
        "breeze-backup-linux-amd64",
      ] as any);
    }

    it("attempts a narrow backup-only backfill (not the full syncFromGitHub) against the pinned version tag when the agent row exists but the backup row does not", async () => {
      setLocalEnvWithVersion("0.65.9");

      // Simulates the pre-fix DB state: agent row registered, backup row
      // missing for this same version.
      dbMocks.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ component: "agent" }]),
        }),
      });

      const fetchMock = vi.fn(async (_url: string) => {
        throw new Error("simulated network failure");
      });
      vi.stubGlobal("fetch", fetchMock);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await syncBinaries();

      // The backfill must have been attempted against the pinned version
      // tag — proving the existence check no longer short-circuits on the
      // agent row alone. (fetch is stubbed to fail so the test doesn't also
      // need a full valid GitHub release fixture; the error path itself is
      // the proof the backfill was attempted.) A single GitHub call is
      // expected here — the narrow backfill fetches only the one release
      // tag, never the full syncFromGitHub fan-out across every component.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        fetchMock.mock.calls.some((call) =>
          String(call[0]).includes("releases/tags/v0.65.9"),
        ),
      ).toBe(true);
      expect(
        errorSpy.mock.calls.some((args) =>
          String(args[0] ?? "").includes(
            "Failed to auto-sync version 0.65.9",
          ),
        ),
      ).toBe(true);

      errorSpy.mockRestore();
    });

    it("refuses the backup backfill on BINARY_EDITION=hosted rather than pulling the public GitHub release", async () => {
      setLocalEnvWithVersion("0.65.9");
      process.env.BINARY_EDITION = "hosted";
      // ENOENTs the official manifest pair so the unrelated hosted rule that
      // makes an UNVERIFIABLE staged manifest fatal doesn't fire first and mask
      // the branch under test.
      mockReadFileVersionOnly("0.65.9");

      // Agent row present, backup row missing — the branch that would
      // otherwise reach GitHub.
      dbMocks.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ component: "agent" }]),
        }),
      });

      const fetchMock = vi.fn(async (_url: string) => {
        throw new Error("network should never be reached");
      });
      vi.stubGlobal("fetch", fetchMock);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await syncBinaries();

      // The whole point: a hosted deployment must not register a self-host
      // backup binary through this side door. Skipped, not thrown — this
      // safety net must never crash boot.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        errorSpy.mock.calls.some((args) =>
          String(args[0] ?? "").includes(
            "BINARY_EDITION=hosted refuses to fall back to the public GitHub release",
          ),
        ),
      ).toBe(true);

      errorSpy.mockRestore();
    });

    it("does not re-sync when both the agent and backup rows already exist for the current version", async () => {
      setLocalEnvWithVersion("0.65.9");

      dbMocks.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { component: "agent" },
            { component: "backup" },
          ]),
        }),
      });

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await syncBinaries();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    // The finding this backfill fixes: re-running the FULL syncFromGitHub
    // just to backfill a possibly-nonexistent backup row has side effects —
    // under AGENT_AUTO_PROMOTE default true it re-stamps isLatest on every
    // component (silently reverting manual fleet promotions), and its
    // onConflictDoUpdate overwrites locally-registered rows' downloadUrl/
    // checksum with github.com values on BINARY_SOURCE=local deploys. The
    // narrow backfill must touch ONLY the component=backup row, and its
    // isLatest must mirror the sibling agent row rather than going through
    // upsertVersion's auto-promote demote logic.
    it("upserts only the component=backup row, mirroring the sibling agent row's isLatest, without running the full syncFromGitHub", async () => {
      process.env.BINARY_SOURCE = "github";
      process.env.APP_VERSION = "0.65.9";

      dbMocks.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              component: "agent",
              platform: "windows",
              architecture: "amd64",
              isLatest: true,
              // NOT NULL DEFAULT 'self-host' in the schema, so a real row
              // always carries one — and the backfill matches its sibling on
              // edition because that column is part of the unique key.
              edition: "self-host",
            },
          ]),
        }),
      });

      const backupAsset = {
        name: "breeze-backup-windows-amd64.exe",
        buffer: Buffer.from("trusted windows backup bytes"),
      };
      const signed = makeSignedReleaseManifestMulti([backupAsset], "v0.65.9");
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      const manifestAssetEntries = [
        {
          name: "release-artifact-manifest.json",
          browser_download_url:
            "https://github.com/LanternOps/breeze/releases/download/v0.65.9/release-artifact-manifest.json",
          size: signed.manifest.length,
        },
        {
          name: "release-artifact-manifest.json.ed25519",
          browser_download_url:
            "https://github.com/LanternOps/breeze/releases/download/v0.65.9/release-artifact-manifest.json.ed25519",
          size: signed.signature.length,
        },
      ];

      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes("/releases/latest")) {
          // The unconditional initial full sync at the top of the
          // BINARY_SOURCE=github path. No component asset names match here,
          // so every target loop short-circuits and nothing is upserted —
          // keeps this call a no-op so the assertions below isolate the
          // backup-only backfill's behavior.
          return new Response(
            JSON.stringify({ tag_name: "v0.65.9", assets: manifestAssetEntries }),
          );
        }
        if (url.includes("/releases/tags/v0.65.9")) {
          return new Response(
            JSON.stringify({
              tag_name: "v0.65.9",
              body: "release notes",
              assets: [
                {
                  name: backupAsset.name,
                  browser_download_url: `https://github.com/LanternOps/breeze/releases/download/v0.65.9/${backupAsset.name}`,
                  size: backupAsset.buffer.length,
                },
                ...manifestAssetEntries,
              ],
            }),
          );
        }
        if (url.endsWith("/release-artifact-manifest.json"))
          return new Response(signed.manifest);
        if (url.endsWith("/release-artifact-manifest.json.ed25519"))
          return new Response(signed.signature);
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      await syncBinaries();

      // Only the backup component was upserted — proves the full
      // syncFromGitHub (which would also re-register agent/watchdog/helper)
      // never ran for the pinned version tag.
      const insertCalls = dbMocks.insertValues.mock.calls.map(
        (c: any[]) => c[0] as Record<string, unknown>,
      );
      expect(insertCalls).toHaveLength(1);
      expect(insertCalls[0]).toMatchObject({
        version: "0.65.9",
        platform: "windows",
        architecture: "amd64",
        component: "backup",
        checksum: signed.checksums.get(backupAsset.name),
        // Mirrors the sibling agent row's isLatest instead of running
        // through upsertVersion's auto-promote demote/insert logic.
        isLatest: true,
      });

      // No demote UPDATE ran — the backfill never touches another row's
      // isLatest.
      expect(dbMocks.updateWhere).not.toHaveBeenCalled();
    });

    it("logs once and upserts nothing when the pinned release predates breeze-backup (no matching assets)", async () => {
      process.env.BINARY_SOURCE = "github";
      process.env.APP_VERSION = "0.60.0";

      dbMocks.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              component: "agent",
              platform: "windows",
              architecture: "amd64",
              isLatest: true,
              // NOT NULL DEFAULT 'self-host' in the schema, so a real row
              // always carries one — and the backfill matches its sibling on
              // edition because that column is part of the unique key.
              edition: "self-host",
            },
          ]),
        }),
      });

      const signed = makeSignedReleaseManifestMulti([], "v0.60.0");
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      const manifestAssetEntries = [
        {
          name: "release-artifact-manifest.json",
          browser_download_url:
            "https://github.com/LanternOps/breeze/releases/download/v0.60.0/release-artifact-manifest.json",
          size: signed.manifest.length,
        },
        {
          name: "release-artifact-manifest.json.ed25519",
          browser_download_url:
            "https://github.com/LanternOps/breeze/releases/download/v0.60.0/release-artifact-manifest.json.ed25519",
          size: signed.signature.length,
        },
      ];

      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes("/releases/latest") || url.includes("/releases/tags/v0.60.0")) {
          // Pre-breeze-backup release: no breeze-backup-* asset present.
          return new Response(
            JSON.stringify({
              tag_name: "v0.60.0",
              body: "release notes",
              assets: manifestAssetEntries,
            }),
          );
        }
        if (url.endsWith("/release-artifact-manifest.json"))
          return new Response(signed.manifest);
        if (url.endsWith("/release-artifact-manifest.json.ed25519"))
          return new Response(signed.signature);
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await syncBinaries();

      expect(
        dbMocks.insertValues.mock.calls.some(
          (c: any[]) => (c[0] as Record<string, unknown>).component === "backup",
        ),
      ).toBe(false);
      expect(
        logSpy.mock.calls.some((a) =>
          String(a[0] ?? "").includes(
            "release v0.60.0 has no breeze-backup assets; backup auto-update unavailable for this version",
          ),
        ),
      ).toBe(true);

      logSpy.mockRestore();
    });
  });

  it("logs at console.error (not warn) when stale-volume detection + GitHub fallback both fail (#644)", async () => {
    // Stale-volume path: BREEZE_VERSION != VERSION-file value.
    // We force the GitHub fallback to throw by making fetch reject. The
    // compound failure must surface as console.error so it's visible in
    // Sentry / log alerting — not buried as console.warn.
    process.env.BINARY_SOURCE = "local";
    process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
    process.env.BINARY_VERSION_FILE = "/fake/version";
    process.env.BREEZE_VERSION = "0.99.0"; // expected != on-disk

    mockReadFileVersionOnly("0.65.7");

    // GitHub fallback path will call fetch; make it reject so syncFromGitHub
    // throws and the compound-failure catch fires.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED — simulated network failure");
      }),
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await syncBinaries();

    // The compound-failure escalation MUST use console.error.
    const compoundFailureCalls = errorSpy.mock.calls.filter((args) =>
      String(args[0] ?? "").includes(
        "Stale binaries volume + GitHub sync FAILED",
      ),
    );
    expect(compoundFailureCalls.length).toBeGreaterThan(0);

    // The same compound-failure message must NOT have been emitted via warn
    // (the prior bug — it was easy to miss).
    const compoundFailureWarnCalls = warnSpy.mock.calls.filter((args) =>
      String(args[0] ?? "").includes(
        "Stale binaries volume + GitHub sync FAILED",
      ),
    );
    expect(compoundFailureWarnCalls.length).toBe(0);

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // BYO signing edition follow-up: if release-artifact-manifest.json +
  // .ed25519 are staged at the binaries volume root (dirname(AGENT_BINARY_DIR),
  // e.g. /data/binaries next to /data/binaries/agent), local-mode registration
  // verifies and registers covered assets FROM that manifest — raw bytes +
  // "release-artifact-manifest-ed25519" key ID — instead of re-signing with
  // the per-deployment key.
  describe("official manifest from local dir (BYO signing edition follow-up)", () => {
    function localAssetChecksum(): string {
      return createHash("sha256").update("local agent bytes").digest("hex");
    }

    // NOTE (Task 2, #3836): this helper configures RELEASE_ARTIFACT_MANIFEST_
    // PUBLIC_KEYS to an arbitrary freshly-generated key and signs with the
    // SAME key, then the tests below assert the row gets stamped
    // signingKeyId="release-artifact-manifest-ed25519". That only proves
    // registration correctly identifies "signed by whatever this test run
    // configured as official" — it does NOT, on its own, prove the
    // server-side download-path binding (that an official-ID stamp can
    // ONLY ever be satisfied by that same official key, never by a
    // DB-provisioned per-deployment key). This file mocks db/manifestSigning
    // too heavily to reach the real validateReleaseManifest for that
    // property cheaply — the exact-binding assertions live instead in:
    //   - apps/api/src/routes/agentVersions.test.ts, describe
    //     "validateReleaseManifest — key-ID-aware dispatch (Task 2, #3836)"
    //     (unit-level, both directions: official-ID-vs-deploy-key and
    //     deploy-ID-vs-official-key)
    //   - apps/api/src/routes/agentVersionsLocalModeRoundtrip.test.ts,
    //     describe "Task 2 — key-ID-aware verification rejects an
    //     official-ID row not actually signed by the official key" (a real
    //     registerFromOfficialManifest row fed into the real
    //     validateReleaseManifest, proving the negative case end-to-end).
    function makeOfficialLocalManifest(
      assets: {
        name: string;
        sha256: string;
        size: number;
        edition?: string;
        // Override for tests that need a platformTrust label that
        // deliberately contradicts what the asset name requires (D4, #3836:
        // the distributability-policy-refused branch). Defaults to the
        // name-derived value, same as before this field existed.
        platformTrust?: string;
      }[],
    ) {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
      const rawPublicKey = publicDer.subarray(publicDer.length - 32).toString("base64");
      const manifest = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          repository: "LanternOps/breeze",
          release: "v1.2.3",
          assets: assets.map((a) => ({
            name: a.name,
            sha256: a.sha256,
            size: a.size,
            platformTrust: a.platformTrust ?? fixturePlatformTrust(a.name),
            ...(a.edition ? { edition: a.edition } : {}),
          })),
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

    function setLocalScanEnv() {
      process.env.BINARY_SOURCE = "local";
      process.env.AGENT_BINARY_DIR = "/data/binaries/agent";
      process.env.BINARY_VERSION_FILE = "/fake/version";
      delete process.env.BREEZE_VERSION;
      fsMocks.readdir.mockResolvedValue(["breeze-agent-linux-amd64"] as any);
      fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 1234 } as any);
    }

    it("registers a covered asset from the official manifest, not the per-deployment re-sign", async () => {
      setLocalScanEnv();
      const checksum = localAssetChecksum();
      const official = makeOfficialLocalManifest([
        {
          name: "breeze-agent-linux-amd64",
          sha256: checksum,
          size: 18, // Buffer.byteLength("local agent bytes")
          edition: "self-host",
        },
      ]);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = official.publicKey;
      mockReadFileWithOfficialManifest("0.65.9", official.manifest, official.signature);

      await syncBinaries();

      // This asserts REGISTRATION stamping only (unchanged by Task 2 — see
      // the NOTE above makeOfficialLocalManifest for where the download-path
      // exact-binding property this used to be conflated with is actually
      // proven).
      expect(dbMocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          signingKeyId: "release-artifact-manifest-ed25519",
          releaseManifest: official.manifest.toString("utf8"),
          edition: "self-host",
          checksum,
        }),
      );
      // The per-deployment key was never needed for this (fully-covered) asset.
      expect(manifestSigningMocks.signManifest).not.toHaveBeenCalled();
    });

    it("falls back to per-deployment re-signing for an asset the official manifest doesn't cover", async () => {
      setLocalScanEnv();
      const official = makeOfficialLocalManifest([
        {
          name: "breeze-agent-windows-amd64.exe", // does not match the scanned linux binary
          sha256: "a".repeat(64),
          size: 999,
        },
      ]);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = official.publicKey;
      mockReadFileWithOfficialManifest("0.65.9", official.manifest, official.signature);

      await syncBinaries();

      expect(dbMocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ signingKeyId: "deploy-test-aaaaaaaa" }),
      );
      expect(manifestSigningMocks.signManifest).toHaveBeenCalled();
    });

    // D4 (#3836): a checksum mismatch between the local file and the
    // manifest's claim for it used to fall through to registerLocalBinaries
    // (deploy-key re-sign), which has no distributability gate at all —
    // silently serving whatever bytes are on disk under a signature that
    // vouches for a DIFFERENT (manifest-claimed) checksum. That must fail
    // closed instead: excluded from both the official path and the
    // per-deployment fallback. See the "no silent policy-bypass fallback"
    // describe block below for the sibling policy-refused case and the
    // shared fail-closed assertions.
    it("checksum mismatch is excluded from BOTH the official path and the local fallback (fail closed), not silently re-signed", async () => {
      setLocalScanEnv();
      const official = makeOfficialLocalManifest([
        {
          name: "breeze-agent-linux-amd64",
          sha256: "b".repeat(64), // deliberately wrong vs the local file's real checksum
          size: 18,
        },
      ]);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = official.publicKey;
      mockReadFileWithOfficialManifest("0.65.9", official.manifest, official.signature);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { captureException } = await import("./sentry");

      await syncBinaries();

      // Never registered via the official path, and never falls through to
      // registerLocalBinaries either.
      expect(dbMocks.insertValues).not.toHaveBeenCalled();
      expect(manifestSigningMocks.signManifest).not.toHaveBeenCalled();
      expect(
        errorSpy.mock.calls.some((args) =>
          String(args[0] ?? "").includes("Checksum mismatch") &&
          String(args[0] ?? "").includes("breeze-agent-linux-amd64"),
        ),
      ).toBe(true);
      expect(vi.mocked(captureException)).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });

    it("self-host: falls back to re-signing and logs an error when the manifest fails signature verification", async () => {
      setLocalScanEnv();
      const official = makeOfficialLocalManifest([
        { name: "breeze-agent-linux-amd64", sha256: localAssetChecksum(), size: 18 },
      ]);
      const tamperedManifest = Buffer.from(
        official.manifest.toString("utf8").replace("v1.2.3", "v9.9.9"),
      );
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = official.publicKey;
      mockReadFileWithOfficialManifest("0.65.9", tamperedManifest, official.signature);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(syncBinaries()).resolves.toBeUndefined();

      expect(dbMocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ signingKeyId: "deploy-test-aaaaaaaa" }),
      );
      expect(
        errorSpy.mock.calls.some((args) =>
          String(args[0] ?? "").includes("Official release manifest found but failed verification"),
        ),
      ).toBe(true);
      errorSpy.mockRestore();
    });

    it("hosted: a manifest that fails verification is fatal, not a silent fallback", async () => {
      setLocalScanEnv();
      process.env.BINARY_EDITION = "hosted";
      const official = makeOfficialLocalManifest([
        { name: "breeze-agent-linux-amd64", sha256: localAssetChecksum(), size: 18 },
      ]);
      const tamperedManifest = Buffer.from(
        official.manifest.toString("utf8").replace("v1.2.3", "v9.9.9"),
      );
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = official.publicKey;
      mockReadFileWithOfficialManifest("0.65.9", tamperedManifest, official.signature);

      await expect(syncBinaries()).rejects.toThrow(
        /BINARY_EDITION=hosted requires a valid manifest/,
      );
      expect(dbMocks.insertValues).not.toHaveBeenCalled();
    });

    it("unchanged self-host local mode when no official manifest is staged", async () => {
      setLocalScanEnv();
      mockReadFileVersionOnly("0.65.9"); // ENOENTs the manifest pair by design

      await syncBinaries();

      expect(dbMocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ signingKeyId: "deploy-test-aaaaaaaa" }),
      );
    });
  });

  // D4 (#3836): registerFromOfficialManifest's per-binary catch used to treat
  // EVERY verifyReleaseArtifactManifestAsset failure as "manifest doesn't
  // cover this file" and fall through to registerLocalBinaries — which
  // deploy-key re-signs and registers the binary with NO distributability
  // gate at all. That is exactly how unsigned darwin binaries (manifest-
  // labeled release-workflow-produced, refused by assertDistributableReleaseAsset
  // which requires macos-developer-id-notarization-required for darwin
  // Mach-Os) shipped to production macOS devices with the trust policy
  // silently bypassed. The checksum-mismatch sibling case lives in the
  // "official manifest from local dir" describe block above (it needed the
  // same helpers); this block covers the distributability-policy-refusal
  // branch plus propagation to a second component (watchdog).
  describe("no silent policy-bypass fallback in local binary registration (D4, #3836)", () => {
    function setLocalScanEnvDarwinAgent() {
      process.env.BINARY_SOURCE = "local";
      process.env.AGENT_BINARY_DIR = "/data/binaries/agent";
      process.env.BINARY_VERSION_FILE = "/fake/version";
      delete process.env.BREEZE_VERSION;
      fsMocks.readdir.mockResolvedValue(["breeze-agent-darwin-amd64"] as any);
      fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 1234 } as any);
    }

    function setLocalScanEnvLinuxAgent() {
      process.env.BINARY_SOURCE = "local";
      process.env.AGENT_BINARY_DIR = "/data/binaries/agent";
      process.env.BINARY_VERSION_FILE = "/fake/version";
      delete process.env.BREEZE_VERSION;
      fsMocks.readdir.mockResolvedValue(["breeze-agent-linux-amd64"] as any);
      fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 1234 } as any);
    }

    function makeSignedOfficialManifest(
      assets: { name: string; sha256: string; size: number; edition?: string; platformTrust?: string }[],
    ) {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
      const rawPublicKey = publicDer.subarray(publicDer.length - 32).toString("base64");
      const manifest = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          repository: "LanternOps/breeze",
          release: "v1.2.3",
          assets: assets.map((a) => ({
            name: a.name,
            sha256: a.sha256,
            size: a.size,
            platformTrust: a.platformTrust ?? fixturePlatformTrust(a.name),
            ...(a.edition ? { edition: a.edition } : {}),
          })),
        }),
      );
      const signature = Buffer.from(sign(null, manifest, privateKey).toString("base64"));
      return { manifest, signature, publicKey: rawPublicKey };
    }

    function mockReadFileWithManifest(
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

    it("a policy-refused asset present in the manifest (unsigned darwin) is excluded from BOTH the official path and the local-resign fallback, and reports once via console.error + captureException", async () => {
      setLocalScanEnvDarwinAgent();
      const checksum = createHash("sha256").update("local agent bytes").digest("hex");
      const official = makeSignedOfficialManifest([
        {
          name: "breeze-agent-darwin-amd64",
          sha256: checksum,
          size: 18, // Buffer.byteLength("local agent bytes")
          edition: "self-host",
          // Deliberately wrong: darwin Mach-O binaries require
          // macos-developer-id-notarization-required. Today's actual hosted
          // release manifests label these release-workflow-produced (unsigned) —
          // this fixture reproduces that exact shape.
          platformTrust: "release-workflow-produced",
        },
      ]);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = official.publicKey;
      mockReadFileWithManifest("0.65.9", official.manifest, official.signature);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { captureException } = await import("./sentry");

      await syncBinaries();

      // Never registered via the official path...
      expect(dbMocks.insertValues).not.toHaveBeenCalled();
      // ...and never falls through to registerLocalBinaries either — that
      // path has no distributability gate and would silently serve the
      // policy-refused binary deploy-signed.
      expect(manifestSigningMocks.signManifest).not.toHaveBeenCalled();
      expect(
        errorSpy.mock.calls.some((args) =>
          String(args[0] ?? "").includes("breeze-agent-darwin-amd64"),
        ),
      ).toBe(true);
      expect(vi.mocked(captureException)).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });

    it("the absent case is unaffected: an asset the manifest genuinely does not cover still falls back to per-deployment re-signing", async () => {
      setLocalScanEnvLinuxAgent();
      const official = makeSignedOfficialManifest([
        {
          name: "breeze-agent-windows-amd64.exe", // does not match the scanned linux binary
          sha256: "a".repeat(64),
          size: 999,
        },
      ]);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = official.publicKey;
      mockReadFileWithManifest("0.65.9", official.manifest, official.signature);
      const { captureException } = await import("./sentry");

      await syncBinaries();

      expect(dbMocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ signingKeyId: "deploy-test-aaaaaaaa" }),
      );
      expect(manifestSigningMocks.signManifest).toHaveBeenCalled();
      expect(captureException).not.toHaveBeenCalled();
    });
  });

  // Issue #816 / PR #845: syncFromGitHub gained a USER_HELPER_TARGETS loop
  // that registers the windows/amd64 breeze-user-helper.exe asset as its own
  // component=user-helper row. heartbeat.doUpgrade's prefetch then fetches
  // it via GET /agent-versions/:v/download. The three tests below cover the
  // load-bearing behaviors of that loop.
  describe("syncFromGitHub user-helper loop (#816)", () => {
    function stubGitHubReleaseFetch(
      signed: ReturnType<typeof makeSignedReleaseManifestMulti>,
      assetBytes: Map<string, Buffer>,
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
                  ...Array.from(assetBytes.entries()).map(([name, buf]) => ({
                    name,
                    browser_download_url: `https://github.com/LanternOps/breeze/releases/download/${signed.release}/${name}`,
                    size: buf.length,
                  })),
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
          if (url.endsWith("/release-artifact-manifest.json"))
            return new Response(signed.manifest);
          if (url.endsWith("/release-artifact-manifest.json.ed25519"))
            return new Response(signed.signature);
          return new Response("not found", { status: 404 });
        }),
      );
    }

    it("registers component=user-helper when both agent and user-helper assets are present", async () => {
      const agentAsset = {
        name: "breeze-agent-windows-amd64.exe",
        buffer: Buffer.from("trusted windows agent bytes"),
      };
      const userHelperAsset = {
        name: "breeze-user-helper-windows-amd64.exe",
        buffer: Buffer.from("trusted user-helper bytes"),
      };
      const signed = makeSignedReleaseManifestMulti([
        agentAsset,
        userHelperAsset,
      ]);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      stubGitHubReleaseFetch(
        signed,
        new Map([
          [agentAsset.name, agentAsset.buffer],
          [userHelperAsset.name, userHelperAsset.buffer],
        ]),
      );

      const result = await syncFromGitHub();

      expect(result.version).toBe("1.2.3");
      expect(result.synced).toEqual(
        expect.arrayContaining([
          "agent:windows/amd64",
          "user-helper:windows/amd64",
        ]),
      );

      // Assert the user-helper upsert specifically — same checksum + canonical
      // browser_download_url the agent will resolve via the download route.
      const userHelperInsert = (
        dbMocks.insertValues.mock.calls as any[][]
      ).find(
        (call) =>
          (call[0] as { component: string }).component === "user-helper",
      );
      expect(userHelperInsert).toBeDefined();
      expect(userHelperInsert![0]).toMatchObject({
        version: "1.2.3",
        platform: "windows",
        architecture: "amd64",
        component: "user-helper",
        checksum: signed.checksums.get(userHelperAsset.name),
        downloadUrl: `https://github.com/LanternOps/breeze/releases/download/v1.2.3/${userHelperAsset.name}`,
      });
    });

    it("succeeds without user-helper row when the asset is missing (pre-#816 release backward-compat)", async () => {
      // Pre-#816 GitHub releases ship the agent asset but not the user-helper.
      // The loop MUST short-circuit silently — anything else would block all
      // historical releases from syncing.
      const agentAsset = {
        name: "breeze-agent-windows-amd64.exe",
        buffer: Buffer.from("pre-816 agent bytes"),
      };
      const signed = makeSignedReleaseManifestMulti([agentAsset]);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      stubGitHubReleaseFetch(
        signed,
        new Map([[agentAsset.name, agentAsset.buffer]]),
      );

      const result = await syncFromGitHub();

      // Agent sync still succeeded.
      expect(result.synced).toContain("agent:windows/amd64");
      // No user-helper row registered.
      expect(result.synced).not.toContain("user-helper:windows/amd64");
      const userHelperInserts = dbMocks.insertValues.mock.calls.filter(
        (call: any[]) => (call[0] as { component: string }).component === "user-helper",
      );
      expect(userHelperInserts).toHaveLength(0);
    });

    it("isolates user-helper upsert failures from the agent insert (logs error, agent still synced)", async () => {
      // Mirror the existing error-handling pattern: per-target try/catch
      // logs to console.error and continues with the next target. A
      // user-helper insert failure MUST NOT abort the agent insert.
      const agentAsset = {
        name: "breeze-agent-windows-amd64.exe",
        buffer: Buffer.from("agent bytes"),
      };
      const userHelperAsset = {
        name: "breeze-user-helper-windows-amd64.exe",
        buffer: Buffer.from("user-helper bytes"),
      };
      const signed = makeSignedReleaseManifestMulti([
        agentAsset,
        userHelperAsset,
      ]);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      stubGitHubReleaseFetch(
        signed,
        new Map([
          [agentAsset.name, agentAsset.buffer],
          [userHelperAsset.name, userHelperAsset.buffer],
        ]),
      );

      // Make the transaction throw ONLY for the user-helper insert. Both
      // agent and user-helper paths run through db.transaction(); detect
      // which is which by peeking at the captured insertValues args.
      const defaultTxImpl = async (fn: (tx: any) => Promise<void>) =>
        fn(dbMocks.tx);
      dbMocks.transaction.mockImplementation(
        async (fn: (tx: any) => Promise<void>) => {
          // Wrap the inner insert to inspect its values before deciding
          // whether to throw.
          const insertWrap = vi.fn((row: Record<string, unknown>) => {
            if (row.component === "user-helper") {
              // Record the captured row so the assertion below can still
              // inspect what would have been inserted.
              (dbMocks.insertValues as any)(row);
              throw new Error("simulated user-helper upsert failure");
            }
            return (dbMocks.insertValues as any)(row);
          });
          const tx = {
            update: dbMocks.tx.update,
            insert: vi.fn(() => ({ values: insertWrap })),
          };
          return fn(tx);
        },
      );

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const result = await syncFromGitHub();

        // Agent insert succeeded.
        expect(result.synced).toContain("agent:windows/amd64");
        // User-helper insert did NOT make it into the synced list.
        expect(result.synced).not.toContain("user-helper:windows/amd64");

        // Error was logged via console.error (don't pin the exact string;
        // the file's existing pattern is `[binarySync] Failed to upsert
        // user-helper version for ...`).
        const userHelperErrCalls = errorSpy.mock.calls.filter((args) =>
          String(args[0] ?? "").includes("user-helper"),
        );
        expect(userHelperErrCalls.length).toBeGreaterThan(0);
      } finally {
        errorSpy.mockRestore();
        // Restore the hoisted default so later tests don't recurse through
        // the wrapper above.
        dbMocks.transaction.mockImplementation(defaultTxImpl);
      }
    });
  });

  // The watchdog sync loop registers breeze-watchdog as its own
  // component=watchdog row so the server can drive watchdog upgrades and the
  // agent's reconcile path can fetch the matching binary. Without this, the
  // watchdog could never auto-update on the hosted (BINARY_SOURCE=github) path.
  describe("syncFromGitHub watchdog loop", () => {
    function stubGitHubReleaseFetch(
      signed: ReturnType<typeof makeSignedReleaseManifestMulti>,
      assetBytes: Map<string, Buffer>,
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
                  ...Array.from(assetBytes.entries()).map(([name, buf]) => ({
                    name,
                    browser_download_url: `https://github.com/LanternOps/breeze/releases/download/${signed.release}/${name}`,
                    size: buf.length,
                  })),
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
          if (url.endsWith("/release-artifact-manifest.json"))
            return new Response(signed.manifest);
          if (url.endsWith("/release-artifact-manifest.json.ed25519"))
            return new Response(signed.signature);
          return new Response("not found", { status: 404 });
        }),
      );
    }

    it("registers component=watchdog when the watchdog asset is present", async () => {
      const agentAsset = {
        name: "breeze-agent-linux-amd64",
        buffer: Buffer.from("trusted linux agent bytes"),
      };
      const watchdogAsset = {
        name: "breeze-watchdog-linux-amd64",
        buffer: Buffer.from("trusted linux watchdog bytes"),
      };
      const signed = makeSignedReleaseManifestMulti([agentAsset, watchdogAsset]);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      stubGitHubReleaseFetch(
        signed,
        new Map([
          [agentAsset.name, agentAsset.buffer],
          [watchdogAsset.name, watchdogAsset.buffer],
        ]),
      );

      const result = await syncFromGitHub();

      expect(result.synced).toEqual(
        expect.arrayContaining(["agent:linux/amd64", "watchdog:linux/amd64"]),
      );

      const watchdogInsert = (dbMocks.insertValues.mock.calls as any[][]).find(
        (call) => (call[0] as { component: string }).component === "watchdog",
      );
      expect(watchdogInsert).toBeDefined();
      expect(watchdogInsert![0]).toMatchObject({
        version: "1.2.3",
        platform: "linux",
        architecture: "amd64",
        component: "watchdog",
        checksum: signed.checksums.get(watchdogAsset.name),
        downloadUrl: `https://github.com/LanternOps/breeze/releases/download/v1.2.3/${watchdogAsset.name}`,
      });
    });

    it("succeeds without a watchdog row when the asset is missing (backward-compat)", async () => {
      const agentAsset = {
        name: "breeze-agent-linux-amd64",
        buffer: Buffer.from("agent only bytes"),
      };
      const signed = makeSignedReleaseManifestMulti([agentAsset]);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      stubGitHubReleaseFetch(
        signed,
        new Map([[agentAsset.name, agentAsset.buffer]]),
      );

      const result = await syncFromGitHub();

      expect(result.synced).toContain("agent:linux/amd64");
      expect(result.synced).not.toContain("watchdog:linux/amd64");
      const watchdogInserts = dbMocks.insertValues.mock.calls.filter(
        (call: any[]) => (call[0] as { component: string }).component === "watchdog",
      );
      expect(watchdogInserts).toHaveLength(0);
    });
  });

  // Mirrors the watchdog sync loop above: breeze-backup registers as its own
  // component=backup row so install.sh (and any future self-heal fetch) can
  // resolve and download the matching binary on the hosted (BINARY_SOURCE=
  // github) path.
  describe("syncFromGitHub backup loop", () => {
    function stubGitHubReleaseFetch(
      signed: ReturnType<typeof makeSignedReleaseManifestMulti>,
      assetBytes: Map<string, Buffer>,
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
                  ...Array.from(assetBytes.entries()).map(([name, buf]) => ({
                    name,
                    browser_download_url: `https://github.com/LanternOps/breeze/releases/download/${signed.release}/${name}`,
                    size: buf.length,
                  })),
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
          if (url.endsWith("/release-artifact-manifest.json"))
            return new Response(signed.manifest);
          if (url.endsWith("/release-artifact-manifest.json.ed25519"))
            return new Response(signed.signature);
          return new Response("not found", { status: 404 });
        }),
      );
    }

    it("registers component=backup when the backup asset is present", async () => {
      const agentAsset = {
        name: "breeze-agent-linux-amd64",
        buffer: Buffer.from("trusted linux agent bytes"),
      };
      const backupAsset = {
        name: "breeze-backup-linux-amd64",
        buffer: Buffer.from("trusted linux backup bytes"),
      };
      const signed = makeSignedReleaseManifestMulti([agentAsset, backupAsset]);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      stubGitHubReleaseFetch(
        signed,
        new Map([
          [agentAsset.name, agentAsset.buffer],
          [backupAsset.name, backupAsset.buffer],
        ]),
      );

      const result = await syncFromGitHub();

      expect(result.synced).toEqual(
        expect.arrayContaining(["agent:linux/amd64", "backup:linux/amd64"]),
      );

      const backupInsert = (dbMocks.insertValues.mock.calls as any[][]).find(
        (call) => (call[0] as { component: string }).component === "backup",
      );
      expect(backupInsert).toBeDefined();
      expect(backupInsert![0]).toMatchObject({
        version: "1.2.3",
        platform: "linux",
        architecture: "amd64",
        component: "backup",
        checksum: signed.checksums.get(backupAsset.name),
        downloadUrl: `https://github.com/LanternOps/breeze/releases/download/v1.2.3/${backupAsset.name}`,
      });
    });

    it("succeeds without a backup row when the asset is missing (backward-compat)", async () => {
      const agentAsset = {
        name: "breeze-agent-linux-amd64",
        buffer: Buffer.from("agent only bytes"),
      };
      const signed = makeSignedReleaseManifestMulti([agentAsset]);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      stubGitHubReleaseFetch(
        signed,
        new Map([[agentAsset.name, agentAsset.buffer]]),
      );

      const result = await syncFromGitHub();

      expect(result.synced).toContain("agent:linux/amd64");
      expect(result.synced).not.toContain("backup:linux/amd64");
      const backupInserts = dbMocks.insertValues.mock.calls.filter(
        (call: any[]) => (call[0] as { component: string }).component === "backup",
      );
      expect(backupInserts).toHaveLength(0);
    });
  });

  // Controlled fleet rollout (AGENT_AUTO_PROMOTE). Default (unset/true) keeps
  // sync == instant fleet upgrade target. When false, binarySync registers the
  // binary but never touches isLatest — the demote UPDATE is skipped, the
  // insert uses isLatest:false, and the conflict `set` omits isLatest.
  describe("AGENT_AUTO_PROMOTE controlled rollout", () => {
    it("local-binary path: AGENT_AUTO_PROMOTE=false registers isLatest:false and does NOT demote", async () => {
      process.env.BINARY_SOURCE = "local";
      process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
      process.env.BINARY_VERSION_FILE = "/fake/version";
      process.env.AGENT_AUTO_PROMOTE = "false";
      delete process.env.BREEZE_VERSION;

      fsMocks.readdir.mockResolvedValue(["breeze-agent-linux-amd64"] as any);
      fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 4096 } as any);
      mockReadFileVersionOnly("0.70.0");

      await syncBinaries();

      // No demote: the tx.update (demote existing isLatest) must NOT run.
      expect(dbMocks.txUpdate).not.toHaveBeenCalled();

      // Insert registers the row with isLatest:false.
      const insertCalls = dbMocks.insertValues.mock.calls.map(
        (call: any[]) => call[0] as Record<string, unknown>,
      );
      expect(insertCalls.length).toBeGreaterThan(0);
      for (const values of insertCalls) {
        expect(values.isLatest).toBe(false);
      }

      // Conflict set OMITS isLatest entirely so re-sync never changes target.
      const conflictSets = dbMocks.onConflictDoUpdate.mock.calls.map(
        (call: any[]) => (call[0] as { set: Record<string, unknown> }).set,
      );
      expect(conflictSets.length).toBeGreaterThan(0);
      for (const set of conflictSets) {
        expect("isLatest" in set).toBe(false);
        // Still updates the registration fields.
        expect(set.checksum).toEqual(expect.any(String));
        expect(set.downloadUrl).toEqual(expect.any(String));
      }
    });

    it("local-binary path: default (AGENT_AUTO_PROMOTE unset) promotes — demotes + isLatest:true (unchanged)", async () => {
      process.env.BINARY_SOURCE = "local";
      process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
      process.env.BINARY_VERSION_FILE = "/fake/version";
      delete process.env.AGENT_AUTO_PROMOTE;
      delete process.env.BREEZE_VERSION;

      fsMocks.readdir.mockResolvedValue(["breeze-agent-linux-amd64"] as any);
      fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 4096 } as any);
      mockReadFileVersionOnly("0.70.0");

      await syncBinaries();

      // Demote ran.
      expect(dbMocks.txUpdate).toHaveBeenCalled();
      expect(dbMocks.updateSet).toHaveBeenCalledWith({ isLatest: false });

      const insertCalls = dbMocks.insertValues.mock.calls.map(
        (call: any[]) => call[0] as Record<string, unknown>,
      );
      for (const values of insertCalls) {
        expect(values.isLatest).toBe(true);
      }
      const conflictSets = dbMocks.onConflictDoUpdate.mock.calls.map(
        (call: any[]) => (call[0] as { set: Record<string, unknown> }).set,
      );
      for (const set of conflictSets) {
        expect(set.isLatest).toBe(true);
      }
    });

    it("GitHub path: AGENT_AUTO_PROMOTE=false registers isLatest:false and does NOT demote", async () => {
      process.env.AGENT_AUTO_PROMOTE = "false";
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

      // Still synced/registered.
      expect(result.synced).toContain("agent:linux/amd64");
      // No demote UPDATE.
      expect(dbMocks.txUpdate).not.toHaveBeenCalled();
      // Insert with isLatest:false.
      expect(dbMocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          version: "1.2.3",
          component: "agent",
          isLatest: false,
        }),
      );
      // Conflict set omits isLatest but keeps registration fields.
      const set = (dbMocks.onConflictDoUpdate.mock.calls[0]![0] as any).set;
      expect("isLatest" in set).toBe(false);
      expect(set.checksum).toBe(signed.checksum);
    });
  });

  it("upserts local agent binaries with the full 5-column conflict target (regression: #617; extended with edition)", async () => {
    // The agent_versions table has a UNIQUE constraint on
    // (version, platform, architecture, component, edition). The local-binary
    // path used to omit `component`, so Postgres rejected the upsert with
    // "no unique or exclusion constraint matching the ON CONFLICT
    // specification" and the wrapping transaction rolled back, leaving
    // agent_versions empty after every API restart. `edition` was added
    // later (BYO signing follow-up) to let two editions of the same version
    // coexist — the conflict target must include it too.
    process.env.BINARY_SOURCE = "local";
    process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
    process.env.BINARY_VERSION_FILE = "/fake/version";
    delete process.env.BREEZE_VERSION;

    fsMocks.readdir.mockResolvedValue(["breeze-agent-linux-amd64"] as any);
    fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 1234 } as any);
    mockReadFileVersionOnly("0.65.7");

    await syncBinaries();

    const targets = dbMocks.onConflictDoUpdate.mock.calls.map(
      (call: any[]) => (call[0] as { target: unknown[] }).target,
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target).toHaveLength(5);
    }
  });

  describe("edition stamping (BYO signing follow-up)", () => {
    it("stamps local-scan registrations with this server's own BINARY_EDITION", async () => {
      process.env.BINARY_SOURCE = "local";
      process.env.BINARY_EDITION = "hosted";
      process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
      process.env.BINARY_VERSION_FILE = "/fake/version";
      delete process.env.BREEZE_VERSION;

      fsMocks.readdir.mockResolvedValue(["breeze-agent-linux-amd64"] as any);
      fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 1234 } as any);
      mockReadFileVersionOnly("0.65.7");

      await syncBinaries();

      expect(dbMocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ edition: "hosted" }),
      );
    });

    it("defaults local-scan registrations to self-host when BINARY_EDITION is unset", async () => {
      process.env.BINARY_SOURCE = "local";
      delete process.env.BINARY_EDITION;
      process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
      process.env.BINARY_VERSION_FILE = "/fake/version";
      delete process.env.BREEZE_VERSION;

      fsMocks.readdir.mockResolvedValue(["breeze-agent-linux-amd64"] as any);
      fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 1234 } as any);
      mockReadFileVersionOnly("0.65.7");

      await syncBinaries();

      expect(dbMocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ edition: "self-host" }),
      );
    });

    it("stamps a GitHub-sync registration with the manifest asset's edition claim", async () => {
      const asset = Buffer.from("linux agent bytes");
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
              name: "breeze-agent-linux-amd64",
              sha256: createHash("sha256").update(asset).digest("hex"),
              size: asset.length,
              platformTrust: "release-workflow-produced",
              edition: "self-host",
            },
          ],
        }),
      );
      const signature = Buffer.from(sign(null, manifest, privateKey).toString("base64"));

      process.env.BINARY_SOURCE = "github";
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = rawPublicKey;

      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes("/releases/latest")) {
          return new Response(
            JSON.stringify({
              tag_name: "v1.2.3",
              body: "",
              assets: [
                {
                  name: "breeze-agent-linux-amd64",
                  browser_download_url: "https://example.com/breeze-agent-linux-amd64",
                  size: asset.length,
                },
                {
                  name: "release-artifact-manifest.json",
                  browser_download_url: "https://example.com/release-artifact-manifest.json",
                  size: manifest.length,
                },
                {
                  name: "release-artifact-manifest.json.ed25519",
                  browser_download_url: "https://example.com/release-artifact-manifest.json.ed25519",
                  size: signature.length,
                },
              ],
            }),
          );
        }
        if (url.endsWith("release-artifact-manifest.json")) return new Response(manifest);
        if (url.endsWith("release-artifact-manifest.json.ed25519")) return new Response(signature);
        if (url.endsWith("breeze-agent-linux-amd64")) return new Response(asset);
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      await syncFromGitHub();

      expect(dbMocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ edition: "self-host" }),
      );
    });

    it("refuses to register a GitHub-sourced asset labeled edition hosted", async () => {
      const asset = Buffer.from("linux agent bytes");
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
              name: "breeze-agent-linux-amd64",
              sha256: createHash("sha256").update(asset).digest("hex"),
              size: asset.length,
              platformTrust: "release-workflow-produced",
              edition: "hosted",
            },
          ],
        }),
      );
      const signature = Buffer.from(sign(null, manifest, privateKey).toString("base64"));

      process.env.BINARY_SOURCE = "github";
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = rawPublicKey;

      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes("/releases/latest")) {
          return new Response(
            JSON.stringify({
              tag_name: "v1.2.3",
              body: "",
              assets: [
                {
                  name: "breeze-agent-linux-amd64",
                  browser_download_url: "https://example.com/breeze-agent-linux-amd64",
                  size: asset.length,
                },
                {
                  name: "release-artifact-manifest.json",
                  browser_download_url: "https://example.com/release-artifact-manifest.json",
                  size: manifest.length,
                },
                {
                  name: "release-artifact-manifest.json.ed25519",
                  browser_download_url: "https://example.com/release-artifact-manifest.json.ed25519",
                  size: signature.length,
                },
              ],
            }),
          );
        }
        if (url.endsWith("release-artifact-manifest.json")) return new Response(manifest);
        if (url.endsWith("release-artifact-manifest.json.ed25519")) return new Response(signature);
        if (url.endsWith("breeze-agent-linux-amd64")) return new Response(asset);
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      // getReleaseAssetMetadata's edition check runs OUTSIDE the per-asset
      // try/catch that wraps upsertVersion, so this fails the whole sync call
      // rather than silently skipping just this asset — a hosted-labeled
      // asset showing up in a public release manifest is a defense-in-depth
      // tripwire, not a routine skip.
      await expect(syncFromGitHub()).rejects.toThrow(
        /must never be fetched from a public GitHub release/,
      );
      expect(dbMocks.insertValues).not.toHaveBeenCalled();
    });
  });
});

describe("boot sync is pinned to the server's own release (#3742)", () => {
  const originalEnv = process.env;
  const apiBase = "https://api.github.com/repos/lanternops/breeze";

  function stubNotFoundFetch() {
    const fetchSpy = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy;
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BINARY_GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO;
    delete process.env.BINARY_VERSION;
    delete process.env.BREEZE_VERSION;
    delete process.env.APP_VERSION;
    delete process.env.BINARY_EDITION;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("github mode fetches releases/tags/v<BREEZE_VERSION>, never /releases/latest", async () => {
    process.env.BINARY_SOURCE = "github";
    process.env.BREEZE_VERSION = "0.105.1";
    const fetchSpy = stubNotFoundFetch();

    await expect(syncBinaries()).rejects.toThrow(/GitHub API error/);

    expect(fetchSpy).toHaveBeenCalledWith(
      `${apiBase}/releases/tags/v0.105.1`,
      expect.anything(),
    );
    expect(fetchSpy).not.toHaveBeenCalledWith(
      `${apiBase}/releases/latest`,
      expect.anything(),
    );
  });

  it("BINARY_VERSION wins over BREEZE_VERSION — the same precedence as the download redirect", async () => {
    // A droplet whose server images are ahead of the last PUBLISHED release
    // pins BINARY_VERSION to that release; boot sync must follow the pin or
    // isLatest runs ahead of the bytes the redirect can serve.
    process.env.BINARY_SOURCE = "github";
    process.env.BREEZE_VERSION = "0.106.0";
    process.env.BINARY_VERSION = "0.105.1";
    const fetchSpy = stubNotFoundFetch();

    await expect(syncBinaries()).rejects.toThrow(/GitHub API error/);

    expect(fetchSpy).toHaveBeenCalledWith(
      `${apiBase}/releases/tags/v0.105.1`,
      expect.anything(),
    );
    expect(fetchSpy).not.toHaveBeenCalledWith(
      `${apiBase}/releases/tags/v0.106.0`,
      expect.anything(),
    );
  });

  it("tolerates an explicit v prefix on the pinned version", async () => {
    process.env.BINARY_SOURCE = "github";
    process.env.BREEZE_VERSION = "v0.105.1";
    const fetchSpy = stubNotFoundFetch();

    await expect(syncBinaries()).rejects.toThrow(/GitHub API error/);

    expect(fetchSpy).toHaveBeenCalledWith(
      `${apiBase}/releases/tags/v0.105.1`,
      expect.anything(),
    );
  });

  it.each([undefined, "latest"])(
    "falls back to /releases/latest when BREEZE_VERSION is %s (floating deployment)",
    async (value) => {
      process.env.BINARY_SOURCE = "github";
      if (value !== undefined) process.env.BREEZE_VERSION = value;
      const fetchSpy = stubNotFoundFetch();

      await expect(syncBinaries()).rejects.toThrow(/GitHub API error/);

      expect(fetchSpy).toHaveBeenCalledWith(
        `${apiBase}/releases/latest`,
        expect.anything(),
      );
    },
  );

  it("local-mode stale-volume fallback fetches the pinned tag, not /releases/latest", async () => {
    process.env.BINARY_SOURCE = "local";
    process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
    process.env.BINARY_VERSION_FILE = "/fake/version";
    process.env.BREEZE_VERSION = "0.65.9";
    fsMocks.readdir.mockResolvedValue(["breeze-agent-linux-amd64"] as any);
    fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 4096 } as any);
    mockReadFileVersionOnly("0.65.8"); // stale: != BREEZE_VERSION
    const fetchSpy = stubNotFoundFetch();

    // The fallback failing is logged, not thrown (compound-failure path);
    // sync then proceeds with the stale local binaries.
    await syncBinaries();

    expect(fetchSpy).toHaveBeenCalledWith(
      `${apiBase}/releases/tags/v0.65.9`,
      expect.anything(),
    );
    expect(fetchSpy).not.toHaveBeenCalledWith(
      `${apiBase}/releases/latest`,
      expect.anything(),
    );
  });
});

describe("unpublished pinned release is loud, not a /releases/latest fallback (#3742)", () => {
  const originalEnv = process.env;
  const apiBase = "https://api.github.com/repos/lanternops/breeze";

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BINARY_GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO;
    delete process.env.BINARY_VERSION;
    delete process.env.APP_VERSION;
    delete process.env.BINARY_EDITION;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("github mode: logs the BINARY_VERSION remedy and rethrows (non-fatal in index.ts), never fetching /releases/latest", async () => {
    process.env.BINARY_SOURCE = "github";
    process.env.BREEZE_VERSION = "0.106.0"; // images ahead of the last published release
    const fetchSpy = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(syncBinaries()).rejects.toThrow(/GitHub API error: 404/);

    // The remedy wording changed with #3499: a failed sync no longer leaves the
    // download redirect disagreeing with agent_versions (the redirect follows
    // the promoted row now), so the hint says the fleet simply will not advance
    // rather than promising that setting BINARY_VERSION realigns the redirect.
    // It must still name BINARY_VERSION as the lever and still refuse the
    // /releases/latest fallback.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/pinned release v0\.106\.0 FAILED.*set BINARY_VERSION to a PUBLISHED release/s),
    );
    expect(fetchSpy).not.toHaveBeenCalledWith(
      `${apiBase}/releases/latest`,
      expect.anything(),
    );
    errorSpy.mockRestore();
  });

  it("local mode with an empty volume: fetches the pinned tag, logs, and does NOT crash boot", async () => {
    process.env.BINARY_SOURCE = "local";
    process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
    process.env.BINARY_VERSION_FILE = "/fake/version";
    process.env.BREEZE_VERSION = "0.106.0";
    fsMocks.readdir.mockResolvedValue([] as any);
    mockReadFileVersionOnly("0.106.0"); // volume version matches — not the stale path
    const fetchSpy = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(syncBinaries()).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledWith(
      `${apiBase}/releases/tags/v0.106.0`,
      expect.anything(),
    );
    expect(fetchSpy).not.toHaveBeenCalledWith(
      `${apiBase}/releases/latest`,
      expect.anything(),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/pinned release v0\.106\.0 FAILED/),
    );
    errorSpy.mockRestore();
  });
});
