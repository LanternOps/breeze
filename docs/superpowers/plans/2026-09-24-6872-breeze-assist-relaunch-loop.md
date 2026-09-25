# Breeze Assist relaunch loop (#6872) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the agent from relaunching a Breeze Assist helper that is not installed, make a missing spawn target fail loudly, and make hosted servers register `component='helper'` rows so the bootstrap install is actually offered.

**Architecture:** Two independent PRs. **PR 1 (API)** extends local-mode `syncBinaries` with a helper-installer scan of `HELPER_BINARY_DIR` and registers rows through the same manifest-then-re-sign tiers the user-helper uses. **PR 2 (agent)** adds an `ErrNotInstalled` sentinel to `helper.Manager` that short-circuits `Apply`, `ensureRunningSession` and the watcher, plus an `os.Stat` guard in `sessionbroker.SpawnProcessInSessionWithArgs`. Tasks 1–3 are PR 1; Tasks 4–8 are PR 2.

**Tech Stack:** TypeScript/Hono/Drizzle + Vitest (API); Go 1.26 + `testing` (agent, `go test -race`); Windows lab VM for the build-tagged test.

**Spec:** `docs/superpowers/specs/agent/2026-09-24-6872-breeze-assist-relaunch-loop-design.md`

## Global Constraints

- Agent code ships to customer machines: full rigor, red test first, `go test -race`, native Windows run before merge (spec §5).
- Helper installer filename → target mapping is exactly the `HELPER_TARGETS` table in `apps/api/src/services/binarySync.ts:201-206`: `breeze-helper-windows.msi` → windows/amd64; `breeze-helper-macos.dmg` → macos/amd64 **and** macos/arm64; `breeze-helper-linux.AppImage` → linux/amd64.
- Helper download URL shape: `${serverUrl}/api/v1/agents/download/helper/${os}/${arch}` (matches `routes/agents/download.ts:414-425` and `routes/agentVersions.ts:513`).
- Do **not** widen `parseBinaryFilename` (its regex is load-bearing for agent/user-helper/watchdog/backup).
- Helper registration failures must be isolated (own `try/catch`) and never block the agent row (binarySync per-component isolation, #816).
- `ErrNotInstalled` must never be logged at Error, never counted as a watcher failure, never set `watcherGaveUp`.
- The `isInstalled()` check in `ensureRunningSession` sits **before** the `watcherGaveUp` check (recovery ordering, spec §4.2).
- Keep `cmd.exe /c start` as the launch mechanism (spec D3); only add the stat guard.
- Branch names: PR 1 `fix/6872-register-helper-rows-local-mode`, PR 2 `fix/6872-assist-not-installed-no-spawn`. Both `Part of #6872`; PR 2 `Closes #6872`.
- Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **`HELPER_BINARY_DIR` unset on a self-host deploy** → default `./agent/bin` (same default as the download route). Must be a warn-and-continue, never a throw. Pinned in Task 1.
2. **Only the `.dmg` present** → two rows (amd64 + arm64) with the same checksum; nothing for windows/linux; no error. Pinned in Task 1.
3. **Manifest refuses `breeze-helper-windows.msi`** (D4 #3836 policy) → it must not fall through to per-deployment re-signing. Pinned in Task 2.
4. **Binary removed while a watcher is running** → the watcher must exit without incrementing `failures` and without `watcherGaveUp`; the next `Apply` must not restart it. Pinned in Tasks 5 and 6.
5. **Device previously in `watcherGaveUp` state, then helper installed** → the first `ensureRunningSession` after install must spawn (the stale flag must not block recovery). Pinned in Task 4.

---

## PR 1 — API: register `helper` rows in local mode

### Task 1: Scan `HELPER_BINARY_DIR` and register helper installers via per-deployment re-signing

**Files:**
- Modify: `apps/api/src/services/binarySync.ts` (add `scanHelperInstallerDir` after `scanBinaryDir` at `:450-498`; add the registration block after the user-helper block ending at `:1154`)
- Test: `apps/api/src/services/binarySync.test.ts` (new `describe` after the `#4682` block ending at `:1017`)

**Interfaces:**
- Consumes: `BinaryInfo` (`:239`), `registerLocalBinaries(args)` (`:500`), `HELPER_TARGETS` (`:201`), `GH_PLATFORM_MAP` (`:171`), `computeStreamingChecksum`, `ensureActiveSigningKey` (`keyId`, already in scope at `:1062`).
- Produces: `async function scanHelperInstallerDir(dir: string): Promise<BinaryInfo[]>` — one `BinaryInfo` per `HELPER_TARGETS` entry whose `assetName` exists in `dir` (so the dmg yields two entries sharing one file). Task 2 reuses it.

- [ ] **Step 1: Write the failing tests**

Append inside the top-level `describe("binarySync", …)` in `apps/api/src/services/binarySync.test.ts`, right after the `local-binary user-helper registration (#4682)` describe:

```ts
  describe("local-binary helper installer registration (#6872)", () => {
    function setLocalEnv() {
      process.env.BINARY_SOURCE = "local";
      process.env.AGENT_BINARY_DIR = "/fake/agent/bin";
      process.env.HELPER_BINARY_DIR = "/fake/helper/bin";
      process.env.BINARY_VERSION_FILE = "/fake/version";
      delete process.env.BREEZE_VERSION;
      fsMocks.stat.mockResolvedValue({ isFile: () => true, size: 4096 } as any);
      mockReadFileVersionOnly("0.116.0");
    }

    // readdir is called once for the agent dir and once for the helper dir;
    // route by path so the two directories can hold different files.
    function mockDirs(agentFiles: string[], helperFiles: string[]) {
      fsMocks.readdir.mockImplementation(async (dir: any) => {
        if (String(dir).includes("/fake/helper/bin")) return helperFiles as any;
        return agentFiles as any;
      });
    }

    afterEach(() => {
      delete process.env.HELPER_BINARY_DIR;
    });

    it("registers component=helper rows for every installer present, two for the shared macOS dmg", async () => {
      setLocalEnv();
      mockDirs(
        ["breeze-agent-windows-amd64.exe"],
        ["breeze-helper-windows.msi", "breeze-helper-macos.dmg", "breeze-helper-linux.AppImage"],
      );

      await syncBinaries();

      const rows = dbMocks.insertValues.mock.calls
        .map((call: any[]) => call[0] as Record<string, unknown>)
        .filter((v) => v.component === "helper");
      expect(rows.map((r) => `${r.platform}/${r.architecture}`).sort()).toEqual([
        "linux/amd64",
        "macos/amd64",
        "macos/arm64",
        "windows/amd64",
      ]);
      const win = rows.find((r) => r.platform === "windows")!;
      expect(win).toMatchObject({
        version: "0.116.0",
        component: "helper",
        isLatest: true,
        downloadUrl: "http://localhost:3001/api/v1/agents/download/helper/windows/amd64",
      });
      expect(JSON.parse(win.releaseManifest as string)).toMatchObject({
        version: "0.116.0",
        component: "helper",
        platform: "windows",
        arch: "amd64",
      });
      const dmg = rows.filter((r) => r.platform === "macos");
      expect(dmg[0]!.checksum).toBe(dmg[1]!.checksum);
      expect(rows.find((r) => r.platform === "macos" && r.architecture === "arm64")!.downloadUrl)
        .toBe("http://localhost:3001/api/v1/agents/download/helper/darwin/arm64"); // registerLocalBinaries maps macos → darwin in the route param
    });

    it("registers only the macOS rows when only the dmg is present", async () => {
      setLocalEnv();
      mockDirs(["breeze-agent-windows-amd64.exe"], ["breeze-helper-macos.dmg"]);

      await syncBinaries();

      const rows = dbMocks.insertValues.mock.calls
        .map((call: any[]) => call[0] as Record<string, unknown>)
        .filter((v) => v.component === "helper");
      expect(rows.map((r) => `${r.platform}/${r.architecture}`).sort()).toEqual([
        "macos/amd64",
        "macos/arm64",
      ]);
    });

    it("warns once and still registers the agent when the helper dir is missing or empty", async () => {
      setLocalEnv();
      fsMocks.readdir.mockImplementation(async (dir: any) => {
        if (String(dir).includes("/fake/helper/bin")) throw new Error("ENOENT");
        return ["breeze-agent-windows-amd64.exe"] as any;
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(syncBinaries()).resolves.toBeUndefined();

      const rows = dbMocks.insertValues.mock.calls.map((c: any[]) => c[0] as Record<string, unknown>);
      expect(rows.some((v) => v.component === "agent")).toBe(true);
      expect(rows.some((v) => v.component === "helper")).toBe(false);
      expect(
        warnSpy.mock.calls.filter((args) => String(args[0] ?? "").includes("helper installer")).length,
      ).toBe(1);
      warnSpy.mockRestore();
    });

    it("defaults HELPER_BINARY_DIR to ./agent/bin when unset", async () => {
      setLocalEnv();
      delete process.env.HELPER_BINARY_DIR;
      const seen: string[] = [];
      fsMocks.readdir.mockImplementation(async (dir: any) => {
        seen.push(String(dir));
        return ["breeze-agent-windows-amd64.exe"] as any;
      });

      await syncBinaries();

      // resolve("./agent/bin") — the same default the download route uses.
      expect(seen.some((d) => d.endsWith("/agent/bin") && !d.includes("/fake/"))).toBe(true);
    });

    it("isolates helper registration failures after the agent succeeds", async () => {
      setLocalEnv();
      mockDirs(["breeze-agent-windows-amd64.exe"], ["breeze-helper-windows.msi"]);
      const defaultTxImpl = async (fn: (tx: any) => Promise<void>) => fn(dbMocks.tx);
      dbMocks.transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
        const insertWrap = vi.fn((row: Record<string, unknown>) => {
          if (row.component === "helper") throw new Error("simulated helper upsert failure");
          return (dbMocks.insertValues as any)(row);
        });
        return fn({ update: dbMocks.tx.update, insert: vi.fn(() => ({ values: insertWrap })) });
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(syncBinaries()).resolves.toBeUndefined();
        const rows = dbMocks.insertValues.mock.calls.map((c: any[]) => c[0] as Record<string, unknown>);
        expect(rows.some((v) => v.component === "agent")).toBe(true);
        expect(rows.some((v) => v.component === "helper")).toBe(false);
        expect(
          errorSpy.mock.calls.some((args) =>
            String(args[0] ?? "").includes("Failed to register local helper installers"),
          ),
        ).toBe(true);
      } finally {
        errorSpy.mockRestore();
        dbMocks.transaction.mockImplementation(defaultTxImpl);
      }
    });
  });
```

If `afterEach` is not already imported from `vitest` at the top of the file, add it to the existing import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/binarySync.test.ts -t "#6872"`
Expected: FAIL — `rows` is empty (`expected [] to equal [...]`) for the first two tests; the "warns once" test fails on the warn count (0).

- [ ] **Step 3: Add `scanHelperInstallerDir`**

In `apps/api/src/services/binarySync.ts`, directly after `scanBinaryDir` (ends at `:498`), add:

```ts
// #6872: the Tauri Breeze Assist helper ships as installers
// (breeze-helper-windows.msi / -macos.dmg / -linux.AppImage), not as
// breeze-helper-{os}-{arch} raw binaries, so parseBinaryFilename can never
// match it. Map the HELPER_TARGETS asset names to (platform, arch) exactly
// as GitHub mode does — the one .dmg covers both macOS arches. Hosted prod
// runs BINARY_SOURCE=local and had ZERO helper rows for that reason: the
// heartbeat's bootstrap offer (helperUpgradeTo) resolved null and no device
// could ever install Assist.
async function scanHelperInstallerDir(dir: string): Promise<BinaryInfo[]> {
  const results: BinaryInfo[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[binarySync] helper installer directory not found: ${dir} (${msg}) — Breeze Assist install/upgrade unavailable`,
    );
    return results;
  }
  const present = new Set(entries);

  // One checksum per FILE, reused for every target that shares it (dmg).
  const checksums = new Map<string, { checksum: string; fileSize: bigint }>();
  for (const target of HELPER_TARGETS) {
    if (!present.has(target.assetName)) continue;
    const platform = GH_PLATFORM_MAP[target.goos];
    if (!platform) continue;
    const filePath = join(dir, target.assetName);
    try {
      let info = checksums.get(target.assetName);
      if (!info) {
        const checksum = await computeStreamingChecksum(filePath);
        const fileStat = await stat(filePath);
        info = { checksum, fileSize: BigInt(fileStat.size) };
        checksums.set(target.assetName, info);
      }
      results.push({
        filename: target.assetName,
        filePath,
        platform,
        architecture: target.goarch,
        checksum: info.checksum,
        fileSize: info.fileSize,
      });
    } catch (err) {
      console.error(`[binarySync] Failed to read ${target.assetName}:`, err);
    }
  }
  return results;
}
```

- [ ] **Step 4: Scan the helper dir and register via re-signing**

In `syncBinaries`, right after `const backupBinaries = await scanBinaryDir(agentBinaryDir, "backup");` (`:1049`), add:

```ts
  const helperBinaryDir = resolve(process.env.HELPER_BINARY_DIR || "./agent/bin");
  const helperInstallers = await scanHelperInstallerDir(helperBinaryDir);
```

Then, inside the `if (binaries.length > 0) { … }` block, immediately after the user-helper `try/catch` (ends at `:1154`, before the `// #1802: register the watchdog component too` comment), add:

```ts
    // #6872: register the Breeze Assist helper installers in local mode.
    // GitHub mode already registers component=helper (HELPER_TARGETS); local
    // mode never did, so hosted deployments (BINARY_SOURCE=local) never
    // produced the row that heartbeat's helperUpgradeTo bootstrap resolves.
    if (helperInstallers.length > 0) {
      try {
        await registerLocalBinaries({
          binaries: helperInstallers,
          component: "helper",
          version,
          keyId,
          downloadUrlFor: (osParam, arch) =>
            `${serverUrl}/api/v1/agents/download/helper/${osParam}/${arch}`,
        });
        console.log(
          `[binarySync] Registered ${helperInstallers.length} helper installer targets via per-deployment re-signing (version: ${version})`,
        );
      } catch (err) {
        console.error(
          `[binarySync] Failed to register local helper installers — Breeze Assist install/upgrade unavailable: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/binarySync.test.ts`
Expected: PASS, including every pre-existing test in the file (the extra `readdir` call must not break the `mockResolvedValue`-style tests, which return the same list for both dirs — `scanHelperInstallerDir` ignores non-helper names, so they stay green).

- [ ] **Step 6: Typecheck and commit**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json` (use a 12 GB heap if it OOMs: `NODE_OPTIONS=--max-old-space-size=12288`; check the exit code, never pipe to `tail`).

```bash
git checkout -b fix/6872-register-helper-rows-local-mode main
git add apps/api/src/services/binarySync.ts apps/api/src/services/binarySync.test.ts
git commit -m "fix(api): register Breeze Assist helper installers in local-mode binary sync (#6872)

Hosted prod runs BINARY_SOURCE=local, which only scanned agent/user-helper/
watchdog/backup. component=helper rows were never created, so the heartbeat
bootstrap offer (helperUpgradeTo) resolved null and no device could install
or upgrade Assist. Scan HELPER_BINARY_DIR for the HELPER_TARGETS installer
names and register them like the other local components.

Part of #6872

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Manifest-first tier for helper installers, with refused assets excluded from re-signing

**Files:**
- Modify: `apps/api/src/services/binarySync.ts` (the block added in Task 1 Step 4)
- Test: `apps/api/src/services/binarySync.test.ts` (extend the `#6872` describe)

**Interfaces:**
- Consumes: `registerFromOfficialManifest({ binaries, component, version, manifestBytes, signatureBytes, downloadUrlFor })` → `{ registeredFilenames, excludedFilenames }` (`:765`); `officialManifest` (`:1018`) in scope.
- Produces: nothing new; the helper block now mirrors the user-helper two-tier flow byte-for-byte in structure.

- [ ] **Step 1: Write the failing tests**

Look at how the existing `official manifest from local dir (BYO signing edition follow-up)` describe (`:1554`) stages a manifest pair (`loadOfficialLocalManifestPair` reads `release-artifact-manifest.json` + `.ed25519` from `dirname(AGENT_BINARY_DIR)` via `fsMocks.readFile`) and how `no silent policy-bypass fallback … (D4, #3836)` (`:1796`) makes `verifyReleaseArtifactManifestAsset` refuse one asset. Reuse those helpers/mocks verbatim. Then add to the `#6872` describe:

```ts
    it("registers manifest-covered helper installers against the official manifest and re-signs the rest", async () => {
      setLocalEnv();
      mockDirs(["breeze-agent-windows-amd64.exe"], ["breeze-helper-windows.msi", "breeze-helper-linux.AppImage"]);
      // Stage an official manifest that covers ONLY breeze-helper-windows.msi
      // (copy the staging helper used by the ':1554' describe; assets: [{ name:
      // "breeze-helper-windows.msi", sha256: <checksum the fs mock yields>, size: 4096,
      // edition: "self-host", platformTrust: "windows-authenticode-required" }]).
      stageOfficialManifestCovering(["breeze-helper-windows.msi"]);

      await syncBinaries();

      const rows = dbMocks.insertValues.mock.calls
        .map((c: any[]) => c[0] as Record<string, unknown>)
        .filter((v) => v.component === "helper");
      const win = rows.find((r) => r.platform === "windows")!;
      const linux = rows.find((r) => r.platform === "linux")!;
      expect(win.signingKeyId).toBe("release-artifact-manifest-ed25519");
      expect(linux.signingKeyId).not.toBe("release-artifact-manifest-ed25519");
    });

    it("does not re-sign a helper installer the manifest refused (D4 #3836)", async () => {
      setLocalEnv();
      mockDirs(["breeze-agent-windows-amd64.exe"], ["breeze-helper-windows.msi"]);
      // Stage a manifest that lists breeze-helper-windows.msi with a sha256 that
      // does NOT match the file → registerFromOfficialManifest puts it in
      // excludedFilenames.
      stageOfficialManifestCovering(["breeze-helper-windows.msi"], { checksumMismatch: true });

      await syncBinaries();

      const rows = dbMocks.insertValues.mock.calls
        .map((c: any[]) => c[0] as Record<string, unknown>)
        .filter((v) => v.component === "helper");
      expect(rows).toHaveLength(0);
    });
```

`stageOfficialManifestCovering` is a local test helper you write in this describe by extracting the staging code the `:1554` and `:1796` describes already inline (manifest JSON + signature bytes through `fsMocks.readFile`, and the `verifyReleaseArtifactManifestAsset`/integrity mocks they set). Keep it inside the `#6872` describe; do not refactor the older describes.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/binarySync.test.ts -t "#6872"`
Expected: FAIL — first test: `win.signingKeyId` is the per-deployment key id, not `release-artifact-manifest-ed25519`; second test: one row registered instead of zero.

- [ ] **Step 3: Implement the two-tier flow**

Replace the helper block from Task 1 Step 4 with:

```ts
    // #6872: register the Breeze Assist helper installers in local mode.
    // GitHub mode already registers component=helper (HELPER_TARGETS); local
    // mode never did, so hosted deployments (BINARY_SOURCE=local) never
    // produced the row that heartbeat's helperUpgradeTo bootstrap resolves.
    // Same two tiers as user-helper: official manifest first, then
    // per-deployment re-signing for whatever the manifest does not cover —
    // never for an asset the manifest refused (D4, #3836).
    if (helperInstallers.length > 0) {
      try {
        let coveredHelperFilenames = new Set<string>();
        let excludedHelperFilenames = new Set<string>();
        if (officialManifest) {
          const result = await registerFromOfficialManifest({
            binaries: helperInstallers,
            component: "helper",
            version,
            manifestBytes: officialManifest.manifestBytes,
            signatureBytes: officialManifest.signatureBytes,
            downloadUrlFor: (osParam, arch) =>
              `${serverUrl}/api/v1/agents/download/helper/${osParam}/${arch}`,
          });
          coveredHelperFilenames = result.registeredFilenames;
          excludedHelperFilenames = result.excludedFilenames;
          if (coveredHelperFilenames.size > 0) {
            console.log(
              `[binarySync] Registered ${coveredHelperFilenames.size} helper installers from the official release manifest (version: ${version})`,
            );
          }
        }
        const remainingHelperInstallers = helperInstallers.filter(
          (b) =>
            !coveredHelperFilenames.has(b.filename) &&
            !excludedHelperFilenames.has(b.filename),
        );
        if (remainingHelperInstallers.length > 0) {
          await registerLocalBinaries({
            binaries: remainingHelperInstallers,
            component: "helper",
            version,
            keyId,
            downloadUrlFor: (osParam, arch) =>
              `${serverUrl}/api/v1/agents/download/helper/${osParam}/${arch}`,
          });
          console.log(
            `[binarySync] Registered ${remainingHelperInstallers.length} helper installer targets via per-deployment re-signing (version: ${version})`,
          );
        }
      } catch (err) {
        console.error(
          `[binarySync] Failed to register local helper installers — Breeze Assist install/upgrade unavailable: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
```

`registerFromOfficialManifest` iterates every `BinaryInfo` entry and upserts by `(platform, architecture)` (`:820-845`), so the dmg's two entries both register; `registeredFilenames` just ends up containing the dmg name once, which is what the `remaining` filter needs.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/binarySync.test.ts`
Expected: PASS (whole file).

- [ ] **Step 5: Typecheck and commit**

```bash
git add apps/api/src/services/binarySync.ts apps/api/src/services/binarySync.test.ts
git commit -m "fix(api): manifest-first tier for local helper installer registration (#6872)

Part of #6872

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Integration proof that the heartbeat resolves the helper row, then open PR 1

**Files:**
- Test: `apps/api/src/__tests__/integration/helperBootstrapOffer.integration.test.ts` (create)
- Modify: `.claude/skills/release/SKILL.md:376` (post-promote verification query)

**Interfaces:**
- Consumes: `resolvePinnedUpgradeTarget` (`routes/agents/helpers.ts:2660`), `agentVersions` schema, `withSystemDbAccessContext`, `getBinaryEdition`.

- [ ] **Step 1: Write the failing integration test**

Model the file on the nearest existing integration test that inserts `agent_versions` rows (grep: `grep -ln "agentVersions" apps/api/src/__tests__/integration/*.ts | head -3`; copy its db setup/teardown).

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, withSystemDbAccessContext } from "../../db";
import { agentVersions } from "../../db/schema";
import { resolvePinnedUpgradeTarget } from "../../routes/agents/helpers";
import { getBinaryEdition } from "../../config/binaryEdition";

// #6872: with no component=helper row, heartbeat's bootstrap offer resolves
// null and Assist is never installed. This pins that a registered helper row
// is what resolvePinnedUpgradeTarget returns for the bootstrap branch.
describe("helper bootstrap offer resolves the registered helper row (#6872)", () => {
  const version = "0.0.1-helper-6872";

  beforeAll(async () => {
    await withSystemDbAccessContext(() =>
      db.insert(agentVersions).values({
        version,
        platform: "windows",
        architecture: "amd64",
        component: "helper",
        edition: getBinaryEdition(),
        isLatest: true,
        downloadUrl: "http://localhost:3001/api/v1/agents/download/helper/windows/amd64",
        checksum: "0".repeat(64),
        fileSize: BigInt(1),
        releaseManifest: "{}",
        manifestSignature: "sig",
        signingKeyId: "test",
      }),
    );
  });

  afterAll(async () => {
    await withSystemDbAccessContext(() =>
      db.delete(agentVersions).where(eq(agentVersions.version, version)),
    );
  });

  it("returns the helper version for pin:null on the matching platform/arch", async () => {
    const target = await withSystemDbAccessContext(() =>
      resolvePinnedUpgradeTarget({
        component: "helper",
        platform: "windows",
        architecture: "amd64",
        pin: null,
      }),
    );
    expect(target).toBe(version);
  });

  it("returns null for a platform with no helper row", async () => {
    const target = await withSystemDbAccessContext(() =>
      resolvePinnedUpgradeTarget({
        component: "helper",
        platform: "linux",
        architecture: "arm64",
        pin: null,
      }),
    );
    expect(target).toBeNull();
  });
});
```

Adjust the import paths for `db`, schema and `getBinaryEdition` to what the neighbouring integration test uses (`grep -n "from '../../db'" apps/api/src/__tests__/integration/*.ts | head -1`).

- [ ] **Step 2: Run it to verify it fails before the row exists**

Temporarily comment out the `beforeAll` insert and run:
`pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/helperBootstrapOffer.integration.test.ts`
Expected: first test FAILS (`expected null to be "0.0.1-helper-6872"`). Restore the insert.

- [ ] **Step 3: Run it to verify it passes**

Same command. Expected: PASS both.

- [ ] **Step 4: Update the release skill verification query**

In `.claude/skills/release/SKILL.md` line 376, change the verify-after query to:

```sql
select component,platform,architecture,version,is_latest from agent_versions where is_latest and edition='<BINARY_EDITION of this droplet>' order by 1,2,3;
```

and append after that bullet:

```markdown
- **Hosted specifically:** expect `helper` rows for windows/amd64, macos/amd64, macos/arm64, linux/amd64. Zero helper rows means `BINARY_SOURCE=local` sync did not see `/data/binaries/helper` (#6872) — Assist bootstrap is down until it does.
```

- [ ] **Step 5: Commit, push, open PR 1**

```bash
git add apps/api/src/__tests__/integration/helperBootstrapOffer.integration.test.ts .claude/skills/release/SKILL.md
git commit -m "test(api): pin helper bootstrap offer to a registered helper row (#6872)

Part of #6872

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin fix/6872-register-helper-rows-local-mode
gh pr create --title "fix(api): register Breeze Assist helper installers in local-mode binary sync (#6872)" --body "$(cat <<'EOF'
## Why
Hosted prod (US + EU, `BINARY_SOURCE=local`) has **zero** `component='helper'` rows in `agent_versions` (verified 2026-09-24). Local-mode `syncBinaries` only scanned agent/user-helper/watchdog/backup and `parseBinaryFilename` cannot match `.msi/.dmg/.AppImage`. So `resolvePinnedUpgradeTarget` returns null and the heartbeat never sends `helperUpgradeTo`: no hosted device can bootstrap or upgrade Assist.

## What
- `scanHelperInstallerDir(HELPER_BINARY_DIR)` maps the `HELPER_TARGETS` installer names to (platform, arch); the dmg covers both macOS arches.
- Registers `component='helper'` through the same two tiers as user-helper (#4682): official manifest first, per-deployment re-signing for uncovered files, refused assets excluded (D4 #3836). Own try/catch; never blocks the agent row.
- Integration test pins that a helper row is what the bootstrap branch resolves.
- Release skill verify query now checks helper slots per edition.

## Ops after deploy
Boot-time sync registers rows for the deployed version. Verify:
`select version,platform,architecture,is_latest,edition from agent_versions where component='helper';` → 4 rows, `is_latest=true`, `edition='hosted'`.

Spec: `docs/superpowers/specs/agent/2026-09-24-6872-breeze-assist-relaunch-loop-design.md` (D1 accepted).
Part of #6872. Agent-side fix follows in a separate PR.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
pnpm test-stack down
```

---

## PR 2 — Agent: never spawn an uninstalled helper; fail a missing spawn target

### Task 4: `ErrNotInstalled` from `ensureRunningSession`

**Files:**
- Modify: `agent/internal/helper/manager.go:63` (sentinel next to `ErrNoActiveSession`), `:557-594` (`ensureRunningSession`)
- Test: `agent/internal/helper/manager_test.go`

**Interfaces:**
- Produces: `var ErrNotInstalled = errors.New("breeze assist is not installed")` (package `helper`, exported). Tasks 5, 6, 7 use `errors.Is(err, ErrNotInstalled)`.

- [ ] **Step 1: Write the failing tests**

Append to `agent/internal/helper/manager_test.go`:

```go
// newNotInstalledManager builds a manager whose binaryPath does not exist
// and whose spawnFunc records every call — the #6872 fixture.
func newNotInstalledManager(t *testing.T) (*Manager, *int) {
	t.Helper()
	tmpDir := t.TempDir()
	origRemove := removeAutoStartFunc
	origStopLegacy := stopHelperLegacyFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		stopHelperLegacyFunc = origStopLegacy
	})
	removeAutoStartFunc = func() error { return nil }
	stopHelperLegacyFunc = func() {}

	spawns := 0
	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir
	mgr.binaryPath = filepath.Join(tmpDir, "breeze-helper") // never written
	mgr.sessionEnumerator = &mockEnumerator{sessions: []SessionInfo{{Key: "1", Username: "kit", UID: 1}}}
	mgr.isOurProcessFunc = func(pid int, binaryPath string) bool { return false }
	mgr.spawnFunc = func(sessionKey, binaryPath string, args ...string) (int, error) {
		spawns++
		return 4242, nil
	}
	return mgr, &spawns
}

func TestEnsureRunningSessionReturnsErrNotInstalled(t *testing.T) {
	mgr, spawns := newNotInstalledManager(t)
	state := newSessionState("1", mgr.baseDir)

	mgr.mu.Lock()
	err := mgr.ensureRunningSession(state)
	mgr.mu.Unlock()

	if !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("err = %v, want ErrNotInstalled", err)
	}
	if *spawns != 0 {
		t.Fatalf("spawnFunc called %d times for a missing binary", *spawns)
	}
}

// A device that hit the watcher's give-up state must recover the moment the
// binary is installed: the not-installed check comes BEFORE watcherGaveUp.
func TestEnsureRunningSessionNotInstalledBeatsWatcherGaveUp(t *testing.T) {
	mgr, spawns := newNotInstalledManager(t)
	state := newSessionState("1", mgr.baseDir)
	state.watcherGaveUp = true

	mgr.mu.Lock()
	err := mgr.ensureRunningSession(state)
	mgr.mu.Unlock()
	if !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("err = %v, want ErrNotInstalled while missing", err)
	}

	// Install it: the stale give-up flag must not block the first spawn.
	if err := os.WriteFile(mgr.binaryPath, []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	state.watcherGaveUp = false // applyPendingUpdate resets session state on install; mirror that
	mgr.mu.Lock()
	err = mgr.ensureRunningSession(state)
	mgr.mu.Unlock()
	if err != nil {
		t.Fatalf("post-install ensureRunningSession: %v", err)
	}
	if *spawns != 1 {
		t.Fatalf("spawnFunc called %d times after install, want 1", *spawns)
	}
}
```

Add `"errors"` to the test file's imports if missing.

- [ ] **Step 2: Run to verify they fail**

Run: `cd agent && go test -race ./internal/helper/ -run 'TestEnsureRunningSession(ReturnsErrNotInstalled|NotInstalledBeatsWatcherGaveUp)' -v`
Expected: compile FAIL — `undefined: ErrNotInstalled`.

- [ ] **Step 3: Implement**

In `agent/internal/helper/manager.go`, after line 63 (`var ErrNoActiveSession = …`):

```go
// ErrNotInstalled: Breeze Assist is enabled by policy but the helper binary is
// not on disk (never installed, or a failed in-place update removed it).
// Callers must not spawn, must not count it as a crash, and must not log it
// as an error on every heartbeat — the server's HelperUpgradeTo bootstrap
// offer is the only thing that resolves it (#6872).
var ErrNotInstalled = errors.New("breeze assist is not installed")
```

Add `"errors"` to the imports. In `ensureRunningSession`, insert between the tracked-PID checks (`:566-571`) and the `watcherGaveUp` check (`:572`):

```go
	// #6872: nothing to spawn. Checked BEFORE watcherGaveUp so a device that
	// burned its retries against a missing binary recovers on install.
	if !m.isInstalled() {
		return ErrNotInstalled
	}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd agent && go test -race ./internal/helper/ -v`
Expected: PASS, all tests in the package.

- [ ] **Step 5: Commit**

```bash
git checkout -b fix/6872-assist-not-installed-no-spawn main
git add agent/internal/helper/manager.go agent/internal/helper/manager_test.go
git commit -m "fix(agent): ensureRunningSession returns ErrNotInstalled instead of spawning a missing helper (#6872)

Part of #6872

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `Apply` returns early when enabled-but-not-installed, warns once, stops watchers

**Files:**
- Modify: `agent/internal/helper/manager.go:132-160` (struct field), `:313-330` (the `settings.Enabled && !m.isInstalled()` block), `:386-390` (per-session error branch)
- Test: `agent/internal/helper/manager_test.go`

**Interfaces:**
- Consumes: `ErrNotInstalled` (Task 4).
- Produces: `notInstalledWarned bool` field on `Manager` (unexported; Task 6's test reads it).

- [ ] **Step 1: Write the failing tests**

Append to `agent/internal/helper/manager_test.go`:

```go
func TestApplyEnabledNotInstalledNoPendingDoesNotSpawn(t *testing.T) {
	mgr, spawns := newNotInstalledManager(t)

	mgr.Apply(&Settings{Enabled: true})
	mgr.Apply(&Settings{Enabled: true})

	if *spawns != 0 {
		t.Fatalf("spawnFunc called %d times with no helper installed", *spawns)
	}
	for key, st := range mgr.sessions {
		if st.watcher != nil {
			t.Fatalf("session %s has a watcher with no helper installed", key)
		}
	}
	if !mgr.notInstalledWarned {
		t.Fatal("expected the not-installed warning to have fired once")
	}
}

func TestApplyNotInstalledWarnResetsWhenInstalledOrDisabled(t *testing.T) {
	mgr, _ := newNotInstalledManager(t)
	mgr.Apply(&Settings{Enabled: true})
	if !mgr.notInstalledWarned {
		t.Fatal("warn flag not set")
	}

	mgr.Apply(&Settings{Enabled: false})
	if mgr.notInstalledWarned {
		t.Fatal("warn flag must reset when the policy turns off")
	}

	mgr.Apply(&Settings{Enabled: true})
	if !mgr.notInstalledWarned {
		t.Fatal("warn flag not set on re-enable")
	}
	if err := os.WriteFile(mgr.binaryPath, []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	mgr.Apply(&Settings{Enabled: true})
	if mgr.notInstalledWarned {
		t.Fatal("warn flag must reset once the binary is installed")
	}
}

// Binary removed while a session watcher is running: the next Apply must stop
// that watcher and spawn nothing.
func TestApplyNotInstalledStopsExistingWatcher(t *testing.T) {
	mgr, spawns := newNotInstalledManager(t)
	if err := os.WriteFile(mgr.binaryPath, []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	mgr.Apply(&Settings{Enabled: true})
	if *spawns != 1 {
		t.Fatalf("installed: spawnFunc called %d times, want 1", *spawns)
	}
	if mgr.sessions["1"] == nil || mgr.sessions["1"].watcher == nil {
		t.Fatal("expected a watcher for session 1 while installed")
	}

	if err := os.Remove(mgr.binaryPath); err != nil {
		t.Fatal(err)
	}
	mgr.Apply(&Settings{Enabled: true})
	if mgr.sessions["1"].watcher != nil {
		t.Fatal("watcher still running after the binary vanished")
	}
	if *spawns != 1 {
		t.Fatalf("spawnFunc called %d times after the binary vanished, want still 1", *spawns)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd agent && go test -race ./internal/helper/ -run 'TestApply(EnabledNotInstalledNoPendingDoesNotSpawn|NotInstalledWarnResets|NotInstalledStopsExistingWatcher)' -v`
Expected: compile FAIL — `mgr.notInstalledWarned undefined`. (After adding the field only, the first test still fails: `spawnFunc called 2 times`.)

- [ ] **Step 3: Implement**

Struct field, after `stopIfOursFunc` in `Manager` (`:158`):

```go
	// notInstalledWarned: the "enabled but not installed, waiting for the
	// server" warning has fired for the current not-installed episode. Reset
	// when the binary appears or the policy turns off, so the log carries one
	// line per transition instead of one per heartbeat (#6872).
	notInstalledWarned bool
```

Replace the block at `:313-330` with:

```go
	if settings.Enabled && !m.isInstalled() {
		// Install only when the server has pinned a concrete (signed) helper
		// version via HelperUpgradeTo -> CheckUpdate. The heartbeat always
		// supplies one when bootstrapping a first install, and it is processed
		// before this Apply call within the same heartbeat. Without it we fail
		// closed rather than fetch unverified bytes.
		if m.pendingHelperVersion == "" {
			if !m.notInstalledWarned {
				log.Warn("breeze assist enabled but not installed; waiting for the server to offer a helper version")
				m.notInstalledWarned = true
			}
			// #6872: nothing to configure, spawn, or watch. A watcher left over
			// from an installed state must not keep respawning a missing binary.
			for _, state := range m.sessions {
				m.stopSessionWatcher(state)
			}
			return
		}
		if err := m.downloadAndInstall(m.pendingHelperVersion); err != nil {
			// downloadAndInstall wraps the verified downloader's error, which for
			// any transport failure is a *url.Error carrying the presigned
			// helper-asset URL. This log line ships, so it must be redacted.
			key, value := updater.SafeDownloadErrorFields(err)
			log.Error("failed to install breeze assist", key, value)
			return
		}
	}
	if !settings.Enabled || m.isInstalled() {
		m.notInstalledWarned = false
	}
```

Per-session error branch at `:386-390`, replace with:

```go
			if err := m.ensureRunningSession(state); err != nil {
				if errors.Is(err, ErrNotInstalled) {
					log.Debug("breeze assist not installed; skipping spawn", "session", si.Key)
				} else {
					log.Error("failed to start breeze assist", "session", si.Key, "error", err.Error())
				}
			} else {
				m.startSessionWatcher(state)
			}
			continue
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd agent && go test -race ./internal/helper/ -v`
Expected: PASS, whole package. `TestApplyDisabledUninstalledIsStableNoOp` and `TestApplyEnabledInstallUsesPendingVersion` must remain green (the early return happens only on the no-pending branch).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/helper/manager.go agent/internal/helper/manager_test.go
git commit -m "fix(agent): Apply skips spawn/watch and warns once when Assist is enabled but not installed (#6872)

Part of #6872

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Watcher exits on `ErrNotInstalled` without burning retries

**Files:**
- Modify: `agent/internal/helper/watcher.go:33-96`
- Test: `agent/internal/helper/watcher_test.go` (create)

**Interfaces:**
- Consumes: `ErrNotInstalled`, `newSessionWatcher(ctx, mgr, state)`, `watcherBaseInterval` (package var, `watcher.go:9`).

- [ ] **Step 1: Write the failing test**

Create `agent/internal/helper/watcher_test.go`:

```go
package helper

import (
	"context"
	"os"
	"testing"
	"time"
)

// #6872: a watcher whose helper binary vanished must exit on the first tick
// without counting a failure or flagging watcherGaveUp; Apply restarts one
// after the install lands.
func TestWatcherExitsOnNotInstalled(t *testing.T) {
	mgr, spawns := newNotInstalledManager(t)

	origInterval := watcherBaseInterval
	watcherBaseInterval = 10 * time.Millisecond
	t.Cleanup(func() { watcherBaseInterval = origInterval })

	state := newSessionState("1", mgr.baseDir)
	mgr.sessions["1"] = state
	w := newSessionWatcher(context.Background(), mgr, state)
	state.watcher = w
	go w.run()

	select {
	case <-w.done:
	case <-time.After(2 * time.Second):
		t.Fatal("watcher did not exit within 2s with the binary missing")
	}
	if *spawns != 0 {
		t.Fatalf("spawnFunc called %d times, want 0", *spawns)
	}
	if state.watcherGaveUp {
		t.Fatal("watcherGaveUp set for a not-installed helper")
	}
}

// Control: with the binary present and a spawnFunc whose process is never
// "running", the watcher still counts failures as before (regression guard).
func TestWatcherStillCountsRealFailures(t *testing.T) {
	mgr, spawns := newNotInstalledManager(t)
	if err := os.WriteFile(mgr.binaryPath, []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	origInterval, origCap := watcherBaseInterval, watcherBackoffCap
	watcherBaseInterval, watcherBackoffCap = 5*time.Millisecond, 5*time.Millisecond
	t.Cleanup(func() { watcherBaseInterval, watcherBackoffCap = origInterval, origCap })

	state := newSessionState("1", mgr.baseDir)
	mgr.sessions["1"] = state
	w := newSessionWatcher(context.Background(), mgr, state)
	go w.run()

	select {
	case <-w.done:
	case <-time.After(5 * time.Second):
		t.Fatal("watcher did not give up")
	}
	if !state.watcherGaveUp {
		t.Fatal("expected watcherGaveUp after retries with the binary present")
	}
	if *spawns != watcherMaxRetries {
		t.Fatalf("spawnFunc called %d times, want %d", *spawns, watcherMaxRetries)
	}
}
```

`watcherBaseInterval` and `watcherBackoffCap` are `const` today (`watcher.go:9-11`). Change them to `var` in Step 3 so tests can shorten them; if `isHelperRunningInSession` on the test OS returns true for the fake PID, set `mgr.isOurProcessFunc` to return false (already done in the fixture) and check `process_check_<os>.go` — on darwin/linux it scans by binary path, which will not match a temp file, so it returns false.

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent && go test -race ./internal/helper/ -run 'TestWatcher' -v`
Expected: compile FAIL (`cannot assign to watcherBaseInterval`), then after the `var` change: `TestWatcherExitsOnNotInstalled` FAILS on `spawnFunc called 5 times` / `watcherGaveUp set` (Task 4's sentinel means spawns stay 0 but the watcher keeps ticking until give-up: the assertion on `watcherGaveUp` is the red).

- [ ] **Step 3: Implement**

In `watcher.go` change the constants to variables:

```go
var (
	watcherBaseInterval = 30 * time.Second
	watcherBackoffCap   = 30 * time.Second
)

const watcherMaxRetries = 5
```

Then in `run()`, replace the `err := w.mgr.ensureRunningSession(w.state)` … `if err != nil { log.Warn(...) } else { log.Info(...) }` section with:

```go
		err := w.mgr.ensureRunningSession(w.state)
		if errors.Is(err, ErrNotInstalled) {
			// #6872: not a crash. Undo the failure we just counted, leave
			// watcherGaveUp alone, and exit — Apply starts a fresh watcher
			// once the server-offered install lands.
			failures--
			w.mgr.mu.Unlock()
			log.Debug("breeze assist not installed; watcher exiting", "session", w.state.key)
			return
		}
		w.mgr.mu.Unlock()

		if err != nil {
			log.Warn("watcher failed to restart breeze assist",
				"session", w.state.key,
				"error", err.Error(),
				"failures", failures,
			)
		} else {
			log.Info("breeze assist restarted by watcher", "session", w.state.key)
		}
```

Add `"errors"` to the imports. Note `failures++` and the `failures > watcherMaxRetries` give-up check run **before** `ensureRunningSession` today; the `failures--` keeps the counter honest for the log line but the important part is the `return` before any further tick.

Because `state.watcher` still points at this exited watcher, `startSessionWatcher` (`manager.go:869`) would refuse to start a new one. Fix that in the same step: in `startSessionWatcher`, replace `if state.watcher != nil { return }` with:

```go
	if state.watcher != nil {
		select {
		case <-state.watcher.done:
			// Exited on its own (ErrNotInstalled, #6872): replace it.
			state.watcher = nil
		default:
			return
		}
	}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd agent && go test -race ./internal/helper/ -v`
Expected: PASS, whole package.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/helper/watcher.go agent/internal/helper/watcher_test.go agent/internal/helper/manager.go
git commit -m "fix(agent): session watcher exits on ErrNotInstalled instead of burning retries (#6872)

Part of #6872

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `SpawnProcessInSessionWithArgs` fails fast on a missing binary

**Files:**
- Create: `agent/internal/sessionbroker/spawn_errors.go` (untagged, so the sentinel is visible on every OS)
- Modify: `agent/internal/sessionbroker/spawn_process_windows.go:29-31`
- Test: `agent/internal/sessionbroker/spawn_process_windows_test.go` (create, `//go:build windows`)

**Interfaces:**
- Produces: `var ErrBinaryMissing = errors.New("spawn target does not exist")` in package `sessionbroker`. The heartbeat `WithSpawnFunc` closure returns it unchanged (wrapped), and `helper.Manager` surfaces it via the existing "failed to start breeze assist" error path. Task 8's lab run observes it.

- [ ] **Step 1: Write the failing test**

Create `agent/internal/sessionbroker/spawn_process_windows_test.go`:

```go
//go:build windows

package sessionbroker

import (
	"errors"
	"path/filepath"
	"testing"
)

// #6872: cmd.exe /c start "" "<missing>" used to report success with cmd.exe's
// PID; the missing file only surfaced as a "crash" 30s later, and Windows
// showed the user a "cannot find" dialog on every retry. Stat first.
func TestSpawnProcessInSessionWithArgsMissingBinary(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "breeze-helper.exe")

	err := SpawnProcessInSessionWithArgs(missing, []string{"--config", "x"}, 1)

	if !errors.Is(err, ErrBinaryMissing) {
		t.Fatalf("err = %v, want ErrBinaryMissing", err)
	}
}
```

Session 1 need not exist: the stat guard must return before `acquireUserToken`, so the test passes on a lab VM with any session layout and fails today with a token error instead.

- [ ] **Step 2: Run to verify it fails (native Windows)**

On the Windows lab VM (`ssh administrator@100.101.150.55`, Go at `C:\go-1.26.6`; read memory `windows_test_vm.md` first), sync the branch and run:
`go test -race ./internal/sessionbroker/ -run TestSpawnProcessInSessionWithArgsMissingBinary -v`
Expected: compile FAIL — `undefined: ErrBinaryMissing`.

Cross-compile check from macOS meanwhile: `cd agent && GOOS=windows GOARCH=amd64 go vet ./internal/sessionbroker/` — must also fail with the same undefined symbol.

- [ ] **Step 3: Implement**

Create `agent/internal/sessionbroker/spawn_errors.go`:

```go
package sessionbroker

import "errors"

// ErrBinaryMissing: the spawn target does not exist on disk. Returned by the
// Windows session spawner BEFORE any token acquisition or cmd.exe launch, so a
// missing helper never reports a bogus "spawned" success (#6872).
var ErrBinaryMissing = errors.New("spawn target does not exist")
```

In `spawn_process_windows.go`, at the top of `SpawnProcessInSessionWithArgs` (before `acquireUserToken`):

```go
	// #6872: cmd.exe always exists, so CreateProcessAsUser(cmd.exe /c start
	// "" "<binary>") succeeds even when <binary> does not — the log then
	// claims a spawn with cmd.exe's PID and the user gets a "Windows cannot
	// find" dialog. Check the target first.
	if _, statErr := os.Stat(binaryPath); statErr != nil {
		if os.IsNotExist(statErr) {
			return fmt.Errorf("%w: %s", ErrBinaryMissing, binaryPath)
		}
		return fmt.Errorf("stat spawn target %s: %w", binaryPath, statErr)
	}
```

`os` is already imported in that file.

- [ ] **Step 4: Run to verify it passes (native Windows) and the package still builds everywhere**

Windows VM: `go test -race ./internal/sessionbroker/ -v` → PASS (including the new test).
macOS: `cd agent && go test -race ./internal/sessionbroker/ ./internal/onedrivehelper/ && GOOS=windows GOARCH=amd64 go vet ./internal/sessionbroker/ ./internal/onedrivehelper/ ./internal/heartbeat/` → clean.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/sessionbroker/spawn_errors.go agent/internal/sessionbroker/spawn_process_windows.go agent/internal/sessionbroker/spawn_process_windows_test.go
git commit -m "fix(agent): SpawnProcessInSessionWithArgs fails fast when the target binary is missing (#6872)

Part of #6872

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Lab proof on the Windows VM, full agent test run, open PR 2

**Files:**
- Modify: `docs/superpowers/specs/agent/2026-09-24-6872-breeze-assist-relaunch-loop-design.md` (append a "Lab evidence" section with the log excerpts)

- [ ] **Step 1: Full agent suite**

Run: `cd agent && go test -race ./...`
Expected: PASS. Then `cd agent && make lint` if the Makefile has it (`grep -n '^lint' Makefile`).

- [ ] **Step 2: Lab run A — not installed, no offer**

Read memory files `windows_test_vm.md` and `devpush_to_remote_vm_gotchas.md`. Bring up a wt-stack (`pnpm wt-stack up`, skill `worktree-stack`), enrol the VM, enable Assist by policy for its org, and make sure the lab API has **no** helper rows (`delete from agent_versions where component='helper'` on the lab DB only). On the VM delete `C:\Program Files\Breeze Helper\breeze-helper.exe` if present. `make dev-push` the branch build.

Expected in `agent.log` after two heartbeats:
- exactly one `WARN breeze assist enabled but not installed; waiting for the server to offer a helper version`
- **no** `spawned process in session`, **no** `breeze assist restarted by watcher`, **no** `keeps crashing`, **no** per-minute `failed to start breeze assist`.
- Nothing visible on the VM desktop (no "Windows cannot find" dialog).

- [ ] **Step 3: Lab run B — offer arrives, install runs, spawn is real**

Stage `breeze-helper-windows.msi` into the lab API's `HELPER_BINARY_DIR` (the PR 1 branch merged into the lab stack, or cherry-picked), restart the API so `syncBinaries` registers the row, confirm with `select version,platform,architecture,is_latest from agent_versions where component='helper'`. Wait for the next heartbeat.

Expected in `agent.log`:
- `helper update pending`, `downloading helper package (verified)`, `helper installed`
- one `spawned process in session … binary="C:\Program Files\Breeze Helper\breeze-helper.exe"`, followed by a running Assist tray icon on the VM, and the watcher staying quiet.

- [ ] **Step 4: Lab run C — binary removed while running**

With Assist running, stop it and delete `breeze-helper.exe`. Expected within one heartbeat: one `WARN … enabled but not installed`, `DEBUG breeze assist not installed; watcher exiting`, no retries, no give-up.

- [ ] **Step 5: Record evidence and open PR 2**

Append to the spec a `## 10. Lab evidence (2026-MM-DD)` section with the three log excerpts (trim to the relevant lines, no hostnames or tokens). Then:

```bash
git add docs/superpowers/specs/agent/2026-09-24-6872-breeze-assist-relaunch-loop-design.md
git commit -m "docs(spec): lab evidence for #6872 fix

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin fix/6872-assist-not-installed-no-spawn
gh pr create --title "fix(agent): stop relaunching Breeze Assist when it is not installed (#6872)" --body "$(cat <<'EOF'
## Why
With Assist enabled by policy and no helper binary on disk, the agent spawned `cmd /c start "" "<missing>"` every 30s (reported success with cmd.exe's PID), burned the watcher's 5 retries, then logged an error once a minute forever. It never installed anything because hosted prod had no helper rows (fixed server-side in the sibling API PR).

## What
- `helper.ErrNotInstalled`: `ensureRunningSession` returns it before spawning (and before the `watcherGaveUp` check, so a device recovers on install).
- `Apply`: enabled-but-not-installed with no pending version → one Warn per transition, stop leftover watchers, return. No config write, no spawn, no watcher.
- Watcher: exits on `ErrNotInstalled` without counting a failure; `startSessionWatcher` replaces an exited watcher.
- `sessionbroker.SpawnProcessInSessionWithArgs`: `os.Stat` the target first → `ErrBinaryMissing`. `cmd /c start` kept (spec D3).

## Verification
- `go test -race ./...` green; new Windows-tagged test run natively on the lab VM.
- Lab runs A/B/C recorded in the spec (§10).

Needs an agent release. Spec: `docs/superpowers/specs/agent/2026-09-24-6872-breeze-assist-relaunch-loop-design.md`.
Closes #6872

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
pnpm wt-stack down
```

- [ ] **Step 6: File the follow-ups from spec §8** as GitHub issues (hosted manifest coverage of helper installers; direct launch in `SpawnProcessInSessionWithArgs`; KIT `.backup`-only binary; "not installed" surfaced in UI; 09-09 offer provenance), each linking #6872, and list their numbers in a comment on #6872.
