---
tracking_issue: LanternOps/breeze#6263
---
# YARA IOC scanning and live security policy — design

Status: **drafted 2026-09-18**, direction agreed with Todd in session (wasm engine, reuse the
existing scan UI and Config Policy Security tab, position as IOC sweeps not EDR).
Advisor quorum: Fable position formed; codex gpt-6-astra xhigh review **deferred** — the
Codex subscription is rate-limited until 2026-09-19 11:38. Run it before W02 starts and
record the outcome in §14.
Tracking: LanternOps/breeze#6263 (waves #6264 W01, #6265 W02, #6266 W03, #6267 W04, #6268 W05).
Plan: `docs/superpowers/plans/security-auth/2026-09-18-yara-ioc-scanning.md` (index, one plan
per wave; written after this spec is approved).

## 1. Problem and goal

Breeze ships a near-complete malware-scan feature that does nothing useful:

- `agent/internal/security/threats.go` matches four XOR-obfuscated hardcoded signatures
  (EICAR, a credential dumper, a C2 beacon, a banking trojan family).
- `SecurityScanManager`, `ThreatList` and `ThreatDetail` in `apps/web/src/components/security/`
  are fully wired to live routes but **mounted on no page**. The EDR page shows only
  SentinelOne and Huntress lists.
- The Config Policies **Security tab** (`featureTabs/SecurityTab.tsx`) saves scan schedule,
  auto-quarantine, exclusions and several toggles into `security_policies.settings`, and
  **nothing reads them**: no scheduler dispatches the scan, the agent never receives the
  settings, and the "real-time protection / behavioral monitoring / cloud lookup" toggles have
  no engine behind them.
- `QuarantineThreat` is a plain `os.Rename` into a directory: quarantined files stay live
  malware on disk, which other AV products will rescan and re-alert on.

Goal: make the existing surfaces real by replacing the signature table with a YARA engine,
enforcing the Security tab's schedule and exclusions, and letting partners bring their own
IOC rules and sweep the fleet with them in minutes. This is Breeze's first first-party
detection content.

**Non-goals (explicit):** real-time file-system watching, kernel drivers, process-memory
scanning, behavioral detection, process kill / host isolation. Breeze remains the pane of
glass over Huntress / SentinelOne / Defender; this feature is threat hunting and IOC
sweeps, and must not be described as EDR anywhere in UI, docs or marketing (§11).

## 2. What exists today (verified 2026-09-18)

| Layer | Surface | State |
|---|---|---|
| Agent | `internal/security/scanner.go`, `threats.go` | walk + 4 signatures, quick/full/custom path sets, rename-quarantine |
| Agent | `internal/heartbeat/handlers_security.go` | `CmdSecurityScan {scanType, scanRecordId, paths, triggerDefender}` → `{threats[], threatsFound, status}` |
| Agent | `internal/remote/tools/sensitive_data_scan.go` | the better walk: worker pool, 64 KB streaming, caps, timeouts, partial results |
| API | `routes/security/scans.ts` | inserts `security_scans`, queues the command |
| API | `routes/agents/helpers.ts:596-660` | result handler updates the scan row, inserts `security_threats` |
| API | `security_policies` | org XOR partner (migration `2026-07-01-security-policies-partner-ownership.sql`), `settings` jsonb |
| API | `jobs/sensitiveDataJobs.ts` | reference scheduler: 60 s policy tick → dispatch jobs → `queueCommand` |
| Web | `components/security/{SecurityScanManager,ThreatList,ThreatDetail}.tsx` | built, unmounted |
| Web | `configurationPolicies/featureTabs/SecurityTab.tsx` | built, inert |
| AI | `aiToolsSecurity.ts` `security_scan` (Tier 3) | actions scan/status/quarantine/remove/restore/vulnerabilities |
| Build | `release.yml` matrix | linux + windows agents `CGO_ENABLED=0`; darwin cgo only for ScreenCaptureKit |

## 3. Decisions

- **D1 Engine = YARA-X via wasm.** `github.com/niallnsec/yaraxwasm` (MIT, v1.1.0, embeds the
  YARA-X guest module, runs under wazero). Pure Go, so the CGO=0 build matrix, cross-compiled
  Windows agent, govulncheck and CodeQL jobs are untouched. Both official bindings
  (`hillu/go-yara`, `VirusTotal/yara-x/go`) need cgo and are rejected. The engine sits behind a
  Go interface (`security.Matcher`) so a native `breeze-scanner` sidecar (same build pattern as
  `breeze-backup`) can replace it later without touching callers. **Gate:** W02 ships a
  benchmark of a full scan on the Windows lab rig; if wall-clock is dominated by CPU rather
  than IO, the sidecar becomes a follow-up wave rather than a rewrite.
- **D2 Rules are compiled server-side and shipped as YARA-X serialized bytecode**, never as
  source in the agent binary or on disk in plaintext. This is what keeps the agent off
  VirusTotal (issue #2797 precedent; CI guard `scripts/security/check-agent-binary-signatures.sh`)
  and rejects malformed or dangerous rules before they reach a device.
- **D3 Rule ownership rides the existing `security` feature type.** No new config feature
  type, no enum / parity churn. New tables `yara_rule_sets` (org XOR partner) and
  `yara_rules` (child). A `security_policies.settings.ruleSetIds[]` field attaches rule sets
  to a policy. The built-in pack is a rule set with `partner_id NULL, org_id NULL, is_builtin
  true`, readable by everyone via a SELECT-only RLS branch and never editable.
- **D4 The Security tab becomes honest.** Kept and enforced: scheduled scan (cron), scan
  type, exclusions, auto-quarantine, notify user. Renamed to "Detection rules": rule-set
  picker. **Removed** from the tab: real-time protection, behavioral monitoring, cloud lookup,
  block untrusted USB (USB belongs to peripheral_control). Values already saved in
  `settings` are ignored, not migrated.
- **D5 Scheduling is server-driven** (clone of `sensitiveDataJobs.ts`), not an agent-side
  cron. Devices get one scan command per due policy, with org and device concurrency caps and
  backpressure. Fan-out for partner-wide policies goes by the device org's partner (CLAUDE.md
  §Partner-Wide First step 5).
- **D6 Quarantine neutralizes.** Quarantined files are stored XOR-0x5A encoded (reuse
  `internal/obfuscate`) with a `.bqz` extension and a sidecar JSON manifest (original path,
  sha256, rule, timestamp). Restore decodes. Existing plain-rename quarantine entries remain
  restorable (manifest absent → treat as plain). Fixes the AV rescan loop.
- **D7 Auto-quarantine defaults off for custom rule sets and on only for the built-in pack.**
  A custom rule can quarantine legitimate files fleet-wide; the blast radius is the reason.
- **D8 Positioning: IOC scanning / threat hunting.** UI copy, docs, the AI system prompt and
  release notes say "IOC scan" / "detection rules", never "EDR" or "antivirus".
- **D9 Findings land in `security_threats`** with `provider = 'breeze'` (new enum value) and
  `details = {ruleName, ruleSetId, tags, matchedStrings[≤10], offsets, sha256, packVersion}`.
  No new findings table.

## 4. Data model

```sql
-- new, org XOR partner, copy the security_policies migration shape
yara_rule_sets (
  id uuid pk, org_id uuid null → organizations, partner_id uuid null → partners,
  name varchar(255), description text, source varchar(50),        -- 'builtin' | 'custom' | 'import'
  is_builtin boolean default false, enabled boolean default true,
  auto_quarantine boolean default false,
  compiled bytea null,            -- YARA-X serialized rules, rebuilt on every rule change
  compiled_version integer default 0, compiled_at timestamptz,
  rule_count integer default 0, created_by uuid → users, created_at, updated_at,
  CONSTRAINT yara_rule_sets_one_owner_chk CHECK (is_builtin OR ((org_id IS NULL) <> (partner_id IS NULL)))
)
yara_rules (
  id uuid pk, rule_set_id uuid → yara_rule_sets ON DELETE CASCADE,
  org_id uuid null, partner_id uuid null,      -- denormalized from the set for RLS shape 1/3
  name varchar(255), source text,              -- the rule text, one rule per row
  severity threat_severity default 'high', tags text[], meta jsonb,
  enabled boolean default true, compile_error text null,
  created_at, updated_at
)
yara_scan_findings: NOT created — see D9.
security_threats.provider enum += 'breeze'
```

Registration (mechanical, all required): both tables into `CORE_ORG_CASCADE_DELETE_ORDER`,
`CORE_TENANT_EXPORT_POLICY` (`compiled` and `meta` are `excludedOpen`; `source` is
`included`), `DUAL_AXIS_TENANT_TABLES` + partner-wide SELECT branch migration, and the
`org_lifecycle` merge contract (no composite FK to `org_id` planned, so no deferrable
constraint needed). Built-in rows with both owner columns NULL need their own SELECT-only
policy `USING (is_builtin)`; write access to them is system-scope only.

`security_policies.settings` additive fields:

```jsonc
{
  "scanType": "quick" | "full",           // existing scheduledScans + cron fields kept
  "ruleSetIds": ["<uuid>", …],             // attached sets; built-in pack id allowed
  "autoQuarantine": true,                  // existing, now enforced per D7
  "exclusions": ["C:\\Backups", …],        // existing, now shipped to the agent
  "maxFileSizeMb": 50, "scanTimeoutMinutes": 120
}
```

## 5. Rule compilation and delivery

1. On any rule change the API recompiles the set with YARA-X (server-side via the same
   `yaraxwasm` guest run under Node? **No** — the API compiles by calling the agent-side
   compiler contract: a small Go binary `breeze-yarac` built from the agent module and
   invoked by the API container, so agent and server agree on bytecode format byte for byte.
   Alternative considered: compile on the agent from source. Rejected: plaintext rules on
   disk on customer machines, and every device pays compile cost).
2. Compile errors are stored per rule (`compile_error`) and shown inline; a set with any
   erroring rule keeps its **last good** bytecode and flags the set as stale in the UI.
3. Banned at compile: `console` module, `include` directives, external variables other than
   `filename`, `filepath`, `extension`, `filesize`. Caps: 500 rules per set, 20 sets per
   policy, 64 KB source per rule, 10 000 strings total per compiled set.
4. Delivery: the scan command payload carries `ruleSets: [{id, version, sha256, url}]`. The
   agent fetches bytecode from `GET /agents/yara/rule-sets/:id/:version` (device-authenticated,
   ETag), caches under the agent data dir keyed by sha256, and reuses across runs. Payload
   size stays small; the built-in pack (~1–3 MB) is fetched once per version.
5. Built-in pack: sourced from **YARA Forge core tier**, filtered to permissive licenses
   (Apache/MIT/BSD/CC0; **no** Elastic License, no DRL, no GPL), reviewed in
   `scripts/security/yara-pack/` with a clean-corpus false-positive run in CI, published as a
   release artifact in the signed release manifest, and inserted/updated as the built-in set
   by `binarySync` on API boot. Out-of-band hot advisories: a platform admin can push a
   pack version without an agent release.

## 6. Agent

- New package `agent/internal/yarascan`: `Matcher` interface, `yaraxwasm` implementation,
  compiled-rules cache, one scanner per worker goroutine (instantiation is the expensive
  path), `SetTimeout`, `MaxMatchesPerPattern`.
- `internal/security/threats.go`: `detectThreats` gains a `Matcher` parameter; the legacy
  signature table becomes the fallback only when no rule set is attached (keeps the CI
  binary-signature guard relevant). The walk itself is lifted from
  `sensitive_data_scan.go`: worker pool (default 4, cap `NumCPU`), size cap, type prefilter
  (skip archives >X, media, VM disks by default; configurable), exclusions, per-scan timeout,
  partial-result reporting with `status: 'timed_out'`.
- Scan command payload additions: `ruleSets[]`, `exclusions[]`, `maxFileSizeMb`,
  `timeoutMinutes`, `autoQuarantine`. Result additions per threat: `ruleName`, `ruleSetId`,
  `tags`, `matchedStrings`, `sha256`, `quarantinedTo`.
- Quarantine per D6. All paths through `tools.EnforcePathContainment` as today.
- Low-priority I/O: `IDLE_PRIORITY_CLASS` on Windows, `nice`/`ionice`-equivalent on
  Linux/macOS, so a full scan never competes with the user or with Defender.

## 7. API

- `routes/security/yara.ts`: CRUD for rule sets and rules (`ownerScope` on create,
  `canManagePartnerWidePolicies` gate for partner sets), `POST /yara/rule-sets/:id/test`
  (upload ≤ 10 MB, run the set, return matches), `POST /yara/rule-sets/:id/sweep`
  (dispatch an immediate custom scan to every device covered by the policies that attach
  the set, or an explicit org/device list; returns a sweep id = `security_scans` batch).
- `POST /yara/ioc-import`: plain IOC list (hashes, filenames, strings, one per line or JSON)
  → generated rule(s) → into a set. This is the "paste an advisory" path.
- `jobs/securityScanJobs.ts`: clone of `sensitiveDataJobs.ts` (60 s policy tick, cron due,
  concurrency caps, partner fan-out). Existing `POST /security/scan/:deviceId` learns to
  resolve the device's effective security policy and attach its rule sets.
- Result handler: extend the existing threat insert with D9 details; auto-quarantine
  actions the agent already took are recorded as `status: 'quarantined'`.
- AI: `security_scan` gains actions `sweep` (rule set + org scope, Tier 3, existing
  3/10 min rate limit) and `list_rule_sets`; the six parity files listed in
  `aiToolsSecurity.ts` conventions are updated together. New MCP tool surface goes through
  the MCP program (#6161) registry rather than ad hoc.
- Audit: every rule / set change and every sweep writes an audit event.

## 8. Web

- **Security → Scans** page (new `pages/security/scans.astro`): mounts the existing
  `SecurityScanManager` and `ThreatList`; `ThreatDetail` gains a "Rule" panel (name, set,
  tags, matched strings) and a "Restore" action.
- **Security → Detection rules** page: rule set list with owner badge ("All orgs" pattern
  from `software/PolicyForm.tsx`), set editor (rule list, inline compile errors, test upload,
  IOC paste importer), "Sweep now" with a scope picker and a confirmation stating device
  count.
- **Config Policy Security tab**: fields per D4; rule-set multi-select; the removed toggles
  are gone, not hidden.
- EDR page: unchanged, plus a one-line link "Looking for Breeze IOC scans? →".

## 9. Security considerations

- Rules are code from techs running on customer machines: compile server-side, bans and caps
  per §5, timeout per scan, no writes except quarantine, partner sets editable only by
  partner admins, org users cannot see other orgs' custom sets (RLS), built-in set read-only.
- Bytecode fetch is device-authenticated and sha256-pinned in the payload; the agent refuses
  a mismatch.
- Matched strings in `details` may contain fragments of customer files; cap to 10 strings ×
  128 bytes and run through the existing ingest redaction (#2434 note in the handler).
- `compiled` (bytea) and `meta` (jsonb) are `excludedOpen` in the export policy.
- Quarantine directory is excluded from scans (already) and should be documented as an AV
  exclusion path for partners who run a second AV.

## 10. Performance budget and gates

- Quick scan (Temp / Downloads / autoruns) with the core pack: ≤ 2 minutes, ≤ 25 % of one
  core on the Windows lab rig `WIN-IMDR2GAIDMV`.
- Full scan: bounded by `scanTimeoutMinutes` (default 120), partial results reported.
- W02 publishes wasm vs native numbers; the sidecar decision is made on those.

## 11. Positioning and copy rules

Allowed: "IOC scan", "detection rules", "threat hunting", "malware scan (signature-based)".
Not allowed: "EDR", "antivirus", "real-time protection", "prevention". Insurance and
compliance questionnaires ask for EDR/MDR specifically; a customer who ticks that box on the
strength of Breeze scans is exposed, and so is Breeze.

## 12. Waves

| Wave | Title | Scope |
|---|---|---|
| W01 | Live security policy and scan UI | `securityScanJobs.ts` scheduler, exclusions / autoQuarantine / timeout shipped to the agent, Security tab per D4 (minus rule-set picker), Scans page mounting the existing components, D6 quarantine encoding. Legacy signatures still the matcher. Proves the pipeline end to end. |
| W02 | YARA-X engine in the agent | `internal/yarascan`, matcher swap, worker-pool walk, bytecode cache + fetch route, benchmark on the lab rig, sidecar go/no-go recorded. |
| W03 | Rule sets, compile service and built-in pack | Tables + RLS + all registration lists, `breeze-yarac`, CRUD routes, YARA Forge pack pipeline with license filter and clean-corpus CI, binarySync insert, `provider = 'breeze'`. |
| W04 | Detection rules UI and IOC import | Detection rules page, set editor with compile errors and test upload, IOC paste importer, Security tab rule-set picker, ThreatDetail rule panel. |
| W05 | Fleet sweep, AI tool and audit | `sweep` route + batch tracking, AI `security_scan` actions + parity files, audit events, docs pass (`update-breeze-docs`), release notes copy per §11. |

W01 and W02 are independent and can run in parallel. W03 depends on W02 (bytecode format).
W04 and W05 depend on W03.

## 13. Open questions

- Q1 Does `yaraxwasm` expose the `pe`, `elf`, `hash`, `math` modules? Public packs rely on
  them; if absent, the pack filter must drop rules importing them and the sidecar decision
  moves earlier. Verify in W02's first task.
- Q2 `breeze-yarac` in the API image: adds a Go binary to the API Dockerfile. Alternative is
  compiling on the agent from source shipped over TLS and never written to disk; revisit if
  the image change is unwelcome.
- Q3 Hot advisory push without an agent release: platform-admin only, or partner-level
  "subscribe to a feed URL"? Deferred to after W03.

## 14. Quorum record

Pending. Codex xhigh read-only review to be run before W02; expected challenge areas: D1
(wasm vs sidecar now), D3 (riding `security` vs a new feature type), §5 step 1 (where to
compile).
