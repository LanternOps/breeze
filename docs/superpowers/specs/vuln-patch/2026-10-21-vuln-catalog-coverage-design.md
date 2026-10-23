# Vulnerability catalog coverage: design

**Status:** approved by Todd 2026-10-22 · **Date:** 2026-10-21
**Builds on:** `docs/superpowers/specs/vuln-patch/2026-07-08-vuln-displayname-cpe-resolver-design.md` (#2290)
**Related:** #2484 (degraded sync status), #7071 (remediation target version)

## 1. Why

A side-by-side run on one Windows lab machine compared Breeze against a commercial vulnerability scanner. Both read the same installed-programs list.

| | Open CVEs | Overlap |
|---|---|---|
| Commercial scanner | 221 | 1 |
| Breeze | 9 | 1 |

The scanner's findings came from ImageMagick (158), VS Code per-user install (20), Python 3.13 (16), Autodesk Fusion (8), Cursor per-user install (5), MongoDB (4), Node.js (4) and a few Microsoft apps. Breeze found none of these. Three of Breeze's own 9 findings are false positives from 2011 and 2015.

The gap is not detection method. The scanner did no file-level scanning here. The causes are in Breeze's matching pipeline, all verified in code on main:

1. **The catalog never grows.** `syncNvd()` in `apps/api/src/jobs/vulnerabilityJobs.ts` stores every changed CVE, but writes product match facts only for CPE vendor:product pairs already present in `software_products.cpe`. The NVD-usable rows come from `apps/api/src/services/__fixtures__/cpe-map.json`: 8 names, 7 products (Chrome, Firefox, Acrobat Reader, 7-Zip, Notepad++, Zoom, VLC). The MSRC sync also writes CPE values for Microsoft products, but in a form the NVD lookup does not key on. The July resolver design assumed the catalog "grows at runtime as NVD/MSRC feeds ingest". Nothing implements that. The curated name dictionary (`cpe-translations.json`) still holds its 15 starter entries. Node.js is in it, but resolves to nothing because no Node.js catalog row exists.
2. **Pinned and N/A versions become "all versions".** `cpePrefix()` in `apps/api/src/services/nvdClient.ts` keeps only `part:vendor:product`. A criteria of `cpe:2.3:a:mozilla:firefox:38.0:...` or `cpe:2.3:a:google:chrome:-:...` with no range fields becomes an unbounded range. That is how CVE-2011-3389 (BEAST) and CVE-2015-1239 land on current Chrome.
3. **Version strings are compared naively.** `segments()` in `apps/api/src/services/versionCompare.ts` splits on dots only. ImageMagick's NVD version `7.1.1-29` compares as `7.1.1`. Windows DisplayVersion formats also differ from upstream versions for some products.
4. **Per-user installs are probably invisible** (inferred from code, not confirmed on a device). `agent/internal/collectors/software_windows.go` reads HKLM plus `CURRENT_USER`. The agent runs as a SYSTEM service, so `CURRENT_USER` is SYSTEM's hive. User-scope installs of VS Code, Cursor, Chrome, Zoom, Slack and similar never reach inventory.

Todd's framing: this needs to keep itself current, not be a one-off cleanup.

## 2. Goals

1. Any Windows application that NVD describes with a CPE can be matched, without a code change per product.
2. NVD version semantics are respected: pinned versions match exactly, N/A versions do not match, and vendor version formats compare correctly.
3. Coverage is visible. Operators can see which installed program names resolve to nothing, ranked by how many devices have them.
4. Coverage maintains itself. New products enter the catalog from fleet demand. The curated dictionary refreshes on a schedule.
5. Accuracy is measured against a reference on every release, so regressions are caught.

## 3. Non-goals

- **macOS application matching** (builder's call, open to Todd's override). The macOS collector reports vendor as "Identified Developer", "Mac App Store" or "Apple" (`agent/internal/collectors/software_darwin.go`). The resolver requires vendor agreement, so macOS apps would need new agent data, such as the bundle or team ID, before matching can work. That is a follow-up.
- **Per-user Windows inventory** (Todd, 2026-10-22). It needs a server ingest redesign plus agent work, so it moves to its own follow-up spec. The notes in §5.6 are input for that spec, not part of this build.
- **File-level or on-disk binary scanning.** Todd's call: a vulnerable file that isn't an installed, runnable product is mostly noise.
- **Linux distro packages.** Backport-aware matching against distro advisories (OSV distro ecosystems) is separate work.
- **Unauthenticated network scanning** of printers, firewalls and other unmanaged devices.
- **Feeds beyond NVD and MSRC.** CVE.org records, CISA Vulnrichment and direct vendor advisories are a follow-up for NVD's enrichment backlog.
- **Prioritization changes.** Risk score, EPSS and KEV handling stay as they are.

## 4. Anti-goals

These would make the work a failure even if it technically ships:

- **A flood of low-confidence findings.** The resolver's rule stays: withhold a match rather than guess. More findings is not the goal. More correct findings is.
- **An alert storm on rollout.** Expanding the catalog creates many findings at once on existing devices. Each new Critical finding currently fires `vulnerability.critical_detected`. Partners must not receive hundreds of alerts the day this ships.
- **Findings that flap.** A user logging off must not mark that user's apps as uninstalled and their findings as "patched".
- **Runtime dependence on GitHub** for self-hosted instances. Dictionary data ships with releases.
- **Loading offline users' registry hives** on customer machines. Loading `NTUSER.DAT` as SYSTEM can collide with that user's next logon.

## 5. Design

### 5.1 Catalog growth, driven by fleet demand

The catalog grows from what the fleet actually has installed, not from all of NVD.

- **Candidate dictionary.** A global table mirrors NVD's CPE product dictionary for application-type (`part = a`) entries, deduplicated to vendor:product. It keeps titles, deprecation links and `target_sw`. It is seeded once from the NVD products API and kept current by a delta sync on its last-modified date. Products with no CVEs stay in the table. They can never produce a finding, but they matter as competitors: without them, an ambiguous name like "Fusion" could confidently match the wrong vendor.
- **Library ecosystems are excluded.** CPEs whose `target_sw` names a language or plugin ecosystem (for example `node.js`, `python`, `wordpress`) describe packages, not installed programs. They stay out of the candidate set, so a DisplayName like "Python 3.13" cannot fuzzy-match a Python library.
- **Resolution.** The resolver searches the candidate dictionary with its current layers: curated dictionary, exact name or title, then guarded token match. The resolver stays pure. The caller passes the candidates in. Two guardrails tighten because the candidate set grows by orders of magnitude:
  - The exact-name layer also requires the publisher to agree when one is present. Today only the dictionary and token layers check it.
  - A token match must cover the product's distinctive tokens and must beat every other candidate. A tie, or a near tie, withholds the match.
- **Cached resolutions are revisited** when the candidate dictionary changes, not only when the resolver version changes. Today a settled match stays settled until the version bumps (`cpeResolution.ts`).
- **Promotion and backfill.** When a fleet name first resolves to a candidate, that candidate becomes a `software_products` row with its CPE, and a backfill job is queued. Backfill fetches the product's full CVE history once from the NVD API by vendor:product (`virtualMatchString`). It writes `vulnerabilities` rows and match facts through the same parse path as the daily sync. Backfill state lives on the product: pending, done or failed, with a timestamp. Backfill is deduplicated globally, so many organizations installing the same app trigger one backfill. After backfill, the deltas that overlapped it are replayed from an activation watermark so nothing slips between the two.
- **Steady state.** After backfill, the daily delta sync keeps the product current. It already writes facts for every `software_products` row that has a CPE.
- **The delta sync must catch up.** Today it always fetches a fixed one-day window ending now, so a missed day is lost for good (`syncNvd()` in `vulnerabilityJobs.ts`). It changes to resume from the last successful window end, using the existing source cursor, capped by NVD's 120-day window limit. This overlaps #2484.
- **Correlation** treats a product whose backfill isn't done as unmatched for reporting (§5.4), and produces no findings from partial history.

### 5.2 NVD version semantics

- A criteria with a specific version and no range fields becomes an exact-version fact (start and end both inclusive at that version).
- A criteria whose version is `-` (not applicable) produces no fact.
- A criteria whose version is `*` with no range keeps today's meaning: all versions. NVD uses this deliberately.
- The parser keeps the rest of the criteria: `target_sw`, edition and the configuration's AND logic, such as "Firefox running on Windows". Matching uses them where inventory can answer and stays conservative where it cannot.
- Fact de-duplication includes the start bounds. Today two facts that differ only in their start version collapse into one.
- Existing facts cannot be fixed from stored data. `raw_payload` holds the already-parsed record, with the version already dropped. Fixing them needs an NVD refetch of the affected products' CVEs, which shares the backfill path in §5.1.
- Facts are insert-only today. Re-deriving a product's facts must replace its old facts, not add to them.
- Existing findings that no longer match must leave the open list without being recorded as `patched`, because nothing was patched. Today the correlation pass would mark them `patched` and emit `vulnerability.remediated` (`vulnerabilityCorrelation.ts`). That changes before the version fix ships. They close as "withdrawn" (§8).

### 5.3 Version normalization

- Version comparison handles common vendor separators, so `7.1.1-29` compares as four segments.
- A small per-product normalizer maps Windows DisplayVersion to the upstream version where they differ. The builder confirms each case against real installs before adding it. Python's installer is the expected first case: its DisplayVersion appears to encode micro version and release level in one segment (unverified).
- When a version cannot be normalized with confidence, the match is withheld and counted in the coverage report (§5.4), not guessed.

### 5.4 Coverage visibility

- An **unmatched-names report** lists installed program names that resolve to no product, ranked by device count, with vendor and a sample version. It reads `software_product_resolutions` rows with no product, joined to `software_inventory`.
- A second list shows names that resolved to a product whose history backfill is still pending or failed.
- A **coverage figure** is the share of installed-program instances, weighted by device count, that resolve to a product with facts. It is tracked over time.
- Resolving an unmatched name is normally a one-line curated dictionary entry, shipped through a PR.

### 5.5 Dictionary refresh

- A scheduled GitHub Action runs `apps/api/scripts/regen-cpe-data.ts` weekly and opens a PR when FleetDM's translation list has changed. A human reviews and merges it. Self-hosters get the update with the next release.
- Curated entries added by hand survive regeneration. The script already unions them.

### 5.6 Per-user installs on Windows: input for the follow-up spec

Not built here (see §3). Kept so the follow-up starts from what the reviews found.

- The collector enumerates the Uninstall key in every **already-loaded** user hive under `HKEY_USERS`. It skips the built-in service SIDs and `_Classes` hives. It never calls `RegLoadKey`.
- Each per-user item records which user it belongs to.
- The agent's de-duplication key gains the owning user, so the same app installed for two users stays as two items.
- When a user isn't logged on, their hive isn't loaded. The server must treat that user's apps as "not observed", not "uninstalled", and keep their last-seen rows.
- **This needs a server ingest change, not just agent work.** Today any failed source makes the whole report `partial`, the server rejects partial reports, and an accepted report deletes and reinserts the device's whole inventory (`softwareInventoryObservations.ts`). Per-user inventory needs replacement scoped to what was actually observed: the machine scope plus each loaded user. It also needs a retention rule for profiles that never log on again.
- This is agent code that ships to customer machines. It needs a Windows lab leg before promotion, with two user profiles where one is logged on and one is not.

### 5.7 Ground-truth harness

- A committed fixture holds one lab machine's inventory (program name, vendor, version), the public NVD records for the relevant products, and an expected CVE list. The expected list is Breeze's own triaged judgement, checked against NVD. It contains no hostnames, IPs or customer data.
- The commercial scanner's raw export is not committed, since its terms may not allow publishing. It stays in the gitignored `internal/` directory and is used for the manual comparison below.
- An offline test runs the resolver and matcher over the fixture and reports recall and precision against the reference. It fails if either drops below the recorded baseline.
- Disagreements are triaged into three kinds: a Breeze miss, a reference false positive, or a version-format problem. The baseline is updated only with that triage written down.
- A manual lab re-run against a fresh commercial scan happens before each release that touches matching.

## 6. Rollout

1. The "withdrawn" status (§8), then version semantics and normalization (§5.2, §5.3), ship first. They only remove noise.
2. The coverage report (§5.4) ships next, so the gap is visible before it closes.
3. Catalog growth (§5.1) ships behind an environment flag, off by default. It is enabled per region after the harness passes.
4. **Alert handling for backfill.** Every product promotion backfills years of history against software that is already installed, so this is not a one-time burst. Findings created by a backfill or a fact re-derivation do not emit per-finding `vulnerability.critical_detected` events. Each backfill run emits one summary event per organization instead, naming the product and the finding count. Webhooks, PSA tickets and automations that hang off the per-finding event are therefore quiet too. The builder confirms which consumers subscribe to that event. Findings from new CVEs in the daily delta keep per-finding events.
5. The harness (§5.7) and the dictionary refresh Action (§5.5) can land at any point.

## 7. Constraints

- New global tables are system-only: RLS enabled, forced, and a system-scope policy in the same migration, registered as intentionally unscoped. They carry no `org_id`, so no cascade or export registration applies. See `docs/agents/tenancy-rls.md`.
- Migrations follow `apps/api/migrations/README.md`: named after the newest committed migration, idempotent, and electing system scope before writing rows.
- History backfill needs `NVD_API_KEY` in production. NVD's keyed limit is about 50 requests per 30 seconds. Backfill is rate-limited, resumable and idempotent.
- The resolver stays pure: no database or network access in `cpeResolver.ts`.
- Self-hosted instances without an NVD key still work, just more slowly.

## 8. Decisions (Todd, 2026-10-22)

1. **Findings that no longer match close with a new terminal status, "withdrawn".** It is auditable and stays out of remediation, SLA and patch metrics. It must not emit `vulnerability.remediated`. Status enum, filters, reports and events are updated to match. This lands before or together with the version fix in §5.2.
2. **Per-user Windows inventory becomes its own follow-up spec** (§3, §5.6).
3. **The coverage report (§5.4) is visible to platform and self-host instance admins only.** No per-partner view for now.

## 9. Calls made by the author, accepted by Todd

- macOS matching is a non-goal for now (§3), because its vendor data can't support matching.
- The candidate dictionary mirrors all of NVD's application products, not only those with CVEs (§5.1), following the independent Codex review.
- Backfill-created findings send one summary per organization instead of per-finding Critical events, on every promotion (§6).
- The commercial scanner's export stays out of the public repo. The committed fixture uses Breeze's own triaged expectations (§5.7).
- The dictionary refresh runs as a weekly bot PR, not a runtime fetch (§5.5).

## 10. Left to the builder

- Table and column shapes, job names and queue placement.
- Which products get version normalizers beyond the examples, decided from the harness and the coverage report.
- Layout of the coverage report page.
