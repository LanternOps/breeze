---
tracking_issue: LanternOps/breeze#6263
---
# YARA IOC Scanning W04: Detection rules UI, IOC import, test upload, rule-set picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tech can manage detection rules from the web app: list and edit rule sets with inline
compile errors and an honest publish outcome, paste an advisory's IOCs and get valid rules, test a
file against a set before it reaches devices, attach sets to a Config Policy, and see which rule fired
on a threat.

**Architecture:** Two PRs. **PR A (API + shared + `breeze-yarac`)** adds three routes on top of W03's
`/security/yara` CRUD: a set-scoped IOC import that re-generates rules server-side from structured
IOCs with a pure generator in `packages/shared` (so the browser preview is byte-identical to what is
saved), an API-side test upload that runs a new in-memory `breeze-yarac match` subcommand outside any
DB transaction, and a read-only threat details view over the `security_threats.details` the agent already
reports. **PR B (web)** adds the Detection rules page, the set editor, the importer and test panels,
the Security tab picker and the ThreatDetail "Rule" panel. No new table, no migration, no agent wire
change, no new agent version gate.

**Tech Stack:** Hono, Zod, Vitest (unit + Integration Tests), Go (`agent/cmd/breeze-yarac`,
`agent/internal/yarascan`), React islands in Astro, react-i18next (8 locales).

**Spec:** `docs/superpowers/specs/security-auth/2026-09-18-yara-ioc-scanning-design.md` §7 (test
upload ≤ 10 MB, IOC import), §8 (Detection rules page, owner badge, editor, picker, ThreatDetail rule
panel), §9 (matched strings 10 × 128 B, redaction), §11 (copy rule), §14.1 (compile on the agent;
the server pre-checks with `breeze-yarac`). **W03 as built is binding:** plan
`docs/superpowers/plans/security-auth/2026-10-13-yara-ioc-scanning-w03-rule-sets.md` and the code in
`apps/api/src/routes/security/yara.ts`, `apps/api/src/services/yaraRuleSetPublisher.ts`,
`apps/api/src/services/yaraPrecheck.ts`, `apps/api/src/routes/configurationPolicies/securityRuleSetGate.ts`.
Index: `docs/superpowers/plans/security-auth/2026-09-18-yara-ioc-scanning.md` (Open Decision 10).

---

## Global Constraints

- **Starts after W03a (#9156) and W03b (#9161) are on `main`** — both are. PR A branches
  `feature/6263-yara-ioc-scanning/wave-6267` from fresh `origin/main`; PR B branches
  `feature/6263-yara-ioc-scanning/wave-6267-b` from `main` **after PR A merges** (never stacked: a
  PR whose base is not `main` gets no CI). PR bodies: `Part of #6263`, `Refs #6267`; only the last PR
  carries `Closes #6267`.
- **No new table and no migration.** Every field W04 needs exists: `yara_rule_sets`, `yara_rules`
  (W03 migration `2026-12-30-230000-yara-rule-sets.sql`), `security_threats.details` jsonb,
  `security_scans.rule_set_errors`. If an implementer finds they need one, stop: it needs a tenancy
  shape, the four registrations (`CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`,
  `CORE_TENANT_EXPORT_POLICY`, device/ticket lists if applicable), and the slot
  `apps/api/migrations/2026-12-31-140000-<slug>.sql` (sorts after today's newest,
  `2026-12-31-110000-restore-point-skipped-no-mutation.sql` — re-check at implementation time).
- **No agent wire change.** The threat object already carries `ruleName`, `ruleSetId`, `ruleId`,
  `tags`, `matchedStrings`, `sha256`, `quarantinedTo` (`agent/internal/security/threats.go:20-45`) and
  the ingest stores it as `details: redactSecretsDeep(threat)` (`apps/api/src/routes/agents/helpers.ts`,
  `handleSecurityCommandResult`). So no `MIN_AGENT_VERSION_*` gate. The `breeze-yarac` and
  `yarascan` changes in Task A3 run only in the API image; agents carry the new helper as unused code.
- **Do not edit `agent/internal/yarascan/yarac/yarac.go`.** It is an input of the built-in pack lock
  (`scripts/security/yara-pack/build-pack.sh` `EXTERNAL_INPUT_FILES`); touching it forces a
  `pack.lock` bump. `matcher.go`, new files in `yarascan`, `yarac_test.go` and `cmd/breeze-yarac` are
  not lock inputs.
- **Server never trusts client-sent rule text from the importer.** The import route takes structured
  IOCs and re-generates; the only rule text a client can send is through W03's own rule routes.
- **Writes keep W03's gates exactly:** built-in set → 403; `canMutateOrgWideGovernance` (site
  ceiling); partner-wide set → `canManagePartnerWidePolicies`; role `devices:write`. Reuse W03's
  `writeDenial` — do not re-implement it.
- **Every rule change publishes in the same request transaction** through `publishRuleSet` and returns
  W03's `publish` body. A 2xx with `publish.published === false` is an unpublished edit.
- **Copy rule (spec §11):** UI strings say "IOC scan", "detection rules", "threat hunting",
  "malware scan (signature-based)". Never "EDR", "antivirus", "real-time protection", "prevention".
- **Web:** every mutation through `runAction` (`apps/web/src/lib/runAction.ts`; guard
  `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`); transient UI state in
  `window.location.hash`; `data-testid` on every interactive element; every new key in all **8**
  locale dirs (`apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}`), checked by
  `apps/web/src/lib/i18n/localeParity.test.ts`.
- **Caps (exact values):** sample ≤ 10 MiB (`YARA_TEST_SAMPLE_MAX_BYTES = 10 * 1024 * 1024`); IOC
  batch ≤ 1000 IOCs, IOC text body ≤ 256 KiB, IOC string value 4–256 UTF-8 bytes, label ≤ 64 chars;
  generated rule source ≤ 60 KiB (under W03's 64 KiB `YARA_MAX_RULE_SOURCE_BYTES`); set ≤ 500 rules
  (`YARA_MAX_RULES_PER_SET`); policy ≤ 20 sets (`YARA_MAX_RULE_SETS_PER_POLICY`); matched strings ≤ 10
  per match, each ≤ 128 bytes before escaping.
- **Verification:** `tsc --noEmit` with `NODE_OPTIONS=--max-old-space-size=12288` and the exit code
  read directly (never piped to `tail`). Scoped Vitest runs per `docs/agents/testing.md` (never
  `pnpm --filter <pkg> test -- --run <path>`). `pnpm test` runs none of the integration suites — run
  them on a per-worktree test stack and tear it down.

## Review Focus

1. **An unpublishable edit toasts "Saved".** The rule PATCH answers 200 with `published: false`;
   `runAction` would show the `successMessage` for any non-failure body. Expected: a warning, an
   inline banner, per-rule errors, never a success toast. Pinned in Task B2 (`describePublishOutcome`
   table test + editor test).
2. **IOC text that YARA rejects or that over-matches.** A 2-byte string fails `ErrorOnSlowPattern`; a
   Windows path with backslashes, a quote, or non-ASCII must be escaped; a defanged `evil[.]com` must
   become `evil.com`. Expected: per-line errors before save, and the saved rule compiles. Pinned in
   Task A1 (generator unit tests) and Task A3 (Go test compiling the golden fixture with the real policy).
3. **A crafted test upload reaches the API container, pins a DB connection or exhausts memory.**
   Expected: the scanning child cannot open any file (Landlock) and is the OOM victim, not the API;
   no request transaction is held across it; one test at a time per API instance, admitted before the
   body is read; a busy instance answers 429. Pinned in Task A3 (sandbox test), Task A4 (admission,
   release-after-exit, self-managed route) and Task A6 Step 4 (sandbox applies in the real image).
4. **A stale or foreign rule-set id already saved in a policy.** The gate rejects saving it again.
   Expected: the picker shows it as unavailable with a remove control and blocks save with an
   explanation — it never silently drops it and never loops on a 400. Pinned in Task B5.
5. **Threat details view leaks across sites or orgs.** A site-restricted tech opens a threat id from
   another site. Expected: 403, same as the quarantine path. Pinned in Task A5.

---

## Decisions this plan makes

Quorum: Claude position + Codex `gpt-6-astra` xhigh read-only, 2026-10-18. Outcome recorded in
§Quorum record at the end of this plan.

**W04-1 IOC importer.**
- Kinds `md5 | sha1 | sha256 | filename | filepath | domain | ip | string`. Registry keys, mutex
  names, URLs and anything unclassified are `string`.
- Input: one IOC per line (`#` comments and blank lines skipped), optional `kind:value` prefix to
  override classification, or a JSON array of strings or `{ kind, value }` objects. A prefix
  applies **only** when the text before the first `:` is exactly one of the eight kind names
  (case-insensitive); otherwise the whole line is the value. So `C:\Users\…`, `2001:db8::1`,
  `http://…` and `nope:x` are values, never prefix errors.
- Classification order: 32/40/64 hex → md5/sha1/sha256; `HK…\` → string; drive letter, leading `/`,
  or UNC `\\` → filepath; dotted-quad or IPv6 → ip; `name.ext` whose extension is in
  `YARA_IOC_FILE_EXTENSIONS` (`exe dll sys scr bat cmd ps1 psm1 vbs vbe js jse wsf hta lnk msi
  jar bin sh py elf so dylib docm xlsm pptm iso img zip rar 7z`) → filename; other domain-shaped
  values (labels + alphabetic TLD, no separators) → domain; everything else → string. `com` is
  deliberately not in the list: `evil.com` is far more often a domain than a DOS executable. The
  preview shows every classification as an editable select, so the user fixes ambiguity (`.zip` is
  also a TLD) before saving; a `kind:value` prefix does the same in pasted text.
- Refang before classification: `[.]`, `(.)`, `{.}` → `.`; `hxxp` → `http`; `[:]` → `:`.
- Generation: **one rule per kind per batch**. IOCs are **sorted by canonical value first**, then
  packed into rules of at most 60 KiB of source (`_2`, `_3`, …), so chunk boundaries do not depend on
  paste order. Per-IOC rules would hit the 500-rule cap after one advisory and gain little: the
  threat already shows the matched string or the file's sha256.
  - hashes: `import "hash"`, condition `hash.<algo>(0, filesize) == "<lowercase hex>" or …`
    (compiles under the W02 policy — verified by the quorum against the real binary, and pinned by
    Task A3's golden test);
  - filename / filepath: condition `filename iequals "<escaped>"` / `filepath iequals "<escaped>"`
    (the externals W02's policy allows; `iequals` compiles under the policy);
  - domain: `$i<n> = "<escaped>" ascii wide nocase` (domains are case-insensitive, matching the
    case-insensitive dedupe);
  - ip and string: `$i<n> = "<escaped>" ascii wide` (case-sensitive);
  - **non-ASCII values** (string kind only — domains are ASCII/punycode, IPv6 is canonicalised to
    compressed lowercase): `ascii wide` over UTF-8 escapes would not match UTF-16
    text, so they become two patterns — `$i<n>` = the UTF-8 bytes as an escaped text string
    (no `wide`) and `$i<n>w` = a hex string of the UTF-16LE bytes; condition stays `any of them`.
  - Escaping: `\` → `\\`, `"` → `\"`, every UTF-8 byte outside `0x20–0x7e` → `\xNN`.
  - No timestamp or random value anywhere in the source (preview must equal saved).
- A **4-byte minimum** for string values is a false-positive floor, not YARA's slow-pattern
  threshold (the quorum showed `"ab"` compiles and four NUL bytes do not). The pre-check stays the
  authority: a value that passes the generator but fails `ErrorOnSlowPattern` comes back as a
  compile error on that rule, and the publish-outcome UI shows it.
- Name: `ioc_<slug(label), ≤ 64>_<kind>_<fnv1a64hex(\n-joined sorted canonical values), 16 hex>[_<n>]`,
  ≤ 128 chars total, matching `YARA_RULE_NAME_PATTERN`. Tags `['ioc', <kind>]`. Meta:
  `source = "breeze-ioc-import"`, `label = "<escaped label>"`, `ioc_count = <n>`.
- Dedupe: within a batch (hashes lowercased; filename, filepath and domain compared
  case-insensitively; strings and ip exact). Across batches: the deterministic name collides on
  `yara_rules (rule_set_id, name)`. On a collision the route compares the stored `source` with the
  generated one: identical → 409 `IOC_BATCH_ALREADY_IMPORTED`; different (a hash collision or a
  hand-edited rule) → 409 `IOC_RULE_NAME_TAKEN` with the name. A batch that overlaps an earlier one
  only partly is not deduped (documented in the importer help text).
- **Concurrency:** the route locks the set row (`SELECT … FOR UPDATE` under the caller's RLS) before
  counting rules, so two concurrent imports cannot both pass the 500-rule check. (W03's single-rule
  create counts before `publishRuleSet` takes that lock — the same race; follow-up below.)
- **Cost:** a hash IOC makes every scanned file (≤ `maxFileSizeMb`) be hashed in full, matching or
  not. Task A3 benchmarks it; the importer shows a one-line note on hash imports.
- Generation is a pure, browser-safe function in `packages/shared` used by both the preview and
  the route. The route takes **structured** IOCs (`{ kind, value }[]`), re-validates each with the
  same shared validator and re-generates. It never accepts rule text. Accepting structured IOCs
  rather than raw text keeps the user's kind overrides from the preview authoritative.
- Route: `POST /security/yara/rule-sets/:id/ioc-import` (set-scoped, like `/rules` and `/test`).
  The spec's `POST /yara/ioc-import` with the set id in the body is the same operation; the
  set-scoped path keeps the `writeDenial` lookup identical to W03's rule routes. The UI creates a
  new set first through W03's create route when the user picks "New rule set".
- Spec §7 lists "hashes, filenames, strings"; domains and IPs are strings with their own kind so
  the preview and tags say what they are. Severity defaults to `high`, the W03 default.

**W04-2 Test upload.**
- Runs **API-side**, not on an agent: instant feedback, the sample never reaches a customer device,
  and no device has to be online. The API image already ships `/usr/local/bin/breeze-yarac`.
- New subcommand `breeze-yarac match --filename <name> [--filepath <virtual path>]`. Stdin is
  framed: 4-byte big-endian bundle length, the bundle JSON, then the sample bytes to EOF. It
  compiles the bundle with the agent's own policy and scans the sample **in memory** (`yaraxwasm`
  `Scanner.Scan([]byte)`, which copies the bytes into guest memory). The sample is never written to
  disk on the API host. `filename`/`extension` come from `--filename`; `filepath` from `--filepath`
  (a path the tech types to emulate where the file would sit on a device, e.g.
  `C:\Users\Public\Downloads\x.exe`), defaulting to the filename — device scans set them differently
  (`agent/internal/yarascan/matcher.go` `ScanFile`), so path-based rules need it.
- **Containment (the quorum's main correction).** `yaraxwasm` hard-codes a WASI mount of host `/`
  into the guest (`runtime_client.go:252` @ v1.1.0) and the child runs as the API's own user, so
  "env is PATH only" is not containment: an engine bug triggered by a crafted sample could read the
  API container's files, including `/proc/<api pid>/environ`. `match` therefore, after reading stdin
  and before initialising the engine:
  1. writes `1000` to `/proc/self/oom_score_adj` (raising it needs no privilege), so a container
     OOM kills the test child, never the API;
  2. sets `PR_SET_NO_NEW_PRIVS`;
  3. applies a **Landlock** ruleset that handles every filesystem access right and allows no path
     (and, at Landlock ABI ≥ 4, every TCP bind/connect right with no port allowed), via
     `golang.org/x/sys/unix` (already in `agent/go.mod`, v0.49.0 — no new dependency). The engine
     needs no file: the guest wasm is embedded;
  4. installs a **seccomp-bpf deny filter** (`SECCOMP_RET_ERRNO(EPERM)`) for `socket`, `socketpair`,
     `connect`, `bind`, `ptrace`, `process_vm_readv`, `process_vm_writev`, `kcmp`, `execve`,
     `execveat`, using `unix.Prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, …)` with a hand-built BPF
     program (no new dependency). Landlock does not cover UDP / unix sockets or cross-process reads
     of the same-uid API process; this does. The filter must be installed after the Go runtime has
     started its threads and use `SECCOMP_FILTER_FLAG_TSYNC` so it applies to every thread.
  If Landlock is unavailable (non-Linux, old kernel, blocked by seccomp) `match` exits 3
  `sandbox_unavailable` and the route answers 503 `YARA_TEST_SANDBOX_UNAVAILABLE` — **fail closed**.
  Dev escape hatch: `BREEZE_YARA_TEST_UNSANDBOXED=1`, honoured only when `NODE_ENV` is
  `development` or `test` (same rule as `yaraLintOnlyAllowed()`), so macOS dev boxes can run it.
  The guest has no WASI socket configuration and the Go host has no network code, so there is no
  network egress path even before Landlock's TCP rule.
- **Memory.** `GOMEMLIMIT` is a soft GC target, not an RSS ceiling, and is not relied on. What bounds
  memory: one `match` at a time per API instance, which also takes a slot of W03's shared yarac gate
  (so at most two engines — validate or match — ever run at once), a 10 MiB sample, and the OOM
  preference above. Task A4 records the child's peak RSS testing the 500-rule built-in pack with a
  10 MiB sample on linux/amd64; **if it exceeds 1 GiB, stop and escalate** before shipping.
- **Admission before buffering.** The route try-acquires both slots *before* reading the body. No
  slot → 429 `YARA_TEST_BUSY` at once; a 10 MiB body is never buffered just to wait. The shared
  gate gains a non-queueing `tryAcquireYaracSlot()` (W03's `acquire()` queues forever, which is fine
  for publishes and wrong here). Slots are released when the child has **exited** (`close`), not when
  the timeout fires. A client disconnect (`c.req.raw.signal`) kills the child.
- Matched strings go through the same caps and escaping as on-device scans: a new
  `yarascan.ScanSample` shares `collectStrings`, refactored to read from an `io.ReaderAt`.
- What is tested: the set's **current enabled rules** — the draft the author just edited. Phase 1
  reads the set's `current_version` and its enabled rules in **one SQL statement** (`yara_rule_sets`
  `LEFT JOIN yara_rules … AND enabled`), so both come from one snapshot even under READ COMMITTED:
  every rule mutation bumps `current_version` in the same transaction as the rule write. Not
  `FOR SHARE`: a locking read needs the row to pass the UPDATE policy, so RLS would hide the
  read-only built-in and partner-wide sets from an org user (W03's publisher relies on exactly that,
  `yaraRuleSetPublisher.ts` step 1) and the test would 404. The bundle is built with
  `buildYaraBundleJson` at `version = max(currentVersion, 1)` (`DecodeBundle` rejects version 0,
  `agent/internal/yarascan/bundle.go`). When the draft does not compile, the route answers 422
  `YARA_TEST_COMPILE_FAILED` with the compile errors and runs no scan. The response carries
  `testedVersion`, `publishedVersion` and `testedDigest` (sha256 of the bundle bytes tested).
  Built-in sets test their stored rules.
- Caps: body ≤ 10 MiB (new body-limit rule `yara-test-sample`, 10 MiB + 64 KiB); child timeout 20 s;
  engine per-scan timeout 15 s; child env `PATH` only. Per-user rate limit
  `userRateLimit('yara-rule-test', 10, 600)`.
- Transport: `Content-Type: application/octet-stream`; `filename` (basename, ≤ 255 chars) and
  optional `filepath` (≤ 1024 chars) as query parameters. No multipart parsing.
- DB: the route is registered in `SELF_MANAGED_DB_CONTEXT_ROUTES`. Phase 1
  `withAuthDbAccessContext` (short) loads the set and rules; phase 2 runs the child outside any
  transaction; phase 3 writes the audit. A 20 s child inside the request transaction would pin a
  pooled connection idle-in-transaction (#1105).
- Tenancy: any set the caller can **see** — own orgs, own partner's partner-wide sets, the built-in
  pack — with `devices:write`. No partner-wide or site-ceiling gate: the route writes nothing and
  reaches no device. An org user may test their MSP's partner-wide set (they can already read its
  source, per W03).
- Response: `{ data: { sha256, size, filename, filepath, durationMs, testedVersion, publishedVersion,
  testedDigest, matches: [{ ruleId, ruleName, severity, tags, matchedStrings: [{ id, offset, data }] }] } }`.
  Matched strings are capped by the engine and run through `redactSecretsDeep`, as at ingest.
- Audit `security.yara_rule_set.test` with set id, sample sha256, size and match count — never the
  filename, the bytes or matched strings.

**W04-3 Editor publish contract — no `runAction` change, no API change.** `runAction` already takes
`successMessage` as a function typed `(data: T) => string`, and shows a toast only when the result is
truthy (`if (msg)`). The editor passes `publishSuccessMessage`, which returns the success copy **only**
for the success row below and `''` otherwise; the caller then shows one `warning` toast plus a
persistent inline banner. States, from `describePublishOutcome(publish, set)`, **evaluated top to
bottom, first match wins**:

| # | Condition | Tone | Copy key (`security:detectionRules.publish.*`) | Inline |
|---|---|---|---|---|
| 1 | no `publish` key (metadata-only PATCH: name, description) | success | `saved` ("Saved") | — |
| 2 | `autoQuarantineOnly` (may coexist with `precheckUnavailable` or errors) | warning | `autoQuarantineOnly` ("Auto-quarantine is off on devices now. Your other changes are not live yet.") + the row-4/5/6 reason as a second line | per-rule errors if any |
| 3 | `published && !stale && set.enabled` | success | `published` ("Saved and published as version {{version}}") | clear errors |
| 3b | `published && !stale && !set.enabled` | success | `savedDisabled` ("Saved. The set is disabled, so devices do not use it.") | clear errors |
| 4 | `precheckUnavailable` | warning | `checkerUnavailable` ("Saved, not published: the rule checker is unavailable. {{devices}}") | none claimed |
| 5 | any `errors[].ruleId` | warning | `compileErrors` ("Saved, not published: {{count}} rules have errors. {{devices}}") | per-rule errors with line |
| 6 | only `ruleId: null` errors | warning | `setErrors` ("Saved, not published: {{message}}. {{devices}}") | set banner |
| 7 | `!published`, `version === 0`, no errors | warning | `noEnabledRules` ("No enabled rules: devices no longer scan with this set.") | — |

`{{devices}}` is one of: `devicesKeep` ("Devices keep version {{version}}.") when `version > 0` and
the set is enabled; `neverPublished` ("This set has not been published yet, so devices do not use
it.") when `version === 0`; `setDisabled` ("The set is disabled, so devices do not use it.") when
`set.enabled === false`. A set whose GET shows `stale: true` gets the same persistent banner ("Not
published: fix the errors below. Devices keep version N."). **Line numbers are not persisted** —
`compile_error` is stored as `code: message` text — so per-rule annotations carry the line only right
after a save; after a reload the rule shows its stored `compileError` text. Plain 4xx/403 are
`runAction` failures and toast normally; `AUTO_QUARANTINE_EXECUTE_REQUIRED` and W04's new codes get
`friendly` copy.

**W04-4 Picker semantics.**
- Multi-select in `SecurityTab.tsx`, sourced from `GET /security/yara/rule-sets`. The list is filtered
  client-side by the **policy owner's** org (`FeatureTabProps.orgId`; `null` = partner-wide policy),
  never the viewer's, using the same rule as `securityRuleSetGate.ts`: an org policy may attach that
  org's sets, its partner's partner-wide sets and the built-in pack; a partner-wide policy may attach
  only partner-wide sets and the built-in pack. Badges: "Built-in", "All orgs" (partner-wide, reusing
  the `software/PolicyForm.tsx` copy). Disabled, never-published and stale sets **stay attachable**
  (the gate checks ownership only; the scan records `disabled` / `not_published` per run) and carry
  status badges "Disabled", "Not published", "Has errors" — distinct from "Unavailable" below.
- **List fetch failure is not deletion.** If `GET /security/yara/rule-sets` fails, the picker shows
  an inline error with Retry, keeps `ruleSetIds` untouched, marks nothing unavailable, and disables
  editing of the picker only (the rest of the tab still saves).
- Selecting nothing is valid and means a legacy scan; the picker says so under the empty state
  ("No rule sets: scans use the built-in legacy signatures only.").
- Preselect the built-in pack **only** when the tab has neither `existingLink` nor `parentLink` (the
  security link is being created) **and** the built-in row is in the list (hosted installs can lack
  it). Never added to an existing link; never defaulted server-side — API and AI creates keep
  `ruleSetIds: []` = legacy scan (Open Decision 10).
- At most 20: the 21st option is disabled with the cap copy. The gate's `TOO_MANY_RULE_SETS` and
  `YARA_RULE_SET_NOT_ATTACHABLE` (with `ruleSetIds`) map to friendly copy and highlight the ids.
- An id saved in the link that is not in the attachable list (deleted, moved, or not visible) shows
  as "Unavailable rule set" with its short id and a remove button. Save is disabled while any remain,
  with the reason inline. It is never dropped silently: the gate would 400 the save anyway, and the
  tech must see that the policy's coverage changes.
- **Inherited links with an unavailable id.** Today Override saves the parent's settings at once
  (`SecurityTab.tsx` `handleSave` via `onOverride`) and the shell disables Override while
  `saveDisabled`; a child whose parent lists a set this child's owner cannot attach would be stuck
  (the gate 400s the override). So when the picker reports a blocking id, Override does **not** save:
  it opens a local override draft (form editable, banner "Remove the unavailable rule sets, then
  Save"), and Save creates the link. With no blocking id, Override keeps today's one-click save.

**W04-5 ThreatDetail rule panel — read route only.** `GET /security/threats/:id/details` (two
segments, so it cannot collide with `GET /threats/:deviceId`). It returns `{ data: { threat, rule } }`:
`threat` in the same shape as one `GET /threats` list item, so `ThreatDetail` stops depending on the
selected threat being among the first 100 the list returns (`ThreatDetail.tsx` `fetchThreat`), and
`rule` a typed projection of `details`. It runs `requireSecurityReadAccess` (keeping its
platform-admin path) and `devices:read`, and copies **both** checks of `queueThreatAction`
(`apps/api/src/routes/security/helpers.ts`): the org condition and the site-scope gate — RLS does
not defend the site axis. `rule = { engine: 'yara' | 'legacy', ruleName, ruleId, ruleSetId, ruleSet:
{ id, name, isBuiltin, partnerWide } | null, tags, matchedStrings (≤ 10, each `data` ≤ 512 chars),
sha256, quarantinedTo, quarantineFailed }`. Every field is type-checked; junk is dropped, never
passed through. `matchedStrings[].data` is already escaped by the agent (`escapeMatched`): the API
truncates it and the UI renders it as text — neither escapes it again. The set name is joined under
the caller's RLS and W03's access condition; `null` means "no longer available". Hits with no
`ruleName` are `engine: 'legacy'` (built-in signatures). `quarantinedTo` is labelled as the
scan-time quarantine path. The rule's version at detection time is not recorded (the agent does not
report it); the panel does not claim one.

**W04-6 "Sweep now" is W05.** The index row W05 (#6268) owns the `sweep` route and batch tracking; the
Detection rules page ships without the button. Nothing in W04 creates scans.

---

## File structure

### PR A — API, shared, breeze-yarac

| File | Responsibility |
|---|---|
| `packages/shared/src/utils/yaraIocImport.ts` (create) | `parseIocText`, `validateIoc`, `generateIocRules` — pure, browser-safe |
| `packages/shared/src/utils/yaraIocImport.test.ts` (create) | classification, refang, escaping, naming, chunking, caps |
| `packages/shared/src/types/yara.ts` (modify) | IOC types + caps constants, test response types |
| `packages/shared/src/index.ts` (modify) | export the new util |
| `agent/internal/yarascan/testdata/ioc-import.golden.json` (create) | bundle of generator output for every kind (written by the shared test) |
| `agent/internal/yarascan/yarac/yarac_test.go` (modify) | golden IOC bundle validates clean under `DefaultPolicy` |
| `agent/internal/yarascan/matcher.go` (modify) | `collectStrings` reads from `io.ReaderAt` |
| `agent/internal/yarascan/sample.go` + `sample_test.go` (create) | `ScanSample` in-memory scan |
| `agent/cmd/breeze-yarac/main.go` + `main_test.go` (modify) | `match` subcommand |
| `agent/cmd/breeze-yarac/sandbox_linux.go`, `sandbox_other.go`, `sandbox_linux_test.go` (create) | Landlock + `no_new_privs` + `oom_score_adj` |
| `agent/internal/yarascan/hash_bench_test.go` (create) | hash-IOC cost benchmark |
| `apps/api/src/system/connections/internalEnvVars.ts` (modify) | `BREEZE_YARA_TEST_UNSANDBOXED` |
| `apps/api/src/routes/security/yaraAccess.ts` (create) | moved from `yara.ts`: `ruleSetAccessCondition`, `loadVisibleSet`, `writeDenial`, `publishBody`, `publishAudit`, `auditOwner` |
| `apps/api/src/routes/security/yara.ts` (modify) | imports the moved helpers; no behaviour change |
| `apps/api/src/routes/security/yaraIocImport.ts` + `.test.ts` (create) | `POST /yara/rule-sets/:id/ioc-import` |
| `apps/api/src/routes/security/yaraTest.ts` + `.test.ts` (create) | `POST /yara/rule-sets/:id/test` |
| `apps/api/src/services/yaraSampleMatch.ts` + `.test.ts` (create) | spawn `breeze-yarac match`, framing, busy gate, timeout, parsing |
| `apps/api/src/services/yaraPrecheck.ts` (modify) | export the shared gate (`withYaracSlot`) and `runYarac` stdin-as-Buffer |
| `apps/api/src/routes/security/threats.ts` + `helpers.ts` (modify) | `GET /threats/:id/details`, `loadThreatForCaller` extracted from `queueThreatAction` |
| `apps/api/src/routes/security/index.ts` (modify) | mount the two new route modules |
| `apps/api/src/middleware/bodyLimit.ts` + `.test.ts` (modify) | `yara-test-sample` rule |
| `apps/api/src/middleware/selfManagedDbContextRoutes.ts` + `.test.ts` (modify) | the test route |
| `apps/api/src/services/mcpCoverage.ts` (modify) | entries for `security/yaraAccess.ts`, `security/yaraIocImport.ts`, `security/yaraTest.ts` |
| `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`, `site-ceiling-write-coverage.test.ts` (modify) | only if the walk flags `yaraIocImport.ts` (see Task A2) |
| `apps/api/src/__tests__/integration/yaraW04Routes.integration.test.ts` (create) | real-DB gates and publish |

### PR B — web

| File | Responsibility |
|---|---|
| `apps/web/src/pages/security/detection-rules.astro` (create) | page shell |
| `apps/web/src/components/security/detectionRules/DetectionRulesPage.tsx` (create) | list + selected set via hash |
| `…/detectionRules/RuleSetList.tsx` (create) | list with badges |
| `…/detectionRules/RuleSetEditor.tsx` (create) | set header, rule list, tabs rules / import / test |
| `…/detectionRules/RuleEditorDialog.tsx` (create) | add/edit one rule |
| `…/detectionRules/IocImportPanel.tsx` (create) | paste, preview, import |
| `…/detectionRules/RuleTestPanel.tsx` (create) | upload, results |
| `…/detectionRules/publishOutcome.ts` (create) | `describePublishOutcome` |
| `…/detectionRules/ruleSetsApi.ts` (create) | typed fetch + `runAction` wrappers |
| `…/detectionRules/*.test.tsx`, `publishOutcome.test.ts` (create) | unit tests |
| `apps/web/src/components/configurationPolicies/featureTabs/SecurityTab.tsx` (+ test) (modify) | picker |
| `…/featureTabs/RuleSetPicker.tsx` (+ test) (create) | the multi-select itself |
| `apps/web/src/components/security/ThreatDetail.tsx` + `ThreatRulePanel.tsx` (+ test) | rule panel |
| `apps/web/src/components/layout/Sidebar.tsx` (modify) | nav entry |
| `apps/web/src/locales/*/security.json`, `policies.json`, `pages.json`, `common.json` (modify, all 8) | copy |
| `apps/web/src/components/security/security403Sweep.test.tsx` (modify) | the new page's AccessDenied |

---

## PR A — API, shared generator, `breeze-yarac match`

### Task A1: Shared IOC parser and rule generator

**Files:**
- Create: `packages/shared/src/utils/yaraIocImport.ts`, `packages/shared/src/utils/yaraIocImport.test.ts`
- Modify: `packages/shared/src/types/yara.ts`, `packages/shared/src/index.ts`
- Create (written by the test with `UPDATE_GOLDEN=1`, then committed): `agent/internal/yarascan/testdata/ioc-import.golden.json`

**Interfaces:**
- Produces (in `types/yara.ts`):
  - `YARA_IOC_KINDS = ['md5','sha1','sha256','filename','filepath','domain','ip','string'] as const`, `type YaraIocKind`
  - `interface YaraIoc { kind: YaraIocKind; value: string }`
  - `YARA_IOC_MAX_PER_BATCH = 1000`, `YARA_IOC_MAX_TEXT_BYTES = 256 * 1024`, `YARA_IOC_STRING_MIN_BYTES = 4`,
    `YARA_IOC_STRING_MAX_BYTES = 256`, `YARA_IOC_LABEL_MAX = 64`, `YARA_IOC_RULE_SOURCE_BUDGET = 60 * 1024`,
    `YARA_TEST_SAMPLE_MAX_BYTES = 10 * 1024 * 1024`, `YARA_IOC_FILE_EXTENSIONS` (readonly tuple, the W04-1 list)
- Produces (in `utils/yaraIocImport.ts`):
  - `parseIocText(text: string): { iocs: YaraIoc[]; errors: Array<{ line: number; value: string; code: YaraIocErrorCode }> }`
  - `validateIoc(ioc: YaraIoc): { ok: true; ioc: YaraIoc } | { ok: false; code: YaraIocErrorCode }` — normalizes (refang, lowercase hashes) and checks the kind's shape and length
  - `type YaraIocErrorCode = 'empty' | 'unknown_kind' | 'bad_hash' | 'too_short' | 'too_long' | 'bad_path' | 'bad_ip' | 'bad_domain' | 'duplicate'`
  - `generateIocRules(input: { label: string; iocs: readonly YaraIoc[]; severity?: YaraRuleSeverity }): YaraGeneratedRule[]` where `interface YaraGeneratedRule { name: string; source: string; severity: YaraRuleSeverity; tags: string[]; kind: YaraIocKind; iocCount: number }` — throws `YaraIocInputError` on an invalid IOC or an empty batch (the route maps it to 400)
  - `escapeYaraText(value: string): string`

- [ ] **Step 1: Write the failing tests** in `yaraIocImport.test.ts`:
  - `classifies by shape`: input lines `44d88612fea8a8f36de82e1278abb02f`, `3395856ce81f2b7382dee72602f798b642f14140`, 64-hex, `C:\Users\Public\evil.exe`, `/tmp/x.sh`, `\\srv\share\a.ps1`, `HKLM\Software\Run\x`, `10.0.0.5`, `2001:db8::1`, `evil[.]com`, `payload.dll`, `malware.exe`, `cdn.example.org`, `Global\MutexName` → kinds `md5, sha1, sha256, filepath, filepath, filepath, string, ip, ip, domain, filename, filename, domain, string`; `evil[.]com` normalizes to `evil.com`.
  - `prefix override`: `filename:invoice.com` → `{ kind: 'filename', value: 'invoice.com' }`; `SHA256:<64hex>` → sha256; `nope:x` → `{ kind: 'string', value: 'nope:x' }`; `C:\a\b.exe` → filepath; `2001:db8::1` → ip; `hxxp://evil[.]com/x` → string `http://evil.com/x`. A JSON object with `kind: 'nope'` → error `unknown_kind`.
  - `ip canonical`: `2001:0db8:0000::0001` and `2001:db8::1` dedupe to one IOC (IPv6 is canonicalised to its compressed lowercase form before dedupe and generation).
  - `domain charset`: a domain with non-ASCII letters is rejected `bad_domain` with copy asking for the punycode (`xn--`) form; domains are ASCII-only, so the domain rule never needs the UTF-16 pattern.
  - `json input`: `["evil.com", {"kind":"string","value":"abcd"}]` parses; `[{"kind":"md5","value":"zz"}]` → error `bad_hash`.
  - `comments, blanks and duplicates`: `# x`, ``, `EVIL.com`, `evil.com` → one domain IOC, one `duplicate` error on line 4.
  - `string length`: `abc` → `too_short`; 257-byte value → `too_long`; `€uro` (6 bytes) accepted.
  - `escapes`: `escapeYaraText('a"b\\c\u00e9\n')` equals `'a\\"b\\\\c\\xc3\\xa9\\x0a'`.
  - `generates one rule per kind`: label `ACME Advisory 7`, IOCs {2 sha256, 1 filename, 1 domain, 2 strings} → 4 rules named `ioc_acme_advisory_7_sha256_<16hex>`, `…_filename_<16hex>`, `…_domain_<16hex>`, `…_string_<16hex>`; the sha256 rule source starts with `import "hash"` and contains `hash.sha256(0, filesize) == "<hex>"` twice joined by ` or `; the filename rule contains `filename iequals "payload.dll"`; the domain rule contains `ascii wide nocase`; the string rule contains `$i0 = "…" ascii wide` (no `nocase`), `$i1`, and `condition:\n    any of them`; every rule's meta contains `source = "breeze-ioc-import"`.
  - `non-ascii`: string `prüfung` produces `$i0 = "pr\xc3\xbcfung"` (no `wide`) and `$i0w = { 70 00 72 00 fc 00 66 00 75 00 6e 00 67 00 }`.
  - `deterministic`: the same IOCs in a different order produce identical rules, names and chunk boundaries.
  - `chunks over the budget`: 1000 distinct 256-byte strings produce ≥ 2 string rules, each `source` ≤ `YARA_IOC_RULE_SOURCE_BUDGET` bytes, names suffixed `_2`, `_3`…, values sorted across chunks, total `iocCount` 1000.
  - `names fit the pattern`: a 200-char label still yields names ≤ 128 chars matching `YARA_RULE_NAME_PATTERN` (slug cut at 64).
  - `rejects over-cap batches`: 1001 IOCs → `YaraIocInputError`.
  - `golden`: generator output for one fixed IOC of every kind, wrapped with `buildYaraBundleJson({ ruleSetId: '00000000-0000-4000-8000-0000000010c0', version: 1, autoQuarantine: false, rules })` (rule ids `00000000-0000-4000-8000-00000000000N`), equals `agent/internal/yarascan/testdata/ioc-import.golden.json` byte for byte; `UPDATE_GOLDEN=1` rewrites it.

- [ ] **Step 2: Run to verify they fail**
  Run: `pnpm --filter @breeze/shared exec vitest run src/utils/yaraIocImport.test.ts`
  Expected: FAIL — module `./yaraIocImport` not found.

- [ ] **Step 3: Implement** the types in `types/yara.ts` and the four functions in `utils/yaraIocImport.ts`.
  Use `TextEncoder` for byte lengths and escaping (browser-safe; no `node:crypto`). Slug: lowercase,
  non-`[a-z0-9]` runs → `_`, trimmed, cut at 64 chars; empty slug → `batch`.
  FNV-1a 64-bit (`BigInt`) over the `\n`-joined sorted canonical values of the rule, 16 lowercase hex
  chars. Rule layout
  (exact, two-space indent inside sections, `\n` line ends):

  ```
  import "hash"            <- hash kinds only, then a blank line
  rule <name> : ioc <kind>
  {
    meta:
      source = "breeze-ioc-import"
      label = "<escaped label>"
      ioc_count = <n>
    strings:               <- domain / ip / string only
      $i0 = "<escaped>" ascii wide
    condition:
      <expr>
  }
  ```
  Tags are written as YARA tags too, so `rule.Tags()` on the agent reports them.

- [ ] **Step 4: Generate the golden and run the tests**
  Run: `UPDATE_GOLDEN=1 pnpm --filter @breeze/shared exec vitest run src/utils/yaraIocImport.test.ts`, then again without `UPDATE_GOLDEN`.
  Expected: PASS both times; `git diff --stat` shows the new golden file.

- [ ] **Step 5: Commit** — `feat(shared): YARA IOC parser and deterministic rule generator (#6267)`

### Task A2: IOC import route

**Files:**
- Create: `apps/api/src/routes/security/yaraAccess.ts`, `apps/api/src/routes/security/yaraIocImport.ts`, `apps/api/src/routes/security/yaraIocImport.test.ts`, `apps/api/src/__tests__/integration/yaraW04Routes.integration.test.ts`
- Modify: `apps/api/src/routes/security/yara.ts` (helpers move out, imports in), `apps/api/src/routes/security/index.ts`, `apps/api/src/services/mcpCoverage.ts`

**Interfaces:**
- Consumes: `generateIocRules`, `validateIoc`, `YaraIoc`, caps (Task A1); `publishRuleSet`, `PublishRuleSetResult` (W03).
- Produces: `yaraIocImportRoutes` (Hono). `yaraAccess.ts` exports `ruleSetAccessCondition(auth)`,
  `loadVisibleSet(auth, id)`, `writeDenial(auth, set)`, `publishBody(result)`, `publishAudit(result)`,
  `auditOwner(set)` — the W03 bodies moved verbatim.
- Request `POST /security/yara/rule-sets/:id/ioc-import`, body (Zod `yaraIocImportSchema` in `yaraSchemas.ts`, `.strict()`):
  `{ label: string (1..64, trimmed), severity?: YaraRuleSeverity, iocs: YaraIoc[] (1..1000), each value ≤ 512 chars }`.
  1000 × 512-char values plus JSON overhead stays well under the 1 MiB default body limit (`bodyLimit.ts` `default`); `YARA_IOC_MAX_TEXT_BYTES` (256 KiB) caps only the pasted text in `parseIocText`. Test: a 1000-IOC body at the per-value max is accepted (not a 413).
- Response 201: `{ data: { rules: [{ id, name, kind, iocCount }] }, publish: <W03 publishBody> }`.
- Errors: 400 `IOC_INVALID` with `{ index, code }[]`; 400 when existing + generated > 500 (`IOC_TOO_MANY_RULES`);
  403 from `writeDenial`; 404 set not visible; 409 `IOC_BATCH_ALREADY_IMPORTED` (stored source identical)
  or 409 `IOC_RULE_NAME_TAKEN` (same name, different source), each with the colliding names.

- [ ] **Step 1: Move the helpers** from `yara.ts` into `yaraAccess.ts` unchanged and import them back.
  Run: `pnpm --filter @breeze/api exec vitest run src/routes/security/yara.test.ts`
  Expected: PASS (pure move).

- [ ] **Step 2: Write the failing route tests** in `yaraIocImport.test.ts` (Drizzle + publisher mocked, `breeze-testing` conventions):
  - `403 on the built-in set` (`isBuiltin: true`) with error `The built-in rule set is read-only`, no insert.
  - `403 partner-wide set without canManagePartnerWidePolicies`; `403 site-restricted caller` (`SITE_CEILING_WRITE_DENIED_MESSAGE`).
  - `400 IOC_INVALID` for `{ kind: 'md5', value: 'zz' }` with `[{ index: 0, code: 'bad_hash' }]`, no insert.
  - `400 IOC_TOO_MANY_RULES` when the set already has 499 rules and the batch generates 2.
  - `201 inserts generated rules and publishes once`: the inserted `source` equals `generateIocRules(...)[i].source` exactly; `publishRuleSet` called once with the set id; the body carries `publish`.
  - `ignores client rule text`: a body with an extra `source` field is rejected by the strict schema (400).
  - `409 IOC_BATCH_ALREADY_IMPORTED` when a generated name already exists with identical `source`; `409 IOC_RULE_NAME_TAKEN` when it exists with different `source`; in both cases nothing is inserted (pre-insert lookup of the generated names, plus the unique violation caught inside the savepoint as the race backstop).
  - `locks before counting`: the set row is selected `FOR UPDATE` before the rule count (assert call order on the mocked query builder).
  - `audit` event `security.yara_rule.ioc_import` with `{ ruleSetId, ruleIds, kinds: { sha256: 2, … }, iocCount }` and no IOC value anywhere in `details`.

- [ ] **Step 3: Run to verify they fail**
  Run: `pnpm --filter @breeze/api exec vitest run src/routes/security/yaraIocImport.test.ts`
  Expected: FAIL — module not found.

- [ ] **Step 4: Implement** `yaraIocImportRoutes.post('/yara/rule-sets/:id/ioc-import', requireScope('organization','partner','system'), requirePermission('devices','write'), zValidator('param', yaraRuleSetIdParamSchema), zValidator('json', yaraIocImportSchema), handler)`.
  Order: `loadVisibleSet` → `writeDenial` → validate each IOC (collect all errors, then 400) → generate →
  `SELECT id FROM yara_rule_sets WHERE id = $1 FOR UPDATE` → look up generated names (409s) → count
  check → insert all rules in one `withDbTransaction` savepoint → `publishRuleSet(id)` (re-locks the
  same row in the same transaction, a no-op) → audit → 201. Mount in `security/index.ts`. Add `mcpCoverage.ts` entries:
  `'security/yaraAccess.ts': { exempt: 'internal_plumbing', note: … }`,
  `'security/yaraIocImport.ts': { exempt: 'tool_in_later_wave', note: 'YARA IOC import (#6263 W04); AI rule-set actions ship in W05 (#6268).' }`.

- [ ] **Step 5: Run the unit tests and the contract walks**
  Run: `pnpm --filter @breeze/api exec vitest run src/routes/security/yaraIocImport.test.ts src/routes/security/yara.test.ts src/__tests__/mcp-coverage.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts`
  Expected: PASS. `yaraIocImport.ts` inserts into `yaraRules`, so the partner-wide and site-ceiling
  walks inspect it. Both checks are textual (does the file mention `canManagePartnerWidePolicies` /
  `canMutateOrgWideGovernance`?), and this file calls them only through `writeDenial`. If either walk
  fails, add an `ALLOWED_*` entry in that contract test with this reason:
  `'every mutation runs writeDenial (routes/security/yaraAccess.ts: canMutateOrgWideGovernance + canManagePartnerWidePolicies) first; 403s pinned in yaraIocImport.test.ts (#6263 W04)'`.
  Do not add a decorative mention of the helper to satisfy the grep.

- [ ] **Step 6: Integration test** `yaraW04Routes.integration.test.ts` (real DB, real RLS, publisher with `BREEZE_YARA_LINT_ONLY=1`, `NODE_ENV=test`): org user imports into their own set (201, rules visible); org user → partner-wide set 403; org A user → org B set 404; second identical import 409 and rule count unchanged.
  Plus: two concurrent imports into a set holding 498 rules, each generating 2 rules → exactly one 201 and one 400 `IOC_TOO_MANY_RULES`; final count 500.
  Run on a test stack per `docs/agents/testing.md` (`pnpm test-stack up`, the integration command for one file, `pnpm test-stack down`).
  Expected: 5/5 PASS.

- [ ] **Step 7: Commit** — `feat(api): YARA IOC import route with server-side generation (#6267)`

### Task A3: `breeze-yarac match` and in-memory `ScanSample`

**Files:**
- Modify: `agent/internal/yarascan/matcher.go` (`collectStrings`), `agent/internal/yarascan/yarac/yarac_test.go`, `agent/cmd/breeze-yarac/main.go`, `agent/cmd/breeze-yarac/main_test.go`
- Create: `agent/internal/yarascan/sample.go`, `agent/internal/yarascan/sample_test.go`, `agent/internal/yarascan/hash_bench_test.go`, `agent/cmd/breeze-yarac/sandbox_linux.go`, `agent/cmd/breeze-yarac/sandbox_other.go`, `agent/cmd/breeze-yarac/sandbox_linux_test.go`

**Interfaces:**
- Produces (Go): `func ScanSample(entry *CacheEntry, filename, filepath string, data []byte, timeout time.Duration) ([]Match, error)` — one scanner, globals `filename`, `filepath` (defaults to `filename` when empty), `extension` from the filename; recovers engine panics into an error.
- `collectStrings(r io.ReaderAt, rule *yx.Rule) []MatchedString` — `ScanFile` passes the opened `*os.File`, `ScanSample` passes `bytes.NewReader(data)`.
- `func enterSandbox() error` (cmd package): linux — `oom_score_adj` 1000, `PR_SET_NO_NEW_PRIVS`, Landlock deny-all FS (+ TCP at ABI ≥ 4), then the seccomp deny filter from W04-2 step 4 (TSYNC); any step failing → `errSandboxUnavailable`; other OSes — returns `errSandboxUnavailable`. Skipped only when `BREEZE_YARA_TEST_UNSANDBOXED=1` (the API passes it only under `NODE_ENV` development/test).
- CLI: `breeze-yarac match --filename NAME [--filepath PATH]` reading framed stdin (4-byte BE length, bundle, sample to EOF). Order: read stdin fully → `enterSandbox()` → `yarac.EnsureEngine()` → compile → scan. Exit codes: 0 ok, 1 bundle compile errors (the `validate` error JSON `{ "ok": false, "errors": [...] }`), 2 usage / oversize / engine failure, **3 sandbox unavailable** (`{ "ok": false, "unavailable": "sandbox" }`). Output on exit 0: one JSON object
  `{ "ok": true, "matches": [{ "ruleSetId", "ruleId", "ruleName", "severity", "tags", "matchedStrings" }], "durationMs": n }`.

- [ ] **Step 1: Write the failing Go tests**
  - `yarac_test.go` `TestIocImportGoldenValidates`: decode `../testdata/ioc-import.golden.json`, `ValidateSet(ToYaracSet(b), DefaultPolicy)` returns no errors. (Pins `import "hash"`, `iequals`, `ascii wide nocase`, the UTF-16LE hex pattern and the escaping under the real policy.)
  - `sample_test.go` `TestScanSampleMatchesAndCaps`: a rule with `$a = "EVILMARK"`, data with 12 occurrences → one match with 10 `MatchedStrings`, each `Data == "EVILMARK"`, offsets ascending; `TestScanSampleGlobals`: `filename iequals "invoice.pdf"` matches when called with `INVOICE.PDF`, and `filepath iequals "C:\\Users\\Public\\x.exe"` matches only when that `filepath` is passed; no-disk is proven structurally — `ScanSample` takes `[]byte`, never a path, and the sandbox test below runs it with every write denied by Landlock and still matches.
  - `sandbox_linux_test.go` (linux only; `t.Skip` when Landlock ABI < 1): in a re-exec'd child, after `enterSandbox()`, `os.ReadFile("/etc/hostname")` and `os.ReadFile("/proc/self/environ")` fail with `EACCES`, `os.WriteFile("/tmp/x", …)` fails, `net.Dial("udp", "127.0.0.1:9")` and `net.Dial("unix", …)` fail with `EPERM`, `unix.PtraceAttach(os.Getppid())` fails with `EPERM`, `/proc/self/oom_score_adj` was `1000` before the Landlock step, and `ScanSample` on the golden bundle still matches.
  - `main_test.go` `TestMatchFramed` (with `BREEZE_YARA_TEST_UNSANDBOXED=1` on non-linux): frame the golden bundle + a sample containing one golden string → exit 0, one match; `TestMatchCompileError`: a bundle with a bad rule → exit 1 and `"ok":false`; `TestMatchOversize`: sample 10 MiB + 1 → exit 2; `TestMatchSandboxUnavailable` (non-linux, flag unset) → exit 3.
  - `hash_bench_test.go` `BenchmarkHashIocs`: rules with 1 and 1000 `hash.sha256` IOCs, and one rule each for md5/sha1/sha256 × 250, over a 25 MiB non-matching buffer and over 1000 × 64 KiB buffers. Not a pass/fail gate; Step 4 records the numbers.

- [ ] **Step 2: Run to verify they fail**
  Run: `cd agent && go test -race ./internal/yarascan/... ./cmd/breeze-yarac/...`
  Expected: FAIL — `ScanSample` undefined, unknown subcommand `match`; `TestIocImportGoldenValidates` FAILS only if the generator emits something the policy rejects (fix the generator in Task A1, not the policy).

- [ ] **Step 3: Implement** `ScanSample` in `sample.go`, refactor `collectStrings` to `io.ReaderAt`, add `enterSandbox` (Landlock via `unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET, …)` with `unix.LandlockRulesetAttr`, then `SYS_LANDLOCK_RESTRICT_SELF`; ABI from `LANDLOCK_CREATE_RULESET_VERSION`; handled FS rights masked to what the ABI supports) and `cmdMatch` in `main.go` (read the 4-byte length with `io.ReadFull`, cap the bundle at `yarascan.MaxBundleBytes`, read the sample through `io.LimitReader(stdin, 10<<20+1)`, sandbox, compile via the existing `compileBundles`, then `ScanSample(entry, *filename, *filepath, data, 15*time.Second)`). Add `match` to `usage`.

- [ ] **Step 4: Run the Go tests and the benchmark**
  Run: `cd agent && go test -race ./internal/yarascan/... ./cmd/breeze-yarac/... ./internal/security/...`
  Expected: PASS (the existing `matcher_test.go` and walk tests still pass after the refactor).
  Run: `cd agent && go test -run '^$' -bench BenchmarkHashIocs -benchtime 3x ./internal/yarascan/` and paste the table into the PR body. If 1000 hashes cost more than 2× one hash per file, the hash module is not caching per scan: escalate (the importer would then have to cap hash IOCs much lower).
  Also run `scripts/security/yara-pack/build-pack.sh --check-lock` → OK (proves `yarac.go` untouched).
  Linux proof: run `sandbox_linux_test.go` in a `golang:1.26` container with the repo mounted (`docker run --rm -v "$PWD":/src -w /src/agent golang:1.26.9-alpine go test -run Sandbox ./cmd/breeze-yarac/`) → PASS, not SKIP.

- [ ] **Step 5: Commit** — `feat(agent): breeze-yarac match — in-memory sample scan for the rule test route (#6267)`

### Task A4: Test upload route

**Files:**
- Create: `apps/api/src/services/yaraSampleMatch.ts`, `apps/api/src/services/yaraSampleMatch.test.ts`, `apps/api/src/routes/security/yaraTest.ts`, `apps/api/src/routes/security/yaraTest.test.ts`
- Modify: `apps/api/src/services/yaraPrecheck.ts`, `apps/api/src/middleware/bodyLimit.ts`, `apps/api/src/middleware/bodyLimit.test.ts`, `apps/api/src/middleware/selfManagedDbContextRoutes.ts`, `apps/api/src/middleware/selfManagedDbContextRoutes.test.ts`, `apps/api/src/routes/security/index.ts`, `apps/api/src/services/mcpCoverage.ts`, `apps/api/src/system/connections/internalEnvVars.ts` (`BREEZE_YARA_TEST_UNSANDBOXED`)

**Interfaces:**
- Consumes: `buildYaraBundleJson` (W03), `loadVisibleSet` (Task A2), `breeze-yarac match` (Task A3), `withAuthDbAccessContext` (`middleware/auth.ts`), `userRateLimit` (`middleware/userRateLimit.ts`), `redactSecretsDeep` (same import as `routes/agents/helpers.ts`).
- Produces:
  - `yaraPrecheck.ts`: `tryAcquireYaracSlot(): (() => void) | null` — non-queueing; returns a release function or `null` when both slots are taken. `runYarac` accepts `stdin: Buffer | string | null` and an `AbortSignal`. The queueing `acquire()` used by publishes is unchanged.
  - `yaraSampleMatch.ts`:
    - `reserveSampleMatch(): YaraMatchReservation | null` — takes the process-wide single match slot and a shared yarac slot, or neither; `null` = busy.
    - `matchSample(reservation, input: { bundleJson: string; filename: string; filepath?: string; sample: Buffer; signal?: AbortSignal }): Promise<YaraSampleMatchResult>` — releases the reservation when the child has exited.
    - `type YaraSampleMatchResult = { ok: true; matches: YaraSampleMatch[]; durationMs: number } | { ok: false; errors: YaraPrecheckError[] } | { ok: false; unavailable: string } | { ok: false; sandboxUnavailable: true }`.
    - `YARA_MATCH_TIMEOUT_MS = 20_000`. The child env is `PATH`, plus `BREEZE_YARA_TEST_UNSANDBOXED=1` only when `yaraTestUnsandboxedAllowed()` (NODE_ENV development/test **and** the API's own `BREEZE_YARA_TEST_UNSANDBOXED=1`; register it in `INTERNAL_ENV_VARS` like W03's `BREEZE_YARA_LINT_ONLY`).
  - Route `POST /security/yara/rule-sets/:id/test?filename=<basename>[&filepath=<path>]`, body `application/octet-stream`.
- Response codes: 200 result; 400 empty body / bad filename or filepath; 404 set not visible; 413 over 10 MiB (gate, or `YARA_TEST_TOO_LARGE` from the route's own exact check); 422 `YARA_TEST_COMPILE_FAILED` with `errors`; 422 `YARA_TEST_NO_RULES` (no enabled rules); 429 `YARA_TEST_BUSY` or rate limit; 503 `YARA_TEST_UNAVAILABLE` (checker missing / timeout / crash); 503 `YARA_TEST_SANDBOX_UNAVAILABLE`.

- [ ] **Step 1: Write the failing service tests** in `yaraSampleMatch.test.ts` (fake binary via `BREEZE_YARAC_PATH` pointing at a test script, the pattern `yaraPrecheck.test.ts` uses):
  - `frames stdin`: the fake echoes stdin length; assert it received `4 + bundle + sample` bytes and the first 4 bytes are the big-endian bundle length.
  - `busy`: with one reservation held, `reserveSampleMatch()` returns `null`; with both shared yarac slots held by pending pre-checks, it also returns `null` and holds nothing.
  - `releases after exit, not at timeout`: a fake that ignores SIGKILL for 200 ms → the reservation is still held when the timeout fires and free only after `close`; result `{ ok: false, unavailable: 'timeout' }`.
  - `abort`: aborting `signal` kills the child and releases.
  - `env`: the child sees only `PATH` (no `BREEZE_YARA_TEST_UNSANDBOXED` under `NODE_ENV=production` even when the API has it set).
  - `parses exit 1` into `errors`; `exit 2` → `unavailable`; `exit 3` → `sandboxUnavailable`; malformed stdout → `unavailable`.

- [ ] **Step 2: Write the failing route tests** in `yaraTest.test.ts`:
  - `404 for a set the caller cannot see`; `200 for the built-in set` for an org user with `devices:write`; `403 without devices:write`.
  - `400` for an empty body and for `filename=../x`; `422 YARA_TEST_NO_RULES` for a set with no enabled rules.
  - `size cap`: a body of exactly `YARA_TEST_SAMPLE_MAX_BYTES` is accepted; `+1` byte → 413 `YARA_TEST_TOO_LARGE` from the route's own `byteLength` check (the body-limit gate allows 64 KiB slack, so the route must check), and `matchSample` is never called.
  - `admission before body`: when `reserveSampleMatch()` returns `null` the route answers 429 `YARA_TEST_BUSY` and never calls `c.req.arrayBuffer()`.
  - `tests the draft`: `currentVersion` and the `enabled = true` rules come from one joined query in one `withAuthDbAccessContext` call; the bundle is built at `max(currentVersion, 1)`; response `testedVersion`, `publishedVersion`, and `testedDigest` = sha256 of the bundle bytes passed to `matchSample`.
  - Integration (add to `yaraW04Routes.integration.test.ts`, real RLS): an **org** user tests the built-in set and their MSP's partner-wide set → 200 (not 404), with `matchSample` stubbed; an org-B user testing org A's set → 404.
  - `redacts`: a match whose `matchedStrings[0].data` is `password=hunter2` comes back redacted the way `redactSecretsDeep` does at ingest.
  - `503 YARA_TEST_SANDBOX_UNAVAILABLE` when `matchSample` reports it; `503 YARA_TEST_UNAVAILABLE` when unavailable.
  - `audit` `security.yara_rule_set.test` with `{ ruleSetId, sampleSha256, size, matchCount }` and no filename.
- Add to `bodyLimit.test.ts`: `/api/v1/security/yara/rule-sets/<uuid>/test` → rule `yara-test-sample`, `maxSize` 10 MiB + 64 KiB; any other `/security/yara` path → `default`.
- Add to `selfManagedDbContextRoutes.test.ts`: `POST /api/v1/security/yara/rule-sets/<uuid>/test` is self-managed; `POST …/ioc-import` and `PATCH /api/v1/security/yara/rules/<uuid>` are not.

- [ ] **Step 3: Run to verify they fail**
  Run: `pnpm --filter @breeze/api exec vitest run src/services/yaraSampleMatch.test.ts src/routes/security/yaraTest.test.ts src/middleware/bodyLimit.test.ts src/middleware/selfManagedDbContextRoutes.test.ts`
  Expected: FAIL — modules not found / rule and route not registered.

- [ ] **Step 4: Implement.** Route chain: `requireScope('organization','partner','system')`,
  `userRateLimit('yara-rule-test', 10, 600)`, `requirePermission('devices','write')`,
  `zValidator('param', yaraRuleSetIdParamSchema)`, `zValidator('query', yaraTestQuerySchema)`. Handler:
  phase 1 `withAuthDbAccessContext(auth, …)` loads the set and its enabled rules in one joined
  query under `ruleSetAccessCondition` (404 / 422 decided here, before any body read);
  `reserveSampleMatch()` (429 if `null`); read `await c.req.arrayBuffer()` (the gate already capped
  it) inside a `try/finally` that releases the reservation if anything throws before `matchSample`;
  build the bundle; phase 2 `matchSample(reservation, { …, signal: c.req.raw.signal })`; sha256 of the
  sample with `node:crypto`; phase 3 audit; respond. Drop the buffer reference before responding. Body-limit rule regex: `^/api/v1/security/yara/rule-sets/[0-9a-f-]{36}/test$` (method
  agnostic, like the others). mcp entry for `security/yaraTest.ts`: `tool_in_later_wave`, note naming #6268.

- [ ] **Step 5: Run the tests**
  Same command as Step 3, plus `src/__tests__/mcp-coverage.test.ts`. Expected: PASS.

- [ ] **Step 6: Real-binary check** (no stack needed): build `cd agent && go build -o /tmp/breeze-yarac ./cmd/breeze-yarac`, then
  `BREEZE_YARAC_PATH=/tmp/breeze-yarac pnpm --filter @breeze/api exec vitest run src/services/yaraSampleMatch.test.ts -t real` — the `real` case (skipped unless `BREEZE_YARAC_PATH` is set, like W03's opt-in case) matches the golden IOC bundle against a sample containing one of its strings.
  Expected: 1 match. Then, inside the built API image (Task A6 Step 4), run `match` against the
  **500-rule built-in pack** with a 10 MiB random sample under `/usr/bin/time -v` and record peak RSS
  in the PR body. **If it exceeds 1 GiB, stop and escalate** (W04-2 Memory).

- [ ] **Step 7: Commit** — `feat(api): YARA rule test upload, scanned in memory by breeze-yarac (#6267)`

### Task A5: Threat details view

**Files:**
- Modify: `apps/api/src/routes/security/helpers.ts` (extract `loadThreatForCaller` from `queueThreatAction`; `toThreatListItem` from the list mapping in `threats.ts`), `apps/api/src/routes/security/threats.ts`, `apps/api/src/routes/security/threats.test.ts`
- Modify: `packages/shared/src/types/yara.ts` (`YaraThreatRuleView`)

**Interfaces:**
- Produces: `loadThreatForCaller(c, id): Promise<{ threat: ThreatRowWithDetails } | { status: 403 | 404 }>` — the org condition **and** the site-scope gate, used by both `queueThreatAction` and the new route; `toThreatListItem(row)` — the exact object `GET /threats` emits per item; `toYaraThreatRuleView(details: unknown, ruleSet): YaraThreatRuleView`; `type YaraThreatRuleView = { engine: 'yara' | 'legacy'; ruleName: string | null; ruleId: string | null; ruleSetId: string | null; ruleSet: { id: string; name: string; isBuiltin: boolean; partnerWide: boolean } | null; tags: string[]; matchedStrings: Array<{ id: string; offset: number; data: string }>; sha256: string | null; quarantinedTo: string | null; quarantineFailed: boolean }`.
- Route `GET /security/threats/:id/details` → `{ data: { threat: <list item>, rule: YaraThreatRuleView } }`; chain `requireScope('organization','partner','system')`, `requireSecurityReadAccess`, `requirePermission('devices','read')`, `zValidator('param', threatIdParamSchema)`.

- [ ] **Step 1: Write the failing tests** in `threats.test.ts`:
  - `returns the rule view` from `details = { ruleName: 'ioc_x', ruleSetId, ruleId, tags: ['ioc'], matchedStrings: [12 items], sha256, quarantineFailed: true }` → 10 matched strings, each `data` ≤ 512 chars and byte-equal to the stored (already escaped) value when shorter, `engine: 'yara'`, `ruleSet.name` from the joined set, `quarantineFailed: true`.
  - `threat matches the list shape`: `data.threat` deep-equals the item `GET /threats` returns for the same row.
  - `legacy hit`: `details = { name: 'EICAR' }` → `engine: 'legacy'`, nulls and empty arrays.
  - `set no longer visible` → `ruleSet: null`, `ruleSetId` still returned.
  - `ignores junk`: `details.tags = 'x'`, `matchedStrings = [{ data: 5 }]`, `sha256 = 'nothex'` → `tags: []`, the bad entry dropped, `sha256: null`.
  - `404` for another org's threat; `403` for a site-restricted caller on a device outside their sites (same message as quarantine); `403` for a caller failing `requireSecurityReadAccess`; the existing quarantine/remove/restore tests still pass after the extraction.

- [ ] **Step 2: Run to verify they fail**
  Run: `pnpm --filter @breeze/api exec vitest run src/routes/security/threats.test.ts`
  Expected: FAIL — 404 on the new path.

- [ ] **Step 3: Implement** the extraction and the route, next to the other `/threats/:id/*` routes.

- [ ] **Step 4: Run the tests** — same command plus `src/routes/security/helpers.siteScope.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(api): threat details view with YARA rule context (#6267)`

### Task A6: PR A gates and PR

- [ ] **Step 1: Typecheck** — `NODE_OPTIONS=--max-old-space-size=12288 pnpm --filter @breeze/api exec tsc --noEmit; echo exit=$?` and the same for `@breeze/shared` and `@breeze/web` (shared types changed). Expected: `exit=0` each.
- [ ] **Step 2: Affected unit tests** in small batches: `src/routes/security`, `src/middleware`, `src/services/yara*`, `src/__tests__` (contract walks), shared `src/utils`. Expected: PASS; record counts.
- [ ] **Step 3: Integration on a test stack:** `yaraW04Routes`, the four W03 yara suites, `rls-coverage`, `integration-suite-coverage`. Tear the stack down. Expected: PASS; record counts.
- [ ] **Step 4: Docker** — `docker build -f apps/api/Dockerfile .`, then with a plain `docker run` (default seccomp profile, the image's `hono` user — what production uses): `breeze-yarac match` on the golden bundle exits **0** (sandbox applied, not 3), and a probe build that tries `os.ReadFile("/etc/hostname")` after `enterSandbox()` gets `EACCES`. Then the RSS measurement from Task A4 Step 6. Delete the local image. If the default seccomp profile blocks the Landlock syscalls, stop and escalate: the feature would be fail-closed in production.
- [ ] **Step 5: Open PR A** against `main`: title `feat(security): YARA W04a — IOC import, rule test upload, threat details view (#6267)`, body `Part of #6263` / `Refs #6267`, the decisions W04-1, W04-2, W04-5, the RSS number from Task A4 Step 6, and the contract-test outcomes. One independent review round.

---

## PR B — web (branch from `main` after PR A merges)

Shared rules for every PR B task: the page and panels render `AccessDenied` on 403 loads (add the page
to `security403Sweep.test.tsx`); every mutation goes through `runAction`; every new string is in all 8
locales; component tests use `data-testid` selectors only.

### Task B1: Page, nav, list

**Files:**
- Create: `apps/web/src/pages/security/detection-rules.astro`, `…/detectionRules/DetectionRulesPage.tsx`, `…/detectionRules/RuleSetList.tsx`, `…/detectionRules/ruleSetsApi.ts`, `…/detectionRules/DetectionRulesPage.test.tsx`
- Modify: `apps/web/src/components/layout/Sidebar.tsx`, `apps/web/src/locales/*/pages.json` (`titles.securityDetectionRules`), `apps/web/src/locales/*/common.json` (`nav.securityDetectionRules`), `apps/web/src/locales/*/security.json` (`detectionRules.*`), `apps/web/src/components/security/security403Sweep.test.tsx`

**Interfaces:**
- Produces: `ruleSetsApi.ts` — `listRuleSets(): Promise<YaraRuleSetSummary[]>`, `getRuleSet(id)`, `createRuleSet(input)`, `updateRuleSet(id, patch)`, `deleteRuleSet(id)`, `createRule(setId, input)`, `updateRule(ruleId, patch)`, `deleteRule(ruleId)`, `importIocs(setId, input)`, `testSample(setId, file: File)`, `getThreatDetails(threatId)`. Mutations wrap `runAction`; the publish-carrying ones return the parsed body so callers can read `publish`. `YaraRuleSetSummary` mirrors W03 `summarize()`.
- Hash: `#<setId>` selects a set; `#<setId>/import` and `#<setId>/test` select the editor tab; empty = list.

- [ ] **Step 1: Write the failing tests** in `DetectionRulesPage.test.tsx`: renders rows with `data-testid="rule-set-row-<id>"`; the built-in row shows `rule-set-badge-builtin`, a partner-wide row `rule-set-badge-all-orgs`, `stale: true` shows `rule-set-badge-errors`, `publishedVersion: 0` shows `rule-set-badge-unpublished`, `enabled: false` shows `rule-set-badge-disabled`; clicking a row sets `window.location.hash` to `#<id>`; loading with `#<id>` opens that set; a 403 list renders `AccessDenied`; "New rule set" offers the "All orgs" owner option only for partner-scope users (server 403 is toasted otherwise).
- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @breeze/web exec vitest run src/components/security/detectionRules/DetectionRulesPage.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Also: the spec §8 EDR-page link — one line in `apps/web/src/components/security/EdrPage.tsx`, "Looking for Breeze IOC scans? →" to `/security/scans` (`data-testid="edr-ioc-scans-link"`, key `security:edrPage.iocScansLink` in all 8 locales, asserted in `EdrPage.test.tsx`); and the copy-rule test `apps/web/src/locales/yaraCopyRule.test.ts` (Task B7 Step 3). Nav entry next to IOC Scans: `{ name: 'Detection rules', labelKey: 'nav.securityDetectionRules', href: '/security/detection-rules', icon: <lucide FileCode or ListChecks>, requiredPermission: { resource: 'devices', action: 'read' } }`. Breadcrumbs `Security › Detection rules`.
- [ ] **Step 4: Run** the test plus `src/lib/i18n/localeParity.test.ts`, `src/lib/i18n/titleKeyUsage.test.ts`, `src/components/security/security403Sweep.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(web): Detection rules page and rule set list (#6267)`

### Task B2: Set editor and publish outcome

**Files:**
- Create: `…/detectionRules/publishOutcome.ts`, `publishOutcome.test.ts`, `RuleSetEditor.tsx`, `RuleEditorDialog.tsx`, `RuleSetEditor.test.tsx`
- Modify: `apps/web/src/locales/*/security.json` (`detectionRules.publish.*`, `detectionRules.editor.*`)

**Interfaces:**
- Produces: `describePublishOutcome(p: YaraPublishBody | undefined, set: { enabled: boolean }): { tone: 'success' | 'warning'; key: string; reasonKey?: string; params: Record<string, string | number>; ruleErrors: Map<string, Array<{ code: string; message: string; line?: number }>>; setErrors: string[] }`, with `YaraPublishBody` = W03 `publishBody` shape. And `publishSuccessMessage(body: { publish?: YaraPublishBody }, set): string` — the `runAction` `successMessage` function: the translated success copy for `tone === 'success'`, `''` otherwise (its type is `(data: T) => string`; `''` is falsy, so no toast).

- [ ] **Step 1: Write the failing tests.** `publishOutcome.test.ts`: one `it` per row of the W04-3 table asserting `tone` and `key`, plus: rows are first-match (`autoQuarantineOnly` + `precheckUnavailable` → key `autoQuarantineOnly`, `reasonKey` `checkerUnavailable`); `published && stale` is never `success`; `{{devices}}` resolves to `devicesKeep` / `neverPublished` / `setDisabled` per the table note; `publishSuccessMessage` returns `''` for every warning row and **never throws** — given `{}`, `null`, or a `publish` with wrong-typed fields it returns `''` (a throwing formatter makes `runAction` show a generic "Done" success toast, `runAction.ts` successMessage catch); `ruleErrors` groups by `ruleId` and keeps `line`. `RuleSetEditor.test.tsx`: saving a rule whose response is `{ publish: { published: false, stale: true, errors: [{ ruleId: 'r1', code: 'compile', message: 'syntax error', line: 3 }] } }` shows NO success toast, shows one warning toast, shows `data-testid="rule-error-r1"` containing `line 3`, and the set banner `rule-set-publish-banner`; a `precheckUnavailable` response shows the checker-unavailable banner and no per-rule errors; a built-in set renders read-only (no add/edit/delete controls; rule source viewable); a 403 `AUTO_QUARANTINE_EXECUTE_REQUIRED` toggle shows the friendly copy.
- [ ] **Step 2: Run to verify they fail** — vitest on both files. Expected: FAIL.
- [ ] **Step 3: Implement.** Rule list shows name, severity, tags, enabled, the stored `compileError` (from GET) inline. The editor dialog edits name / severity / tags / source (monospace textarea; no syntax highlighter dependency). After every mutation, re-fetch the set so `stale`, `currentVersion` and stored `compileError` reflect the server.
- [ ] **Step 4: Run** both test files plus `src/lib/__tests__/no-silent-mutations.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(web): rule set editor with honest publish outcomes and inline compile errors (#6267)`

### Task B3: IOC import panel

**Files:** Create `…/detectionRules/IocImportPanel.tsx`, `IocImportPanel.test.tsx`; modify `security.json` ×8 (`detectionRules.ioc.*`, one key per `YaraIocErrorCode`).

**Interfaces:** Consumes `parseIocText`, `generateIocRules` (Task A1), `importIocs` (Task B1), `describePublishOutcome` (Task B2).

- [ ] **Step 1: Write the failing tests:** pasting three lines shows a preview table (`ioc-preview-row-<n>`) with detected kinds and a kind selector per row; changing a row's kind re-runs validation; invalid lines show their error copy and are excluded from the count; the generated-rule preview (`ioc-generated-rule-<n>`) shows `source` text equal to `generateIocRules` output; Import posts `{ label, severity, iocs }` (structured, no `source`) and then follows the publish-outcome rules from Task B2; a 409 `IOC_BATCH_ALREADY_IMPORTED` shows the friendly "already imported" copy; over 1000 IOCs disables Import with the cap copy.
- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Help text states: exact match only, no wildcards; domains and IPs match file content, not network traffic; partial overlap with an earlier import is not deduplicated; hash IOCs make every scanned file be hashed in full, so full scans take longer (shown only when the batch has a hash).
- [ ] **Step 4: Run** the test + `localeParity`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(web): IOC paste importer with byte-identical preview (#6267)`

### Task B4: Test upload panel

**Files:** Create `…/detectionRules/RuleTestPanel.tsx`, `RuleTestPanel.test.tsx`; modify `security.json` ×8 (`detectionRules.test.*`).

- [ ] **Step 1: Write the failing tests:** choosing a file over 10 MiB shows the size error and sends nothing; a 200 renders `rule-test-match-<ruleName>` rows with tags and matched strings, and a "No rules matched" state for an empty list; the header says which version was tested and, when it is not the published one, "Testing your unpublished changes"; 422 `YARA_TEST_COMPILE_FAILED` lists the compile errors; 429 `YARA_TEST_BUSY` shows "Another test is running, try again in a few seconds"; 422 `YARA_TEST_NO_RULES` shows "This set has no enabled rules to test"; 503 `YARA_TEST_UNAVAILABLE` shows "The rule checker is unavailable, try again later"; 413 shows the size copy; 503 `YARA_TEST_SANDBOX_UNAVAILABLE` shows "File tests are not available on this server" and disables the panel; an optional "Path on device" field (`rule-test-filepath`) is sent as `filepath`; the request is `POST …/test?filename=<name>[&filepath=<path>]` with the raw file as body and `Content-Type: application/octet-stream`. The test is a read action, but it is a POST, so it goes through `runAction` with no success toast.
- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Copy states the file is scanned on the Breeze server and is not stored.
- [ ] **Step 4: Run** the test + `no-silent-mutations` + `localeParity`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(web): test a file against a rule set (#6267)`

### Task B5: Security tab rule-set picker

**Files:** Create `apps/web/src/components/configurationPolicies/featureTabs/RuleSetPicker.tsx`, `RuleSetPicker.test.tsx`; modify `SecurityTab.tsx`, its test, `apps/web/src/locales/*/policies.json` (`configurationPolicies.featureTabs.securityTab.ruleSets.*`).

**Interfaces:**
- `RuleSetPicker` props: `{ value: string[]; onChange(ids: string[]): void; policyOwner: { orgId: string | null; partnerId: string | null }; disabled: boolean; onBlockingChange(blocking: boolean): void }`.
- `FeatureTabProps` gains `partnerId?: string | null`: add it next to `orgId: policy?.orgId ?? null` in `ConfigPolicyDetailPage.tsx` `renderFeatureTab` (`policy.partnerId` is already loaded there), so a system-scope viewer never sees another partner's partner-wide sets as attachable. `attachableRuleSets` matches partner-wide sets on `set.partnerId === owner.partnerId` when it is known.
- `attachableRuleSets(sets: YaraRuleSetSummary[], owner): YaraRuleSetSummary[]` — exported, mirrors `checkSecurityRuleSetsWrite`.
- `SecurityTab` gains `ruleSetIds` editing; preselect per W04-4.

- [ ] **Step 1: Write the failing tests:**
  - `attachableRuleSets`: org policy for org A, viewed by a partner user who can see orgs A and B → A's sets + partner-wide + built-in, never B's; partner-wide policy → partner-wide + built-in only; disabled / unpublished / stale sets are included (with their badges).
  - `list fetch fails`: `ruleSetIds` unchanged, no `rule-set-unavailable-*` rows, `rule-set-picker-load-error` with Retry, rest of the tab still saves.
  - `empty selection`: shows the legacy-scan note `rule-set-picker-legacy-note`.
  - `override draft`: inherited link whose parent lists an id not attachable for this policy → clicking Override does not call `save`; the form becomes editable with the unavailable row and banner; removing it and clicking Save calls `save(null, …)` without that id. With no blocking id, Override saves at once (today's behaviour, existing test unchanged).
  - `preselects built-in on create`: no `existingLink`, no `parentLink`, list contains the built-in row → initial `ruleSetIds` = `[YARA_BUILTIN_RULE_SET_ID]`.
  - `no preselect for existing links`: `existingLink.inlineSettings.ruleSetIds = []` stays `[]`; with a `parentLink` (inherited) stays the parent's value; with no built-in row in the list stays `[]`.
  - `cap`: with 20 selected, unselected options are disabled.
  - `unavailable id`: a saved id not in the list renders `rule-set-unavailable-<id>` with a remove button, and Save is disabled with the reason until it is removed.
  - `gate error`: a save answered 400 `YARA_RULE_SET_NOT_ATTACHABLE` with `ruleSetIds` highlights those rows and shows the friendly copy.
  - Badges `rule-set-option-badge-all-orgs`, `…-builtin`, `…-errors`, `…-unpublished`, `…-disabled`.
- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add the `friendly` mappings for `TOO_MANY_RULE_SETS`, `INVALID_RULE_SET_IDS` and `YARA_RULE_SET_NOT_ATTACHABLE` in `useFeatureLink.ts`. The policy owner is `FeatureTabProps.orgId` (`featureTabs/types.ts:68`, `orgId?: string | null`): a string = org policy, `null` = partner-wide. It is optional, so first make sure the policy editor passes it to `SecurityTab` (grep the feature-tab render site); if it is still `undefined` at runtime, `attachableRuleSets` returns every visible set unfiltered and the server gate stays the authority — never guess partner-wide from `undefined`. Add a test for the `undefined` case; the override draft is local state in `SecurityTab` (`overrideDraft: boolean`), passed to `FeatureTabShell` as `isInherited={isInherited && !overrideDraft}`.
- [ ] **Step 4: Run** `RuleSetPicker.test.tsx`, `SecurityTab.test.tsx` and `localeParity`. Expected: PASS (W01/W03's 13 SecurityTab tests stay green).
- [ ] **Step 5: Commit** — `feat(web): rule-set picker on the Config Policy Security tab (#6267)`

### Task B6: ThreatDetail rule panel

**Files:** Create `apps/web/src/components/security/ThreatRulePanel.tsx`, `ThreatRulePanel.test.tsx`; modify `ThreatDetail.tsx`, `security.json` ×8 (`securityThreatDetail.rule.*`).

- [ ] **Step 1: Write the failing tests:** a YARA view renders rule name, set name with Built-in / All orgs badge and a link to `/security/detection-rules#<setId>`, tags, matched strings as text in a monospace list with offsets (a stored `\x00` shows as the four characters `\x00`, not re-escaped to `\\x00`), sha256 with copy button, the quarantine path labelled "Quarantined to (at scan time)", and "Auto-quarantine failed" when `quarantineFailed`; `ruleSet: null` renders "Rule set no longer available" and the id; `engine: 'legacy'` renders "Built-in signature (legacy scan)" and no rule fields; no version is shown; `ThreatDetail` given a threat id that is not in the first 100 list items still renders it (it loads `/details`).
- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** `ThreatDetail` loads the selected threat from `GET /security/threats/:id/details` (no longer from the first 100 list items) and passes `rule` to the panel; related threats still come from the list.
- [ ] **Step 4: Run** the test, `ThreatDetail`'s existing tests, `SecurityScansPage.test.tsx`, `localeParity`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(web): Rule panel on threat details (#6267)`

### Task B7: PR B gates and PR

- [ ] **Step 1:** `NODE_OPTIONS=--max-old-space-size=12288 pnpm --filter @breeze/web exec tsc --noEmit; echo exit=$?` → `exit=0`; `pnpm --filter @breeze/web exec astro check` if the repo's CI runs it.
- [ ] **Step 2:** web tests in batches: `src/components/security`, `src/components/configurationPolicies`, `src/lib`. Expected: PASS; record counts.
- [ ] **Step 3: Copy check** is a test, added in Task B1: `apps/web/src/locales/yaraCopyRule.test.ts` walks `security:detectionRules.*`, `security:securityThreatDetail.rule.*` and `policies:configurationPolicies.featureTabs.securityTab.ruleSets.*` in all 8 locales against a per-locale banned list (en: EDR, antivirus, anti-virus, real-time protection, prevention; plus each locale's translations, e.g. de `Virenschutz`, `Echtzeitschutz`; fr `antivirus`, `protection en temps réel`; es/pt `antivirus`, `tiempo real`/`tempo real`; it `antivirus`, `tempo reale`; tr `antivirüs`, `gerçek zamanlı`). Run it here; expected PASS.
- [ ] **Step 4: Browser check** on a per-worktree stack (`worktree-stack` skill): create a set, add a broken rule (warning, inline error, no success toast), fix it (success), import 3 IOCs, test the EICAR string against the imported set, attach it to a new policy (built-in preselected), open a threat's Rule panel if a scan produced one. Tear the stack down and say so.
- [ ] **Step 5: Open PR B** against `main`: title `feat(security): YARA W04b — Detection rules UI, IOC importer, test upload, rule-set picker (#6267)`, body `Part of #6263` / `Closes #6267`. One independent review round.

---

## Contract tests and CI jobs that fire

| Suite | Fires? | Why |
|---|---|---|
| `rls-coverage` | no new table → no change; still run (Integration Tests) | |
| `mcp-coverage` | yes | three new route modules (`yaraAccess.ts`, `yaraIocImport.ts`, `yaraTest.ts`) |
| `partner-wide-write-coverage` | yes, may need an allowlist line | `yaraIocImport.ts` inserts `yaraRules` (Task A2 Step 5) |
| `site-ceiling-write-coverage` | yes, may need an allowlist line | same |
| `aiToolsSiteScope` | no | no AI tool (W05) |
| `workerReadiness` | no | no job, no worker |
| `no-silent-mutations` | yes | every PR B mutation |
| `localeParity` | yes | new keys ×8 |
| `bodyLimit` / `selfManagedDbContextRoutes` unit tests | yes | Task A4 |
| Test Agent (`go test -race`) | yes | Task A3 |
| `yara-pack-fp` / `pack.lock` check | must stay green with no lock bump | `yarac.go` untouched |

`pnpm test` does not run the integration suites; run them on a test stack (Task A2 Step 6, Task A6
Step 3). PR B is not stacked on PR A — it branches from `main` after PR A merges, so CI runs.

## Exit checklist

- [ ] No migration, no new table; `git diff origin/main --stat -- apps/api/migrations` is empty.
- [ ] No change to `agent/internal/yarascan/yarac/yarac.go`; `build-pack.sh --check-lock` passes.
- [ ] `tsc --noEmit` exit 0 for api, shared, web (12 GB heap, exit code read directly).
- [ ] Every new route: role gate, tenancy test, audit event, mcp-coverage entry.
- [ ] Test upload holds no DB transaction across the child; sample never written to disk; Landlock applied inside the production image (exit 0, not 3); peak RSS recorded and ≤ 1 GiB.
- [ ] Hash benchmark table in PR A's body.
- [ ] Editor never shows a success toast for `published: false` or `stale: true`.
- [ ] Picker preselects the built-in pack only on a new security link.
- [ ] 8 locales, `localeParity` green, no §11 banned word in new copy.
- [ ] Each PR had one independent review round with its summary posted.

## Deferred

- **Sweep now** (spec §8) → W05 (#6268) with the `sweep` route.
- **AI tool actions** for rule sets, import and test → W05; W04 routes are `tool_in_later_wave`.
- Playwright E2E for the Detection rules page: `data-testid`s are in place; a spec is owed to the
  next pre-release sweep.
- Partial-overlap IOC dedupe across batches (needs parsing stored rules or an IOC table).
- Per-IOC attribution of hash hits (the threat's `sha256` already identifies the file).
- **W03 follow-up (file an issue, not W04 scope):** `POST /yara/rule-sets/:id/rules` counts rules
  before `publishRuleSet` locks the set, so two concurrent creates can exceed 500. W04's import locks
  first; the single-rule route should too.
- **W03 follow-up:** the same Landlock + `oom_score_adj` hardening for `breeze-yarac validate`, which
  also runs author-controlled input (rule source) inside the API container. Kept out of W04 because
  `validate` must fail closed today and a Landlock miss would block every publish.
- Rule version at detection time on the threat (needs the agent to report it — a wire change with a
  `MIN_AGENT_VERSION_*` gate).

## Decisions for Todd

Defaults are what this plan is written to; each changes in one place.

1. **Where the test upload runs.** Default: in the API container, in a Landlock-sandboxed
   `breeze-yarac match` child that is the preferred OOM victim, one at a time per instance, fail
   closed when Landlock is unavailable. Alternative (Codex's preference for memory): a separate,
   memory-limited, network-less sandbox container — stronger isolation, but a new compose service on
   every hosted and self-hosted deployment. Recommend the default: the feature is admin-only, rate-limited,
   single-flight, and the Landlock + OOM measures close the file-read and API-kill paths; the
   separate container stays the fallback if Task A6 Step 4 shows Landlock is blocked in the image or
   peak RSS exceeds 1 GiB.
2. **Landlock on production hosts.** The default needs Linux ≥ 5.13 with Landlock enabled, and Docker's
   default seccomp profile allowing the three `landlock_*` syscalls. Task A6 Step 4 proves the image;
   someone must confirm the production host kernels before PR A deploys (a miss shows "File tests are
   not available on this server", it does not break anything else).
3. **IOC import path.** Default: set-scoped `POST /security/yara/rule-sets/:id/ioc-import` instead of
   the spec's `POST /yara/ioc-import`. Same operation; no behavioural difference.

## Quorum record

**2026-10-18 — Claude position, then Codex `gpt-6-astra`, `model_reasoning_effort="xhigh"`,
read-only, against this worktree at `58eb7ba317`.** Codex probed the real `breeze-yarac` binary.

| Decision | Codex | Resolution |
|---|---|---|
| W04-1 IOC importer | DISAGREE as written | All corrections adopted: 4-byte minimum is an FP floor, not the slow-pattern threshold (`"ab"` compiles); `nocase` for domains to match case-insensitive dedupe; UTF-16LE hex pattern for non-ASCII instead of `wide` over UTF-8 escapes; editable classification and an executable-extension list for `name.ext`; sort before chunking; 64-bit name hash plus `IOC_RULE_NAME_TAKEN` vs `IOC_BATCH_ALREADY_IMPORTED`; ≤ 128-char names; lock the set before counting. Confirmed: `iequals` and `hash.*(0, filesize)` compile under the W02 policy. |
| W04-2 Test upload | AGREE API-side and draft testing; DISAGREE on containment | Adopted: Landlock deny-all + `no_new_privs` + `oom_score_adj` (the guest mounts host `/`, `runtime_client.go:252`); `GOMEMLIMIT` dropped as a control; non-queueing admission before the body is read; release after child exit; disconnect kills the child; one-statement snapshot (not `FOR SHARE`, which RLS hides for read-only sets); `version = max(currentVersion, 1)`; `testedDigest`; virtual `filepath`. **Not adopted:** a separate sandbox container — surfaced to Todd as Decision 1 with the default above. |
| W04-3 Publish UX | AGREE with corrections | Adopted: `successMessage` returns `''` (typed `string`); absent `publish` = plain "Saved"; first-match order with `autoQuarantineOnly` first; never-published and disabled branches; line numbers only right after a save. |
| W04-4 Picker | DISAGREE as written | Adopted: filter by the policy owner, not the viewer; disabled / unpublished / stale stay attachable with badges; a failed list fetch never implies deletion; empty selection = legacy note; override draft for inherited links holding an unavailable id. |
| W04-5 ThreatDetail | AGREE | Adopted: copy both org and site checks; `requireSecurityReadAccess`; type-check every field; no double escaping; `quarantineFailed`; quarantine path labelled scan-time; route widened to `/threats/:id/details` so the panel is not limited to the first 100 list items; no version claimed. Also adopted: benchmark hash IOCs (caching in the Rust `hash` module is unverified). |

No disagreement is left open except Decision 1, which has a recommended default.
