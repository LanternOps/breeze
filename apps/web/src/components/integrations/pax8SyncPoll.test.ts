import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { syncFinished, waitForSyncCompletion, type SyncSnapshot } from "./pax8SyncPoll";

describe("syncFinished", () => {
  const before: SyncSnapshot = {
    lastSyncAt: "2026-06-18T12:00:00.000Z",
    lastSyncStatus: "success",
    updatedAt: "2026-06-18T12:00:00.000Z",
  };

  it.each([
    ["lastSyncAt changed", { ...before, lastSyncAt: "2026-06-19T12:00:00.000Z" }, true],
    [
      "failed and updatedAt changed",
      { ...before, lastSyncStatus: "failed", updatedAt: "2026-06-19T12:00:00.000Z" },
      true,
    ],
    ["failed and updatedAt unchanged", { ...before, lastSyncStatus: "failed" }, false],
    [
      "non-failed and updatedAt changed",
      { ...before, updatedAt: "2026-06-19T12:00:00.000Z" },
      false,
    ],
    ["nothing changed", { ...before }, false],
  ] as Array<[string, SyncSnapshot, boolean]>)("%s -> %s", (_label, now, expected) => {
    expect(syncFinished(before, now)).toBe(expected);
  });

  it("treats null and undefined as equivalent", () => {
    expect(
      syncFinished(
        { lastSyncAt: null, updatedAt: undefined },
        { lastSyncAt: undefined as unknown as null, updatedAt: null, lastSyncStatus: "failed" },
      ),
    ).toBe(false);
    expect(
      syncFinished({ lastSyncAt: null }, { lastSyncAt: null, lastSyncStatus: "failed", updatedAt: null }),
    ).toBe(false);
  });
});

describe("waitForSyncCompletion", () => {
  const before: SyncSnapshot = { lastSyncAt: "a", lastSyncStatus: "success", updatedAt: "u" };
  const changed: SyncSnapshot = { ...before, lastSyncAt: "b" };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves true once the snapshot changes", async () => {
    const read = vi
      .fn<() => Promise<SyncSnapshot | null>>()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(changed);
    const p = waitForSyncCompletion({
      before,
      read,
      signal: new AbortController().signal,
      intervalMs: 100,
      maxAttempts: 3,
    });
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("resolves false after maxAttempts unchanged reads", async () => {
    const read = vi.fn<() => Promise<SyncSnapshot | null>>().mockResolvedValue(before);
    const p = waitForSyncCompletion({
      before,
      read,
      signal: new AbortController().signal,
      intervalMs: 100,
      maxAttempts: 3,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("resolves false and stops reading when aborted mid-wait", async () => {
    const read = vi.fn<() => Promise<SyncSnapshot | null>>().mockResolvedValue(before);
    const controller = new AbortController();
    const p = waitForSyncCompletion({
      before,
      read,
      signal: controller.signal,
      intervalMs: 100,
      maxAttempts: 5,
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(read).toHaveBeenCalledTimes(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("counts a throwing read as an attempt and never rejects", async () => {
    const read = vi
      .fn<() => Promise<SyncSnapshot | null>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(changed);
    const p = waitForSyncCompletion({
      before,
      read,
      signal: new AbortController().signal,
      intervalMs: 100,
      maxAttempts: 3,
    });
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(2);

    const failing = vi.fn<() => Promise<SyncSnapshot | null>>().mockRejectedValue(new Error("x"));
    const p2 = waitForSyncCompletion({
      before,
      read: failing,
      signal: new AbortController().signal,
      intervalMs: 100,
      maxAttempts: 3,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p2).resolves.toBe(false);
    expect(failing).toHaveBeenCalledTimes(3);
  });
});
