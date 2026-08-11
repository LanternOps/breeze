# Workspace → `ee/workspace` merge (design)

**Date:** 2026-08-11
**Status:** Approved direction (Todd, 2026-08-11); implementation plan to follow
**Supersedes:** the open-core seam consolidation directive of 2026-07-20 and the
seam-based W4 approach (`ToddHebebrand/client-ext-seam-w4`)

## Decision

Move the Breeze Workspace extension (`LanternOps/breeze-workspace`, private)
into the public breeze monorepo at `ee/workspace/`, loaded as a **built-in
extension** (static import), under a commercial license. The two-repo split,
vendored-SDK tarballs, signing/packing pipeline, and symlink dev flow are
retired for Workspace. The signed-runtime-bundle platform itself stays intact
for third-party extensions.

## Why

The extension seam was built to keep proprietary Workspace code out of the
public AGPL repo. In practice the split imposed a heavy per-change tax:
vendored `file:vendor/*.tgz` SDK deps, a frozen Ed25519-signed wire format,
stage/validate/pack scripts, a live stock-host conformance suite, a
machine-local `pnpm.overrides` hack, a symlinked `extensions/workspace` dev
flow with compose-override mounts, and cross-repo PR sequencing on nearly
every change.

Two facts change the calculus:

1. **AGPL-3.0 already provides the protection that matters most** — no one can
   run a modified Workspace as closed SaaS without publishing changes.
2. **An `ee/` directory with a commercial license** (the Cal.com pattern:
   AGPL repo, `ee/` under commercial terms) preserves the "source-visible but
   not free to resell" lever at near-zero cost, without a second repo.

Merging also dissolves the entire 6-point breeze↔workspace coupling backlog
(see "Ripple effects").

## Design

### 1. Repo layout & licensing

- Workspace source lands at `ee/workspace/` in breeze, copied from
  `LanternOps/breeze-workspace` at a pinned SHA, with attribution in the
  commit message. The private repo is archived (read-only) as the history
  record.
- `pnpm-workspace.yaml` gains `ee/*`. The package is renamed
  `@breeze/ext-workspace` (from `@lanternops/breeze-ext-workspace`) and
  depends on `@breeze/extension-sdk` / `@breeze/extension-web-sdk` via
  `workspace:*`.
- Deleted along with the move: `vendor/` tarballs, `.stubs/`, the packer /
  sign / stage / validate scripts, the root-`package.json` `pnpm.overrides`
  entries (currently an unstaged machine-local edit) and the compose-override
  `package.json` mount, and the `extensions/workspace` symlink.
- Licensing: `ee/LICENSE` carries the commercial license; root `LICENSE` /
  `README.md` get one paragraph: everything except `ee/` is AGPL-3.0, `ee/`
  is covered by the Breeze Commercial License. `ee/workspace/package.json`
  sets `"license"` accordingly. No runtime license-key gating for now
  (nothing to gate; can be added if Workspace becomes a sold tier).

### 2. Loading: built-in extension path

A third delivery mode alongside signed runtime bundles and the deprecated
source-directory scan — **built-in**:

- `apps/api/src/extensions/builtinExtensions.ts` statically imports the
  workspace package's parsed manifest and v1 register entry and feeds them
  through the **same v1 host pipeline** as runtime bundles: staged
  contribution registry, default-deny gateway, tenancy/RLS tripwires,
  enabled-gate. Workspace remains org-gated exactly as today (DB row per
  enabled org).
- No signing, no bundle verification, no discovery scan, no
  `BREEZE_LEGACY_SOURCE_EXTENSIONS` flag involvement.
- Static import means tsup bundles Workspace into the API image and
  `apps/api`'s strict tsconfig (`noUncheckedIndexedAccess` etc.) typechecks
  it — the extension-cli-style "passes its own gate, fails apps/api's" bug
  class disappears.
- The "one delivery path per extension name" boot-failure tripwire extends to
  built-ins: a runtime artifact or source dir named `workspace` fails boot.
- The legacy one-arg-`register()` bridge inside the extension is deleted; the
  built-in path makes the v1 two-arg call directly.

### 3. Migrations

Mechanism unchanged: the extension migrator runs
`ee/workspace/migrations/*.sql` (idempotent, RLS via
`breeze_has_org_access`, one transaction per file, no inner BEGIN/COMMIT).
The built-in registration hands the migrator a `migrationsDir` resolved from
the package; the API Docker build copies that directory into the image so the
CJS bundle can find it at boot.

### 4. Web contributions

The contribution / web-asset registry mechanism is kept as-is. Assets are
produced by the package's normal in-repo build (`tsup.web.config.ts`) and
served from the package's dist output instead of an unpacked signed artifact.
Portal-side loading code does not change.

### 5. Tests & CI

- Workspace unit + integration tests join breeze CI as a normal workspace
  member (same runner as other packages). The isolated-throwaway-DB pattern
  for full-`reconcileExtensions` integration tests is unchanged.
- The live stock-host conformance suite is retired as a Workspace gate. The
  platform keeps its own conformance coverage via the fixtures in
  `apps/api` (`packerConformance.test.ts` etc.) — it no longer needs
  Workspace as its reference guinea pig.
- Docs stating "stock images contain public SDK/host code only" are updated:
  images now contain AGPL core + `ee/` code; the *runtime-bundle* path still
  ships nothing third-party in the image.

## Ripple effects

The July coupling inventory dissolves:

1. Legacy loader bridge → deleted (built-in makes the v1 call directly).
2. Root `pnpm.overrides` machine-local hack + compose mount → deleted
   (`workspace:*` resolution).
3. Symlink dev flow → deleted (code is in-repo; dev loop = edit, tsx reload).
4. W4 client-ai plumbing → the dilemma (move core auth/DLP/add-in code
   private, or freeze a public seam contract) is cancelled. Add-ins and
   `packages/office-addin-core` stay in core; Workspace imports them
   directly. Remaining W4 scope is pure feature work (Workspace content in
   the in-Excel assistant, org-policy gating, DLP coverage for workspace
   sources) done as ordinary same-repo development.
5. Gateway `/agent/:agentId` contract negotiation → moot for Workspace
   (first-party code uses the gateway as-is; no frozen contract needed).
6. Duplicate e2e coverage across repos → collapses into breeze CI.

## Sequencing & in-flight work

- **breeze#3032 (tenant-scoped installs, open):** touches extension
  registration (incl. the new-org registration table every extension must be
  entered in). Merge #3032 first; the built-in path registers Workspace
  through that machinery so org-gating keeps working.
- **`ToddHebebrand/client-ext-seam-w4` (local branch, 2 commits ahead of
  main + ~25 uncommitted docs edits):** the seam-based W4 approach this
  design supersedes. Its commits (clientSurfaces/clientPanels through the
  legacy load path; CORS allowlist for the extension web-module route) should
  be triaged: keep what serves the third-party platform generally, drop what
  existed only to reach Workspace across the seam. The uncommitted
  `apps/docs` edits look unrelated and need separate triage.
- The workspace repo's open PRs/issues migrate or close at archive time.

## Non-goals

- Dismantling the signed-runtime-bundle platform (stays, for third parties).
- Moving `breeze-worktrack` in-repo (unaffected; can follow later if wanted).
- Folding Workspace UI directly into `apps/web` pages (Option B); the
  contribution mechanism is kept.
- Runtime license-key enforcement for `ee/` features.
- Moving Office add-ins or `office-addin-core` anywhere — they stay in core.

## Estimated shape

One focused breeze PR (source move + built-in path + build/CI wiring + license
files + doc updates), plus archiving the private repo. Roughly a day of
work once #3032 is merged.
