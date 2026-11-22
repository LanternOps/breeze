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

type Row = { version: string; component: string; platform: string; architecture: string };

const state = vi.hoisted(() => ({
  readOnly: true,
  // Refuse one write as read-only although the probe may read writable (a
  // stale pooled session, or the database flipping mid-sync).
  refuse: null as null | ((v: Row) => boolean),
  inserts: [] as string[],
  // Extra release assets beyond the linux/amd64 agent.
  extraAssets: [] as string[],
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
      values: (v: Row) => ({
        onConflictDoUpdate: async () => {
          if (state.readOnly || state.refuse?.(v)) throw readOnlyError();
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
const BASE = "https://github.com/example/breeze/releases/download";

vi.mock("./urlSafety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./urlSafety")>()),
  safeFetchFollowingRedirects: vi.fn(async (url: string) => {
    const names = ["breeze-agent-linux-amd64", ...state.extraAssets];
    if (url.endsWith("/checksums.txt")) {
      return new Response(names.map((n) => `${CHECKSUM}  ${n}\n`).join(""), { status: 200 });
    }
    const step = state.net[state.netCalls++];
    if (step === undefined) throw new Error(`unexpected GitHub call #${state.netCalls}`);
    if (step instanceof Error) throw step;
    const tag = url.match(/\/releases\/tags\/(v[^/]+)$/)?.[1] ?? "v0.127.0";
    return new Response(
      JSON.stringify({
        tag_name: tag,
        assets: [
          { name: "checksums.txt", browser_download_url: `${BASE}/${tag}/checksums.txt`, size: 100 },
          ...names.map((n) => ({ name: n, browser_download_url: `${BASE}/${tag}/${n}`, size: 1234 })),
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
  state.refuse = null;
  state.extraAssets = [];
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

  it("defers a boot sync where only some writes were refused, instead of reading as done", async () => {
    state.readOnly = false;
    state.extraAssets = ["breeze-agent-linux-arm64"];
    state.refuse = (v) => v.architecture === "arm64";
    state.net = ["ok", "ok"];
    const binarySync = await import("./binarySync");

    expect(await bootSync(binarySync)).toBe(true);
    expect(binarySync.isBinarySyncDeferred()).toBe(true);

    state.refuse = null;
    await binarySync.retryDeferredBinarySync();
    expect(binarySync.isBinarySyncDeferred()).toBe(false);
    expect(state.inserts).toContain("agent:linux/arm64");
  });

  it("defers when only a backup write is refused", async () => {
    state.readOnly = false;
    state.extraAssets = ["breeze-backup-linux-amd64"];
    state.refuse = (v) => v.component === "backup";
    state.net = ["ok"];
    const binarySync = await import("./binarySync");

    expect(await bootSync(binarySync)).toBe(true);
    expect(binarySync.isBinarySyncDeferred()).toBe(true);
  });

  it("defers when the current-version safety net's writes are refused", async () => {
    // /releases/latest registers fine; the running RC's own release is
    // refused (the safety net used to log that and carry on).
    process.env.APP_VERSION = "0.128.0-rc.1";
    state.readOnly = false;
    state.refuse = (v) => v.version === "0.128.0-rc.1";
    state.net = ["ok", "ok"];
    const binarySync = await import("./binarySync");

    expect(await bootSync(binarySync)).toBe(true);
    expect(state.netCalls).toBe(2);
    expect(state.inserts).toEqual(["agent:linux/amd64"]);
    expect(binarySync.isBinarySyncDeferred()).toBe(true);
  });

  it("does not hand a network failure on to a GitHub retry stopped by shutdown", async () => {
    state.net = ["ok"];
    const binarySync = await import("./binarySync");
    expect(await bootSync(binarySync)).toBe(true);

    state.readOnly = false;
    let fail!: (e: Error) => void;
    const { safeFetchFollowingRedirects } = await import("./urlSafety");
    vi.mocked(safeFetchFollowingRedirects).mockImplementationOnce(
      () => new Promise<Response>((_resolve, reject) => { fail = reject; }),
    );
    const retry = binarySync.retryDeferredBinarySync();
    await vi.advanceTimersByTimeAsync(0);
    binarySync.stopDeferredBinarySyncRetry();
    binarySync.stopGithubSyncRetry();
    fail(new Error("request timed out after 30000ms"));
    await retry;

    expect(binarySync.isGithubSyncRetryPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(errors.filter((e) => /restart the API/.test(e))).toEqual([]);
    const { captureException } = await import("./sentry");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("schedules nothing for a boot failure that arrives after shutdown", async () => {
    const binarySync = await import("./binarySync");
    binarySync.stopDeferredBinarySyncRetry();
    binarySync.stopGithubSyncRetry();

    const readOnly = Object.assign(new Error("cannot execute INSERT in a read-only transaction"), { code: "25006" });
    expect(binarySync.scheduleGithubSyncRetry(readOnly)).toBe(false);
    expect(binarySync.scheduleGithubSyncRetry(new Error("request timed out after 30000ms"))).toBe(false);
    expect(binarySync.isBinarySyncDeferred()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reminds every 30 retries when the database reads writable but writes are still refused", async () => {
    state.net = Array.from({ length: 31 }, () => "ok" as const);
    const binarySync = await import("./binarySync");
    expect(await bootSync(binarySync)).toBe(true);

    state.readOnly = false;
    state.refuse = () => true;
    for (let i = 0; i < 29; i += 1) await binarySync.retryDeferredBinarySync();
    const reminder = (w: string) => /writes were still refused 30 times/.test(w);
    expect(warnings.filter(reminder)).toEqual([]);
    await binarySync.retryDeferredBinarySync();
    expect(warnings.filter(reminder)).toHaveLength(1);
    expect(binarySync.isBinarySyncDeferred()).toBe(true);
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
