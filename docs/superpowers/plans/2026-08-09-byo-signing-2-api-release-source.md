# BYO Signing Phase 2: API Release Source + Trust Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec Deliverable 3 (3a unified release source, 3b deployment re-signing for overridden repos, 3c positive trust allowlist at ingestion + serving, 3d recovery-media manifest-driven hashes) and Deliverable 5 (retire `msiSigning.ts`) from `docs/superpowers/specs/2026-08-09-selfhost-byo-signing-design.md`, so a self-hoster can point `BINARY_GITHUB_REPOSITORY` at their own signed-release repo and their agents update via the TOFU-pinned deployment key with zero agent-side changes.

**Architecture:** A single validated release-source helper (`releaseSource.ts`) replaces the three fragmented repo identities (`binarySource.ts` hardcoded constant, `binarySync.ts` `GITHUB_REPO` env, `BINARY_GITHUB_REPOSITORY` manifest-only override). When the source is overridden, github-mode sync re-signs a normalized per-asset update manifest with the existing per-deployment Ed25519 key (`manifestSigning.ts`) and stamps the `deploy-*` key ID; the official path stays byte-identical. A positive platform-trust allowlist is enforced centrally in `releaseArtifactManifest.selectManifestAsset` (every manifest verification funnels through it) plus a name-based `signing-input` guard in the URL-builder chokepoint that `download.ts`/`supportPublic.ts` redirect/proxy through. Recovery media verifies the backup binary against the deployment-verified release manifest instead of the static hash table. `msiSigning.ts` and every env/validation/compose/test-mock trace of `MSI_SIGNING_*` are deleted.

**Tech Stack:** TypeScript (Hono API), Vitest, Drizzle, Go (agent updater E2E), Docker Compose

## Global Constraints

- Default repository is `lanternops/breeze` (case-insensitive compare everywhere; manifest repository matching is already case-insensitive per `releaseArtifactManifest.ts:238-252`).
- Repository values must match `/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/` — anything else throws at the helper AND boot-refuses via the config schema.
- Production override rule: `BINARY_GITHUB_REPOSITORY` set to a non-official repo requires `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` explicitly set (note: production already requires it unconditionally at `validate.ts:1109-1116`; the new rule adds the override-specific message and survives any future relaxation of the blanket rule).
- Re-sign ONLY for overridden repos: when `isOfficialReleaseSource()` is true the github sync path must remain **byte-identical** to today (still stamps `signingKeyId: "release-artifact-manifest-ed25519"`, still stores the raw release manifest, never calls `ensureActiveSigningKey`).
- `intendedUse: "signing-input"` assets (and any `-unsigned`-named asset) are never registrable and never serveable; unknown `platformTrust` values fail closed; canonical Windows `.exe`/`.msi` require `windows-authenticode-required`; canonical macOS assets require `macos-developer-id-notarization-required`.
- New env var `BINARY_GITHUB_REPOSITORY` must be added to the config schema (`validate.ts`), BOTH compose `environment:` blocks (`docker-compose.yml` api service, `deploy/docker-compose.prod.yml` api service), and BOTH `.env.example` files (as a commented entry — `envComposeParity.test.ts` only enforces uncommented assignments, but the compose mapping is required regardless per the deploy contract).
- Compose files are touched → run `pnpm --filter @breeze/api test -- src/config/composeBindMounts.test.ts src/config/envComposeParity.test.ts src/config/proxyTrustCompose.test.ts` in the tasks that edit them.
- TDD: every behavioral change lands as failing test → implement → pass. Unit config (`apps/api/vitest.config.ts`) with Drizzle mocks per `binarySync.test.ts` patterns; no new integration-suite dependencies.
- Go: `cd agent && go test -race ./internal/updater/...`.
- Conventional commits; every commit ends with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Out of scope (explicit handoffs): `apps/docs` content changes (Phase 3/Deliverable 4); a `ci-smoke-binary-source-github.yml` override variant needs a real fixture repo with releases and is deferred to the Phase 3 template-repo work; the template repo itself (Deliverable 2); release.yml changes (Deliverable 1).

---

### Task 1: Create the validated release-source helper

**Files:**
- Create: `apps/api/src/services/releaseSource.ts`
- Test: `apps/api/src/services/releaseSource.test.ts` (new)

**Interfaces:**
- Produces:
  - `getReleaseSourceRepository(): string` — `BINARY_GITHUB_REPOSITORY` → legacy `GITHUB_REPO` (deprecation-warned once) → `'lanternops/breeze'`; throws on invalid shape.
  - `isOfficialReleaseSource(): boolean` — lowercase compare against `OFFICIAL_RELEASE_REPOSITORY`.
  - `getReleaseSourceReleaseBase(): string` — `https://github.com/<repo>/releases`.
  - `getReleaseSourceApiBase(): string` — `https://api.github.com/repos/<repo>`.
  - `getReleaseDownloadUrl(tag: string | null, assetName: string): string` — `latest/download/<asset>` when tag is null, else `download/<tag>/<asset>`.
  - `OFFICIAL_RELEASE_REPOSITORY = 'lanternops/breeze'` (exported const).
- Consumes: `process.env.BINARY_GITHUB_REPOSITORY`, `process.env.GITHUB_REPO`.

**Steps:**

- [ ] Write `apps/api/src/services/releaseSource.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OFFICIAL_RELEASE_REPOSITORY,
  getReleaseDownloadUrl,
  getReleaseSourceApiBase,
  getReleaseSourceReleaseBase,
  getReleaseSourceRepository,
  isOfficialReleaseSource,
} from './releaseSource';

describe('releaseSource', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BINARY_GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults to the official repository', () => {
    expect(getReleaseSourceRepository()).toBe(OFFICIAL_RELEASE_REPOSITORY);
    expect(isOfficialReleaseSource()).toBe(true);
  });

  it('resolves BINARY_GITHUB_REPOSITORY as the override', () => {
    process.env.BINARY_GITHUB_REPOSITORY = 'acme/breeze-selfhost-signing';
    expect(getReleaseSourceRepository()).toBe('acme/breeze-selfhost-signing');
    expect(isOfficialReleaseSource()).toBe(false);
  });

  it('treats a case-variant of the official repo as official', () => {
    process.env.BINARY_GITHUB_REPOSITORY = 'LanternOps/breeze';
    expect(isOfficialReleaseSource()).toBe(true);
  });

  it('falls back to the legacy GITHUB_REPO alias when BINARY_GITHUB_REPOSITORY is unset', () => {
    process.env.GITHUB_REPO = 'LanternOps/breeze';
    expect(getReleaseSourceRepository()).toBe('LanternOps/breeze');
  });

  it('prefers BINARY_GITHUB_REPOSITORY over the legacy alias', () => {
    process.env.GITHUB_REPO = 'legacy/repo';
    process.env.BINARY_GITHUB_REPOSITORY = 'acme/breeze-selfhost-signing';
    expect(getReleaseSourceRepository()).toBe('acme/breeze-selfhost-signing');
  });

  it.each([
    'no-slash',
    'a/b/c',
    'owner/repo?x=1',
    'owner/../repo',
    '../etc/passwd',
    'owner/repo#frag',
    'owner /repo',
    'https://github.com/owner/repo',
  ])('rejects malformed repository %j', (bad) => {
    process.env.BINARY_GITHUB_REPOSITORY = bad;
    expect(() => getReleaseSourceRepository()).toThrow(/Invalid release source repository/);
  });

  it('accepts dots, underscores, and hyphens in the repository name', () => {
    process.env.BINARY_GITHUB_REPOSITORY = 'my-org/breeze_signing.v2';
    expect(getReleaseSourceRepository()).toBe('my-org/breeze_signing.v2');
  });

  it('builds release, API, and download URLs from the resolved repository', () => {
    process.env.BINARY_GITHUB_REPOSITORY = 'acme/breeze-selfhost-signing';
    expect(getReleaseSourceReleaseBase()).toBe(
      'https://github.com/acme/breeze-selfhost-signing/releases',
    );
    expect(getReleaseSourceApiBase()).toBe(
      'https://api.github.com/repos/acme/breeze-selfhost-signing',
    );
    expect(getReleaseDownloadUrl(null, 'breeze-agent.msi')).toBe(
      'https://github.com/acme/breeze-selfhost-signing/releases/latest/download/breeze-agent.msi',
    );
    expect(getReleaseDownloadUrl('v1.2.3', 'breeze-agent.msi')).toBe(
      'https://github.com/acme/breeze-selfhost-signing/releases/download/v1.2.3/breeze-agent.msi',
    );
  });
});
```

- [ ] Run `pnpm --filter @breeze/api test -- src/services/releaseSource.test.ts` — expect failure: `Cannot find module './releaseSource'`.
- [ ] Create `apps/api/src/services/releaseSource.ts`:

```ts
/**
 * Single source of truth for WHICH GitHub repository this deployment pulls
 * release artifacts from (spec: 2026-08-09-selfhost-byo-signing-design.md,
 * Deliverable 3a).
 *
 * Before this module the release-source identity was fragmented three ways:
 * binarySource.ts hardcoded lanternops/breeze for download URLs, binarySync.ts
 * read a separate GITHUB_REPO env for the Releases API, and
 * BINARY_GITHUB_REPOSITORY only affected manifest-repository validation. Every
 * consumer now resolves the repository here.
 *
 * BYO signing: a self-hoster sets BINARY_GITHUB_REPOSITORY=theirorg/their-repo
 * (plus RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=<their release key>) and the
 * whole instance — sync, download redirects, installer pre-flight, support
 * client, recovery media — follows their signed releases.
 */

export const OFFICIAL_RELEASE_REPOSITORY = 'lanternops/breeze';

// Strict owner/repository shape. GitHub owner names are alphanumeric+hyphen;
// repository names additionally allow dot and underscore. Nothing else may
// reach URL construction (path traversal, query strings, schemes).
const REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

let legacyGithubRepoWarned = false;

export function getReleaseSourceRepository(): string {
  const override = process.env.BINARY_GITHUB_REPOSITORY?.trim();
  const legacy = process.env.GITHUB_REPO?.trim();

  let repository = OFFICIAL_RELEASE_REPOSITORY;
  if (override) {
    repository = override;
  } else if (legacy) {
    // Pre-unification binarySync.ts read GITHUB_REPO. Kept as a deprecated
    // alias so an existing deployment that set it does not silently flip back
    // to the official repo on upgrade.
    if (!legacyGithubRepoWarned) {
      console.warn(
        '[releaseSource] GITHUB_REPO is deprecated; set BINARY_GITHUB_REPOSITORY instead',
      );
      legacyGithubRepoWarned = true;
    }
    repository = legacy;
  }

  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(
      `Invalid release source repository "${repository}": expected "owner/repository" matching [A-Za-z0-9-]+/[A-Za-z0-9._-]+`,
    );
  }
  return repository;
}

export function isOfficialReleaseSource(): boolean {
  return getReleaseSourceRepository().toLowerCase() === OFFICIAL_RELEASE_REPOSITORY;
}

export function getReleaseSourceReleaseBase(): string {
  return `https://github.com/${getReleaseSourceRepository()}/releases`;
}

export function getReleaseSourceApiBase(): string {
  return `https://api.github.com/repos/${getReleaseSourceRepository()}`;
}

/** tag === null means "latest". Tags are passed verbatim (e.g. "v1.2.3"). */
export function getReleaseDownloadUrl(tag: string | null, assetName: string): string {
  const base = getReleaseSourceReleaseBase();
  return tag === null
    ? `${base}/latest/download/${assetName}`
    : `${base}/download/${tag}/${assetName}`;
}
```

- [ ] Run `pnpm --filter @breeze/api test -- src/services/releaseSource.test.ts` — expect all green.
- [ ] Commit: `feat(api): validated release-source helper for BYO signing (spec 3a)`

---

### Task 2: Wire binarySource.ts URL builders through the helper

**Files:**
- Modify: `apps/api/src/services/binarySource.ts` (delete hardcoded `GITHUB_RELEASE_BASE`/`GITHUB_REPOSITORY` at lines 3-4; rewrite `getGithubReleasePageUrl` at 37-43, `githubDownloadBase` at 45-51, `getGithubReleaseRepository` at 53-55)
- Test: `apps/api/src/services/binarySource.test.ts` (new)

**Interfaces:**
- Consumes: `getReleaseSourceRepository`, `getReleaseSourceReleaseBase` from `./releaseSource`.
- Produces: unchanged public signatures — `getGithubReleaseRepository(): string` (now delegates), `getGithubAgentUrl(os, arch)`, `getGithubBackupUrl`, `getGithubAgentPkgUrl`, `getGithubWatchdogUrl`, `getGithubUserHelperUrl`, `getGithubRegularMsiUrl`, `getGithubViewerUrl`, `getGithubHelperUrl`, `getGithubInstallerAppUrl`, `getGithubReleasePageUrl`, manifest URL builders. Callers (`routes/agents/download.ts:6`, `routes/supportPublic.ts`, `services/installerBuilder.ts:8-13`, `services/recoveryMediaService.ts:25`) need no edits.

**Steps:**

- [ ] Write `apps/api/src/services/binarySource.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getGithubAgentUrl,
  getGithubHelperUrl,
  getGithubInstallerAppUrl,
  getGithubRegularMsiUrl,
  getGithubReleasePageUrl,
  getGithubReleaseRepository,
  getGithubViewerUrl,
} from './binarySource';

describe('binarySource release-source unification', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BINARY_GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO;
    delete process.env.BINARY_VERSION;
    delete process.env.BREEZE_VERSION;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('default URLs are unchanged (official repo, latest)', () => {
    expect(getGithubAgentUrl('windows', 'amd64')).toBe(
      'https://github.com/lanternops/breeze/releases/latest/download/breeze-agent-windows-amd64.exe',
    );
    expect(getGithubRegularMsiUrl()).toBe(
      'https://github.com/lanternops/breeze/releases/latest/download/breeze-agent.msi',
    );
    expect(getGithubReleasePageUrl()).toBe(
      'https://github.com/lanternops/breeze/releases/latest',
    );
  });

  it('every URL builder follows BINARY_GITHUB_REPOSITORY', () => {
    process.env.BINARY_GITHUB_REPOSITORY = 'acme/breeze-selfhost-signing';
    process.env.BINARY_VERSION = '1.2.3';
    const base = 'https://github.com/acme/breeze-selfhost-signing/releases/download/v1.2.3';
    expect(getGithubAgentUrl('linux', 'arm64')).toBe(`${base}/breeze-agent-linux-arm64`);
    expect(getGithubViewerUrl('windows')).toBe(`${base}/breeze-viewer-windows.msi`);
    expect(getGithubHelperUrl('darwin')).toBe(`${base}/breeze-helper-macos.dmg`);
    expect(getGithubInstallerAppUrl()).toBe(`${base}/Breeze.Installer.app.zip`);
    expect(getGithubReleaseRepository()).toBe('acme/breeze-selfhost-signing');
    expect(getGithubReleasePageUrl()).toBe(
      'https://github.com/acme/breeze-selfhost-signing/releases/tag/v1.2.3',
    );
  });

  it('rejects a malformed repository before building any URL', () => {
    process.env.BINARY_GITHUB_REPOSITORY = 'owner/repo/../evil';
    expect(() => getGithubAgentUrl('windows', 'amd64')).toThrow(
      /Invalid release source repository/,
    );
  });
});
```

- [ ] Run `pnpm --filter @breeze/api test -- src/services/binarySource.test.ts` — expect failures on the override test (URLs still hardcode `lanternops/breeze`).
- [ ] Edit `apps/api/src/services/binarySource.ts`. Replace lines 3-4:

```ts
const GITHUB_RELEASE_BASE = 'https://github.com/lanternops/breeze/releases';
const GITHUB_REPOSITORY = 'lanternops/breeze';
```

with:

```ts
import { getReleaseSourceReleaseBase, getReleaseSourceRepository } from './releaseSource';
```

  Then replace every `GITHUB_RELEASE_BASE` usage (lines 40, 42, 48, 50) with `getReleaseSourceReleaseBase()`:

```ts
export function getGithubReleasePageUrl(): string {
  const version = getGithubReleaseVersion();
  if (version === 'latest') {
    return `${getReleaseSourceReleaseBase()}/latest`;
  }
  return `${getReleaseSourceReleaseBase()}/tag/v${version}`;
}

function githubDownloadBase(): string {
  const version = getGithubReleaseVersion();
  if (version === 'latest') {
    return `${getReleaseSourceReleaseBase()}/latest/download`;
  }
  return `${getReleaseSourceReleaseBase()}/download/v${version}`;
}
```

  And replace `getGithubReleaseRepository` (lines 53-55) with a delegation:

```ts
export function getGithubReleaseRepository(): string {
  return getReleaseSourceRepository();
}
```

- [ ] Run `pnpm --filter @breeze/api test -- src/services/binarySource.test.ts src/services/releaseSource.test.ts src/services/installerBuilder.test.ts` — expect green (installerBuilder pre-flight consumes `getGithubReleaseRepository`, which behaves identically for unset/official env).
- [ ] Commit: `feat(api): route binarySource URL builders through the unified release source (spec 3a)`

---

### Task 3: Wire binarySync.ts through the helper (retire GITHUB_REPO)

**Files:**
- Modify: `apps/api/src/services/binarySync.ts` (delete `const GITHUB_REPO` at line 17; `expectedRepository` at line 225; GitHub API URL construction at lines 551-553)
- Test: `apps/api/src/services/binarySync.test.ts` (extend; helper `makeSignedReleaseManifest` at lines 75-104, `makeSignedReleaseManifestMulti` at 108-141)

**Interfaces:**
- Consumes: `getReleaseSourceRepository`, `getReleaseSourceApiBase` from `./releaseSource`.
- Produces: `syncFromGitHub(requestedVersion?: string): Promise<{ version: string; synced: string[] }>` — signature unchanged.

**Steps:**

- [ ] In `apps/api/src/services/binarySync.test.ts`, first update the two manifest fixture helpers to take a repository (needed by this task and Task 5). Change the signature of `makeSignedReleaseManifest` (line 75) to:

```ts
function makeSignedReleaseManifest(
  assetName: string,
  assetBuffer: Buffer,
  repository = "LanternOps/breeze",
) {
```

  and its manifest body to use `repository:` instead of the literal. Same for `makeSignedReleaseManifestMulti` (line 108):

```ts
function makeSignedReleaseManifestMulti(
  assets: { name: string; buffer: Buffer }[],
  release = "v1.2.3",
  repository = "LanternOps/breeze",
) {
```

- [ ] Add the failing tests to `binarySync.test.ts` (inside the top-level `describe("binarySync", ...)`):

```ts
  describe("release-source unification (spec 3a)", () => {
    function stubOverriddenRepoFetch(
      repo: string,
      assetName: string,
      asset: Buffer,
      signed: ReturnType<typeof makeSignedReleaseManifest>,
    ) {
      const fetchSpy = vi.fn(async (url: string) => {
        if (url === `https://api.github.com/repos/${repo}/releases/latest`) {
          return new Response(
            JSON.stringify({
              tag_name: "v1.2.3",
              body: "release notes",
              assets: [
                {
                  name: assetName,
                  browser_download_url: `https://github.com/${repo}/releases/download/v1.2.3/${assetName}`,
                  size: asset.length,
                },
                {
                  name: "release-artifact-manifest.json",
                  browser_download_url: `https://github.com/${repo}/releases/download/v1.2.3/release-artifact-manifest.json`,
                  size: signed.manifest.length,
                },
                {
                  name: "release-artifact-manifest.json.ed25519",
                  browser_download_url: `https://github.com/${repo}/releases/download/v1.2.3/release-artifact-manifest.json.ed25519`,
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
      });
      vi.stubGlobal("fetch", fetchSpy);
      return fetchSpy;
    }

    it("queries the GitHub API for the overridden repository and accepts its manifest", async () => {
      const repo = "acme/breeze-selfhost-signing";
      process.env.BINARY_GITHUB_REPOSITORY = repo;
      const assetName = "breeze-agent-linux-amd64";
      const asset = Buffer.from("self-hosted agent bytes");
      const signed = makeSignedReleaseManifest(assetName, asset, repo);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      const fetchSpy = stubOverriddenRepoFetch(repo, assetName, asset, signed);

      const result = await syncFromGitHub();

      expect(fetchSpy).toHaveBeenCalledWith(
        `https://api.github.com/repos/${repo}/releases/latest`,
        expect.anything(),
      );
      expect(result.synced).toContain("agent:linux/amd64");
    });

    it("rejects a manifest whose repository does not match the overridden source", async () => {
      const repo = "acme/breeze-selfhost-signing";
      process.env.BINARY_GITHUB_REPOSITORY = repo;
      const assetName = "breeze-agent-linux-amd64";
      const asset = Buffer.from("self-hosted agent bytes");
      // Manifest still claims the OFFICIAL repository — must not register.
      const signed = makeSignedReleaseManifest(assetName, asset, "LanternOps/breeze");
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      stubOverriddenRepoFetch(repo, assetName, asset, signed);

      await expect(syncFromGitHub()).rejects.toThrow(/repository mismatch/);
      expect(dbMocks.insertValues).not.toHaveBeenCalled();
    });

    it("honors the legacy GITHUB_REPO alias", async () => {
      const repo = "legacyorg/breeze-mirror";
      process.env.GITHUB_REPO = repo;
      const assetName = "breeze-agent-linux-amd64";
      const asset = Buffer.from("legacy alias bytes");
      const signed = makeSignedReleaseManifest(assetName, asset, repo);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      const fetchSpy = stubOverriddenRepoFetch(repo, assetName, asset, signed);
      await syncFromGitHub();
      expect(fetchSpy).toHaveBeenCalledWith(
        `https://api.github.com/repos/${repo}/releases/latest`,
        expect.anything(),
      );
    });
  });
```

  Note: existing tests stub fetch with `url.includes("/releases/latest")`, which continues to match the new `getReleaseSourceApiBase()`-built URL, so they stay green. Also add `delete process.env.BINARY_GITHUB_REPOSITORY; delete process.env.GITHUB_REPO;` to the file's `beforeEach` (line 146-149) so ambient env can never leak in.
- [ ] Run `pnpm --filter @breeze/api test -- src/services/binarySync.test.ts` — the new tests fail (API URL still built from module-load-time `GITHUB_REPO`; repository-mismatch test fails because `expectedRepository` is the module constant).
- [ ] Edit `apps/api/src/services/binarySync.ts`:
  - Delete line 17 (`const GITHUB_REPO = process.env.GITHUB_REPO || "LanternOps/breeze";`).
  - Add to the imports: `import { getReleaseSourceApiBase, getReleaseSourceRepository } from "./releaseSource";`
  - Line 225: `expectedRepository: GITHUB_REPO,` → `expectedRepository: getReleaseSourceRepository(),`
  - Lines 551-553:

```ts
  const ghUrl = requestedVersion
    ? `${getReleaseSourceApiBase()}/releases/tags/${requestedVersion}`
    : `${getReleaseSourceApiBase()}/releases/latest`;
```

- [ ] Run `pnpm --filter @breeze/api test -- src/services/binarySync.test.ts src/services/binarySync.selftest.test.ts` — expect green.
- [ ] Commit: `feat(api): binarySync resolves its GitHub repo via the unified release source, retiring GITHUB_REPO (spec 3a)`

---

### Task 4: Config schema, production override rule, compose mappings, env examples

**Files:**
- Modify: `apps/api/src/config/validate.ts` (schema near `BINARY_SOURCE` at line 501; production superRefine block after line 1116)
- Modify: `docker-compose.yml` (api `environment:`, after line 273)
- Modify: `deploy/docker-compose.prod.yml` (api `environment:`, after line 219)
- Modify: `.env.example` (binary-source section, after the `# BINARY_SOURCE=github` line at ~861)
- Modify: `deploy/.env.example` (after the `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` block ending ~line 103)
- Test: `apps/api/src/config/validate.test.ts` (extend)

**Interfaces:**
- Consumes: existing `hasReleaseArtifactManifestPublicKey(data)` helper (`validate.ts:194-202`).
- Produces: boot-refusal on malformed `BINARY_GITHUB_REPOSITORY` (all envs) and on production override without a manifest trust root.

**Steps:**

- [ ] Add failing tests to `apps/api/src/config/validate.test.ts` (place next to the existing binary-source/production tests; reuse the file's `withEnv` + `validEnv`/`prodBase` fixtures):

```ts
  describe('BINARY_GITHUB_REPOSITORY (BYO signing, spec 3a)', () => {
    it('refuses to boot on a malformed repository in any environment', () => {
      withEnv({ ...validEnv, BINARY_GITHUB_REPOSITORY: 'not-a-repo' }, () => {
        expect(() => validateConfig()).toThrow(/BINARY_GITHUB_REPOSITORY/);
      });
    });

    it('treats an empty string (compose ${VAR:-} interpolation) as unset', () => {
      withEnv({ ...validEnv, BINARY_GITHUB_REPOSITORY: '' }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('production: overriding the release source requires the manifest trust root', () => {
      withEnv(
        {
          ...prodBase,
          BINARY_GITHUB_REPOSITORY: 'acme/breeze-selfhost-signing',
          RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: '',
          BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: '',
        },
        () => {
          expect(() => validateConfig()).toThrow(/BINARY_GITHUB_REPOSITORY/);
        },
      );
    });

    it('production: override boots when the trust root is set', () => {
      withEnv(
        {
          ...prodBase,
          BINARY_GITHUB_REPOSITORY: 'acme/breeze-selfhost-signing',
          RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: 'yzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso=',
        },
        () => {
          expect(() => validateConfig()).not.toThrow();
        },
      );
    });
  });
```

  (If `prodBase` is scoped inside the H-3 describe at line 1633, define a local equivalent: `{ ...validEnv, NODE_ENV: 'production' as const, CORS_ALLOWED_ORIGINS: 'https://app.breeze.io', TRUST_PROXY_HEADERS: 'true' }`.)
- [ ] Run `pnpm --filter @breeze/api test -- src/config/validate.test.ts` — new tests fail (unknown key is accepted silently today).
- [ ] Edit `apps/api/src/config/validate.ts`. After line 501 (`BINARY_SOURCE: z.string().optional(),`) insert:

```ts
    // BYO signing (spec 3a): the release-source repository override consumed by
    // services/releaseSource.ts. Empty string means "unset" — both compose
    // files map it as `${BINARY_GITHUB_REPOSITORY:-}`, which always injects the
    // key. Shape is validated in EVERY environment so a typo'd override
    // boot-refuses instead of silently building garbage GitHub URLs.
    BINARY_GITHUB_REPOSITORY: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z
        .string()
        .regex(
          /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/,
          'BINARY_GITHUB_REPOSITORY must be "owner/repository" ([A-Za-z0-9-]+/[A-Za-z0-9._-]+)',
        )
        .optional(),
    ),
```

  Then, in the production superRefine block immediately after the existing `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` rule (after line 1116), insert:

```ts
      // BYO signing (spec 3a): pointing the deployment at a NON-official
      // release repository only makes sense with a manifest trust root that is
      // the OVERRIDING repository's release key — without one, github-mode
      // sync would either fail closed on every release or (if the blanket
      // production key rule above were ever relaxed) accept unverified
      // third-party binaries. Kept as its own rule with its own message even
      // though the blanket rule currently subsumes the "unset" case.
      const releaseRepositoryOverride = data.BINARY_GITHUB_REPOSITORY?.trim().toLowerCase();
      if (
        releaseRepositoryOverride &&
        releaseRepositoryOverride !== 'lanternops/breeze' &&
        !hasReleaseArtifactManifestPublicKey(data)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['BINARY_GITHUB_REPOSITORY'],
          message:
            'BINARY_GITHUB_REPOSITORY overrides the release source; production requires RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS to be set to the overriding repository\'s release manifest public key (NOT the official Breeze key).',
        });
      }
```

- [ ] Run `pnpm --filter @breeze/api test -- src/config/validate.test.ts` — expect green.
- [ ] Edit `docker-compose.yml`: after line 273 (`RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: ${RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS:-}`) add:

```yaml
      # BYO signing: override the GitHub repository that releases are pulled
      # from (default lanternops/breeze). Pair with
      # RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS set to YOUR release manifest key.
      BINARY_GITHUB_REPOSITORY: ${BINARY_GITHUB_REPOSITORY:-}
```

- [ ] Edit `deploy/docker-compose.prod.yml`: after line 219 (`RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: ...`) add:

```yaml
      BINARY_GITHUB_REPOSITORY: ${BINARY_GITHUB_REPOSITORY:-}
```

- [ ] Edit `.env.example`: after the `# BINARY_SOURCE=github` line (~861) add:

```
#
# BYO signing: pull releases from YOUR signed-release repository instead of the
# official one (see the "Sign Your Own Agent Packages" guide). When you set
# this, you MUST also set RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS to YOUR release
# manifest public key — production refuses to boot otherwise.
# BINARY_GITHUB_REPOSITORY=lanternops/breeze
```

- [ ] Edit `deploy/.env.example`: after the `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=...` line (~103) add:

```
# BYO signing: override the release repository (default lanternops/breeze).
# Requires RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS to be YOUR release key.
# BINARY_GITHUB_REPOSITORY=lanternops/breeze
```

- [ ] Run `pnpm --filter @breeze/api test -- src/config/validate.test.ts src/config/envComposeParity.test.ts src/config/composeBindMounts.test.ts src/config/proxyTrustCompose.test.ts` — expect green (commented env-example entries impose no parity requirement; the compose mapping is additive).
- [ ] Commit: `feat(api): BINARY_GITHUB_REPOSITORY config schema, production override rule, compose + env-example wiring (spec 3a)`

---

### Task 5: Deployment re-signing on overridden-repo github sync

**Files:**
- Modify: `apps/api/src/services/binarySync.ts` (new `applyDeploymentSigning` helper; call it at the top of `upsertVersion`, currently line 822)
- Test: `apps/api/src/services/binarySync.test.ts` (extend)

**Interfaces:**
- Consumes: `isOfficialReleaseSource()` from `./releaseSource`; `ensureActiveSigningKey(): Promise<{ keyId: string; publicKeyB64: string }>` and `signManifest(manifestJson: string): Promise<string>` from `./manifestSigning` (both already imported at line 15).
- Produces (module-private):

```ts
async function applyDeploymentSigning(args: {
  metadata: { checksum: string; size: number; releaseManifest?: string; manifestSignature?: string; signingKeyId?: string };
  version: string;
  component: string;
  platform: string;
  arch: string;
  downloadUrl: string;
}): Promise<typeof args.metadata>
```

**Steps:**

- [ ] Add failing tests to `binarySync.test.ts`. First extend the top-of-file crypto import (line 1) to `import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";`. Then add:

```ts
  describe("deployment re-signing on overridden repos (spec 3b)", () => {
    const repo = "acme/breeze-selfhost-signing";
    const assetName = "breeze-agent-linux-amd64";

    function stubRepoFetch(
      asset: Buffer,
      signed: ReturnType<typeof makeSignedReleaseManifest>,
    ) {
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
                    browser_download_url: `https://github.com/${repo}/releases/download/v1.2.3/${assetName}`,
                    size: asset.length,
                  },
                  {
                    name: "release-artifact-manifest.json",
                    browser_download_url: `https://github.com/${repo}/releases/download/v1.2.3/release-artifact-manifest.json`,
                    size: signed.manifest.length,
                  },
                  {
                    name: "release-artifact-manifest.json.ed25519",
                    browser_download_url: `https://github.com/${repo}/releases/download/v1.2.3/release-artifact-manifest.json.ed25519`,
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

    it("stamps the deploy-* key ID and a normalized manifest that verifies against the deployment key", async () => {
      process.env.BINARY_GITHUB_REPOSITORY = repo;
      const asset = Buffer.from("self-hoster signed agent bytes");
      const signed = makeSignedReleaseManifest(assetName, asset, repo);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      // Real deployment key: signManifest signs with it so the test can
      // assert the stored signature verifies against the deployment pubkey.
      const { publicKey: deployPub, privateKey: deployPriv } =
        generateKeyPairSync("ed25519");
      manifestSigningMocks.signManifest.mockImplementation(
        async (json: string) =>
          sign(null, Buffer.from(json, "utf8"), deployPriv).toString("base64"),
      );

      try {
        stubRepoFetch(asset, signed);
        const result = await syncFromGitHub();
        expect(result.synced).toContain("agent:linux/amd64");

        expect(manifestSigningMocks.ensureActiveSigningKey).toHaveBeenCalled();
        const insert = dbMocks.insertValues.mock.calls[0]![0] as Record<string, unknown>;
        expect(insert.signingKeyId).toBe("deploy-test-aaaaaaaa");
        // NOT the raw release manifest: a normalized per-asset update manifest.
        expect(JSON.parse(insert.releaseManifest as string)).toEqual({
          version: "1.2.3",
          component: "agent",
          platform: "linux",
          arch: "amd64",
          url: `https://github.com/${repo}/releases/download/v1.2.3/${assetName}`,
          checksum: signed.checksum,
          size: asset.length,
        });
        expect(
          verify(
            null,
            Buffer.from(insert.releaseManifest as string, "utf8"),
            deployPub,
            Buffer.from(insert.manifestSignature as string, "base64"),
          ),
        ).toBe(true);

        // Conflict-update path carries the same re-signed fields.
        const set = (dbMocks.onConflictDoUpdate.mock.calls[0]![0] as any).set;
        expect(set.signingKeyId).toBe("deploy-test-aaaaaaaa");
        expect(set.releaseManifest).toBe(insert.releaseManifest);
      } finally {
        // vi.clearAllMocks() clears CALLS, not implementations — restore the
        // hoisted default so later tests keep the canned signature.
        manifestSigningMocks.signManifest.mockImplementation(
          async () => "test-signature-base64",
        );
      }
    });

    it("official-repo path is untouched: raw manifest, official key ID, no deployment key provisioning", async () => {
      // No override env set.
      const asset = Buffer.from("official agent bytes");
      const signed = makeSignedReleaseManifest(assetName, asset);
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/releases/latest")) {
            return new Response(
              JSON.stringify({
                tag_name: "v1.2.3",
                body: null,
                assets: [
                  {
                    name: assetName,
                    browser_download_url: `https://github.com/LanternOps/breeze/releases/download/v1.2.3/${assetName}`,
                    size: asset.length,
                  },
                  {
                    name: "release-artifact-manifest.json",
                    browser_download_url: "https://github.com/LanternOps/breeze/releases/download/v1.2.3/release-artifact-manifest.json",
                    size: signed.manifest.length,
                  },
                  {
                    name: "release-artifact-manifest.json.ed25519",
                    browser_download_url: "https://github.com/LanternOps/breeze/releases/download/v1.2.3/release-artifact-manifest.json.ed25519",
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

      await syncFromGitHub();

      expect(manifestSigningMocks.ensureActiveSigningKey).not.toHaveBeenCalled();
      expect(manifestSigningMocks.signManifest).not.toHaveBeenCalled();
      const insert = dbMocks.insertValues.mock.calls[0]![0] as Record<string, unknown>;
      expect(insert.signingKeyId).toBe("release-artifact-manifest-ed25519");
      expect(insert.releaseManifest).toBe(signed.manifest.toString("utf8"));
    });
  });
```

- [ ] Run `pnpm --filter @breeze/api test -- src/services/binarySync.test.ts` — the first new test fails (`signingKeyId` is still `release-artifact-manifest-ed25519`).
- [ ] Edit `apps/api/src/services/binarySync.ts`. Extend the Task 3 import to `import { getReleaseSourceApiBase, getReleaseSourceRepository, isOfficialReleaseSource } from "./releaseSource";`. Add above `upsertVersion` (currently line 819):

```ts
type UpsertMetadata = {
  checksum: string;
  size: number;
  releaseManifest?: string;
  manifestSignature?: string;
  signingKeyId?: string;
};

// Spec 3b: when syncing from an OVERRIDDEN repository, the release manifest is
// signed by the self-hoster's release key, which agents do not (and must not
// need to) trust. Re-sign a NORMALIZED per-asset update manifest — the exact
// shape registerLocalBinaries produces — with the per-deployment key and stamp
// the deploy-* key ID, so agents verify against their TOFU-pinned deployment
// key with zero agent-side changes.
//
// For the official repository this is a pass-through: that path must stay
// byte-identical (raw release manifest + "release-artifact-manifest-ed25519",
// which agents bind to the embedded official key). The checksums.txt fallback
// path (no releaseManifest, non-production only) is also passed through — there
// is no verified manifest to normalize.
async function applyDeploymentSigning(args: {
  metadata: UpsertMetadata;
  version: string;
  component: string;
  platform: string;
  arch: string;
  downloadUrl: string;
}): Promise<UpsertMetadata> {
  const { metadata } = args;
  if (isOfficialReleaseSource() || !metadata.releaseManifest) {
    return metadata;
  }

  const { keyId } = await ensureActiveSigningKey();
  const releaseManifest = JSON.stringify({
    version: args.version,
    component: args.component,
    platform: args.platform,
    arch: args.arch,
    url: args.downloadUrl,
    checksum: metadata.checksum,
    size: metadata.size,
  });
  const manifestSignature = await signManifest(releaseManifest);
  return {
    checksum: metadata.checksum,
    size: metadata.size,
    releaseManifest,
    manifestSignature,
    signingKeyId: keyId,
  };
}
```

  Then in `upsertVersion` (line 822), insert as the first statement of the function body and use `signedMetadata` in place of `metadata` in both the `.values({...})` and the `.onConflictDoUpdate({ set: {...} })` blocks:

```ts
  const signedMetadata = await applyDeploymentSigning({
    metadata,
    version,
    component,
    platform,
    arch,
    downloadUrl,
  });
```

  (A signing failure — e.g. missing `APP_ENCRYPTION_KEY` — throws inside the existing per-target `try/catch` in the four `syncFromGitHub` loops, so one component failure logs and continues, matching current upsert-failure semantics; the asset is simply not registered — fail closed.)
- [ ] Run `pnpm --filter @breeze/api test -- src/services/binarySync.test.ts src/services/binarySync.selftest.test.ts` — expect green (the second new test locks the official-path bytes).
- [ ] Commit: `feat(api): re-sign github-synced update manifests with the deployment key for overridden release sources (spec 3b)`

---

### Task 6: Positive trust allowlist, enforced centrally

**Files:**
- Create: `apps/api/src/services/releaseAssetTrust.ts`
- Modify: `apps/api/src/services/releaseArtifactManifest.ts` (asset type at lines 16-21, `VerifiedReleaseArtifact` at 35-42, `selectManifestAsset` at 230-295, both verify returns at 219-227 and 314-322)
- Modify: `apps/api/src/services/binarySource.ts` (asset-URL chokepoint for the serving surfaces `routes/agents/download.ts:42` and `routes/supportPublic.ts:193`, which redirect/proxy via these builders)
- Test: `apps/api/src/services/releaseAssetTrust.test.ts` (new), `apps/api/src/services/releaseArtifactManifest.test.ts` (extend), `apps/api/src/services/binarySource.test.ts` (extend)
- Sweep: test fixtures that stamp `platformTrust` on canonical Windows/macOS asset names — `apps/api/src/services/binarySync.test.ts` (helpers currently hardcode `"release-workflow-produced"` for every asset incl. `.exe`), `apps/api/src/services/installerBuilder.test.ts`, `apps/api/src/routes/agentVersions.test.ts`, `apps/api/src/services/releaseArtifactManifest.test.ts`

**Interfaces:**
- Produces (`releaseAssetTrust.ts`):

```ts
export const PLATFORM_TRUST_WINDOWS = 'windows-authenticode-required';
export const PLATFORM_TRUST_MACOS = 'macos-developer-id-notarization-required';
export const PLATFORM_TRUST_WORKFLOW = 'release-workflow-produced';
export const PLATFORM_TRUST_NONE = 'none';
export const INTENDED_USE_SIGNING_INPUT = 'signing-input';
export function isSigningInputAssetName(assetName: string): boolean;
export function requiredPlatformTrustFor(assetName: string): string | null;
export function assertDistributableReleaseAsset(args: { assetName: string; platformTrust: string | null; intendedUse: string | null }): void;
```

- Modifies: `VerifiedReleaseArtifact` gains `intendedUse: string | null`.

**Steps:**

- [ ] Write `apps/api/src/services/releaseAssetTrust.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_TRUST_MACOS,
  PLATFORM_TRUST_WINDOWS,
  PLATFORM_TRUST_WORKFLOW,
  assertDistributableReleaseAsset,
  isSigningInputAssetName,
  requiredPlatformTrustFor,
} from './releaseAssetTrust';

describe('releaseAssetTrust', () => {
  it.each([
    ['breeze-agent-windows-amd64-unsigned.exe', true],
    ['breeze-agent-darwin-arm64-unsigned', true],
    ['breeze-user-helper-windows-amd64-unsigned.exe', true],
    ['breeze-agent-windows-amd64.exe', false],
    ['breeze-agent.msi', false],
    ['breeze-agent-darwin-arm64', false],
  ])('isSigningInputAssetName(%s) === %s', (name, expected) => {
    expect(isSigningInputAssetName(name)).toBe(expected);
  });

  it.each([
    ['breeze-agent-windows-amd64.exe', PLATFORM_TRUST_WINDOWS],
    ['breeze-agent.msi', PLATFORM_TRUST_WINDOWS],
    ['breeze-viewer-windows.msi', PLATFORM_TRUST_WINDOWS],
    ['breeze-agent-darwin-arm64.pkg', PLATFORM_TRUST_MACOS],
    ['breeze-helper-macos.dmg', PLATFORM_TRUST_MACOS],
    ['Breeze Installer.app.zip', PLATFORM_TRUST_MACOS],
    ['Breeze.Installer.app.zip', PLATFORM_TRUST_MACOS],
    ['breeze-agent-darwin-amd64', PLATFORM_TRUST_MACOS],
    ['breeze-watchdog-darwin-arm64', PLATFORM_TRUST_MACOS],
    ['breeze-agent-linux-amd64', null],
    ['install.sh', null],
  ])('requiredPlatformTrustFor(%s) === %s', (name, expected) => {
    expect(requiredPlatformTrustFor(name)).toBe(expected);
  });

  it('rejects signing-input intendedUse regardless of trust value', () => {
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-windows-amd64-unsigned.exe',
        platformTrust: 'none',
        intendedUse: 'signing-input',
      }),
    ).toThrow(/not distributable/);
  });

  it('rejects ANY non-null intendedUse (unknown values fail closed)', () => {
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-linux-amd64',
        platformTrust: PLATFORM_TRUST_WORKFLOW,
        intendedUse: 'debugging-symbols',
      }),
    ).toThrow(/not distributable/);
  });

  it('rejects -unsigned names even when the manifest entry claims full trust', () => {
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-windows-amd64-unsigned.exe',
        platformTrust: PLATFORM_TRUST_WINDOWS,
        intendedUse: null,
      }),
    ).toThrow(/signing input/);
  });

  it('rejects unknown platformTrust values', () => {
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-linux-amd64',
        platformTrust: 'totally-new-trust-level',
        intendedUse: null,
      }),
    ).toThrow(/unknown platformTrust/);
  });

  it('requires windows-authenticode-required on canonical Windows executables', () => {
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-windows-amd64.exe',
        platformTrust: PLATFORM_TRUST_WORKFLOW,
        intendedUse: null,
      }),
    ).toThrow(/windows-authenticode-required/);
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-windows-amd64.exe',
        platformTrust: null,
        intendedUse: null,
      }),
    ).toThrow(/windows-authenticode-required/);
  });

  it('requires macos-developer-id-notarization-required on canonical macOS assets', () => {
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-darwin-arm64.pkg',
        platformTrust: PLATFORM_TRUST_WORKFLOW,
        intendedUse: null,
      }),
    ).toThrow(/macos-developer-id-notarization-required/);
  });

  it('accepts a correctly-labeled canonical asset and a plain linux asset', () => {
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-windows-amd64.exe',
        platformTrust: PLATFORM_TRUST_WINDOWS,
        intendedUse: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-linux-amd64',
        platformTrust: PLATFORM_TRUST_WORKFLOW,
        intendedUse: null,
      }),
    ).not.toThrow();
    // Pre-platformTrust manifests: null on a non-canonical asset is tolerated.
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-linux-amd64',
        platformTrust: null,
        intendedUse: null,
      }),
    ).not.toThrow();
  });
});
```

- [ ] Run `pnpm --filter @breeze/api test -- src/services/releaseAssetTrust.test.ts` — fails (module missing).
- [ ] Create `apps/api/src/services/releaseAssetTrust.ts`:

```ts
/**
 * Positive platform-trust allowlist for release assets (spec 3c).
 *
 * Replaces expected-value-only checking: instead of only failing when a caller
 * happened to pass expectedPlatformTrust, every manifest-verified asset is
 * checked against what its NAME requires, unknown trust vocabulary fails
 * closed, and signing-input assets (Deliverable 1's `-unsigned` uploads with
 * intendedUse: "signing-input") are never distributable.
 *
 * The name classifier deliberately mirrors the manifest generator in
 * .github/workflows/release.yml (platform_trust(), ~line 2088) — keep the two
 * in sync when the asset taxonomy changes.
 */

export const PLATFORM_TRUST_WINDOWS = 'windows-authenticode-required';
export const PLATFORM_TRUST_MACOS = 'macos-developer-id-notarization-required';
export const PLATFORM_TRUST_WORKFLOW = 'release-workflow-produced';
export const PLATFORM_TRUST_NONE = 'none';

export const KNOWN_PLATFORM_TRUST_VALUES: ReadonlySet<string> = new Set([
  PLATFORM_TRUST_WINDOWS,
  PLATFORM_TRUST_MACOS,
  PLATFORM_TRUST_WORKFLOW,
  PLATFORM_TRUST_NONE,
]);

export const INTENDED_USE_SIGNING_INPUT = 'signing-input';

// Raw darwin Mach-O binaries carry Developer ID + notarization even though
// they ship inside the .pkg (see release.yml DARWIN_BINARY_RE).
const DARWIN_BINARY_RE = /^breeze-(agent|backup|desktop-helper|watchdog)-darwin-(amd64|arm64)$/;

// "-unsigned" immediately before the extension chain (or at the end for
// extensionless darwin/linux binaries): breeze-agent-windows-amd64-unsigned.exe,
// breeze-agent-darwin-arm64-unsigned.
const SIGNING_INPUT_NAME_RE = /-unsigned(\.[A-Za-z0-9]+)*$/;

export function isSigningInputAssetName(assetName: string): boolean {
  return SIGNING_INPUT_NAME_RE.test(assetName);
}

/**
 * The platformTrust value an asset's NAME requires, or null when the name
 * implies no platform-signing requirement (Linux binaries, scripts, manifests).
 */
export function requiredPlatformTrustFor(assetName: string): string | null {
  if (/\.(exe|msi)$/i.test(assetName)) return PLATFORM_TRUST_WINDOWS;
  if (/\.pkg$/i.test(assetName) || /\.dmg$/i.test(assetName) || /\.app\.zip$/i.test(assetName)) {
    return PLATFORM_TRUST_MACOS;
  }
  if (DARWIN_BINARY_RE.test(assetName)) return PLATFORM_TRUST_MACOS;
  return null;
}

/**
 * Throws unless the asset may be registered or served to end users/agents.
 * Fail-closed on: any intendedUse (the only known value, "signing-input", is
 * never distributable, and unknown future values must not slip through), a
 * signing-input-shaped name, unknown platformTrust vocabulary, and a canonical
 * Windows/macOS asset whose trust label is missing or weaker than required.
 *
 * platformTrust === null on a NON-canonical asset is tolerated for manifests
 * predating the platformTrust field.
 */
export function assertDistributableReleaseAsset(args: {
  assetName: string;
  platformTrust: string | null;
  intendedUse: string | null;
}): void {
  if (args.intendedUse !== null) {
    throw new Error(
      `Release asset ${args.assetName} is not distributable (intendedUse=${args.intendedUse})`,
    );
  }
  if (isSigningInputAssetName(args.assetName)) {
    throw new Error(
      `Release asset ${args.assetName} is a signing input and must never be registered or served`,
    );
  }
  if (args.platformTrust !== null && !KNOWN_PLATFORM_TRUST_VALUES.has(args.platformTrust)) {
    throw new Error(
      `Release asset ${args.assetName} has unknown platformTrust "${args.platformTrust}"`,
    );
  }
  const required = requiredPlatformTrustFor(args.assetName);
  if (required !== null && args.platformTrust !== required) {
    throw new Error(
      `Release asset ${args.assetName} requires platformTrust "${required}", got ${
        args.platformTrust === null ? 'none recorded' : `"${args.platformTrust}"`
      }`,
    );
  }
}
```

- [ ] Run `pnpm --filter @breeze/api test -- src/services/releaseAssetTrust.test.ts` — green.
- [ ] Add failing tests to `apps/api/src/services/releaseArtifactManifest.test.ts`. The file's existing `makeSignedManifest` helper (lines 9-41) hardcodes `platformTrust: "release-workflow-produced"` for a **`breeze-agent.msi`** fixture, which the new enforcement would reject — so first extend the helper to classify by name and accept overrides:

```ts
import { requiredPlatformTrustFor } from "./releaseAssetTrust";

function makeSignedManifest(args: {
  assetName: string;
  assetBuffer: Buffer;
  release?: string;
  repository?: string;
  assetOverrides?: Record<string, unknown>;
}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPublicKey = publicDer
    .subarray(publicDer.length - 32)
    .toString("base64");
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      repository: args.repository ?? "lanternops/breeze",
      release: args.release ?? "v1.2.3",
      assets: [
        {
          name: args.assetName,
          sha256: "placeholder",
          size: args.assetBuffer.length,
          platformTrust:
            requiredPlatformTrustFor(args.assetName) ??
            "release-workflow-produced",
          ...(args.assetOverrides ?? {}),
        },
      ],
    }).replace("placeholder", createSha256(args.assetBuffer)),
  );

  return {
    manifest,
    signature: Buffer.from(sign(null, manifest, privateKey).toString("base64")),
    publicKey: rawPublicKey,
  };
}
```

  (The classify-by-name default keeps every existing `breeze-agent.msi` test in this file green under the new enforcement.) Then add the new tests:

```ts
  describe("positive trust enforcement (spec 3c)", () => {
    it("rejects verification of a signing-input asset", async () => {
      const asset = Buffer.from("unsigned input bytes");
      const signed = makeSignedManifest({
        assetName: "breeze-agent-windows-amd64-unsigned.exe",
        assetBuffer: asset,
        assetOverrides: { platformTrust: "none", intendedUse: "signing-input" },
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      await expect(
        verifyReleaseArtifactManifestAsset({
          assetName: "breeze-agent-windows-amd64-unsigned.exe",
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
        }),
      ).rejects.toThrow(/not distributable/);
    });

    it("rejects an unknown platformTrust value", async () => {
      const asset = Buffer.from("linux agent bytes");
      const signed = makeSignedManifest({
        assetName: "breeze-agent-linux-amd64",
        assetBuffer: asset,
        assetOverrides: { platformTrust: "mystery-trust" },
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      await expect(
        verifyReleaseArtifactManifestAsset({
          assetName: "breeze-agent-linux-amd64",
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
        }),
      ).rejects.toThrow(/unknown platformTrust/);
    });

    it("rejects a canonical Windows exe without windows-authenticode-required", async () => {
      const asset = Buffer.from("windows agent bytes");
      const signed = makeSignedManifest({
        assetName: "breeze-agent-windows-amd64.exe",
        assetBuffer: asset,
        assetOverrides: { platformTrust: "release-workflow-produced" },
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      await expect(
        verifyReleaseArtifactManifestAsset({
          assetName: "breeze-agent-windows-amd64.exe",
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
        }),
      ).rejects.toThrow(/windows-authenticode-required/);
    });

    it("returns intendedUse: null and the required trust for ordinary assets", async () => {
      const asset = Buffer.from("windows agent bytes");
      const signed = makeSignedManifest({
        assetName: "breeze-agent-windows-amd64.exe",
        assetBuffer: asset,
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      await expect(
        verifyReleaseArtifactManifestAsset({
          assetName: "breeze-agent-windows-amd64.exe",
          manifestBytes: signed.manifest,
          signatureBytes: signed.signature,
        }),
      ).resolves.toMatchObject({
        platformTrust: "windows-authenticode-required",
        intendedUse: null,
      });
    });
  });
```
- [ ] Run `pnpm --filter @breeze/api test -- src/services/releaseArtifactManifest.test.ts` — new tests fail.
- [ ] Edit `apps/api/src/services/releaseArtifactManifest.ts`:
  - Add import: `import { assertDistributableReleaseAsset } from './releaseAssetTrust';`
  - Add `intendedUse?: unknown;` to `ReleaseArtifactManifestAsset` (lines 16-21).
  - Add `intendedUse: string | null;` to `VerifiedReleaseArtifact` (lines 35-42).
  - In `selectManifestAsset` (after the size check ending at line 280, BEFORE the `expectedPlatformTrust` check at 281):

```ts
  // Spec 3c: positive allowlist, enforced for EVERY manifest verification —
  // github sync registration, installer/support asset pre-flight, and recovery
  // media all funnel through here. expectedPlatformTrust (below) remains as a
  // caller-supplied stricter expectation on top of this baseline.
  assertDistributableReleaseAsset({
    assetName: args.assetName,
    platformTrust: typeof entry.platformTrust === 'string' ? entry.platformTrust : null,
    intendedUse: typeof entry.intendedUse === 'string' ? entry.intendedUse : null,
  });
```

  - In both return blocks (`verifyReleaseArtifactBuffer` lines 219-227 and `verifyReleaseArtifactManifestAsset` lines 314-322), add after the `platformTrust` field:

```ts
    intendedUse: typeof entry.intendedUse === 'string' ? entry.intendedUse : null,
```

  (For `verifyReleaseArtifactBuffer`, `entry` is already in scope; keep the field derivation identical in both.)
- [ ] Sweep test fixtures that now violate the positive allowlist: in `apps/api/src/services/binarySync.test.ts`, change both manifest helpers to classify trust by name instead of hardcoding `"release-workflow-produced"`:

```ts
import { requiredPlatformTrustFor } from "./releaseAssetTrust";

function fixturePlatformTrust(name: string): string {
  return requiredPlatformTrustFor(name) ?? "release-workflow-produced";
}
```

  and use `platformTrust: fixturePlatformTrust(a.name)` / `platformTrust: fixturePlatformTrust(assetName)` in `makeSignedReleaseManifest` and `makeSignedReleaseManifestMulti`. Then run `grep -rn "platformTrust" apps/api/src --include="*.test.ts"` and apply the same fix to any fixture in `installerBuilder.test.ts` and `agentVersions.test.ts` that stamps a canonical `.exe`/`.msi`/`.pkg`/`.dmg`/darwin-binary name with the wrong value (`installerBuilder.test.ts` already passes the correct expected values for its MSI/pkg fixtures — verify, don't assume).
- [ ] Add a serving-surface guard in `apps/api/src/services/binarySource.ts`: add import `import { isSigningInputAssetName } from './releaseAssetTrust';`, add the chokepoint below `githubDownloadBase()`:

```ts
// Spec 3c serving-surface guard: routes/agents/download.ts redirects and
// routes/supportPublic.ts proxies whatever URL these builders produce, without
// ever seeing a manifest. All canonical asset filenames are static strings
// today, so this is a tripwire against a future builder (or refactor) leaking
// a signing-input asset onto a public surface.
function githubAssetDownloadUrl(filename: string): string {
  if (isSigningInputAssetName(filename)) {
    throw new Error(
      `Refusing to build a download URL for signing-input asset "${filename}"`,
    );
  }
  return `${githubDownloadBase()}/${filename}`;
}
```

  and replace every `` `${githubDownloadBase()}/${filename}` `` template in the asset builders (`getGithubAgentUrl`, `getGithubBackupUrl`, `getGithubAgentPkgUrl`, `getGithubWatchdogUrl`, `getGithubUserHelperUrl`, `getGithubRegularMsiUrl`, `getGithubViewerUrl`, `getGithubHelperUrl`, `getGithubInstallerAppUrl`) with `githubAssetDownloadUrl(filename)` (for `getGithubRegularMsiUrl`/`getGithubInstallerAppUrl`, pass the literal: `githubAssetDownloadUrl('breeze-agent.msi')`, `githubAssetDownloadUrl('Breeze.Installer.app.zip')`). Leave the two manifest-URL builders on `githubDownloadBase()`.
- [ ] Add to `apps/api/src/services/binarySource.test.ts`:

```ts
  it('serving-surface guard: refuses to build URLs for signing-input asset names', async () => {
    const { HELPER_FILENAMES } = await import('./binarySource');
    // Simulate a future registry mistake by direct call through a builder that
    // takes caller-controlled filename mapping.
    HELPER_FILENAMES.windows = 'breeze-helper-windows-unsigned.msi';
    const { getGithubHelperUrl } = await import('./binarySource');
    expect(() => getGithubHelperUrl('windows')).toThrow(/signing-input/);
    HELPER_FILENAMES.windows = 'breeze-helper-windows.msi';
  });
```

- [ ] Run `pnpm --filter @breeze/api test -- src/services/releaseAssetTrust.test.ts src/services/releaseArtifactManifest.test.ts src/services/binarySource.test.ts src/services/binarySync.test.ts src/services/installerBuilder.test.ts src/routes/agentVersions.test.ts src/routes/agents/download.test.ts src/routes/supportPublic.test.ts` — expect green.
- [ ] Commit: `feat(api): positive platform-trust allowlist at manifest verification + serving chokepoints (spec 3c)`

---

### Task 7: Recovery media — expected hashes from the verified release manifest

**Files:**
- Modify: `apps/api/src/services/recoveryMediaService.ts` (`resolveBackupBinary` at lines 81-120; imports at 24-26)
- Test: `apps/api/src/services/recoveryMediaService.test.ts` (new)
- Unchanged: `apps/api/src/services/binaryManifest.ts` (`verifyBinaryChecksum` at 53-95 stays as the LOCAL-mode path; the static `recovery-binary-manifest.json` table no longer gates github mode)

**Interfaces:**
- Consumes: `verifyGithubReleaseArtifactBuffer` from `./releaseArtifactManifest` (returns `VerifiedReleaseArtifact | null`; throws when verification is required but unconfigured, and on any hash/size/trust mismatch); `getGithubReleaseArtifactManifestUrl`, `getGithubReleaseArtifactManifestSignatureUrl` from `./binarySource`; `getReleaseSourceRepository` from `./releaseSource`; `VerifiedRecoveryBinary` type from `./binaryManifest`.
- Produces: `export async function resolveBackupBinary(platform: string, architecture: string, workingDir: string): Promise<{ fileName: string; filePath: string; verified: VerifiedRecoveryBinary }>` (previously module-private; exported for unit testing, same call site in `buildRecoveryMediaArtifact` at line 395).

**Steps:**

- [ ] Write `apps/api/src/services/recoveryMediaService.test.ts`:

```ts
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// recoveryMediaService pulls in the db and the recovery-bootstrap/signing
// stack at module load; none of it is exercised by resolveBackupBinary.
vi.mock('../db', () => ({ db: {} }));
vi.mock('./recoveryBootstrap', () => ({
  asRecord: (v: unknown) => (v && typeof v === 'object' ? v : {}),
  getStringValue: () => null,
  resolveServerUrl: () => 'https://breeze.example.com',
  resolveSnapshotProviderConfig: vi.fn(),
}));
vi.mock('./recoverySigning', () => ({
  getRecoverySigningKey: () => null,
  isRecoverySigningConfigured: () => false,
  signRecoveryArtifact: vi.fn(),
}));

import { resolveBackupBinary } from './recoveryMediaService';

function makeSignedBackupManifest(assetName: string, assetBuffer: Buffer) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const rawPublicKey = publicDer.subarray(publicDer.length - 32).toString('base64');
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      repository: 'LanternOps/breeze',
      release: 'v1.2.3',
      assets: [
        {
          name: assetName,
          sha256: createHash('sha256').update(assetBuffer).digest('hex'),
          size: assetBuffer.length,
          platformTrust: 'release-workflow-produced',
        },
      ],
    }),
  );
  return {
    manifest,
    signature: Buffer.from(sign(null, manifest, privateKey).toString('base64')),
    publicKey: rawPublicKey,
  };
}

describe('resolveBackupBinary (github mode, spec 3d)', () => {
  const originalEnv = process.env;
  let workingDir: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    delete process.env.BINARY_SOURCE; // github is the default
    delete process.env.BINARY_GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO;
    process.env.BINARY_VERSION = '1.2.3';
    workingDir = await mkdtemp(join(tmpdir(), 'recovery-test-'));
  });

  afterEach(async () => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    await rm(workingDir, { recursive: true, force: true });
  });

  function stubFetch(assetName: string, bytes: Buffer, signed: ReturnType<typeof makeSignedBackupManifest>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith(`/${assetName}`)) return new Response(bytes);
        if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
        if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
        return new Response('not found', { status: 404 });
      }),
    );
  }

  it('verifies the backup binary against the signed release manifest, not the static table', async () => {
    const bytes = Buffer.from('backup binary bytes');
    const signed = makeSignedBackupManifest('breeze-backup-linux-amd64', bytes);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
    stubFetch('breeze-backup-linux-amd64', bytes, signed);

    const result = await resolveBackupBinary('linux', 'amd64', workingDir);
    expect(result.verified).toMatchObject({
      platform: 'linux',
      architecture: 'amd64',
      sourceType: 'github',
      sourceRef: 'github-release:v1.2.3',
      version: '1.2.3',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      manifestVersion: 'v1.2.3',
    });
  });

  it('fails closed when the downloaded bytes do not match the manifest hash', async () => {
    const bytes = Buffer.from('backup binary bytes');
    const signed = makeSignedBackupManifest('breeze-backup-linux-amd64', bytes);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
    stubFetch('breeze-backup-linux-amd64', Buffer.from('TAMPERED bytes!!!!!'), signed);

    await expect(resolveBackupBinary('linux', 'amd64', workingDir)).rejects.toThrow(
      /mismatch/,
    );
  });

  it('fails closed when no manifest trust root is configured', async () => {
    const bytes = Buffer.from('backup binary bytes');
    const signed = makeSignedBackupManifest('breeze-backup-linux-amd64', bytes);
    delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    delete process.env.BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    stubFetch('breeze-backup-linux-amd64', bytes, signed);

    await expect(resolveBackupBinary('linux', 'amd64', workingDir)).rejects.toThrow(
      /RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS/,
    );
  });

  it('still requires a pinned version (never "latest")', async () => {
    process.env.BINARY_VERSION = 'latest';
    await expect(resolveBackupBinary('linux', 'amd64', workingDir)).rejects.toThrow(
      /pinned GitHub release version/,
    );
  });
});
```

  (Size note: the manifest lists the tampered test's size as the ORIGINAL bytes' length, and the tampered buffer has a different length, so the failure surfaces as a size or digest mismatch — the `/mismatch/` matcher covers both.)
- [ ] Run `pnpm --filter @breeze/api test -- src/services/recoveryMediaService.test.ts` — fails (`resolveBackupBinary` is not exported; github path uses the static table).
- [ ] Edit `apps/api/src/services/recoveryMediaService.ts`:
  - Extend imports:

```ts
import { verifyBinaryChecksum, type VerifiedRecoveryBinary } from './binaryManifest';
import {
  getBinarySource,
  getGithubBackupUrl,
  getGithubReleaseArtifactManifestSignatureUrl,
  getGithubReleaseArtifactManifestUrl,
  getGithubReleaseVersion,
} from './binarySource';
import { verifyGithubReleaseArtifactBuffer } from './releaseArtifactManifest';
import { getReleaseSourceRepository } from './releaseSource';
```

  - Replace `resolveBackupBinary` (lines 81-120) with:

```ts
export async function resolveBackupBinary(
  platform: string,
  architecture: string,
  workingDir: string,
): Promise<{
  fileName: string;
  filePath: string;
  verified: VerifiedRecoveryBinary;
}> {
  const fileName = getBinaryFileName(platform, architecture);
  const destinationPath = join(workingDir, fileName);
  const sourceType = getBinarySource();

  if (sourceType === 'github') {
    // Spec 3d: expected hashes come from the deployment-verified release
    // manifest, not a static table — a BYO-signed backup binary has a
    // different hash per self-hoster, which no shipped table can know.
    const version = getGithubReleaseVersion();
    if (version === 'latest') {
      throw new Error(
        'Recovery helper builds require a pinned GitHub release version, not "latest"',
      );
    }
    const sourceRef = `github-release:v${version}`;
    await downloadFile(getGithubBackupUrl(platform, architecture), destinationPath);

    const verifiedAsset = await verifyGithubReleaseArtifactBuffer({
      assetName: fileName,
      assetBuffer: await readFile(destinationPath),
      manifestUrl: getGithubReleaseArtifactManifestUrl(),
      signatureUrl: getGithubReleaseArtifactManifestSignatureUrl(),
      expectedRepository: getReleaseSourceRepository(),
      expectedRelease: `v${version}`,
    });
    if (!verifiedAsset) {
      // Only reachable outside production with no trust root configured.
      // Recovery media is a restore path — never ship an unverified helper.
      throw new Error(
        'Recovery helper builds require RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS so the backup binary can be verified against the signed release manifest',
      );
    }
    return {
      fileName,
      filePath: destinationPath,
      verified: {
        platform,
        architecture,
        sourceType: 'github',
        sourceRef,
        version,
        sha256: verifiedAsset.sha256,
        manifestVersion: verifiedAsset.release,
      },
    };
  }

  // Local mode: unchanged — verify against the pinned checksum table
  // (BINARY_CHECKSUM_MANIFEST overrides the shipped recovery-binary-manifest.json).
  const candidatePath = resolve(
    process.env.BACKUP_BINARY_DIR ||
      process.env.AGENT_BINARY_DIR ||
      './agent/bin',
    fileName
  );
  const sourceRef = candidatePath;
  const version = process.env.BINARY_VERSION || process.env.BREEZE_VERSION || 'workspace-local';
  await copyFile(candidatePath, destinationPath);

  const verified = await verifyBinaryChecksum({
    filePath: destinationPath,
    platform,
    architecture,
    sourceType,
    sourceRef,
    version,
  });
  return { fileName, filePath: destinationPath, verified };
}
```

  (`buildRecoveryMediaArtifact` at line 395 consumes `binary.verified.version/.sourceType/.sourceRef/.manifestVersion` — all preserved. The `helperBinaryDigestVerified: true` metadata claim at line 511 is now backed by the release-manifest digest check in github mode.)
- [ ] Run `pnpm --filter @breeze/api test -- src/services/recoveryMediaService.test.ts src/services/binaryManifest.test.ts src/services/recoveryDownloadService.test.ts src/services/recoveryBootstrap.test.ts` — expect green.
- [ ] Commit: `feat(api): recovery media verifies the backup binary against the signed release manifest (spec 3d)`

---

### Task 8: Retire msiSigning.ts (Deliverable 5)

**Files:**
- Delete: `apps/api/src/services/msiSigning.ts`, `apps/api/src/services/msiSigning.test.ts`
- Modify: `apps/api/src/config/validate.ts` (schema lines 594-598; superRefine lines 1358-1370; indicator-comment line 1256)
- Modify: `apps/api/src/config/validate.test.ts` (MSI-signing cases: header comment ~1626, tests ~1827-1845, fixture usage ~1890)
- Modify: `apps/api/src/routes/system.ts` (line 75)
- Modify: `apps/api/src/routes/enrollmentKeys_installer.test.ts` (mock lines 98-103, import line 134, reset line 220), `apps/api/src/routes/enrollmentKeys.test.ts` (mock 76-77, import 156, `mockReturnValue(null)` at 250, 609, 754, 794, 1297, 1611, 2075), `apps/api/src/routes/enrollmentKeys_capClamp.test.ts` (line 76)
- Modify: `apps/api/src/services/installerBuilder.ts` (comment line 32)
- Modify: `docker-compose.yml` (lines 296-300), `deploy/docker-compose.prod.yml` (lines 270-272)
- Modify: `.env.example` (MSI Signing block, lines ~793-804), `deploy/.env.example` (MSI Signing block, lines ~304-307)

**Interfaces:** none produced — pure removal. Confirmed before deletion: NO runtime module imports `MsiSigningService` (only test mocks + the two env reads above), so this cannot change route behavior.

**Steps:**

- [ ] TDD the observable change first — add to `apps/api/src/routes/system.test.ts` (the file already provides `setAuth()` and `makeApp()`, and mocks `requirePermission` as a pass-through, so `GET /system/config-status` is reachable):

```ts
  it('config-status no longer reports an msiSigning integration flag (per-download signing retired)', async () => {
    setAuth();
    const app = makeApp();
    const res = await app.request('/system/config-status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { integrations: Record<string, unknown> };
    expect(body.integrations).not.toHaveProperty('msiSigning');
  });
```

  and to `apps/api/src/config/validate.test.ts`, inside the `Feature-flagged production secrets (H-3)` describe (~line 1633) where `prodBase` is in scope — this REPLACES the block of MSI tests deleted below:

```ts
    it('MSI_SIGNING_URL is inert: production boots without MSI_SIGNING_CF_ACCESS_SECRET', () => {
      withEnv({
        ...prodBase,
        MSI_SIGNING_URL: 'https://sign.example.com/sign-breeze-agent',
        MSI_SIGNING_CF_ACCESS_SECRET: '',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });
```

- [ ] Run `pnpm --filter @breeze/api test -- src/routes/system.test.ts src/config/validate.test.ts` — both new tests fail.
- [ ] `git rm apps/api/src/services/msiSigning.ts apps/api/src/services/msiSigning.test.ts`
- [ ] Edit `apps/api/src/config/validate.ts`: delete lines 594-598 (the `// MSI signing —` comment plus `MSI_SIGNING_URL` and `MSI_SIGNING_CF_ACCESS_SECRET` schema entries); delete lines 1358-1370 (the `// MSI signing (MSI_SIGNING_URL as indicator).` comment block, `const msiSigningEnabled ...`, and its `requireIf(...)` call); on line 1256 change `S3_BUCKET, CLOUDFLARE_API_TOKEN, MSI_SIGNING_URL` → `S3_BUCKET, CLOUDFLARE_API_TOKEN`.
- [ ] Edit `apps/api/src/config/validate.test.ts`: delete the `- MSI signing: MSI_SIGNING_URL set` line from the H-3 header comment (~1626), the `--- MSI signing (MSI_SIGNING_URL set) ---` tests (~1827-1845), and remove `MSI_SIGNING_URL`/`MSI_SIGNING_CF_ACCESS_SECRET` keys from any remaining fixture objects (~1890). Keep the new inert-var test from the first step.
- [ ] Edit `apps/api/src/routes/system.ts`: delete line 75 (`msiSigning: !!env.MSI_SIGNING_URL,`).
- [ ] Edit the three enrollment-key test files: remove the `vi.mock('../services/msiSigning', ...)` blocks, the `import { MsiSigningService } from '../services/msiSigning';` lines, and every `vi.mocked(MsiSigningService.fromEnv).mockReturnValue(null);` statement (they are stale — the routes stopped importing the service when the per-download signing path was removed).
- [ ] Edit `apps/api/src/services/installerBuilder.ts` line 32: `// --- Windows zip bundle builder (fallback when remote signing service is not configured) ---` → `// --- Windows zip bundle builder ---`
- [ ] Edit `docker-compose.yml`: delete lines 296-300 (the `# MSI Signing (optional — ...)` comment and the four `MSI_SIGNING_*` mappings). Edit `deploy/docker-compose.prod.yml`: delete lines 270-272 (the three `MSI_SIGNING_*` mappings).
- [ ] Edit `.env.example`: delete the whole `# MSI Signing (Windows installer code-signing tunnel)` block (header lines ~793-795 through `# MSI_SIGNING_API_KEY=` at ~804, plus the trailing blank line). Edit `deploy/.env.example`: delete the `# ── MSI Signing (optional) ─────…` block (~304-307).
- [ ] Sweep for stragglers: `grep -rn "MSI_SIGNING\|msiSigning\|MsiSigningService" apps/api docker-compose.yml deploy .env.example --include="*.ts" --include="*.yml" -l` must return nothing. (`apps/docs` and `docs/` mentions are Phase 3's docs deliverable — leave them; note the handoff in the PR description.)
- [ ] Run `pnpm --filter @breeze/api test -- src/routes/system.test.ts src/config/validate.test.ts src/routes/enrollmentKeys.test.ts src/routes/enrollmentKeys_installer.test.ts src/routes/enrollmentKeys_capClamp.test.ts src/config/envComposeParity.test.ts src/config/composeBindMounts.test.ts` — expect green.
- [ ] Commit: `chore(api): retire the dead per-download MSI signing client and every MSI_SIGNING_* surface (spec deliverable 5)`

---

### Task 9: Trust-chain E2E — three distinct keys ending in real Go-updater verification

**Files:**
- Create: `scripts/generate-deployment-manifest-fixture.mjs` (deterministic fixture generator)
- Create: `agent/internal/updater/testdata/deployment_signed_manifest.json` (generated, committed)
- Create: `agent/internal/updater/deployment_trustchain_test.go`
- Create: `apps/api/src/services/releaseTrustChain.e2e.test.ts` (unit config — no DB)

**Interfaces:**
- Fixture JSON contract (shared between vitest and Go):

```json
{
  "keyId": "deploy-fixture-trustchain",
  "publicKeyB64": "<raw Ed25519 pubkey, base64>",
  "entries": [
    { "platform": "linux",   "arch": "amd64", "url": "…", "checksum": "…", "manifest": "<exact JSON string the API stores>", "signatureB64": "…" },
    { "platform": "linux",   "arch": "arm64", … },
    { "platform": "macos",   "arch": "amd64", … },
    { "platform": "macos",   "arch": "arm64", … },
    { "platform": "windows", "arch": "amd64", … }
  ]
}
```

- Consumes (Go): `Updater.verifyUpdateManifest(info downloadInfo, version string) (updateManifest, error)` (`updater.go:928`) with `Config.PinnedManifestPubKeys` in `"<keyId>:<base64>"` form (pattern: `updater_test.go:926-970`). `manifestPlatform()` maps GOOS darwin → `"macos"` (`updater.go:378-383`) — fixture `platform` values match.
- Ed25519 signatures are deterministic (RFC 8032), so a fixed seed makes the fixture reproducible and lets the vitest assert the API produces the exact committed bytes.

**Steps:**

- [ ] Create `scripts/generate-deployment-manifest-fixture.mjs`:

```js
#!/usr/bin/env node
// Regenerates agent/internal/updater/testdata/deployment_signed_manifest.json —
// the cross-language trust-chain golden fixture. Deterministic: fixed Ed25519
// seed + deterministic RFC 8032 signatures, so re-running is a no-op unless the
// normalized-manifest shape changes (in which case BOTH sides of the contract
// must move together; see releaseTrustChain.e2e.test.ts and
// deployment_trustchain_test.go).
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const KEY_ID = 'deploy-fixture-trustchain';
const REPO = 'acme/breeze-selfhost-signing';
const VERSION = '9.9.9';

const privateKey = createPrivateKey({
  key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(SEED_HEX, 'hex')]),
  format: 'der',
  type: 'pkcs8',
});
const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
const publicKeyB64 = spki.subarray(spki.length - 32).toString('base64');

const checksum = createHash('sha256').update('trust-chain-fixture-binary').digest('hex');

const targets = [
  { goos: 'linux', platform: 'linux', arch: 'amd64', ext: '' },
  { goos: 'linux', platform: 'linux', arch: 'arm64', ext: '' },
  { goos: 'darwin', platform: 'macos', arch: 'amd64', ext: '' },
  { goos: 'darwin', platform: 'macos', arch: 'arm64', ext: '' },
  { goos: 'windows', platform: 'windows', arch: 'amd64', ext: '.exe' },
];

const entries = targets.map((t) => {
  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/breeze-agent-${t.goos}-${t.arch}${t.ext}`;
  // EXACT key order of binarySync.applyDeploymentSigning's normalized manifest.
  const manifest = JSON.stringify({
    version: VERSION,
    component: 'agent',
    platform: t.platform,
    arch: t.arch,
    url,
    checksum,
    size: 4096,
  });
  return {
    platform: t.platform,
    arch: t.arch,
    url,
    checksum,
    manifest,
    signatureB64: sign(null, Buffer.from(manifest, 'utf8'), privateKey).toString('base64'),
  };
});

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'agent/internal/updater/testdata/deployment_signed_manifest.json',
);
writeFileSync(out, JSON.stringify({ keyId: KEY_ID, publicKeyB64, entries }, null, 2) + '\n');
console.log(`wrote ${out}`);
```

- [ ] Run `mkdir -p agent/internal/updater/testdata && node scripts/generate-deployment-manifest-fixture.mjs` and commit the generated JSON alongside the script.
- [ ] Write `agent/internal/updater/deployment_trustchain_test.go`:

```go
package updater

import (
	"encoding/json"
	"os"
	"runtime"
	"testing"
)

// deploymentManifestFixture mirrors the JSON written by
// scripts/generate-deployment-manifest-fixture.mjs. It is the Go end of the
// BYO-signing trust chain (spec 3b): the API re-signs a normalized update
// manifest with the per-deployment key; this test proves the shipped agent
// accepts EXACTLY those bytes under the deploy-* key ID — and only under it.
type deploymentManifestFixture struct {
	KeyID        string `json:"keyId"`
	PublicKeyB64 string `json:"publicKeyB64"`
	Entries      []struct {
		Platform     string `json:"platform"`
		Arch         string `json:"arch"`
		URL          string `json:"url"`
		Checksum     string `json:"checksum"`
		Manifest     string `json:"manifest"`
		SignatureB64 string `json:"signatureB64"`
	} `json:"entries"`
}

func loadDeploymentManifestFixture(t *testing.T) deploymentManifestFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/deployment_signed_manifest.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fx deploymentManifestFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return fx
}

func TestDeploymentSignedManifestFixture_VerifiesUnderPinnedDeploymentKey(t *testing.T) {
	fx := loadDeploymentManifestFixture(t)

	var entry *struct {
		Platform     string `json:"platform"`
		Arch         string `json:"arch"`
		URL          string `json:"url"`
		Checksum     string `json:"checksum"`
		Manifest     string `json:"manifest"`
		SignatureB64 string `json:"signatureB64"`
	}
	for i := range fx.Entries {
		if fx.Entries[i].Platform == manifestPlatform() && fx.Entries[i].Arch == runtime.GOARCH {
			entry = &fx.Entries[i]
			break
		}
	}
	if entry == nil {
		t.Skipf("fixture has no entry for %s/%s", manifestPlatform(), runtime.GOARCH)
	}

	u := &Updater{
		config: &Config{
			Component:             "agent",
			PinnedManifestPubKeys: []string{fx.KeyID + ":" + fx.PublicKeyB64},
		},
	}
	info := downloadInfo{
		URL:               entry.URL,
		Checksum:          entry.Checksum,
		Manifest:          entry.Manifest,
		ManifestSignature: entry.SignatureB64,
		SigningKeyID:      fx.KeyID,
	}
	got, err := u.verifyUpdateManifest(info, "9.9.9")
	if err != nil {
		t.Fatalf("verifyUpdateManifest: %v", err)
	}
	if got.Version != "9.9.9" || got.Component != "agent" {
		t.Fatalf("unexpected manifest accepted: %+v", got)
	}
}

func TestDeploymentSignedManifestFixture_RejectedUnderOfficialKeyID(t *testing.T) {
	// Keyed trust means the deployment signature must NOT verify when the
	// response claims the embedded official key's ID (P1-UPD-001 semantics).
	fx := loadDeploymentManifestFixture(t)
	entry := fx.Entries[0]

	u := &Updater{
		config: &Config{
			Component:             "agent",
			PinnedManifestPubKeys: []string{fx.KeyID + ":" + fx.PublicKeyB64},
		},
	}
	info := downloadInfo{
		URL:               entry.URL,
		Checksum:          entry.Checksum,
		Manifest:          entry.Manifest,
		ManifestSignature: entry.SignatureB64,
		SigningKeyID:      "release-artifact-manifest-ed25519",
	}
	if _, err := u.verifyUpdateManifest(info, "9.9.9"); err == nil {
		t.Fatal("expected verification to fail under the official key ID")
	}
}
```

- [ ] Run `cd agent && go test -race ./internal/updater/ -run TestDeploymentSignedManifestFixture` — first test fails only if the fixture/normalized shape disagree with `updateManifest` (`updater.go:349-357`); fix the generator, never the agent, until green. (Note: the platform-match test verifies `platform`/`arch` against the runtime, which is why the fixture carries all five agent targets.)
- [ ] Write `apps/api/src/services/releaseTrustChain.e2e.test.ts` — the vitest half walks all three keys and pins the API's output to the committed fixture bytes:

```ts
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn(() => ({ onConflictDoUpdate }));
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const tx = {
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhere })) })),
    insert: vi.fn(() => ({ values: insertValues })),
  };
  return {
    insertValues,
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn(tx)),
  };
});
vi.mock('../db', () => ({ db: { transaction: dbMocks.transaction } }));
vi.mock('./s3Storage', () => ({ isS3Configured: () => false, syncDirectory: vi.fn() }));

// Deployment key = the FIXTURE key: signManifest signs with the fixture seed so
// the sync output must be byte-identical to what the Go updater test verifies.
// Everything the mock factory touches lives inside vi.hoisted(): static imports
// are hoisted above module-body consts, and the factory runs while
// './binarySync' is being imported — a plain top-level const would still be in
// its temporal dead zone at that point.
const trustChainSigner = vi.hoisted(() => {
  const { createPrivateKey, sign } =
    require('node:crypto') as typeof import('node:crypto');
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 Ed25519 prefix
      Buffer.from(
        '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', // fixture seed
        'hex',
      ),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    keyId: 'deploy-fixture-trustchain',
    ensureActiveSigningKey: vi.fn(async () => ({
      keyId: 'deploy-fixture-trustchain',
      publicKeyB64: '',
    })),
    signManifest: vi.fn(async (json: string) =>
      sign(null, Buffer.from(json, 'utf8'), privateKey).toString('base64'),
    ),
  };
});
vi.mock('./manifestSigning', () => ({
  ensureActiveSigningKey: trustChainSigner.ensureActiveSigningKey,
  signManifest: trustChainSigner.signManifest,
}));

import { syncFromGitHub } from './binarySync';
import { verifyReleaseArtifactManifestAsset } from './releaseArtifactManifest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixture = JSON.parse(
  readFileSync(
    path.join(REPO_ROOT, 'agent/internal/updater/testdata/deployment_signed_manifest.json'),
    'utf8',
  ),
) as {
  keyId: string;
  publicKeyB64: string;
  entries: Array<{
    platform: string;
    arch: string;
    url: string;
    checksum: string;
    manifest: string;
    signatureB64: string;
  }>;
};

function rawPub(publicKey: import('node:crypto').KeyObject): string {
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(der.length - 32).toString('base64');
}

function signManifestBytes(
  manifest: Buffer,
  privateKey: import('node:crypto').KeyObject,
): Buffer {
  return Buffer.from(sign(null, manifest, privateKey).toString('base64'));
}

describe('trust-chain E2E: official key → self-hoster release key → deployment key (spec 3b/3c)', () => {
  const originalEnv = process.env;
  const REPO = 'acme/breeze-selfhost-signing';
  const CHECKSUM = createHash('sha256').update('trust-chain-fixture-binary').digest('hex');

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.GITHUB_REPO;
    delete process.env.BINARY_GITHUB_REPOSITORY;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('layer 1 — the official source key verifies canonical assets and rejects signing inputs', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519'); // official key
    const officialManifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        repository: 'LanternOps/breeze',
        release: 'v9.9.9',
        assets: [
          {
            name: 'breeze-agent-windows-amd64.exe',
            sha256: CHECKSUM,
            size: 4096,
            platformTrust: 'windows-authenticode-required',
          },
          {
            name: 'breeze-agent-windows-amd64-unsigned.exe',
            sha256: CHECKSUM,
            size: 4096,
            platformTrust: 'none',
            intendedUse: 'signing-input',
          },
        ],
      }),
    );
    const signature = signManifestBytes(officialManifest, privateKey);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = rawPub(publicKey);

    // The template workflow's verification of official inputs is out of repo;
    // in-repo, layer 1 means: the official key gates canonical assets, and the
    // API can NEVER register/serve a signing input even from a valid manifest.
    await expect(
      verifyReleaseArtifactManifestAsset({
        assetName: 'breeze-agent-windows-amd64.exe',
        manifestBytes: officialManifest,
        signatureBytes: signature,
      }),
    ).resolves.toMatchObject({ platformTrust: 'windows-authenticode-required' });
    await expect(
      verifyReleaseArtifactManifestAsset({
        assetName: 'breeze-agent-windows-amd64-unsigned.exe',
        manifestBytes: officialManifest,
        signatureBytes: signature,
      }),
    ).rejects.toThrow(/not distributable/);
  });

  it('layers 2+3 — self-hoster release key gates the sync; deployment key output matches the Go-verified fixture bytes', async () => {
    process.env.BINARY_GITHUB_REPOSITORY = REPO;
    process.env.BINARY_VERSION = '9.9.9';

    const officialKey = generateKeyPairSync('ed25519'); // distinct key #1
    const selfHosterKey = generateKeyPairSync('ed25519'); // distinct key #2
    // distinct key #3 is the fixture deployment seed inside the signManifest mock.

    const releaseManifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        repository: REPO,
        release: 'v9.9.9',
        assets: [
          {
            name: 'breeze-agent-linux-amd64',
            sha256: CHECKSUM,
            size: 4096,
            platformTrust: 'release-workflow-produced',
          },
        ],
      }),
    );
    const selfHosterSig = signManifestBytes(releaseManifest, selfHosterKey.privateKey);
    const officialSig = signManifestBytes(releaseManifest, officialKey.privateKey);

    const stub = (signatureBody: Buffer) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('/releases/tags/v9.9.9') || url.includes('/releases/latest')) {
            return new Response(
              JSON.stringify({
                tag_name: 'v9.9.9',
                body: null,
                assets: [
                  {
                    name: 'breeze-agent-linux-amd64',
                    browser_download_url: `https://github.com/${REPO}/releases/download/v9.9.9/breeze-agent-linux-amd64`,
                    size: 4096,
                  },
                  {
                    name: 'release-artifact-manifest.json',
                    browser_download_url: `https://github.com/${REPO}/releases/download/v9.9.9/release-artifact-manifest.json`,
                    size: releaseManifest.length,
                  },
                  {
                    name: 'release-artifact-manifest.json.ed25519',
                    browser_download_url: `https://github.com/${REPO}/releases/download/v9.9.9/release-artifact-manifest.json.ed25519`,
                    size: signatureBody.length,
                  },
                ],
              }),
            );
          }
          if (url.endsWith('/release-artifact-manifest.json')) return new Response(releaseManifest);
          if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signatureBody);
          return new Response('not found', { status: 404 });
        }),
      );

    // Source isolation: with only the SELF-HOSTER key configured, a manifest
    // signed by the (still distinct) official key must be rejected.
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = rawPub(selfHosterKey.publicKey);
    stub(officialSig);
    await expect(syncFromGitHub('v9.9.9')).rejects.toThrow(/signature verification failed/);
    expect(dbMocks.insertValues).not.toHaveBeenCalled();

    // Happy path: self-hoster-signed manifest registers, and the stored row is
    // byte-identical to the committed Go fixture — same manifest string, same
    // deterministic Ed25519 signature, same deploy-* key ID.
    stub(selfHosterSig);
    const result = await syncFromGitHub('v9.9.9');
    expect(result.synced).toContain('agent:linux/amd64');

    const fixtureEntry = fixture.entries.find(
      (e) => e.platform === 'linux' && e.arch === 'amd64',
    )!;
    const insert = dbMocks.insertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(insert.signingKeyId).toBe(fixture.keyId);
    expect(insert.releaseManifest).toBe(fixtureEntry.manifest);
    expect(insert.manifestSignature).toBe(fixtureEntry.signatureB64);
  });
});
```

- [ ] Run `pnpm --filter @breeze/api test -- src/services/releaseTrustChain.e2e.test.ts` — if the byte-equality assertion fails, the generator and `applyDeploymentSigning` disagree on the normalized shape; fix the generator (or Task 5 code) so all three of {API output, fixture, Go verification} agree, then re-run `node scripts/generate-deployment-manifest-fixture.mjs` and the Go test.
- [ ] Run the full local gate: `pnpm --filter @breeze/api test` and `cd agent && go test -race ./internal/updater/...` — all green.
- [ ] Commit: `test(api,agent): three-key trust-chain E2E with a shared deployment-signed manifest fixture (spec testing)`

---

## Final verification (whole plan)

- [ ] `pnpm --filter @breeze/api test` — full API unit suite green (remember: this does NOT run the RLS/integration configs; none of this plan touches tenancy/cascade surfaces, and no new tables/columns were added, so no cascade/export-policy registration applies).
- [ ] `cd agent && go test -race ./internal/updater/...` — green.
- [ ] `grep -rn "MSI_SIGNING\|MsiSigningService" apps/api docker-compose.yml deploy .env.example` — empty.
- [ ] `grep -rn "GITHUB_REPO " apps/api/src --include="*.ts" | grep -v releaseSource` — only the deprecated-alias read in `releaseSource.ts` remains.
- [ ] Confirm official-path byte-identity one more time: the Task 5 regression test (`official-repo path is untouched`) and the pre-existing `binarySync.test.ts:156` test both assert `signingKeyId: "release-artifact-manifest-ed25519"` with the raw manifest.
- [ ] PR description records the explicit handoffs: apps/docs + `docs/signing/*` MSI mentions (Phase 3, Deliverable 4), smoke-workflow override variant (needs the Phase 3 fixture repo), template repo (Deliverable 2), release.yml `sourceCommit`/`intendedUse` emission (Deliverable 1 — until it ships, no official manifest contains `intendedUse`, which this plan tolerates: `intendedUse` absent ⇒ `null` ⇒ distributable).
