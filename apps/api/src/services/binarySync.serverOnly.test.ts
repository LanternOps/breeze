import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Server-only hotfix releases rebuild only the server images and carry the
// previous full release's agent binaries forward. These tests pin the API side:
//  - syncFromGitHub verifies a release manifest's identity BEFORE it reads
//    releaseKind, and follows a server-only release's binariesRelease at most
//    one hop, to a verified FULL release built from binariesSourceCommit;
//  - a server-only boot (BREEZE_BINARIES_VERSION baked into the image) never
//    writes agent_versions, in either binary-source mode;
//  - a full-release image (BREEZE_BINARIES_VERSION empty) behaves exactly as
//    before.

const dbMocks = vi.hoisted(() => {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn(() => ({ onConflictDoUpdate }));
  const txInsert = vi.fn(() => ({ values: insertValues }));
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const txUpdate = vi.fn(() => ({ set: updateSet }));
  const tx = { update: txUpdate, insert: txInsert };
  return {
    insertValues,
    txInsert,
    txUpdate,
    select: vi.fn(),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn(tx)),
  };
});

vi.mock("../db", () => ({
  db: { transaction: dbMocks.transaction, select: dbMocks.select },
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
  assertOutsideHeldDbContext: () => {},
}));

vi.mock("./urlSafety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./urlSafety")>()),
  safeFetchFollowingRedirects: vi.fn((url: string, init?: RequestInit) =>
    globalThis.fetch(url, init),
  ),
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

const s3Mocks = vi.hoisted(() => ({
  isS3Configured: vi.fn(() => false),
  syncDirectory: vi.fn(
    async (_dir: string, _prefix: string): Promise<{ uploaded: number; skipped: number; errors: string[]; failedKeys: string[] }> =>
      ({ uploaded: 0, skipped: 0, errors: [], failedKeys: [] }),
  ),
}));
vi.mock("./s3Storage", () => s3Mocks);

vi.mock("./manifestSigning", () => ({
  ensureActiveSigningKey: vi.fn(async () => ({
    keyId: "deploy-test-aaaaaaaa",
    publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  })),
  signManifest: vi.fn(async () => "test-signature-base64"),
}));

vi.mock("./sentry", () => ({ captureException: vi.fn() }));

import {
  ServerOnlyReleaseError,
  syncBinaries,
  syncFromGitHub,
} from "./binarySync";

const API = "https://api.github.com/repos/lanternops/breeze";
const DL = "https://github.com/LanternOps/breeze/releases/download";
const BASE_SHA = "a".repeat(40);
const SERVER_SHA = "b".repeat(40);
const AGENT = "breeze-agent-linux-amd64";
const AGENT_BYTES = Buffer.from("base release linux agent");

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    publicKey: der.subarray(der.length - 32).toString("base64"),
    sign: (obj: unknown) => {
      const manifest = Buffer.from(JSON.stringify(obj));
      return {
        manifest,
        signature: Buffer.from(sign(null, manifest, privateKey).toString("base64")),
      };
    },
  };
}

function fullManifest(release: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    repository: "LanternOps/breeze",
    release,
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

function serverOnlyManifest(release: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    repository: "LanternOps/breeze",
    release,
    sourceCommit: SERVER_SHA,
    releaseKind: "server-only",
    binariesRelease: "v0.118.0",
    binariesSourceCommit: BASE_SHA,
    carriedImages: [],
    assets: [],
    ...extra,
  };
}

type SignedManifest = { manifest: Buffer; signature: Buffer };

function releaseJson(tag: string, signed: SignedManifest, withAgent: boolean) {
  return {
    tag_name: tag,
    body: `notes for ${tag}`,
    assets: [
      ...(withAgent
        ? [{ name: AGENT, browser_download_url: `${DL}/${tag}/${AGENT}`, size: AGENT_BYTES.length }]
        : []),
      { name: "checksums.txt", browser_download_url: `${DL}/${tag}/checksums.txt`, size: 100 },
      {
        name: "release-artifact-manifest.json",
        browser_download_url: `${DL}/${tag}/release-artifact-manifest.json`,
        size: signed.manifest.length,
      },
      {
        name: "release-artifact-manifest.json.ed25519",
        browser_download_url: `${DL}/${tag}/release-artifact-manifest.json.ed25519`,
        size: signed.signature.length,
      },
    ],
  };
}

/**
 * Routes GitHub API + release-asset URLs for a set of releases. `latest` names
 * the tag /releases/latest resolves to.
 */
function stubReleases(
  releases: Record<string, { signed: SignedManifest; withAgent: boolean }>,
  latest: string,
) {
  const fetchSpy = vi.fn(async (url: string) => {
    const tagFor = (u: string) =>
      u === `${API}/releases/latest` ? latest : u.startsWith(`${API}/releases/tags/`) ? u.slice(`${API}/releases/tags/`.length) : null;
    const apiTag = tagFor(url);
    if (apiTag !== null) {
      const r = releases[apiTag];
      if (!r) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(releaseJson(apiTag, r.signed, r.withAgent)));
    }
    for (const [tag, r] of Object.entries(releases)) {
      if (url === `${DL}/${tag}/checksums.txt`) {
        return new Response(
          r.withAgent ? `${createHash("sha256").update(AGENT_BYTES).digest("hex")}  ${AGENT}\n` : "",
        );
      }
      if (url === `${DL}/${tag}/release-artifact-manifest.json`) return new Response(new Uint8Array(r.signed.manifest));
      if (url === `${DL}/${tag}/release-artifact-manifest.json.ed25519`) return new Response(new Uint8Array(r.signed.signature));
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

const requested = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.map((c) => String(c[0]));

describe("server-only releases", () => {
  const originalEnv = process.env;
  let key: ReturnType<typeof keypair>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const name of [
      "BINARY_GITHUB_REPOSITORY",
      "GITHUB_REPO",
      "BINARY_VERSION",
      "BREEZE_VERSION",
      "BREEZE_BINARIES_VERSION",
      "APP_VERSION",
      "BINARY_EDITION",
      "BINARY_SOURCE",
      "AGENT_AUTO_PROMOTE",
      "RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS",
      "BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS",
      "RELEASE_ARTIFACT_MANIFEST_VERIFICATION",
    ]) {
      delete process.env[name];
    }
    process.env.NODE_ENV = "test";
    vi.clearAllMocks();
    s3Mocks.isS3Configured.mockReturnValue(false);
    key = keypair();
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = key.publicKey;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("syncFromGitHub: verify identity, then follow binariesRelease at most one hop", () => {
    it("pinned to a server-only release: refuses with ServerOnlyReleaseError naming the binaries release, writes nothing", async () => {
      const spy = stubReleases(
        {
          "v0.118.2": { signed: key.sign(serverOnlyManifest("v0.118.2")), withAgent: false },
          "v0.118.0": { signed: key.sign(fullManifest("v0.118.0")), withAgent: true },
        },
        "v0.118.2",
      );

      const err = await syncFromGitHub("v0.118.2").catch((e) => e);
      expect(err).toBeInstanceOf(ServerOnlyReleaseError);
      expect(err.message).toMatch(/v0\.118\.2 is a server-only release.*v0\.118\.0/);
      expect(err.binariesRelease).toBe("v0.118.0");
      expect(requested(spy)).not.toContain(`${API}/releases/tags/v0.118.0`);
      expect(dbMocks.transaction).not.toHaveBeenCalled();
    });

    it("unpinned (/releases/latest is server-only): follows exactly one hop and registers the binaries release", async () => {
      const spy = stubReleases(
        {
          "v0.118.2": { signed: key.sign(serverOnlyManifest("v0.118.2")), withAgent: false },
          "v0.118.0": { signed: key.sign(fullManifest("v0.118.0")), withAgent: true },
        },
        "v0.118.2",
      );

      const result = await syncFromGitHub();

      expect(result).toEqual({ version: "0.118.0", synced: ["agent:linux/amd64"], failed: [] });
      const apiCalls = requested(spy).filter((u) => u.startsWith(API));
      expect(apiCalls).toEqual([`${API}/releases/latest`, `${API}/releases/tags/v0.118.0`]);
      expect(dbMocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ version: "0.118.0", component: "agent" }),
      );
      for (const call of dbMocks.insertValues.mock.calls as unknown as [{ version: string }][]) {
        expect(call[0].version).not.toBe("0.118.2");
      }
    });

    it("refuses a chained hop: the binaries release is itself server-only (no third release fetch)", async () => {
      const spy = stubReleases(
        {
          "v0.118.2": { signed: key.sign(serverOnlyManifest("v0.118.2")), withAgent: false },
          "v0.118.0": {
            signed: key.sign(
              serverOnlyManifest("v0.118.0", {
                sourceCommit: BASE_SHA,
                binariesRelease: "v0.117.0",
              }),
            ),
            withAgent: false,
          },
        },
        "v0.118.2",
      );

      await expect(syncFromGitHub()).rejects.toThrow(/Binaries release v0\.118\.0 .* is not a full release/);
      expect(requested(spy)).not.toContain(`${API}/releases/tags/v0.117.0`);
      expect(dbMocks.transaction).not.toHaveBeenCalled();
    });

    it("refuses when the binaries release's sourceCommit is not binariesSourceCommit", async () => {
      stubReleases(
        {
          "v0.118.2": { signed: key.sign(serverOnlyManifest("v0.118.2")), withAgent: false },
          "v0.118.0": {
            signed: key.sign(fullManifest("v0.118.0", { sourceCommit: "c".repeat(40) })),
            withAgent: true,
          },
        },
        "v0.118.2",
      );

      await expect(syncFromGitHub()).rejects.toThrow(/source commit mismatch/);
      expect(dbMocks.transaction).not.toHaveBeenCalled();
    });

    it("never follows a server-only manifest whose signature does not verify", async () => {
      const forged = keypair().sign(serverOnlyManifest("v0.118.2"));
      const spy = stubReleases(
        {
          "v0.118.2": { signed: forged, withAgent: false },
          "v0.118.0": { signed: key.sign(fullManifest("v0.118.0")), withAgent: true },
        },
        "v0.118.2",
      );

      await expect(syncFromGitHub()).rejects.toThrow(/signature verification failed/);
      expect(requested(spy)).not.toContain(`${API}/releases/tags/v0.118.0`);
      expect(dbMocks.transaction).not.toHaveBeenCalled();
    });

    it("never follows a server-only manifest bound to another repository", async () => {
      const spy = stubReleases(
        {
          "v0.118.2": {
            signed: key.sign(serverOnlyManifest("v0.118.2", { repository: "evil/breeze" })),
            withAgent: false,
          },
          "v0.118.0": { signed: key.sign(fullManifest("v0.118.0")), withAgent: true },
        },
        "v0.118.2",
      );

      await expect(syncFromGitHub()).rejects.toThrow(/repository mismatch/);
      expect(requested(spy)).not.toContain(`${API}/releases/tags/v0.118.0`);
    });

    it("never reads releaseKind from an unverified manifest (no trust root, non-production)", async () => {
      delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const spy = stubReleases(
        {
          "v0.118.2": { signed: key.sign(serverOnlyManifest("v0.118.2")), withAgent: false },
          "v0.118.0": { signed: key.sign(fullManifest("v0.118.0")), withAgent: true },
        },
        "v0.118.2",
      );

      const result = await syncFromGitHub();

      expect(result.version).toBe("0.118.2");
      expect(requested(spy)).not.toContain(`${API}/releases/tags/v0.118.0`);
    });

    it("full releases are unchanged: a manifest carrying releaseKind full syncs its own assets, no extra fetch", async () => {
      const spy = stubReleases(
        {
          "v0.118.0": {
            signed: key.sign(fullManifest("v0.118.0", { releaseKind: "full" })),
            withAgent: true,
          },
        },
        "v0.118.0",
      );

      const result = await syncFromGitHub("v0.118.0");

      expect(result).toEqual({ version: "0.118.0", synced: ["agent:linux/amd64"], failed: [] });
      expect(requested(spy).filter((u) => u.startsWith(API))).toEqual([
        `${API}/releases/tags/v0.118.0`,
      ]);
    });
  });

  describe("server-only boots never write agent_versions", () => {
    function registrationRows(rows: { component: string }[]) {
      dbMocks.select.mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
      });
    }
    const complete = [{ component: "agent" }, { component: "backup" }];

    function localEnv(volumeVersion: string) {
      process.env.BINARY_SOURCE = "local";
      process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
      process.env.BINARY_VERSION_FILE = "/fake/version";
      fsMocks.readFile.mockImplementation((path: unknown) =>
        typeof path === "string" && path.includes("release-artifact-manifest")
          ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
          : Promise.resolve(volumeVersion),
      );
      fsMocks.readdir.mockResolvedValue([AGENT, "breeze-backup-linux-amd64"] as never);
      fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 4096 } as never);
    }

    it("github mode, paired release registered: no GitHub fetch, no write, one pairing log line", async () => {
      process.env.BINARY_SOURCE = "github";
      process.env.BREEZE_VERSION = "0.118.2";
      process.env.BREEZE_BINARIES_VERSION = "0.118.0";
      registrationRows(complete);
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await syncBinaries();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(dbMocks.transaction).not.toHaveBeenCalled();
      const pairingLines = logSpy.mock.calls.filter((c) =>
        String(c[0]).includes("server-only pairing"),
      );
      expect(pairingLines).toHaveLength(1);
      expect(String(pairingLines[0]?.[0])).toMatch(
        /server 0\.118\.2 pairs with binaries 0\.118\.0, already registered — skipping agent_versions registration/,
      );
    });

    it("github mode, paired release NOT registered (upgrade from an older release): still no write, warns with the remedy", async () => {
      process.env.BINARY_SOURCE = "github";
      process.env.BREEZE_VERSION = "0.118.2";
      process.env.BREEZE_BINARIES_VERSION = "0.118.0";
      registrationRows([]);
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await syncBinaries();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(dbMocks.transaction).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/binaries 0\.118\.0 is not fully registered.*sync-github\?version=v0\.118\.0/s),
      );
    });

    it("github mode with BINARY_VERSION also set: still no write (server-only boots never register)", async () => {
      process.env.BINARY_SOURCE = "github";
      process.env.BREEZE_VERSION = "0.118.2";
      process.env.BREEZE_BINARIES_VERSION = "0.118.0";
      process.env.BINARY_VERSION = "0.118.0";
      registrationRows([]);
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      vi.spyOn(console, "warn").mockImplementation(() => {});

      await syncBinaries();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(dbMocks.transaction).not.toHaveBeenCalled();
    });

    it("github mode, registration-state read fails: boot still does not crash or write", async () => {
      process.env.BINARY_SOURCE = "github";
      process.env.BREEZE_VERSION = "0.118.2";
      process.env.BREEZE_BINARIES_VERSION = "0.118.0";
      dbMocks.select.mockImplementation(() => {
        throw new Error("db down");
      });
      vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(syncBinaries()).resolves.toBeUndefined();
      expect(dbMocks.transaction).not.toHaveBeenCalled();
    });

    it("local mode, volume matches the pairing: no stale path, no GitHub fetch, no write, S3 offload still runs", async () => {
      localEnv("0.118.0");
      process.env.BREEZE_VERSION = "0.118.2";
      process.env.BREEZE_BINARIES_VERSION = "0.118.0";
      registrationRows(complete);
      s3Mocks.isS3Configured.mockReturnValue(true);
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});

      await syncBinaries();

      const all = [...warnSpy.mock.calls, ...errorSpy.mock.calls].map((c) => String(c[0]));
      expect(all.some((m) => /stale binaries volume/i.test(m))).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(dbMocks.transaction).not.toHaveBeenCalled();
      expect(s3Mocks.syncDirectory).toHaveBeenCalledWith(expect.any(String), "agent");
      expect(s3Mocks.syncDirectory).toHaveBeenCalledWith(expect.any(String), "viewer");
    });

    it("a failed S3 upload is an alertable error (log tag + Sentry), not a fatal boot error (#7574)", async () => {
      localEnv("0.118.0");
      process.env.BREEZE_VERSION = "0.118.2";
      process.env.BREEZE_BINARIES_VERSION = "0.118.0";
      registrationRows(complete);
      s3Mocks.isS3Configured.mockReturnValue(true);
      s3Mocks.syncDirectory.mockImplementation(async (_dir: string, prefix: string) =>
        prefix === "agent"
          ? {
              uploaded: 3,
              skipped: 0,
              errors: ["breeze-agent-linux-amd64: upload failed after 3 attempt(s): InternalError; previous object deleted"],
              failedKeys: ["agent/breeze-agent-linux-amd64"],
            }
          : { uploaded: 0, skipped: 1, errors: [], failedKeys: [] },
      );
      vi.stubGlobal("fetch", vi.fn());
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { captureException } = await import("./sentry");

      await expect(syncBinaries()).resolves.toBeUndefined();

      const errors = errorSpy.mock.calls.map((c) => String(c[0]));
      expect(
        errors.some((m) => m.includes("S3_SYNC_UPLOAD_FAILED prefix=agent keys=agent/breeze-agent-linux-amd64")),
      ).toBe(true);
      expect(errors.some((m) => m.includes("S3_SYNC_UPLOAD_FAILED prefix=viewer"))).toBe(false);
      expect(vi.mocked(captureException)).toHaveBeenCalledWith(
        expect.any(Error),
        undefined,
        expect.objectContaining({ binary_s3_sync: "upload_failed", binary_s3_prefix: "agent" }),
      );
    });

    it("local mode, hosted, volume behind the pairing: fails closed naming both versions and BREEZE_BINARIES_IMAGE_REF", async () => {
      localEnv("0.117.0");
      process.env.BINARY_EDITION = "hosted";
      process.env.BREEZE_VERSION = "0.118.2";
      process.env.BREEZE_BINARIES_VERSION = "0.118.0";
      registrationRows(complete);
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const err = await syncBinaries().catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/server 0\.118\.2 pairs with binaries 0\.118\.0; the volume has v0\.117\.0/);
      expect(err.message).toMatch(/BREEZE_BINARIES_IMAGE_REF to the 0\.118\.0 hosted digest/);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(dbMocks.transaction).not.toHaveBeenCalled();
    });

    it("local mode, self-host, volume behind the pairing: loud error, but no GitHub fallback and no write", async () => {
      localEnv("0.117.0");
      process.env.BREEZE_VERSION = "0.118.2";
      process.env.BREEZE_BINARIES_VERSION = "0.118.0";
      registrationRows(complete);
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});

      await expect(syncBinaries()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/server 0\.118\.2 pairs with binaries 0\.118\.0; the volume has v0\.117\.0/),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(dbMocks.transaction).not.toHaveBeenCalled();
    });
  });

  describe("full-release images are unchanged (BREEZE_BINARIES_VERSION baked empty)", () => {
    it("github mode still pins boot sync to BREEZE_VERSION", async () => {
      process.env.BINARY_SOURCE = "github";
      process.env.BREEZE_VERSION = "0.105.1";
      process.env.BREEZE_BINARIES_VERSION = "";
      const fetchSpy = vi.fn(async () => new Response("not found", { status: 404 }));
      vi.stubGlobal("fetch", fetchSpy);
      vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(syncBinaries()).rejects.toThrow(/GitHub API error/);
      expect(fetchSpy).toHaveBeenCalledWith(`${API}/releases/tags/v0.105.1`, expect.anything());
    });

    it("local mode stale detection still compares the volume to BREEZE_VERSION and falls back to GitHub", async () => {
      process.env.BINARY_SOURCE = "local";
      process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
      process.env.BINARY_VERSION_FILE = "/fake/version";
      process.env.BREEZE_VERSION = "0.65.9";
      process.env.BREEZE_BINARIES_VERSION = "";
      fsMocks.readFile.mockImplementation((path: unknown) =>
        typeof path === "string" && path.includes("release-artifact-manifest")
          ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
          : Promise.resolve("0.65.8"),
      );
      fsMocks.readdir.mockResolvedValue([AGENT] as never);
      fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 4096 } as never);
      const fetchSpy = vi.fn(async () => new Response("not found", { status: 404 }));
      vi.stubGlobal("fetch", fetchSpy);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      dbMocks.select.mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });

      await syncBinaries();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Stale binaries volume detected: volume has v0.65.8 but BREEZE_VERSION=0.65.9",
        ),
      );
      expect(fetchSpy).toHaveBeenCalledWith(`${API}/releases/tags/v0.65.9`, expect.anything());
    });
  });
});
