/**
 * SSRF regression suite for binarySync's outbound release fetches (#4262).
 *
 * #3649 (PR #4255) routed `releaseArtifactManifest.ts` through the guarded
 * helper, but `binarySync.ts` reached the network by a second, structurally
 * parallel path that fetched **the very same two artifacts** —
 * `release-artifact-manifest.json` and its `.ed25519` signature — with a bare
 * `fetch`. So the module was closed and the artifact was not. This file pins
 * the other path shut.
 *
 * Two properties, and both matter:
 *
 *   1. Normal GitHub redirects still work. Release asset URLs 302 from
 *      `github.com` to `objects.githubusercontent.com`, and this code runs at
 *      BOOT under `BINARY_SOURCE=github` — an over-tight guard here would be an
 *      availability bug on the startup path, not a security win.
 *   2. Every hop is independently DNS-resolved, filtered and IP-pinned, so a
 *      redirect into loopback / link-local / RFC1918 is refused rather than
 *      followed.
 *
 * This file deliberately does NOT mock `./urlSafety` — the guard runs for real.
 * Only DNS (`__setLookupForTests`) and the socket layer are stubbed, so every
 * host that would actually be dialed is recorded and assertable. The socket
 * harness is the one from `releaseArtifactManifest.redirect.test.ts`.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn(() => ({ onConflictDoUpdate }));
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const tx = {
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhere })) })),
  };
  return {
    insertValues,
    transaction: vi.fn(async (fn: (t: unknown) => Promise<void>) => fn(tx)),
    select: vi.fn(),
  };
});

vi.mock("../db", () => ({
  db: { transaction: dbMocks.transaction, select: dbMocks.select },
  // safeFetch calls this (#1105 tripwire) and the real `../db` is mocked away.
  assertOutsideHeldDbContext: vi.fn(),
}));

// Settable rather than fixed: the local-mode case below (site 4) needs readdir
// and the version file to describe a populated binaries volume.
const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("node:fs/promises", () => fsMocks);

// Spread the original: the source-scan case needs the REAL `readFileSync`, so
// this may only override `createReadStream` (used for local checksumming).
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  createReadStream: () => {
    const { Readable } = require("node:stream");
    return Readable.from(Buffer.from("local agent bytes"));
  },
}));

vi.mock("./s3Storage", () => ({
  isS3Configured: () => false,
  syncDirectory: vi.fn(),
}));

vi.mock("./manifestSigning", () => ({
  ensureActiveSigningKey: vi.fn(async () => ({
    keyId: "deploy-test-aaaaaaaa",
    publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  })),
  signManifest: vi.fn(async () => "test-signature-base64"),
}));

vi.mock("./sentry", () => ({ captureException: vi.fn() }));

import { syncBinaries, syncFromGitHub } from "./binarySync";
import { requiredPlatformTrustFor } from "./releaseAssetTrust";
import {
  ResponseTooLargeError,
  SsrfBlockedError,
  __setLookupForTests,
} from "./urlSafety";

type StubbedResponse =
  | { status: number; headers?: Record<string, string>; body?: Buffer }
  | { networkError: string };

interface RecordedRequest {
  protocol: "http" | "https";
  host: string;
  path: string;
}

/** Signed-asset redirects carry a `?token=`, so path comparisons ignore it. */
function pathWithoutQuery(path: string): string {
  return path.split("?")[0] ?? path;
}

function installRequestStub(handler: (req: RecordedRequest) => StubbedResponse): {
  requests: RecordedRequest[];
  restore: () => void;
} {
  const requests: RecordedRequest[] = [];

  const makeImpl = (protocol: "http" | "https") =>
    ((options: any, callback?: any) => {
      const recorded: RecordedRequest = {
        protocol,
        host: String(options.host),
        path: String(options.path),
      };
      requests.push(recorded);
      const outcome = handler(recorded);

      const req = new EventEmitter() as any;
      req.write = vi.fn();
      req.destroy = vi.fn();
      req.setTimeout = vi.fn();
      req.end = vi.fn(() => {
        if ("networkError" in outcome) {
          req.emit("error", new Error(outcome.networkError));
          return;
        }
        const res = new EventEmitter() as any;
        res.statusCode = outcome.status;
        res.statusMessage = "";
        res.headers = outcome.headers ?? {};
        res.setEncoding = vi.fn();
        callback?.(res);
        if (outcome.body) res.emit("data", outcome.body);
        res.emit("end");
      });
      return req;
    }) as any;

  const httpsSpy = vi.spyOn(https, "request").mockImplementation(makeImpl("https"));
  const httpSpy = vi.spyOn(http, "request").mockImplementation(makeImpl("http"));
  return {
    requests,
    restore: () => {
      httpsSpy.mockRestore();
      httpSpy.mockRestore();
    },
  };
}

const REPO = "acme/breeze-selfhost-signing";
const ASSET_NAME = "breeze-agent-linux-amd64";
const ASSET_BYTES = Buffer.from("self-hosted agent bytes");
const API_HOST = "api.github.com";
const API_PATH = `/repos/${REPO}/releases/latest`;
const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download/v1.2.3`;

function makeSignedManifest() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      repository: REPO,
      release: "v1.2.3",
      assets: [
        {
          name: ASSET_NAME,
          sha256: createHash("sha256").update(ASSET_BYTES).digest("hex"),
          size: ASSET_BYTES.length,
          platformTrust:
            requiredPlatformTrustFor(ASSET_NAME) ?? "release-workflow-produced",
        },
      ],
    }),
  );
  return {
    manifest,
    signature: Buffer.from(sign(null, manifest, privateKey).toString("base64")),
    publicKey: publicDer.subarray(publicDer.length - 32).toString("base64"),
  };
}

/** The GitHub Releases API payload, with or without the signed-manifest pair. */
function releaseJson(opts: { withManifest: boolean }): Buffer {
  const assets: Record<string, unknown>[] = [
    {
      name: ASSET_NAME,
      browser_download_url: `${DOWNLOAD_BASE}/${ASSET_NAME}`,
      size: ASSET_BYTES.length,
    },
  ];
  if (opts.withManifest) {
    assets.push(
      {
        name: "release-artifact-manifest.json",
        browser_download_url: `${DOWNLOAD_BASE}/release-artifact-manifest.json`,
      },
      {
        name: "release-artifact-manifest.json.ed25519",
        browser_download_url: `${DOWNLOAD_BASE}/release-artifact-manifest.json.ed25519`,
      },
    );
  } else {
    assets.push({
      name: "checksums.txt",
      browser_download_url: `${DOWNLOAD_BASE}/checksums.txt`,
    });
  }
  return Buffer.from(
    JSON.stringify({ tag_name: "v1.2.3", body: "release notes", assets }),
  );
}

const METADATA_IP = "169.254.169.254";

describe("binarySync — SSRF-guarded release fetches (#4262)", () => {
  const originalEnv = process.env;
  let restoreRequests: (() => void) | undefined;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.BINARY_GITHUB_REPOSITORY = REPO;
    delete process.env.GITHUB_REPO;
    vi.clearAllMocks();
    // Default: an EMPTY binaries volume, so the syncFromGitHub cases below are
    // not accidentally rescued by local registration.
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"));
    fsMocks.readdir.mockResolvedValue([]);
    fsMocks.stat.mockRejectedValue(new Error("ENOENT"));
    __setLookupForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    process.env = originalEnv;
    __setLookupForTests(null);
    restoreRequests?.();
    restoreRequests = undefined;
  });

  it("still follows the normal github.com → objects.githubusercontent.com redirect", async () => {
    // The point of this case: GitHub release assets CANNOT be fetched without
    // following redirects, and this path runs at boot. A guard that refused the
    // legitimate hop would break every BINARY_SOURCE=github deployment.
    const signed = makeSignedManifest();
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const stub = installRequestStub((req) => {
      if (req.host === API_HOST) {
        return { status: 200, body: releaseJson({ withManifest: true }) };
      }
      if (req.host === "github.com") {
        return {
          status: 302,
          headers: {
            location: `https://objects.githubusercontent.com/breeze${req.path}?token=abc`,
          },
        };
      }
      if (req.host === "objects.githubusercontent.com") {
        return {
          status: 200,
          body: pathWithoutQuery(req.path).endsWith(".ed25519")
            ? signed.signature
            : signed.manifest,
        };
      }
      return { status: 404, body: Buffer.from("not found") };
    });
    restoreRequests = stub.restore;

    const result = await syncFromGitHub();
    expect(result.synced).toContain("agent:linux/amd64");

    // Both artifacts were fetched through the redirect, in order, and the
    // redirect target really was dialed (not merely returned as a 302).
    const hostsFor = (suffix: string) =>
      stub.requests
        .filter((req) => pathWithoutQuery(req.path).endsWith(suffix))
        .map((req) => req.host);
    expect(hostsFor("/release-artifact-manifest.json")).toEqual([
      "github.com",
      "objects.githubusercontent.com",
    ]);
    expect(hostsFor("/release-artifact-manifest.json.ed25519")).toEqual([
      "github.com",
      "objects.githubusercontent.com",
    ]);
  });

  it("REFUSES a GitHub API redirect into cloud metadata without dialing it", async () => {
    // Site :1090 — the release-listing call that starts the whole sync.
    const stub = installRequestStub((req) =>
      req.host === API_HOST
        ? {
            status: 302,
            headers: { location: `http://${METADATA_IP}/latest/meta-data/iam/` },
          }
        : { status: 200, body: Buffer.from("unexpected") },
    );
    restoreRequests = stub.restore;

    const err = await syncFromGitHub().catch((error) => error);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(stub.requests.map((req) => req.host)).not.toContain(METADATA_IP);
    expect(stub.requests).toHaveLength(1);
  });

  it("REFUSES a manifest-asset redirect into cloud metadata without dialing it", async () => {
    // Site :159 — `fetchReleaseAssetBuffer`, which pulls
    // release-artifact-manifest.json and its .ed25519 signature. This is the
    // exact artifact pair #3649 was filed about and the reason this issue
    // exists: closing releaseArtifactManifest.ts did not close this path.
    const signed = makeSignedManifest();
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const stub = installRequestStub((req) => {
      if (req.host === API_HOST) {
        return { status: 200, body: releaseJson({ withManifest: true }) };
      }
      if (req.host === "github.com") {
        return {
          status: 302,
          headers: { location: `http://${METADATA_IP}/latest/meta-data/iam/` },
        };
      }
      return { status: 200, body: Buffer.from("unexpected") };
    });
    restoreRequests = stub.restore;

    const err = await syncFromGitHub().catch((error) => error);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(String(err)).toMatch(/169\.254\.169\.254/);
    expect(stub.requests.map((req) => req.host)).not.toContain(METADATA_IP);
    // `not.toContain` alone would pass on an EMPTY request list, so pin the
    // positive shape too. The manifest and its signature are fetched
    // concurrently (Promise.all), so the github.com hop count is 1 or 2
    // depending on scheduling — assert the SET of hosts and a floor, not an
    // exact sequence.
    expect(stub.requests.length).toBeGreaterThanOrEqual(2);
    expect(new Set(stub.requests.map((req) => req.host))).toEqual(
      new Set([API_HOST, "github.com"]),
    );
  });

  it("REFUSES a checksums.txt redirect to a host that RESOLVES into RFC1918", async () => {
    // Site :224 — the integrity FALLBACK used when no signed manifest is
    // published, so it is the last thing that should be reachable by an
    // unvalidated redirect. This is also the deeper bypass shape: the Location
    // looks public and only DNS resolution reveals 192.168.1.10.
    delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    __setLookupForTests(async (hostname: string) =>
      hostname === "internal.example"
        ? [{ address: "192.168.1.10", family: 4 }]
        : [{ address: "93.184.216.34", family: 4 }],
    );

    const stub = installRequestStub((req) => {
      if (req.host === API_HOST) {
        return { status: 200, body: releaseJson({ withManifest: false }) };
      }
      if (req.host === "github.com") {
        return {
          status: 302,
          headers: { location: "https://internal.example/checksums.txt" },
        };
      }
      return { status: 200, body: Buffer.from("unexpected") };
    });
    restoreRequests = stub.restore;

    const err = await syncFromGitHub().catch((error) => error);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(String(err)).toMatch(/internal\.example|192\.168\.1\.10/);
    expect(stub.requests.map((req) => req.host)).not.toContain("internal.example");
    // Positive shape, so the `not.toContain` above cannot pass on an empty
    // list: exactly the API call and the one refused hop. checksums.txt is a
    // single fetch, so unlike the manifest pair this count IS deterministic.
    expect(stub.requests.map((req) => req.host)).toEqual([API_HOST, "github.com"]);
  });

  it("aborts an oversized manifest at the streaming ceiling", async () => {
    // `maxBytes` fires DURING the response stream: the socket is destroyed and
    // ResponseTooLargeError thrown, so a TRUNCATED manifest is never handed on
    // to signature verification — which is the dangerous way to fail here. The
    // bare `fetch` this replaced had no ceiling at all.
    const signed = makeSignedManifest();
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    // Served from the REDIRECT TARGET, not from the first hop. In production
    // every release-asset fetch redirects to objects.githubusercontent.com, so
    // the ceiling that actually protects the boot path is the one applied on
    // hop 2. `safeFetchFollowingRedirects` carries `maxBytes` across a hop only
    // because its per-hop init spread preserves it — and no test in this repo
    // pinned that (urlSafety.test.ts exercises maxBytes on bare `safeFetch`
    // only). A refactor of that spread would otherwise go unnoticed.
    const oversized = Buffer.alloc(1024 * 1024 + 1, 0x61);
    const stub = installRequestStub((req) => {
      if (req.host === API_HOST) {
        return { status: 200, body: releaseJson({ withManifest: true }) };
      }
      if (req.host === "github.com") {
        return {
          status: 302,
          headers: {
            location: `https://objects.githubusercontent.com/breeze${req.path}?token=abc`,
          },
        };
      }
      return pathWithoutQuery(req.path).endsWith(".ed25519")
        ? { status: 200, body: signed.signature }
        : { status: 200, body: oversized };
    });
    restoreRequests = stub.restore;

    const err = await syncFromGitHub().catch((error) => error);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    // The overrun really did happen on the far side of the redirect.
    expect(stub.requests.map((req) => req.host)).toContain(
      "objects.githubusercontent.com",
    );
  });

  it("REFUSES the backup-backfill redirect, and says so instead of failing mute", async () => {
    // Site :1474 (`backfillBackupRowsForVersion`) is the ONE call site not
    // reachable from syncFromGitHub — it hangs off syncBinaries() →
    // ensureCurrentVersionRegistered(). It is also the site whose failure is
    // SWALLOWED by a catch that only console.errors, so a regression here is
    // silent by construction. That inverts the usual priority: this is the site
    // where a behavioral test earns the most, not the least.
    process.env.BINARY_SOURCE = "local";
    process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
    process.env.BINARY_VERSION_FILE = "/fake/version";
    process.env.BREEZE_VERSION = "0.65.9";
    fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 4096 } as never);
    fsMocks.readFile.mockResolvedValue("0.65.9" as never);
    fsMocks.readdir.mockResolvedValue([
      "breeze-agent-linux-amd64",
      "breeze-backup-linux-amd64",
    ] as never);
    // Agent row registered, backup row missing — the state that triggers the
    // narrow backfill.
    dbMocks.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ component: "agent" }]),
      }),
    });

    const stub = installRequestStub((req) =>
      req.host === API_HOST
        ? {
            status: 302,
            headers: { location: `http://${METADATA_IP}/latest/meta-data/iam/` },
          }
        : { status: 200, body: Buffer.from("unexpected") },
    );
    restoreRequests = stub.restore;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Deliberately does NOT reject: the caller swallows it. That is existing,
    // intended behavior (a transient failure must not take boot down), so the
    // assertion is on the guard holding and the refusal being REPORTED.
    await expect(syncBinaries()).resolves.toBeUndefined();

    expect(stub.requests.map((req) => req.host)).not.toContain(METADATA_IP);
    expect(stub.requests.map((req) => req.host)).toEqual([API_HOST]);
    // The backfill was genuinely attempted against the pinned tag — otherwise
    // the assertions above would hold vacuously for a code path never entered.
    expect(stub.requests[0]?.path).toContain("/releases/tags/v0.65.9");
    // And the swallow is not mute: the operator gets the guard named, plus the
    // host and resolved address, which live on the error's properties rather
    // than in its message.
    const logged = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain("Failed to auto-sync version 0.65.9");
    expect(logged).toContain("BLOCKED BY SSRF GUARD");
    expect(logged).toContain(METADATA_IP);

    errorSpy.mockRestore();
  });

  it("contains no raw fetch call, and every outbound call is guarded and capped", () => {
    // The perishable half of this fix is the four call sites; this is the
    // durable half. A future bare `fetch` in this module fails CI rather than
    // quietly reopening the hole — the same anti-regrowth contract
    // `releaseArtifactManifest.redirect.test.ts` and
    // `backupSsrfAdoption.test.ts` apply to their surfaces.
    const raw = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "binarySync.ts"),
      "utf8",
    );

    // Scan CODE, not prose. The forbidden list below includes bare words like
    // `undici` and `axios`, and this module's comments legitimately discuss
    // them — a comment explaining what undici does across a redirect would
    // otherwise red this test. (That fails safe rather than open, but it sends
    // the next person word-policing their comments instead of fixing code.)
    //
    // Deliberately conservative: only block comments and comments occupying a
    // WHOLE line are removed. Stripping trailing `//` comments would have to
    // cope with `"https://…"` inside string literals, and a regex that got it
    // wrong there would silently delete real code from the scan — a false
    // NEGATIVE on a security control, which is the one direction that must not
    // happen. A trailing comment can still trip this; that is the safe way to
    // be wrong.
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    // Guard the strip itself: if a regex change ever nuked the file, every
    // `not.toMatch` below would pass vacuously.
    expect(source).toContain("safeFetchFollowingRedirects");
    expect(source.length).toBeGreaterThan(raw.length / 2);

    // Banning only `fetch` is too narrow — a reintroduction could just as
    // easily use `https.request` or axios and satisfy a fetch-only scan. This
    // mirrors the FORBIDDEN list already used by `backupSsrfAdoption.test.ts`
    // for the backup surface.
    const FORBIDDEN: Array<[string, RegExp]> = [
      // Bare `fetch(` — exactly what a revert would look like. The lookbehind
      // exempts `.fetch`/`safeFetch`, so the next entry covers those.
      ["bare fetch(", /(?<![.\w])fetch\s*\(/],
      [
        "qualified global fetch(",
        /\b(?:globalThis|window|global)\s*\.\s*fetch\s*\(/,
      ],
      // Indexed and indirect spellings that evade the two patterns above.
      ["indexed global fetch", /\b(?:globalThis|window|global)\s*\[\s*["'`]fetch/],
      ["fetch.call/.apply", /(?<![.\w])fetch\s*\.\s*(?:call|apply|bind)\s*\(/],
      ["http(s).request(", /\bhttps?\s*\.\s*request\s*\(/],
      ["http(s).get(", /\bhttps?\s*\.\s*get\s*\(/],
      ["axios", /\baxios\b/],
      ["undici", /\bundici\b/],
      ["new http(s).Agent(", /new\s+https?\s*\.\s*Agent\s*\(/],
      // SSRF-guarded but UNCAPPED: bare `safeFetch(` takes no redirect budget
      // and evades the per-call-site maxBytes loop below entirely, so it would
      // otherwise be a silent way to add an unbounded outbound call here.
      ["uncapped safeFetch(", /(?<![.\w])safeFetch\s*\(/],
    ];
    for (const [label, pattern] of FORBIDDEN) {
      expect(
        source,
        `binarySync.ts must not reach the network via ${label} — route it through ` +
          "safeFetchFollowingRedirects with a maxBytes ceiling (services/urlSafety.ts).",
      ).not.toMatch(pattern);
    }

    // Positive half: the helper must actually be CALLED, not merely imported —
    // an orphaned import would satisfy a bare identifier match. Pin the count
    // too, so deleting a call site cannot pass this test the way an empty file
    // would. This is a DELETION tripwire, not a completeness check: adding a
    // legitimate fifth guarded call site is expected to fail here once, so that
    // a human confirms it carries a ceiling and a timeout.
    const CALL_SITE = /safeFetchFollowingRedirects\s*\(/g;
    const offsets = [...source.matchAll(CALL_SITE)].map((m) => m.index ?? 0);
    expect(
      offsets,
      "binarySync.ts should have exactly 4 guarded outbound call sites; if you " +
        "added or removed one deliberately, update this count and confirm the " +
        "new site passes maxBytes and timeoutMs.",
    ).toHaveLength(4);

    // Every one of them carries BOTH ceilings. Bytes without time still lets a
    // hung socket pin a pooled DB connection (these all run inside a held
    // context); time without bytes still lets a huge body be buffered.
    //
    // The window is clamped at the NEXT call site rather than a fixed length,
    // so a new site cannot borrow its neighbour's `maxBytes:` match. The value
    // must be a named constant or a literal — `maxBytes: undefined` satisfies a
    // bare /maxBytes:/ while disabling the ceiling entirely.
    offsets.forEach((start, i) => {
      const end = offsets[i + 1] ?? source.length;
      const callSite = source.slice(start, Math.min(end, start + 600));
      expect(
        callSite,
        `call site at offset ${start} must pass a real maxBytes`,
      ).toMatch(/maxBytes:\s*(?:[A-Z][A-Z0-9_]*|\d)/);
      expect(
        callSite,
        `call site at offset ${start} must pass a real timeoutMs`,
      ).toMatch(/timeoutMs:\s*(?:[A-Z][A-Z0-9_]*|\d)/);
    });
  });
});
