import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #11731: a deferred BINARY_SOURCE=local registration retries once the
 * database answers writable. The probe and the writes can land on different
 * pooled sessions, and a session opened while the database was read-only
 * keeps that default, so a component write inside the retry can still fail
 * with 25006. The per-component catches (user-helper, helper, watchdog,
 * backup) log and swallow errors on a normal boot; during a retry a read-only
 * failure must keep the registration deferred instead of reading as done.
 */

const state = vi.hoisted(() => ({
  readOnly: true,
  registered: [] as Array<{ component: string; platform: string; architecture: string; checksum: string }>,
  failComponent: null as string | null,
}));

vi.mock("../db", () => {
  const tx = {
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: () => ({
      values: (v: { component: string }) => ({
        onConflictDoUpdate: async () => {
          if (state.failComponent === v.component) {
            throw Object.assign(new Error("cannot execute INSERT in a read-only transaction"), { code: "25006" });
          }
        },
      }),
    }),
  };
  return {
    db: {
      execute: vi.fn(async () => [{ ro: state.readOnly ? "on" : "off" }]),
      select: vi.fn(() => ({ from: () => ({ where: async () => state.registered }) })),
      transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    },
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    assertOutsideHeldDbContext: vi.fn(),
  };
});
vi.mock("./manifestSigning", () => ({
  ensureActiveSigningKey: vi.fn(async () => ({ keyId: "test-key", publicKeyB64: "x" })),
  signManifest: vi.fn(async () => "signature"),
}));
vi.mock("./s3Storage", () => ({ isS3Configured: () => false, syncDirectory: vi.fn() }));
vi.mock("./sentry", () => ({ captureException: vi.fn() }));

let dir: string;
const savedEnv = { ...process.env };

async function binary(name: string): Promise<{ checksum: string }> {
  const bytes = Buffer.from(`${name}-bytes`);
  await writeFile(path.join(dir, name), bytes);
  return { checksum: createHash("sha256").update(bytes).digest("hex") };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "breeze-ro-retry-"));
  await writeFile(path.join(dir, "VERSION"), "1.2.3\n");
  process.env.BINARY_SOURCE = "local";
  process.env.AGENT_BINARY_DIR = dir;
  process.env.HELPER_BINARY_DIR = dir;
  process.env.BINARY_VERSION_FILE = path.join(dir, "VERSION");
  delete process.env.BREEZE_VERSION;
  delete process.env.APP_VERSION;
  delete process.env.BINARY_EDITION;
  state.readOnly = true;
  state.failComponent = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.resetModules();
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  await rm(dir, { recursive: true, force: true });
});

describe("deferred binary registration retry (#11731)", () => {
  it("stays deferred when a component write inside the retry is still rejected as read-only", async () => {
    const agent = await binary("breeze-agent-linux-amd64");
    await binary("breeze-watchdog-linux-amd64");
    // Only the agent is registered, so the read-only boot defers.
    state.registered = [{ component: "agent", platform: "linux", architecture: "amd64", checksum: agent.checksum }];
    const binarySync = await import("./binarySync");

    await binarySync.syncBinaries();
    expect(binarySync.isBinarySyncDeferred()).toBe(true);

    // The probe now answers writable, but the watchdog write hits a stale
    // read-only session.
    state.readOnly = false;
    state.failComponent = "watchdog";
    await binarySync.retryDeferredBinarySync();
    expect(binarySync.isBinarySyncDeferred()).toBe(true);

    // Next retry, every session writable: the registration completes.
    state.failComponent = null;
    await binarySync.retryDeferredBinarySync();
    expect(binarySync.isBinarySyncDeferred()).toBe(false);
    binarySync.stopDeferredBinarySyncRetry();
  });

  it("still swallows a component failure on a normal writable boot (unchanged behaviour)", async () => {
    await binary("breeze-agent-linux-amd64");
    await binary("breeze-watchdog-linux-amd64");
    state.readOnly = false;
    state.failComponent = "watchdog";
    const binarySync = await import("./binarySync");

    await expect(binarySync.syncBinaries()).resolves.toBeUndefined();
    expect(binarySync.isBinarySyncDeferred()).toBe(false);
  });
});
