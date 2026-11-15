import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #11741 ("Also noted"): in BINARY_SOURCE=github mode the boot-time release
 * sync that failed because the database was read-only (SQLSTATE 25006) was
 * logged once and never retried, so the release stayed unregistered until the
 * next restart. It now joins the same deferral BINARY_SOURCE=local uses
 * (#11731): retried once the database accepts writes, visible on
 * /health/ready as `binarySyncPending`, and stopped on shutdown. Any other
 * failure behaves as before.
 */

const state = vi.hoisted(() => ({
  readOnly: true,
  inserts: [] as string[],
  // One entry per expected release lookup: an Error to throw, or "ok".
  net: [] as Array<Error | "ok">,
  netCalls: 0,
}));

function readOnlyError(): Error {
  return Object.assign(new Error("cannot execute UPDATE in a read-only transaction"), { code: "25006" });
}

vi.mock("../db", () => {
  const tx = {
    update: () => ({
      set: () => ({
        where: async () => {
          if (state.readOnly) throw readOnlyError();
        },
      }),
    }),
    insert: () => ({
      values: (v: { component: string; platform: string; architecture: string }) => ({
        onConflictDoUpdate: async () => {
          if (state.readOnly) throw readOnlyError();
          state.inserts.push(`${v.component}:${v.platform}/${v.architecture}`);
        },
      }),
    }),
  };
  return {
    db: {
      execute: vi.fn(async () => [{ ro: state.readOnly ? "on" : "off" }]),
      select: vi.fn(() => ({ from: () => ({ where: async () => [] }) })),
      transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    },
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    assertOutsideHeldDbContext: vi.fn(),
  };
});

const CHECKSUM = "a".repeat(64);
const BASE = "https://github.com/example/breeze/releases/download/v0.127.0";

vi.mock("./urlSafety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./urlSafety")>()),
  safeFetchFollowingRedirects: vi.fn(async (url: string) => {
    if (url.endsWith("/checksums.txt")) {
      return new Response(`${CHECKSUM}  breeze-agent-linux-amd64\n`, { status: 200 });
    }
    const step = state.net[state.netCalls++];
    if (step === undefined) throw new Error(`unexpected GitHub call #${state.netCalls}`);
    if (step instanceof Error) throw step;
    return new Response(
      JSON.stringify({
        tag_name: "v0.127.0",
        assets: [
          { name: "checksums.txt", browser_download_url: `${BASE}/checksums.txt`, size: 100 },
          { name: "breeze-agent-linux-amd64", browser_download_url: `${BASE}/breeze-agent-linux-amd64`, size: 1234 },
        ],
      }),
      { status: 200 },
    );
  }),
}));
vi.mock("./manifestSigning", () => ({
  ensureActiveSigningKey: vi.fn(async () => ({ keyId: "test-key", publicKeyB64: "x" })),
  signManifest: vi.fn(async () => "signature"),
}));
vi.mock("./s3Storage", () => ({ isS3Configured: () => false, syncDirectory: vi.fn() }));
vi.mock("./sentry", () => ({ captureException: vi.fn() }));

const savedEnv = { ...process.env };
let warnings: string[];
let errors: string[];
let logs: string[];

/** Boot's sync exactly as index.ts runs it: await it, hand a failure to the retry. */
async function bootSync(binarySync: typeof import("./binarySync")): Promise<boolean> {
  try {
    await binarySync.syncBinaries();
    return false;
  } catch (err) {
    return binarySync.scheduleGithubSyncRetry(err);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  process.env.BINARY_SOURCE = "github";
  process.env.BINARY_VERSION = "0.127.0";
  delete process.env.BREEZE_VERSION;
  delete process.env.APP_VERSION;
  delete process.env.BREEZE_BINARIES_VERSION;
  delete process.env.BINARY_EDITION;
  delete process.env.NODE_ENV;
  state.readOnly = true;
  state.inserts = [];
  state.net = [];
  state.netCalls = 0;
  warnings = [];
  errors = [];
  logs = [];
  const text = (args: unknown[]) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warnings.push(text(a)));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(text(a)));
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(text(a)));
  vi.resetModules();
});

afterEach(async () => {
  const binarySync = await import("./binarySync");
  binarySync.stopDeferredBinarySyncRetry();
  binarySync.stopGithubSyncRetry();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
});

describe("BINARY_SOURCE=github boot sync on a read-only database (#11741)", { timeout: 30_000 }, () => {
  it("defers a sync that failed read-only and completes it once the database accepts writes", async () => {
    state.net = ["ok", "ok"];
    const binarySync = await import("./binarySync");

    expect(await bootSync(binarySync)).toBe(true);
    expect(binarySync.isBinarySyncDeferred()).toBe(true);
    // A read-only failure is not a network failure: no backoff retry.
    expect(binarySync.isGithubSyncRetryPending()).toBe(false);
    expect(warnings.filter((w) => /binary registration deferred/.test(w))).toHaveLength(1);
    expect(state.inserts).toEqual([]);

    // Still read-only: the retry tick only probes, and does not call GitHub.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.netCalls).toBe(1);
    expect(binarySync.isBinarySyncDeferred()).toBe(true);

    // Writable: the next tick runs the sync again and it registers.
    state.readOnly = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.netCalls).toBe(2);
    expect(state.inserts).toEqual(["agent:linux/amd64"]);
    expect(binarySync.isBinarySyncDeferred()).toBe(false);
    expect(logs.some((l) => /Deferred binary registration completed/.test(l))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(errors.filter((e) => /restart the API/.test(e))).toEqual([]);
  });

  it("hands a network failure on the deferred retry to the bounded GitHub retry", async () => {
    const timedOut = new Error("request timed out after 30000ms");
    state.net = ["ok", timedOut, "ok"];
    const binarySync = await import("./binarySync");

    expect(await bootSync(binarySync)).toBe(true);
    expect(binarySync.isBinarySyncDeferred()).toBe(true);

    state.readOnly = false;
    await binarySync.retryDeferredBinarySync();
    expect(state.netCalls).toBe(2);
    // The database is writable now; what is left is a network retry.
    expect(binarySync.isBinarySyncDeferred()).toBe(false);
    expect(binarySync.isGithubSyncRetryPending()).toBe(true);
    expect(errors.filter((e) => /restart the API/.test(e))).toEqual([]);

    await vi.advanceTimersByTimeAsync(binarySync.GITHUB_SYNC_RETRY_DELAYS_MS[0]!);
    expect(state.netCalls).toBe(3);
    expect(state.inserts).toEqual(["agent:linux/amd64"]);
    expect(binarySync.isGithubSyncRetryPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defers when a network retry reaches a database that went read-only", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 192.0.2.1:443"), { code: "ECONNREFUSED" });
    state.readOnly = false;
    state.net = [refused, "ok"];
    const binarySync = await import("./binarySync");

    expect(await bootSync(binarySync)).toBe(true);
    expect(binarySync.isGithubSyncRetryPending()).toBe(true);

    state.readOnly = true;
    await vi.advanceTimersByTimeAsync(binarySync.GITHUB_SYNC_RETRY_DELAYS_MS[0]!);
    expect(state.netCalls).toBe(2);
    expect(binarySync.isGithubSyncRetryPending()).toBe(false);
    expect(binarySync.isBinarySyncDeferred()).toBe(true);
    // Not reported as a failed retry: it is waiting for the database.
    expect(errors.filter((e) => /not retrying again/.test(e))).toEqual([]);
  });

  it("does not defer after shutdown stopped the GitHub retry", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 192.0.2.1:443"), { code: "ECONNREFUSED" });
    state.readOnly = false;
    let release!: () => void;
    state.net = [refused];
    const binarySync = await import("./binarySync");
    expect(await bootSync(binarySync)).toBe(true);

    // The retry's release lookup is in flight when shutdown runs, and the
    // database turns read-only underneath it.
    state.net.push("ok");
    const { safeFetchFollowingRedirects } = await import("./urlSafety");
    const real = vi.mocked(safeFetchFollowingRedirects).getMockImplementation()!;
    vi.mocked(safeFetchFollowingRedirects).mockImplementationOnce(
      (...args) => new Promise((resolve) => { release = () => resolve(real(...args)); }),
    );
    await vi.advanceTimersByTimeAsync(binarySync.GITHUB_SYNC_RETRY_DELAYS_MS[0]!);
    binarySync.stopDeferredBinarySyncRetry();
    binarySync.stopGithubSyncRetry();
    state.readOnly = true;
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(binarySync.isBinarySyncDeferred()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves any other failure as boot reported it (unchanged)", async () => {
    state.readOnly = false;
    state.net = [new Error("GitHub API error: 404")];
    const binarySync = await import("./binarySync");

    expect(await bootSync(binarySync)).toBe(false);
    expect(binarySync.isBinarySyncDeferred()).toBe(false);
    expect(binarySync.isGithubSyncRetryPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
