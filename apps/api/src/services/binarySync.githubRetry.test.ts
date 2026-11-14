import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #11641: in BINARY_SOURCE=github mode a network failure during the boot-time
 * release sync used to be logged once and never retried, leaving the pinned
 * release unregistered until some later restart. Boot now hands a network
 * failure to a bounded background retry, logging every attempt and ending in
 * an explicit error when the retries run out.
 */

const net = vi.hoisted(() => ({
  // One entry per expected GitHub API call: an Error to throw, or "ok".
  script: [] as Array<Error | "ok">,
  calls: 0,
}));

vi.mock("../db", () => ({
  db: {
    execute: vi.fn(async () => [{ ro: "off" }]),
    select: vi.fn(() => ({ from: () => ({ where: async () => [] }) })),
    transaction: vi.fn(async (fn: (t: unknown) => Promise<void>) =>
      fn({
        update: () => ({ set: () => ({ where: async () => undefined }) }),
        insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
      }),
    ),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  assertOutsideHeldDbContext: vi.fn(),
}));
vi.mock("./urlSafety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./urlSafety")>()),
  safeFetchFollowingRedirects: vi.fn(async (url: string) => {
    // A successful release lookup is followed by its (empty) checksums file:
    // a release with no binaries for this platform set, which registers nothing.
    if (url.endsWith("/checksums.txt")) return new Response("", { status: 200 });
    const step = net.script[net.calls++];
    if (step === undefined) throw new Error(`unexpected GitHub call #${net.calls}`);
    if (step instanceof Error) throw step;
    const checksums = "https://github.com/example/breeze/releases/download/v0.127.0/checksums.txt";
    return new Response(
      JSON.stringify({ tag_name: "v0.127.0", assets: [{ name: "checksums.txt", browser_download_url: checksums }] }),
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

function timedOut(): Error {
  return new Error("request timed out after 30000ms");
}

function refused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 192.0.2.1:443"), { code: "ECONNREFUSED" });
}

/** Run boot's sync exactly as index.ts does: await it, hand a failure to the retry. */
async function bootSync(binarySync: typeof import("./binarySync")): Promise<boolean> {
  try {
    await binarySync.syncBinaries();
    return false;
  } catch (err) {
    return binarySync.scheduleGithubSyncRetry(err);
  }
}

let errors: string[];
let warnings: string[];
let logs: string[];

beforeEach(() => {
  vi.useFakeTimers();
  process.env.BINARY_SOURCE = "github";
  process.env.BINARY_VERSION = "0.127.0";
  delete process.env.BREEZE_VERSION;
  delete process.env.APP_VERSION;
  delete process.env.BREEZE_BINARIES_VERSION;
  delete process.env.BINARY_EDITION;
  net.script = [];
  net.calls = 0;
  errors = [];
  warnings = [];
  logs = [];
  const text = (args: unknown[]) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(text(a)));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warnings.push(text(a)));
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(text(a)));
  vi.resetModules();
});

afterEach(async () => {
  const binarySync = await import("./binarySync");
  binarySync.stopGithubSyncRetry();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
});

// Each case imports binarySync cold (vi.resetModules), which is slow on a loaded runner.
describe("boot-time GitHub sync retry (#11641)", { timeout: 30_000 }, () => {
  it("retries a network failure with backoff and stops once a retry succeeds", async () => {
    net.script = [timedOut(), refused(), "ok"];
    const binarySync = await import("./binarySync");
    const delays = binarySync.GITHUB_SYNC_RETRY_DELAYS_MS;

    expect(await bootSync(binarySync)).toBe(true);
    expect(net.calls).toBe(1);
    expect(binarySync.isGithubSyncRetryPending()).toBe(true);

    // Nothing happens before the first delay has elapsed.
    await vi.advanceTimersByTimeAsync(delays[0]! - 1);
    expect(net.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(net.calls).toBe(2);

    // The second retry waits longer than the first.
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
    await vi.advanceTimersByTimeAsync(delays[1]! - 1);
    expect(net.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(net.calls).toBe(3);

    expect(binarySync.isGithubSyncRetryPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    // Every attempt is logged, and so is the recovery.
    expect(warnings.filter((w) => /retry 1 of \d+/.test(w))).toHaveLength(1);
    expect(warnings.filter((w) => /retry 2 of \d+/.test(w))).toHaveLength(1);
    expect(logs.some((l) => /v0\.127\.0.*succeeded on retry 2/.test(l))).toBe(true);
    // Each network failure is reported as one, never as an unpublished release.
    expect(errors).toHaveLength(2);
    for (const e of errors) {
      expect(e).toMatch(/pinned release v0\.127\.0 FAILED.*This is a network failure, not a missing release/s);
      expect(e).not.toMatch(/PUBLISHED release/);
    }
  });

  it("ends in an explicit, operator-visible error after the bounded retries run out", async () => {
    const binarySync = await import("./binarySync");
    const { captureException } = await import("./sentry");
    const delays = binarySync.GITHUB_SYNC_RETRY_DELAYS_MS;
    net.script = Array.from({ length: delays.length + 1 }, timedOut);

    expect(await bootSync(binarySync)).toBe(true);
    for (const delay of delays) await vi.advanceTimersByTimeAsync(delay);

    expect(net.calls).toBe(delays.length + 1);
    expect(binarySync.isGithubSyncRetryPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    const final = errors.filter((e) => e.includes(`still failing after ${delays.length} retries`));
    expect(final).toHaveLength(1);
    expect(final[0]).toContain("v0.127.0");
    expect(final[0]).toContain("request timed out after 30000ms");
    expect(final[0]).toContain("POST /api/v1/agent-versions/sync-github?version=v0.127.0");
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), undefined, { area: "binary_sync_github_retry" });

    // Nothing further is scheduled, however long the process runs.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(net.calls).toBe(delays.length + 1);
  });

  it("does not retry a failure that is not a network failure", async () => {
    net.script = [];
    const binarySync = await import("./binarySync");
    const notFound = new Error("GitHub API error: 404");

    expect(binarySync.scheduleGithubSyncRetry(notFound)).toBe(false);
    expect(binarySync.isGithubSyncRetryPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops retrying when a retry fails for a reason that is not a network failure", async () => {
    net.script = [timedOut(), new Error("GitHub API error: 404")];
    const binarySync = await import("./binarySync");

    expect(await bootSync(binarySync)).toBe(true);
    await vi.advanceTimersByTimeAsync(binarySync.GITHUB_SYNC_RETRY_DELAYS_MS[0]!);

    expect(net.calls).toBe(2);
    expect(binarySync.isGithubSyncRetryPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(errors.some((e) => /not a network failure.*GitHub API error: 404/.test(e))).toBe(true);
  });

  it("only retries in BINARY_SOURCE=github mode", async () => {
    process.env.BINARY_SOURCE = "local";
    const binarySync = await import("./binarySync");

    expect(binarySync.scheduleGithubSyncRetry(timedOut())).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a second failure report while a retry is pending does not stack another timer", async () => {
    net.script = [timedOut()];
    const binarySync = await import("./binarySync");

    expect(await bootSync(binarySync)).toBe(true);
    expect(binarySync.scheduleGithubSyncRetry(refused())).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("isTransientNetworkFailure", () => {
  it("recognises timeouts, connection errors and wrapped causes; rejects policy and HTTP errors", async () => {
    const binarySync = await import("./binarySync");
    const urlSafety = await import("./urlSafety");
    const is = binarySync.isTransientNetworkFailure;

    expect(is(timedOut())).toBe(true);
    expect(is(refused())).toBe(true);
    expect(is(Object.assign(new Error("getaddrinfo EAI_AGAIN api.github.com"), { code: "EAI_AGAIN" }))).toBe(true);
    expect(is(new Error("connection closed before a response was received"))).toBe(true);
    expect(is(new urlSafety.ResponseHeadersTimeoutError(5000))).toBe(true);
    expect(is(new Error("wrapped", { cause: refused() }))).toBe(true);
    expect(is(new AggregateError([refused()], "all failed"))).toBe(true);

    expect(is(new Error("GitHub API error: 404"))).toBe(false);
    expect(is(new urlSafety.SsrfBlockedError("blocked"))).toBe(false);
    expect(is(new urlSafety.ResponseTooLargeError(10))).toBe(false);
    expect(is("request timed out after 30000ms")).toBe(false);
    expect(is(undefined)).toBe(false);
  });
});
