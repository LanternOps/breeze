# Package-Manager Sources in the Software Library (winget + Homebrew)

**Date:** 2026-08-15
**Status:** Approved design, pre-implementation
**Reviewed by:** Fable + Codex quorum (gpt-5.6-sol, xhigh, read-only) — agreed on
library-first; disagreement on Homebrew bootstrap resolved to the opt-in middle
path (below).

## Problem

Adding a package to the Software Library today means finding an installer URL or
uploading a binary, plus silent args and detection rules. Meanwhile the winget /
Homebrew world already lives in Breeze — but only inside the *patching*
subsystem (agent providers in `agent/internal/patching/`, the global curated
`third_party_package_catalog`, `GET /patches/app-options`). The library
(`software_catalog` / `software_versions`) has zero package-manager awareness,
and the agent's `software_install` handler only understands
download-and-run-installer (exe/msi/deb/pkg/dmg).

MSPs want two things, staged:

1. **Phase 1 — easy library adds:** search winget/brew from inside Breeze, pick
   a package, and it becomes a deployable library item. No URL hunting.
2. **Phase 2 — install-if-missing:** "every device in this org/partner should
   have these apps" — converging enforcement, not one-shot deploys.

## Decision: library-first (Approach A)

The library owns *what should exist*; software policies own *enforcement*;
patching keeps owning *keep-current for what's installed*. Once a
manager-linked package is installed, the existing 3P patching
(winget/homebrew providers, rings, deferrals) maintains it with no new code.

Rejected: **patching-first** (adding an `install` action to patch-policy
`PolicyAppRule`) — it fabricates patch rows for apps that were never observed
installed, leaves the library ignorant of package managers (no deploy wizard,
no one-off "push Chrome to 5 devices"), and would be retrofitted into the
library shape later anyway (the org-first-config lesson).

## Phase 1 design

### Data model — new `software_install_methods` table

A child of `software_catalog`, NOT columns on the catalog row and NOT fake
`software_versions` rows (quorum consensus: version rows would poison
`is_latest`/promote/download plumbing with rows that have no payload).

```
software_install_methods
  id           uuid PK default gen_random_uuid()
  catalog_id   uuid NOT NULL FK software_catalog(id) ON DELETE CASCADE
  platform     enum('windows','macos') NOT NULL
  kind         enum('winget','homebrew_cask','homebrew_formula') NOT NULL
  package_id   varchar(256) NOT NULL      -- e.g. Google.Chrome / firefox
  enabled      boolean NOT NULL DEFAULT true
  created_at   timestamptz NOT NULL DEFAULT now()
  UNIQUE (catalog_id, platform, kind)
  CHECK (platform/kind coherence: winget⇔windows, homebrew_*⇔macos)
```

- One catalog item can carry a winget method AND a brew method → a single
  cross-platform "Google Chrome" library entry.
- A catalog item may hold install methods, uploaded/URL versions, or both.
  When both exist for a platform, the deploy wizard makes the tech choose;
  no silent preference.
- **Version intent lives on the deployment, not the method:**
  `versionMode: 'latest' | 'exact'` + `requestedVersion` (winget only —
  Homebrew is latest-only in v1). An exact version that winget can't satisfy
  fails that device's result row; it never silently falls back to latest.
  "Latest" means latest *at execution time* — queued offline commands may run
  days later (queued `software_install` lives up to 7 days).
- Deliberately omitted (YAGNI, revisit if needed): a `revision` column
  (dispatch already snapshots the full resolved payload per device command, so
  editing a method cannot mutate queued work), a `source_name` column (v1
  hardcodes the official winget community source and official brew taps —
  arbitrary sources are a supply-chain door that stays shut), and any
  managed-brew-prefix scope concept.

**Tenancy:** the table is scoped by its parent catalog item, which is already
dual org/partner-owned. RLS: an **`EXISTS` join policy** to `software_catalog`
(the cold-table pattern) — no denormalized `org_id`/`partner_id`, so the table
needs no org-cascade or export-policy registration (deletion rides the
`ON DELETE CASCADE` FK), only the RLS-coverage allowlist entry for join-policy
tables. This is a low-write config table; the join cost is irrelevant. Note:
`software_catalog` global built-in rows (integration-provider rows with both
owners NULL) may NOT carry install methods in v1.

### Agent — new `EnsurePresent` operation

The existing patch providers' `Install()` is an *upgrade* path (homebrew's
literally runs `brew upgrade`) governed by rings/pins. Ensure-present is a
separate operation with install-only semantics:

- Reaches the agent as the existing `software_install` command type with a new
  payload shape: `{ installMethod: { kind, packageId }, versionMode,
  requestedVersion? }` instead of `downloadUrl`. Same dispatch, WS-with-queue
  fallback, retry, and result plumbing as today
  (`services/softwareDeployment.ts` → `handlers_software_install.go`).
- **Windows (winget):** query installed first (`winget list --exact --id`);
  if present, succeed as no-op (reported distinctly, `alreadyInstalled`) —
  never upgrade. Install: `winget install --exact --id <id> --scope machine
  --silent --accept-package-agreements --accept-source-agreements`
  (+ `--version` when exact). No `--force`, no hash-override switches.
  Package IDs validated against the existing winget-ID regex
  (`validateSoftwarePackageID`).
- **macOS (brew):** `brew install [--cask] <name>` — which no-ops when already
  installed (never `brew upgrade`). Runs as the active console user via the
  same `sudo -n -H -u` machinery the homebrew patch provider uses.
- Success is two-stage: command exit code completes the `deployment_results`
  row; the app appearing in `software_inventory` (existing detection/inventory
  linkage) is the verification signal. Phase 1 surfaces both; phase 2's
  convergence loop *requires* the inventory confirmation.
- **Unavailability is honest state, not failure noise:** devices without
  winget (Server/LTSC — the agent's winget bootstrap `Provision` is a
  deliberate stub, `agent/internal/patching/winget_ensuredeps.go:12`) or
  without brew report `manager_unavailable` and the deploy wizard shows the
  count *before* dispatch.

### Homebrew bootstrap — explicit opt-in only (quorum resolution)

- Codex's position: no auto-bootstrap (brew is non-root, single-user-owned;
  console user is not a stable management identity; `curl | bash` is a trust
  hazard). Fable's position: without any bootstrap the macOS half is inert on
  most endpoints (community ask #2994).
- **Resolution:** v1 ships a "Homebrew missing" device state with a one-click,
  admin-triggered bootstrap action: a **pinned, checksummed** copy of the
  official installer (vendored/versioned by Breeze, never fetched-and-piped
  unverified at run time), executed as the active console user via the
  existing run-as-console-user machinery, with the run recorded in the audit
  trail. Never automatic; never fleet-wide-silent. If the console user lacks
  admin rights or no user is logged in, the action fails with a clear message.
- winget's `Provision` stub stays stubbed in phase 1; finishing it is a listed
  follow-up (it has its own planned task — "Task 9b" in the agent code).

### Discovery — in-product package search

`GET /software/package-search?platform=windows|macos&q=...` (auth'd, no tenant
data — results are global):

- **Homebrew:** official `formulae.brew.sh` JSON API (formulae + casks),
  fetched server-side and cached (Redis, hours-scale TTL). Self-hosted
  instances without egress degrade to manual ID entry.
- **winget:** a **synced local index of `microsoft/winget-pkgs` manifests**
  (MIT-licensed). A background job periodically syncs a known upstream commit,
  parses package identifier / publisher / name / moniker / versions, and
  builds a global read-only Postgres search index (new generation built and
  atomically switched; upstream commit SHA + sync time stored; stale age
  surfaced in the UI). A versioned snapshot ships with self-hosted releases so
  search works without GitHub access. **No dependency on unofficial community
  APIs.** (Parsing Microsoft's CDN-pre-indexed `source.msix` was rejected as
  implementation-specific and brittle.)
- Results are annotated from the curated `third_party_package_catalog`:
  `breeze_tested` shown as *version-specific evidence* ("tested v126 on
  2026-08-01"), never a permanent trust badge.
- **Manual ID entry always exists** as the fallback path (air-gapped,
  index-stale, or long-tail packages).
- Import = create the tenant/partner-owned `software_catalog` row (name,
  vendor, homepage, icon where available) + `software_install_methods` rows.
  Policies and deployments only ever reference tenant-owned rows — never the
  global index.

### API surface

- `GET /software/package-search` (above).
- `POST /software/catalog/:id/install-methods`, `PATCH`/`DELETE`
  `/software/catalog/:id/install-methods/:methodId` — writes gated by the same
  ownership rules as version writes (`authorizeCatalogItemWrite`), partner-wide
  writes gated by `canManagePartnerWidePolicies`.
- `POST /software/deploy` extended: a target `softwareVersionId` OR
  `{ catalogId, installMethod resolution }` + `versionMode`/`requestedVersion`.
  Per-device resolution picks the method matching the device OS; devices with
  no matching enabled method fail their result row pre-dispatch (same pattern
  as unresolved installer variables — never dispatch an impossible command).
- Import endpoint: `POST /software/catalog/import-package` (one call that
  creates catalog item + methods from a search result or pasted IDs).

### Web UI

- **AddPackageModal:** source segmented control gains "Package manager"
  alongside file upload / URL. Search box (per-platform tabs or combined with
  platform chips), pick → prefilled identity, optional second method
  ("also add the macOS cask?"), manual-ID entry fallback. Respects the
  existing partner-wide `ownerScope` create flow.
- **Catalog cards/detail:** manager badges (winget / brew icons + package IDs),
  `breeze_tested` evidence line where available.
- **DeploymentWizard:** for manager-linked items — version mode selector
  (latest default, exact for winget), per-OS resolution preview, and the
  "manager unavailable on N devices" callout with the affected device list.
- All mutations via `runAction` per repo contract.

### Testing (phase 1)

- Schema/RLS: contract-suite registrations + a cross-tenant forge test as
  `breeze_app`; export-policy classification for every new column.
- API: route unit tests (Drizzle mocks) for method CRUD, import, deploy
  resolution incl. no-method-for-OS failure and exact-version payloads;
  integration test for the winget index sync job (fixture manifests →
  generation swap).
- Agent: table-driven Go tests for EnsurePresent per manager — present→no-op,
  absent→install, exact-version miss→fail, manager unavailable→
  `manager_unavailable`; command payload parsing; brew console-user selection.
- Web: modal search/import flow, wizard resolution preview, unavailable callout.
- E2E: import a winget package → deploy to a Windows test device → inventory
  shows it (against the Windows VM rig where feasible).

## Phase 2 direction — install-if-missing (own spec before build)

Pinned direction so phase 1 leaves the right contracts behind; details get
their own spec:

- **Home:** software-policy domain, NOT update rings. Rings keep governing
  *upgrades* (pins/deferrals); presence is desired-state.
- **Shape:** a `software_assignments` layer (policy- or standalone-owned,
  dual org/partner per partner-wide-first) — "these catalog items must be
  present," referencing catalog items whose install methods make the install
  executable. The existing compliance worker already emits `missing`
  violations; the remediation worker (today uninstall-only) gains an install
  action dispatching the same EnsurePresent command.
- **Convergence requirements:** idempotency key (assignment × device), at most
  one active install attempt, requeue after command expiry while still
  missing, completion confirmed by inventory — not exit code alone;
  maintenance-window awareness.
- **Precedence, defined up front:** explicit prohibition (blocklist) beats
  required-presence; equal-priority contradictions produce a conflict finding
  and NO mutation (no install/uninstall oscillation); audit-mode never
  mutates; rings' pins/deferrals govern upgrades only.
- Quick Support ephemeral devices are excluded (existing remediation-worker
  guard pattern).

## Risks & mitigations (quorum top 5)

1. **Inventory identity gap** — inventory rows lack manager/package identity,
   so "is it installed?" relies on name matching. Mitigation: EnsurePresent
   no-op check happens agent-side against the manager itself (`winget list
   --exact`, brew's own no-op), not server-side name matching; follow-up to
   add manager identity to inventory reporting.
2. **Cross-tenant resolution in system workers** — partner-wide catalog items
   evaluated in system context must fan out by the device org's partner
   (established partner-wide fan-out contract).
3. **Ensure-present accidentally upgrading** — designed out: install-only
   semantics, never the patch providers' upgrade path.
4. **Offline/queued drift** — payload snapshotted at dispatch; "latest" labeled
   as latest-at-execution; phase 2 adds durable idempotency.
5. **Policy oscillation** — phase-2 precedence rules above.

Supply chain: official sources only, exact IDs, no force/hash-bypass flags,
pinned checksummed brew bootstrap, winget IDs regex-validated.

## Follow-ups (explicitly out of scope)

- Finish winget `Provision` bootstrap (agent Task 9b) — unlocks Server/LTSC.
- Manager identity fields on `software_inventory` reporting.
- Phase 2 spec: `software_assignments` + install remediation.
- Chocolatey / Linux (apt/dnf) install methods — enum is extensible.
- Private winget REST sources for air-gapped installs.
