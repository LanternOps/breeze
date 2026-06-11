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

// Multi-asset variant for tests that need the same signed manifest to cover
// both the agent and the user-helper sync loops (issue #816 / PR #845).
function makeSignedReleaseManifestMulti(
  assets: { name: string; buffer: Buffer }[],
  release = "v1.2.3",
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
      repository: "LanternOps/breeze",
      release,
      assets: assets.map((a) => ({
        name: a.name,
        sha256: checksums.get(a.name)!,
        size: a.buffer.length,
        platformTrust: "release-workflow-produced",
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

  it("logs at console.error (not warn) when stale-volume detection + GitHub fallback both fail (#644)", async () => {
    // Stale-volume path: BREEZE_VERSION != VERSION-file value.
    // We force the GitHub fallback to throw by making fetch reject. The
    // compound failure must surface as console.error so it's visible in
    // Sentry / log alerting — not buried as console.warn.
    process.env.BINARY_SOURCE = "local";
    process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
    process.env.BINARY_VERSION_FILE = "/fake/version";
    process.env.BREEZE_VERSION = "0.99.0"; // expected != on-disk

    fsMocks.readFile.mockResolvedValue("0.65.7" as any);

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
