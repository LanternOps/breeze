import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real fs, real crypto — deliberately does NOT reuse binarySync.test.ts's
// `vi.mock("node:fs", ...)` / `vi.mock("node:fs/promises", ...)` (those mocks
// are file-scoped to that file), so this suite exercises the actual
// readdir/stat/createReadStream + sha256 pipeline against files on disk
// (spec §4.1: a real-checksum test, not a mocked one).
//
// `../db` still has to be stubbed: importing binarySync.ts transitively pulls
// in `../db/index.ts`, which opens a real Postgres pool and reads
// process.env at import time — inert here since this suite never touches any
// DB-writing code path (only the pure `scanHelperInstallerDir` scanner).
vi.mock("../db", () => ({
  db: { transaction: vi.fn(), select: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  assertOutsideHeldDbContext: vi.fn(),
}));

vi.mock("./sentry", () => ({ captureException: vi.fn() }));

import { scanHelperInstallerDir } from "./binarySync";

describe("scanHelperInstallerDir — real filesystem checksums (#6872, spec §4.1)", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("computes real sha256 checksums per platform/arch, sharing the dmg checksum across both macOS arches", async () => {
    dir = await mkdtemp(join(tmpdir(), "breeze-helper-installers-"));
    const msiBytes = Buffer.from("windows msi installer bytes");
    const dmgBytes = Buffer.from("macos dmg installer bytes, different from the msi");
    await writeFile(join(dir, "breeze-helper-windows.msi"), msiBytes);
    await writeFile(join(dir, "breeze-helper-macos.dmg"), dmgBytes);
    // Deliberately no AppImage present.

    const results = await scanHelperInstallerDir(dir);

    expect(results).toHaveLength(3);

    const msiChecksum = createHash("sha256").update(msiBytes).digest("hex");
    const dmgChecksum = createHash("sha256").update(dmgBytes).digest("hex");

    const windows = results.find((r) => r.platform === "windows" && r.architecture === "amd64");
    expect(windows).toBeDefined();
    expect(windows!.checksum).toBe(msiChecksum);
    expect(windows!.fileSize).toBe(BigInt(msiBytes.length));

    const macAmd64 = results.find((r) => r.platform === "macos" && r.architecture === "amd64");
    const macArm64 = results.find((r) => r.platform === "macos" && r.architecture === "arm64");
    expect(macAmd64).toBeDefined();
    expect(macArm64).toBeDefined();
    expect(macAmd64!.checksum).toBe(dmgChecksum);
    expect(macArm64!.checksum).toBe(dmgChecksum);
    expect(macAmd64!.fileSize).toBe(BigInt(dmgBytes.length));
    expect(macArm64!.fileSize).toBe(BigInt(dmgBytes.length));

    expect(results.some((r) => r.platform === "linux")).toBe(false);
  });

  it("returns [] for an empty directory", async () => {
    dir = await mkdtemp(join(tmpdir(), "breeze-helper-installers-empty-"));

    const results = await scanHelperInstallerDir(dir);

    expect(results).toEqual([]);
  });

  it("returns [] and warns once for a nonexistent directory", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const results = await scanHelperInstallerDir(
        join(tmpdir(), "breeze-helper-installers-does-not-exist-6872"),
      );

      expect(results).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]![0])).toContain("helper installer");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
