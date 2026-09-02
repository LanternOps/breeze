# Org-Scoped Cross-Platform Software Catalog with AI-Assisted Version Research — Design Spike

**Date:** 2026-08-14
**Status:** Proposed (design spike deliverable for #2994; no code)
**Issue:** #2994 (SemoTech follow-up comment is the source model)
**Related:** #2135 (partner-wide epic), #3381 (blast-radius lesson), spec
`2026-08-04-third-party-update-ring-auto-approve-design.md` (ring composition target), spec
`2026-07-08-vuln-displayname-cpe-resolver-design.md` (global resolution-cache precedent)

## 1. Problem + scope

Breeze's third-party patching today is package-manager-shaped: the agent's `PatchProvider`
implementations (`agent/internal/patching/`: `winget_system.go`, `chocolatey.go`, `homebrew.go`,
`apt.go`, `yum.go`, `apple_softwareupdate.go`) can only see and update software their manager
installed. Everything else is invisible to the update loop even though it is fully visible to
*inventory* — the agent already collects the complete installed-app list every 15 minutes
(`heartbeat.go:1721` `sendInventory` → `collectors/software.go`) into `software_inventory`.

Gaps this design closes:

- **macOS beyond Homebrew** — Sparkle-updating and direct-download `.app`s (the majority of a
  typical Mac fleet; `system_profiler SPApplicationsDataType` sees them, nothing tracks their
  latest versions), Microsoft 365/Office (`msupdate`, no driver today), Adobe CC
  (`RemoteUpdateManager`, no driver today). Confirmed no `msupdate`/`RemoteUpdateManager`/Sparkle
  string exists anywhere in `agent/`.
- **Windows per-user installs** — `software_windows.go` reads HKLM (both views) plus
  `registry.CURRENT_USER`, but the agent runs as SYSTEM, so per-user apps in real users' HKCU
  hives are invisible to both inventory and winget-system patching. (Inventory fix is in scope;
  per-user *install* execution is Phase-3+.)
- **Linux repo apps** — apt/yum patch scans already report updates; the catalog unifies them into
  the same per-app cross-platform view instead of a wall of package rows.
- **The reporting gap** — "which orgs run outdated VLC/Zoom/AnyDesk anywhere, on any OS" is
  unanswerable today. Phase 1 answers it with zero new install mechanics.

**Out of scope:** Mac App Store / VPP management (MDM territory — Todd's #2994 answer stands; at
most `mas`-based *detection* later), mobile, license management, and replacing the Software
Deployment package repository (`software_catalog`/`software_versions` — the *push installers*
feature keeps its name and role; the new tables use distinct names to avoid collision).

## 2. Data model

Follows the existing three-layer split already proven by patching: **global identity facts**
(`patches` is globally deduped by `(source, external_id)`; `third_party_package_catalog` and the
CPE resolver's `software_product_resolutions` are intentionally-unscoped global tables) →
**partner-scoped decisions** (`patch_approvals`, `patch_policies` rings are partner-axis) →
**org/device-scoped state** (`device_patches`, `software_inventory`).

### 2a. `software_app_identities` — global, intentionally unscoped

The cross-platform app identity: one row per real-world application, unioned across platforms.

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| canonical_name | varchar(255) | normalized display name |
| vendor | varchar(255) | |
| platform_keys | jsonb | per-platform matchers: winget id, brew cask/formula, apt/yum package names, macOS bundle id + app name patterns, Windows DisplayName patterns |
| category | varchar(64) | |
| homepage_url | text | |
| identity_source | varchar(32) | `seeded` \| `deterministic` \| `ai` \| `manual` |
| created_at / updated_at | timestamptz | |

Unique partial indexes per extracted key (e.g. `(platform_keys->>'wingetId')`) to keep
deterministic matching O(1).

**Tenancy treatment:** shape "intentionally unscoped", registered in
`rls-coverage.integration.test.ts` with a justification comment exactly like line 89's
`third_party_package_catalog` entry. **Isolation contract:** rows may contain only public
software identifiers — never org ids, device ids, counts, or tenant-derived strings. Row
*creation* is triggered by some org's inventory, but the row records nothing about which org;
tenant reads always go through their own `org_software_catalog` join, so no tenant can enumerate
this table via app routes. Writes happen only in system-context workers and platform-admin routes
(same gate as `third_party_package_catalog`). No org/device/partner cascade entries needed; no
export-policy entry needed (no `org_id`).

### 2b. `software_version_research` — global, intentionally unscoped (the shared cache)

One row per `(app_identity_id, platform, channel)` — research done **once**, shared across every
org that runs the app. This is the cost-bounding mechanism and mirrors decision #1 of the CPE
resolver spec ("DisplayNames repeat fleet-wide, so a global cache is compact, cross-org,
auditable, and cheap to re-run").

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| app_identity_id | uuid FK → software_app_identities (ON DELETE CASCADE) | |
| platform | varchar(16) | `windows` \| `macos` \| `linux` |
| channel | varchar(32) | default `stable` |
| latest_version | varchar(100) | |
| release_date | date | |
| source | varchar(32) | `winget` \| `brew` \| `distro_repo` \| `sparkle_appcast` \| `vendor_cli` \| `vendor_api` \| `ai_web_research` |
| confidence | varchar(8) | `high` \| `medium` \| `low` — see §3 rules |
| evidence | jsonb | source URLs, appcast URL, download URL, expected hash/signature identity |
| status | varchar(16) | `fresh` \| `stale` \| `failed` \| `unresolvable` |
| researched_at / stale_after | timestamptz | TTL drives re-research |
| failure_count | integer | backoff; `unresolvable` after N |

**Tenancy treatment:** same as 2a — intentionally unscoped, allowlisted with comment, system-write
only, no cascades, no export-policy entry. **Shared-cache isolation implications, addressed
head-on:** (1) contents are public facts about public software, no tenant data can enter — the
research worker's inputs are only identity-row fields, enforced by construction and stated in the
allowlist comment; (2) timing side-channel ("row created ⇒ some org installed X") is only
observable to platform admins / system context, not to any tenant; (3) an org can never poison
another org's results directly — orgs cannot write these tables; poisoning via *inventory* (a
crafted DisplayName steering identity matching) is mitigated by the deterministic matcher rules
(§3) and by AI results being capped at `medium` confidence and therefore never auto-installed.

### 2c. `org_software_catalog` — org-scoped (shape 1, direct `org_id`)

The per-org catalog: "apps this org actually runs", derived from `software_inventory`.

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| org_id | uuid NOT NULL FK → organizations | |
| app_identity_id | uuid FK → software_app_identities | nullable — unmatched apps still get a row (`identity_confidence='none'`) and ARE the research backlog |
| display_name | varchar(500) | as seen in this org's inventory |
| vendor | varchar(255) | |
| platforms | jsonb | `["windows","macos"]` — which OSes this org runs it on |
| identity_confidence | varchar(8) | `high` \| `medium` \| `low` \| `none` |
| tracking_status | varchar(16) | `tracked` \| `ignored` (org-local mute) |
| device_count / outdated_device_count | integer | denormalized rollup, refreshed by reconcile |
| lowest_installed_version | varchar(100) | rollup for the list view |
| first_seen_at / last_seen_at / retired_at | timestamptz | |

Unique `(org_id, app_identity_id)` where identity is set; unique
`(org_id, lower(display_name), vendor)` for unmatched rows. **Deliberately no FK to
`software_inventory`** — ingest is delete+reinsert per report (`routes/agents/inventory.ts`), so
inventory row ids are ephemeral; the reconcile worker joins by normalized name/vendor exactly as
the vuln relink does.

**Partner-Wide First, resolved head-on:** this table is **org-scoped by design and that is the
justified exception CLAUDE.md requires.** It is not a config/policy/template table — it is
*derived observation state* ("what this org's devices run"), the same class as `device_patches`
and worker-created findings, which the epic-#2135 playbook itself says "always take the DEVICE's
org" (CLAUDE.md rule 5). A partner-axis or dual-axis shape here would be semantically wrong: the
same app has different device counts, versions, and staleness per org. The MSP-tech need — one
partner-level review/approval surface across all orgs — is real but is a *decision*, not an
*observation*, and lives in 2d, exactly as `patches` (facts) vs `patch_approvals` (partner
decisions) already split. A partner roll-up *view* ("Chrome: outdated in 7 of 12 orgs") is a
read-time aggregation across org rows under a partner token, needing no new tenancy shape. PR
description must carry this justification explicitly.

**Cascade/export registration (the full checklist):**
- `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`) — has `org_id`; insert
  alphabetically (`org_software_catalog` sorts after `oauth_*`, before `organizations`); verify FK
  direction (only parents are `organizations` + two global tables → no child-ordering hazard).
- `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`) — every column
  classified: `platforms` jsonb → **`excludedOpen`**; all other columns `included` (no
  SUSPICIOUS_NAME_PARTS hits).
- NOT in `CORE_DEVICE_CASCADE_DELETE_TABLES` / `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (no
  `device_id` column).
- RLS in the same migration: shape 1, `breeze_has_org_access(org_id)`, enabled + forced; run
  contract suites locally (they only fail in the Integration Tests CI job — stale-base hazard per
  CLAUDE.md).

### 2d. `software_catalog_approvals` — partner-axis (shape 3)

The MSP-tech review/approval state, one decision per `(partner, app_identity)`, optionally per
ring — the exact shape of `patch_approvals` (`partner_id NOT NULL`, unique
`(partner_id, app_identity_id, COALESCE(ring_id, zero-uuid))`).

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| partner_id | uuid NOT NULL FK → partners | |
| app_identity_id | uuid NOT NULL FK → software_app_identities | |
| ring_id | uuid FK → patch_policies | NULL = partner-wide blanket |
| status | varchar(16) | `approved` \| `blocked` \| `pending` |
| pinned_version | varchar(100) | optional hold |
| decided_by / decided_at / notes | | |

**Tenancy treatment:** register in `PARTNER_TENANT_TABLES`
(`rls-coverage.integration.test.ts`), policy `breeze_has_partner_access(partner_id)` (flat, no
tree traversal). No `org_id` → **no org-cascade entry and no export-policy entry required**
(CLAUDE.md: "A table with no org_id needs no entry"); partner deletion handled by the partner
cascade path like `patch_approvals`. Write routes gate on the same partner-scope authz as update
rings. This is deliberately **not** dual-ownership: an org-scoped Breeze customer (self-hosted
single-org) still has a partner row, so partner-scoped decisions degrade gracefully — the same
argument that made update rings pure partner-axis (spec 2026-06-21).

### 2e. No new execution tables

Phase-2 execution flows through the existing `patches` / `device_patches` / `patch_jobs`
pipeline (§5). Per-device staleness for Phase 1 is computed at read time
(`software_inventory` version vs `software_version_research.latest_version` via the org catalog
join) — no per-device table, no new agent write path, nothing new to cascade.

### Config-policy linkage

None in Phases 1–2. The catalog does not become a `PARTNER_LINKABLE_FEATURE_TYPES` entry:
execution rides the existing `patch` feature link (config-policy sources gate + ring dual
consent). If a later phase adds a linkable "software update settings" feature, it follows the
epic-#2135 playbook then.

## 3. Catalog lifecycle

**Discovery — no new agent collection for Phase 1.** A new BullMQ worker
`softwareCatalogReconcileWorker` (pattern: `cveEnrichmentWorker.ts` — singleton queue, system DB
context via `withSystemDbAccessContext`, `attachWorkerObservability`) runs daily per org
(staggered), reading only `software_inventory` (already refreshed every 15 min by the agent):

1. Aggregate distinct `(lower(trim(name)), lower(trim(vendor)), platform-from-device-os)` with
   device counts and min/max versions.
2. **Deterministic identity matching, in strict priority order:** (a) exact package-manager key —
   winget/brew/apt package ids are already present on `patches.package_id` rows for
   manager-installed apps, and macOS `installLocation` + Windows registry keys give bundle-path
   hints; (b) exact `(normalized_name, vendor)` against `platform_keys` patterns; (c) the CPE
   resolver's token-set logic (port of the Layer-B guardrail approach — deterministic, no fuzzy
   scores, misses are withheld not guessed). Confidence: (a)=`high`, (b)=`high`, (c)=`medium`.
3. Unmatched names get an identity-less org row (`identity_confidence='none'`) — these ARE the
   AI identity-resolution backlog, same "NULL rows are the unmatched log" trick as
   `software_product_resolutions`.
4. Upsert `org_software_catalog`; refresh rollups; stamp `last_seen_at`; rows unseen for 30 days
   → `retired_at` (kept for history, excluded from lists).
5. Enqueue version-research jobs for identities whose research row is missing or past
   `stale_after`.

**Cadence:** org reconcile daily; research TTL 7 days for deterministic sources, 14 days for AI
rows (matches SemoTech's "weekly reconcile"; both env-tunable).

**Dedup/normalization across platforms:** the identity row is the join point — "Google Chrome"
(HKLM DisplayName), `Google.Chrome` (winget), `google-chrome` (brew cask), `google-chrome-stable`
(apt) all map to one `software_app_identities` row via `platform_keys`. Seed the initial identity
set from the existing `third_party_package_catalog` (~curated winget rows, vendor + friendly name
+ homepage already present) plus a small vendored mapping fixture (FleetDM-style, MIT, with
attribution — same sourcing decision as the CPE spec).

**Confidence model (two independent axes, both surfaced in UI):**
- *Identity confidence* (is this inventory row really that app): high/medium/low/none per matcher
  above; AI-proposed identity links are always `medium` until a human confirms.
- *Version confidence* (is `latest_version` really the latest): `high` only from deterministic
  sources (winget manifest, brew JSON API, distro repo via the device's own patch scan, Sparkle
  appcast fetched from a signed feed URL, vendor CLI output); `medium` for AI research with
  corroborating evidence URLs; `low` for AI without corroboration.
- Effective confidence = min(identity, version). **Only `high` is ever eligible for
  auto-anything** (§6).

## 4. Version research

**Deterministic first, per platform:**
- **Windows:** winget — the agent's winget scan already reports available upgrades for
  manager-visible apps; for catalog-only apps, server-side lookup of the winget community
  manifest (static JSON, free). Chocolatey feed as secondary.
- **macOS:** brew — `formulae.brew.sh` JSON API (free, no auth) covers casks even for apps NOT
  installed via brew (a cask version is a valid latest-version signal for the same bundle id);
  Sparkle — fetch the app's appcast XML server-side; the feed URL (`SUFeedURL`) lives in the
  app's `Info.plist`, which requires a **small agent inventory addition** (read
  `SUFeedURL`/`CFBundleIdentifier` for each app path during the existing `system_profiler` pass —
  flagged as the one exception to "no new agent collection", Phase 1b); vendor CLIs — `msupdate
  --list` and `RemoteUpdateManager --action=list` run on-device via the new providers (§5) and
  are authoritative.
- **Linux:** no research needed — the distro repo already answers via the existing apt/yum patch
  scan; the catalog just links those `patches` rows to identities.

**AI fallback — `softwareVersionResearchWorker` (BullMQ):**
- Job unit: one `(app_identity_id, platform)`; enqueued only when every deterministic resolver
  missed. Runs in system context; **once globally, results shared across all orgs** via 2b.
- Implementation pattern: `catalogEnrichmentService.ts` — direct Anthropic SDK call with the
  server `web_search` tool, strict JSON-only contract
  (`{latestVersion, releaseDate, downloadUrl, publisher, evidenceUrls[], confidence, notes}`),
  parse-or-fail with `AI_PARSE`-style error codes, Sentry capture. Model: current Haiku tier
  (cheapest; this is extraction, not reasoning), id resolved via `resolveDefaultModel`-style
  helper, priced in `aiCostTracker.ts` `MODEL_PRICING`.
- Prompt inputs are ONLY identity-row fields (canonical name, vendor, platform, homepage) —
  never anything org-derived; this is the enforcement point for the shared-cache isolation
  contract in §2b.
- **Cost bounding:** research once per identity+platform, TTL re-research; per-run job cap
  (default 50/day) + hard daily token budget from env (`SOFTWARE_RESEARCH_AI_DAILY_BUDGET_CENTS`)
  tracked through `recordUsage` under a **platform-level system ledger, not per-org `ai_budgets`**
  — costs are shared, attributing them to the org that happened to trigger discovery is wrong and
  leaks tenant activity into billing rows. Kill switch env var. `failure_count` backoff →
  `unresolvable` after 3 attempts (re-tried monthly).
- **Never-auto-install-low-confidence rule, mechanically:** AI-sourced rows are capped at
  `medium` confidence *in the schema contract* (worker clamps), and §5's evaluator gate requires
  `high` — so AI results can, by construction, only ever produce report-level staleness and
  human-approvable suggestions, never an unattended install.

## 5. Update execution

**Phase 1 — detect/report only (no installs, no agent changes):** org catalog UI tab
(Software → Catalog): app list with identity/version confidence badges, outdated-device counts,
drill-down to devices, partner roll-up view, CSV export, optional alert rule ("new app appeared
in org", "app outdated > N days"). All value ships without touching install mechanics.

**Phase 2 — high-confidence auto-update via the EXISTING pipeline:**
- **New agent providers** implementing the existing `PatchProvider` interface
  (`agent/internal/patching/types.go:43` — `ID/Name/Scan/Install/Uninstall/GetInstalled`),
  registered in `defaults_darwin.go`:
  - `msupdate` — wraps `/Library/Application Support/Microsoft/MAU2.0/Microsoft AutoUpdate.app/
    Contents/MacOS/msupdate`; `Scan` = `--list` parsed to `AvailablePatch` rows; `Install` =
    `--install --apps <id>`. Follows the homebrew.go pattern for console-user execution quirks
    (msupdate must run as the console user, exactly the problem homebrew.go already solves).
  - `adobe_rum` — wraps `RemoteUpdateManager` (root, so simpler); `Scan` = `--action=list`;
    `Install` = `--action=install --productVersions=<sap>`.
- Their scans flow through the untouched agent→API patch ingestion (`routes/agents/patches.ts`)
  into `patches` (global dedup by `(source, external_id)`; `source='third_party'`, externalId
  namespaced `msupdate:<appId>` / `adobe_rum:<sap>`, provider in `metadata`) and `device_patches`
  (device-org-scoped) — the existing patch_catalog/device_patches split needs zero schema change.
- **Ring/policy composition:** they inherit the 2026-08-04 spec's dual-consent model verbatim —
  config-policy `sources` must include third-party (outer gate) AND the ring's `thirdPartyApps`
  toggle (ring consent). The catalog adds a third gate for catalog-derived candidates: a
  `software_catalog_approvals` row (`approved`, matching ring or blanket) with effective
  confidence `high`. Enforced in `patchApprovalEvaluator.ts` alongside the existing app
  block/pin rules.
- **Sparkle/direct-download installs are NOT in Phase 2.** Phase 2 auto-updates only
  provider-backed apps (winget/choco/brew/apt/yum/msupdate/adobe_rum). Direct-download apps stay
  report-only until a Phase-3 verified-download driver exists (download from research-evidence
  URL → hash + codesign/Team-ID verification → install via the Software Deployment execution
  path, reusing `software_versions`' checksum/detection-rules machinery).
- Windows per-user inventory (HKU enumeration under SYSTEM) lands as an agent inventory
  improvement in Phase 2; per-user *installs* (`winget --scope user` impersonation) are Phase 3+.

## 6. Safety

- **Verification:** provider-backed installs inherit each manager's own trust chain (winget
  hashes/signatures, brew checksums, apt/yum GPG, msupdate/RUM are vendor-signed channels) — no
  new verification surface in Phase 2. The Phase-3 direct-download driver requires expected hash
  + publisher signature identity (Authenticode subject / Apple Team ID) recorded in
  `software_version_research.evidence` at research time and verified on-device before install;
  mismatch = hard fail + alert, never fall through.
- **Confidence gate:** auto-approval requires effective confidence `high`; `high` is unreachable
  for AI-sourced versions and AI-proposed identities by construction (§3, §4).
- **Blast radius (the #3381 lesson applied):** any action that turns on catalog-driven
  auto-update for a scope (ring toggle + approval blanket) presents a **scope preview before
  commit** — device count, org count, exact app list, and what would install *today* — with an
  explicit typed confirmation for partner-wide blankets, mirroring what #3381 demands for
  allowlist mode. Approvals default per-app, not "approve all". Global kill switch
  (`SOFTWARE_CATALOG_AUTOUPDATE_DISABLED`) plus the existing per-source ring controls.
- **Audit:** `writeAuditEvent` (`services/auditEvents.ts`) on every mutation: identity
  create/merge, research result write (system actor), org-catalog tracking-status change,
  approval create/change/delete (with scope snapshot), every synthesized auto-approval, every
  install decision (already audited via patch jobs). Research rows keep `evidence` for
  after-the-fact "why did we think this was latest".

## 7. Phasing (PR-by-PR, each ships standalone value)

| PR | Contents | Effort |
|---|---|---|
| 1 | Tables 2a–2c + migrations/RLS/cascade/export registration + reconcile worker + deterministic matchers + seed from `third_party_package_catalog` | M (4–6 d) |
| 2 | Org catalog UI (read-only list, confidence badges, device drill-down) + partner roll-up view | M (3–5 d) |
| 3 | Deterministic version research (winget manifest + brew JSON + apt/yum passthrough) + staleness computation + outdated counts in UI | M (4–6 d) |
| 4 | AI fallback worker + platform budget ledger + kill switch + identity-suggestion review UI | M (4–6 d) |
| 5 | Agent providers `msupdate` + `adobe_rum`, **Scan-only** first (report through patches pipeline) | M–L (5–8 d, needs macOS fixtures/hardware) |
| 6 | Table 2d approvals + evaluator third gate + ring UI + scope preview/confirmation → **Phase 2 auto-update live** for provider-backed apps | M (4–6 d) |
| 7 | Sparkle: agent `SUFeedURL`/bundle-id collection + server appcast fetch → report-only staleness for direct-download apps | S–M (3–4 d) |
| 8+ | Windows per-user inventory; verified-download install driver; `mas` detection | later |

PRs 1–4 are pure API/worker/UI (no agent release); 5 and 7 ride the agent release train.

## Alternatives considered

- **Global curated every-app DB** — rejected. Unbounded curation cost (MacUpdater tracks ~10k
  apps with a paid team); Breeze's own curated table (`third_party_package_catalog`) works
  precisely because it is small and test-focused. Org-scoping bounds work to apps customers
  actually run; the global *identity* table grows organically to the union of real fleets, which
  is orders of magnitude smaller than "every app on earth".
- **MacUpdater-style licensed data bootstrap** — honestly assessed: it would give day-one Mac
  version coverage and high-quality Sparkle metadata, and SemoTech is right that it de-risks the
  research layer. Rejected as a core dependency for three reasons: (1) Breeze is self-hostable —
  redistributing licensed proprietary data to self-hosted instances is almost certainly
  contractually impossible, forking the product into cloud-only-accurate; (2) Mac-only, so the
  cross-platform identity/research machinery must exist anyway; (3) it substitutes for exactly
  the layer (2b) that is cheapest to build given deterministic sources + bounded AI. Viable
  later as an optional cloud-side enrichment source writing into `software_version_research`
  with `source='vendor_api'` — the schema accommodates it without redesign.
- **No catalog: just add vendor CLI drivers (msupdate, RUM, brew bootstrap)** — the cheap path
  (~PR 5 alone). It genuinely closes the two highest-value named gaps (M365 + Adobe ≈ the bulk
  of *managed-software* update pain) and should ship regardless — which is why it is PR 5, not
  an alternative. What it loses without the catalog: any answer for the Sparkle/direct-download
  long tail (typically 40–70% of the 60–120 apps `system_profiler` reports per Mac have no
  manager and no vendor CLI); no cross-platform unified app view or partner roll-up; no
  "outdated anywhere" reporting for unmanaged apps; no substrate for the phase-3 verified
  direct-download driver. It answers "update what we manage" but not SemoTech's actual ask,
  "know what's outdated across everything we see".

## 8. Advisor quorum outcome (2026-08-14)

Independent codex review (read-only, xhigh): **proceed with amendments.** Decisions 2 (org-scoped
catalog), 3 (partner-axis approvals), and 4 (reuse patch pipeline) confirmed. Accepted amendments,
to be folded into the PRs:

1. **Decision 1 amended — hybrid identity flow.** Direct global writes from reconcile are too
   trusting: org-scoped identity *proposals* first, promotion into the global tables only after
   deterministic validation or human curation. Global tables copy the CPE resolver's **forced
   system-only RLS** (`2026-07-08-vuln-product-resolutions.sql`), NOT the RLS-less
   `third_party_package_catalog` precedent this spec originally cited.
2. **Decision 5 overturned — enforce the confidence cap in the schema, not the worker.** DB CHECK
   (`source='ai_web_research'` ⇒ confidence ≠ 'high'), an `identity_match_source` provenance
   column on org rows, and an explicit patch→identity link + confidence inputs in
   `patchApprovalEvaluator` (today's `PatchCandidate` has neither). Snapshot effective confidence
   + research row version into the job/audit record at dispatch.
3. **Decision 6 overturned — re-order phasing fail-closed.** Corrections to this spec's claims:
   the agent carries provider identity in namespaced `externalId`/`packageId`, not
   `patches.metadata`; unknown providers map to `custom` (not `third_party`) in
   `mapPatchProviderSource`; and "PR 6 = auto-update live" was incoherent while PR 5 was
   scan-only. New order: capability/confidence gate first, then scan-only providers (explicitly
   registered, install methods present but refusing), then approvals + real install support
   shipping together.
4. **Version dimensions widened** where the source demands it: architecture, distro/release, and
   per-feed channel join the research key; `pinned_version` becomes per-platform. Version
   comparison must be source-specific; unknown formats withhold rather than guess.
5. **Sparkle PR 7 is a security boundary, not data collection.** Appcast signing is optional in
   Sparkle (archives are what's signed); `SUFeedURL` is untrusted device-supplied input. Server
   fetch needs HTTPS-only, redirect revalidation, private-address blocking, size/time limits, and
   evidence sanitization. Appcast URLs may be private/secret-bearing.
6. **AI research hardening:** deterministic BullMQ job IDs + atomic budget reservation (unique
   rows dedupe storage, not paid calls); inventory-derived prompt inputs treated as
   injection-bearing; evidence/download URLs never trusted for execution without the Phase-3
   verification chain.
7. **Identity merge semantics** need aliases, transactional conflict reconciliation with the
   `(org_id, app_identity_id)` unique key, and immutable merge history before any auto-merge.

**Pre-existing finding surfaced by the review (independent of this design):** the agent patch
ingestion upsert (`routes/agents/patches.ts`) lets any tenant's agent overwrite global `patches`
row metadata via `(source, external_id)` collision — being handled separately; PR 1 must not
widen that surface and the identity link must key on server-validated fields only.

## 9. Open questions for the owner

> **Recommended answers (Claude, 2026-08-14; owner to confirm/override):**
> 1. Platform-admin-gated curation until Phase 2; auto-created identities visible with confidence
>    badges but not editable by tenants (matches `third_party_package_catalog` governance).
> 2. Platform-level COGS budget, env-capped; self-hosted gates the AI fallback on
>    `ANTHROPIC_API_KEY` presence with its own cap — deterministic sources work without it.
> 3. Defer the Sparkle `Info.plist` agent read (PR 7) until Phases 1–3 prove out; it's the only
>    agent-side inventory change and nothing earlier depends on it.
> 4. Partner-only approvals for v1; add the org-exception overlay only on demonstrated demand.
> 5. Reap retired rows after 180 days; keeps history through a couple of quarters without
>    unbounded growth.
> 6. Let PR 5 (msupdate/RUM scan-only) lead — it is independent, closes the two highest-pain
>    gaps (M365 + Adobe on Mac), and per the quorum re-order must ship with the fail-closed
>    source-registration gate either way.
> 7. Seed top-50; grow organically from unmatched-row volume rather than curating speculatively.
> 8. Yes — invite SemoTech to the Phase-1 beta once the read-only catalog exists.

1. **Identity-table governance:** platform-admin-only curation UI (like
   `third_party_package_catalog` today), or accept AI/deterministic auto-creation with
   partner-visible confidence and no human gate until Phase 2?
2. **AI research spend:** confirm platform-level budget (absorbed as COGS, env-capped) vs any
   per-partner metering — the shared cache makes per-org attribution wrong, but self-hosters
   need their own Anthropic key and cap; is `ANTHROPIC_API_KEY`-present the feature gate for
   self-hosted AI fallback?
3. **Sparkle agent collection:** is the `Info.plist` read (PR 7) acceptable agent scope-creep
   for Phase 1b, or defer until after auto-update proves out?
4. **Approvals granularity:** is partner-scoped-only (2d) acceptable for v1, or do MSPs need
   per-org overrides ("approved everywhere except org X") on day one? (Schema extends via a
   nullable org exception table later; starting dual-granularity doubles evaluator complexity.)
5. **`retired_at` retention:** keep retired org-catalog rows indefinitely for history, or reap
   after N days (export-policy implications either way are handled)?
6. **Does PR 5 (msupdate/RUM Scan) ship before or after PR 1–3?** It is independent and
   arguably the highest immediate customer value; sequencing above assumes catalog-first per the
   issue's framing, but the drivers could lead.
7. **Seeding scale:** how large a vendored identity fixture do we want at launch (top-500 apps
   vs top-50)? Larger = better day-one match rates, more curation surface.
8. **SemoTech beta:** loop in the reporter for Phase-1 beta on the mixed Intel/AS fleet as
   offered?
