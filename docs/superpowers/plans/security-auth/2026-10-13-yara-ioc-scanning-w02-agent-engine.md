---
tracking_issue: LanternOps/breeze#6263
---
# YARA IOC Scanning W02: YARA-X engine in the agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent can take a list of rule-set references from a `security_scan` command, fetch each
set's rule **source bundle** over device-authenticated TLS, verify it against a sha256 pin, compile it
**on the device** with YARA-X (wasm, pure Go), cache only the compiled form, and scan files with a
worker pool — reporting rule-level detail per threat — while every agent that receives no rule sets
keeps behaving exactly as W01 left it.

**Architecture:** Two new agent packages. `internal/yarascan/yarac` is **`breeze-yarac`**: the one
place rules are validated and compiled (bans, caps, namespaces), wrapping
`github.com/niallnsec/yaraxwasm`. `internal/yarascan` holds the wire contract (`Bundle`,
`RuleSetRef`), the HTTPS fetcher, the obfuscated compiled-rules cache, and the `Matcher` interface
with a YARA implementation. `internal/security` gets a worker-pool walk that drives any `Matcher`;
the legacy XOR signature table becomes the `legacyMatcher` used when no rule set is usable. A thin
CLI `agent/cmd/breeze-yarac` (`validate | compile | scan`) wraps the same `yarac` package for CI, the
W03 server-side pre-check, and the lab benchmark. The API side of this wave is deliberately small:
one enum value (`security_provider += 'breeze'`) and correct provider attribution at ingest.

**Tech Stack:** Go 1.26 (agent, `CGO_ENABLED=0` on linux/windows), `github.com/niallnsec/yaraxwasm`
(YARA-X guest under `github.com/tetratelabs/wazero`), TypeScript (Hono, Drizzle), Vitest, Go
`testing` with `-race`.

**Spec:** `docs/superpowers/specs/security-auth/2026-09-18-yara-ioc-scanning-design.md` — read §3
D1/D2/D7/D9, §5, §6, §9, §10, and **§14 (quorum record + 2026-10-13 owner decision)** before
starting. Plan index: `docs/superpowers/plans/security-auth/2026-09-18-yara-ioc-scanning.md`
("Cross-wave names that must not drift"). W01 plan (shipped, PR #6573):
`docs/superpowers/plans/security-auth/2026-09-18-yara-ioc-scanning-w01-live-policy.md`.


**Open Decisions:** numbered list with recommendations in the plan index
(`2026-09-18-yara-ioc-scanning.md` → "Open Decisions for W02/W03"). This plan is written to the
recommendations.

---

## Global Constraints

- **Owner decision 2026-10-13 is binding and supersedes spec D2 and §5 step 1:** rules are compiled
  **in the agent** by `breeze-yarac` (Go, YARA-X). The server never produces or ships compiled rules.
  Rule **source** crosses the wire (TLS, device-authenticated, sha256-pinned); the agent never
  explicitly persists it (it lives in process memory for the duration of a compile — swap and crash
  dumps are outside that guarantee, so never describe it as "never on disk"). Any server-side validator
  is a pre-check only (W03).
- **Engine:** `github.com/niallnsec/yaraxwasm` pinned to the exact version Task 1 records (v1.1.0 is
  the newest at plan time — `go list -m -versions github.com/niallnsec/yaraxwasm`). No cgo engine
  (`hillu/go-yara`, `VirusTotal/yara-x/go`) — the linux/windows agents build with `CGO_ENABLED=0`.
- **No rule text, malware token, or test-file signature in Go source or in any built binary.** Test
  fixtures use invented benign markers (`breeze_yara_fixture_marker_7f3a`) in `testdata/` files only.
  `scripts/security/check-agent-binary-signatures.sh --source` and the binary mode must stay green on
  `breeze-agent` **and** the new `breeze-yarac`.
- **Back-compat on the wire (index "Cross-wave names"):** payload keys `scanRecordId`, `scanType`,
  `paths`, `triggerDefender`, `exclusions`, `maxFileSizeMb`, `timeoutMinutes`, `autoQuarantine` keep
  their names and meaning. W02 adds **only** `ruleSets: [{id, version, sha256, url}]`. Result keys
  `scanRecordId`, `scanType`, `durationMs`, `threatsFound`, `threats`, `status`, `filesScanned`,
  `timedOut`, `partial` keep their names. W02 adds result keys `engine` and `ruleSetErrors`, and per
  threat `ruleName`, `ruleSetId`, `ruleId`, `tags`, `matchedStrings`, `sha256`.
- **Empty or absent `ruleSets` ⇒ byte-identical W01 behaviour** (same matcher, same result shape plus
  `engine: "legacy"`). This is what lets W02 merge before any server sends rule sets.
- **Matched-string cap is enforced agent-side:** ≤ 10 matched strings per threat, each ≤ 128 source
  bytes, non-printable bytes escaped `\xNN`. The API redacts again at ingest (`redactSecretsDeep`,
  already in place).
- **Quarantine manifest:** writes `"v": 2` (adds `ruleName`, `ruleSetId`); reads `1` and `2`. The
  `.bqz` / `.bqz.json` names do not change.
- **Exactly one migration:** `ALTER TYPE security_provider ADD VALUE IF NOT EXISTS 'breeze';` named to
  sort after the newest committed migration at implementation time (newest at plan time:
  `2026-12-27-120000-ticket-mailbox-transient-poll-failures.sql`; the date block `2026-08-06` is
  closed). Read `apps/api/migrations/README.md` first.
- **Agent rigor:** `cd agent && go test -race ./...`, `golangci-lint run ./internal/security/...
  ./internal/yarascan/... ./cmd/breeze-yarac/...`, `GOOS=windows go vet ./...`,
  `GOOS=darwin go vet ./...`. Every exported function that can panic inside `yaraxwasm`
  (e.g. `NewScanner` panics on guest failure) is called behind `recover`.
- **Copy rule (spec §11):** no new user-visible string says "EDR", "antivirus", "real-time
  protection" or "prevention". Log lines and error strings say "IOC scan" / "detection rules".
- **Never run a lab Breeze agent on a host that has the installed agent** (benchmark task).

## The W02 → W03 format contract (W03 consumes this verbatim)

This section is the contract the owner decision says W03 depends on. W03 must not change any of it
without a `v` bump handled on both sides.

### C1. Scan command payload entry (API → agent)

```jsonc
"ruleSets": [
  {
    "id": "6f1d…-uuid",            // yara_rule_sets.id (W03); the built-in pack has a fixed id
    "version": 7,                    // integer ≥ 1, monotonically increasing per set
    "sha256": "<64 lowercase hex>",  // sha256 of the EXACT bundle response body bytes (C2)
    "url": "/api/v1/agents/<agentId>/yara/rule-sets/<id>/7"  // server-relative path ONLY
  }
]
```

- At most **20** entries (spec §5.3 cap). The agent rejects the whole `ruleSets` value (falls back to
  legacy, reports `ruleSetErrors[{id:"*", code:"invalid_refs"}]`) when it is not an array of objects
  with exactly these four keys of these types.
- `url` must start with `/api/v1/agents/` and contain no `..`, `?`, `#`, `\`, or scheme. The agent
  joins it to its configured server URL; it never follows an absolute URL from the payload and never
  follows redirects to another host.

### C2. Bundle (agent fetch response body, W03 serves it)

`GET <url>` with `Authorization: Bearer <agent token>`, response `200`,
`Content-Type: application/vnd.breeze.yara-bundle+json`, `ETag: "<sha256>"`, body ≤ **16 MiB**:

```json
{"format":"breeze-yara-bundle","v":1,"ruleSetId":"<uuid>","version":7,"autoQuarantine":false,"rules":[{"id":"<uuid>","name":"rule_identifier","severity":"high","source":"rule rule_identifier { … }"}]}
```

- Canonical serialization (W03's builder must reproduce it byte for byte): UTF-8, no BOM, no
  whitespace outside strings, keys in exactly the order shown, `rules` sorted by `id` ascending,
  JavaScript `JSON.stringify` string escaping. The golden fixture
  `agent/internal/yarascan/testdata/bundle-v1.golden.json` (+ `.sha256`) created in Task 2 is the
  executable form of this rule; W03 Task 4 asserts its builder emits exactly those bytes.
- `severity ∈ {low, medium, high, critical}` (the `threat_severity` enum values).
- Each `source` holds **exactly one** rule whose identifier equals `name`; `name` is unique within
  the bundle. The agent compiles each bundle into its own YARA namespace = `ruleSetId`.
- Error statuses the agent must handle: `304` (only if it sent `If-None-Match`; not used in W02),
  `404` (set deleted or not visible to this device), `409` (`version` is no longer current — the set
  changed after dispatch), `5xx`. All are per-set failures, never a scan failure.

### C3. Result additions (agent → API)

```jsonc
{
  "engine": "yara" | "legacy",
  "ruleSetErrors": [ { "id": "<uuid>|*", "version": 7, "code": "fetch|http_404|http_409|sha256_mismatch|bundle_invalid|compile|invalid_refs|engine_unavailable", "detail": "≤ 512 chars" } ],
  "threats": [ {
    "name": "rule_identifier", "type": "malware", "severity": "high", "path": "C:\\…",
    "quarantinedTo": "", "quarantineFailed": false,
    "ruleName": "rule_identifier", "ruleSetId": "<uuid>", "ruleId": "<uuid>",
    "tags": ["apt", "loader"],
    "matchedStrings": [ { "id": "$a", "offset": 1024, "data": "MZ\\x90\\x00…" } ],
    "sha256": "<file sha256, empty if the file exceeded the hash cap>"
  } ]
}
```

- `type` comes from the rule's `meta: threat_type = "…"` when it is one of
  `malware | trojan | ransomware | pup | exploit | hacktool | webshell | suspicious`, else `"malware"`.

### C4. Compiled-rules cache (agent-private — W03 must NOT depend on it, listed so nobody else invents one)

- Directory `<config.GetDataDir()>/yara/cache/`, mode `0700`; files `<key>.byrc`, mode `0600`.
- `key = sha256(hex)` of `"byrc1\n" + engineVersion + "\n" + policyVersion + "\n" + GOOS + "/" + GOARCH + "\n" + join(sorted "<bundle sha256>@<ruleSetId>", "\n")`
  (`policyVersion` = `yarac.PolicyVersion`, bumped whenever C5 changes, so a policy change can never
  be served a binary compiled under the old one).
- The cache directory and each entry are `os.Lstat`-checked: a symlink at either is deleted, never
  followed. Reads are bounded (header ≤ 8 MiB, file ≤ 64 MiB).
- File layout: `"BYRC"` (4 bytes) · `uint16 BE format = 1` · `uint32 BE headerLen` · header JSON ·
  payload = XOR-0x5A(`Rules.WriteTo` bytes) · trailing 32-byte sha256 of the **un-XORed** payload.
  Header JSON: `{"key": "...", "engine": "...", "goos": "...", "goarch": "...", "createdAt": "RFC3339",
  "rules": {"<ruleSetId>:<name>": {"ruleId": "...", "severity": "..."}}, "autoQuarantine": {"<ruleSetId>": bool}}`.
- Any mismatch (magic, format, key, engine, arch, trailing hash) ⇒ delete the file and recompile.
  At most **16** entries; least-recently-used beyond that are deleted after each successful store.
- The XOR is an AV-recognition break (compiled rules contain literal pattern bytes), not
  confidentiality — same rationale as `.bqz` (spec D6).

### C5. Compile policy (enforced by `yarac` on the agent; W03's pre-check calls the same code)

- `yarac.PolicyVersion = 1`. Banned modules: `console`. Includes **explicitly** disabled
  (`EnableIncludes(false)` — upstream yaraxwasm defaults includes **on**, `compiler.go:261` at v1.1.0).
  Globals defined (and the only ones allowed):
  `filename`, `filepath`, `extension` (strings, set per file at scan time). `filesize` is built-in.
- `ErrorOnSlowPattern(true)`, `ErrorOnSlowLoop(true)`.
- Caps: ≤ 500 rules per bundle, ≤ 64 KiB source per rule, ≤ 10 000 string definitions per bundle
  (counted from compiled rule patterns, not by regex), bundle ≤ 16 MiB.
- A bundle with **any** failing rule is rejected whole on the agent (`code: "compile"`) — the server's
  pre-check (W03) prevents that state from being dispatched; the agent check is the backstop.
- The per-rule error JSON emitted by `breeze-yarac validate` (Task 4) is
  `{"ok": bool, "errors": [{"ruleId": "...", "name": "...", "code": "...", "message": "...", "line": n}]}` —
  W03's pre-check parses exactly this.

---

## Review Focus

1. **A rule set that compiled on the server pre-check fails on the agent** (engine version skew after
   an agent upgrade lags a server upgrade). Expected: that set lands in `ruleSetErrors` with
   `code: "compile"`, the remaining sets still scan, and the scan completes — never a failed command.
   Test lives in Task 6 (`TestLoadMatcherIsolatesFailingBundle`).
2. **The API sends `ruleSets` to an agent that predates W02.** Expected: the old agent ignores the key
   and runs the legacy matcher (no crash). Covered by the payload parser reading keys with
   `tools.GetPayload*` only; W03 additionally version-gates. Test in Task 8
   (`TestHandleSecurityScanIgnoresMalformedRuleSets`) covers the malformed-shape side.
3. **A huge file inside the size cap stalls one worker** (YARA-X copies the file into guest memory).
   Expected: per-file timeout (`60 s`) and `maxFileSizeMb` bound it; the other workers keep going and
   the scan deadline still fires. Test in Task 7 (`TestWalkPoolHonoursDeadlineWithSlowWorker`).
4. **Cache file tampered with or truncated on disk.** Expected: detected by the trailing hash, deleted,
   recompiled from a fresh fetch; never loaded. Test in Task 5 (`TestCacheRejectsTamperedPayload`).
5. **Payload `url` pointing off-host** (`https://evil/…`, `//evil/…`, `/api/v1/agents/../../x`).
   Expected: rejected before any network I/O, `code: "invalid_refs"`. Test in Task 3
   (`TestParseRuleSetRefsRejectsOffHostURL`).

---

## Decisions this plan makes (each is reversible; flagged in the PR body)

- **DECISION W02-a — no fetch route in W02.** The route needs `yara_rule_sets` (W03). W02 lands dark:
  nothing on the server sends `ruleSets` yet, so production behaviour is unchanged; the agent path is
  proven end-to-end by Go tests against `httptest.Server`. W03 adds the route and starts sending
  `ruleSets` behind a min-agent-version gate.
- **DECISION W02-b — one compiled `Rules` per scan, one namespace per set.** All usable bundles are
  compiled together (namespace = `ruleSetId`) so each worker holds **one** wasm scanner instance, not
  one per set. Each bundle is first compiled alone to isolate errors (that cost is paid once per
  bundle version thanks to the cache).
- **DECISION W02-c — per-thread, not per-process, background priority.** The spec says
  `IDLE_PRIORITY_CLASS`; that would deprioritise heartbeats and remote sessions too. Workers call
  `runtime.LockOSThread()` then lower **their own thread** (Windows
  `THREAD_MODE_BACKGROUND_BEGIN`; Linux `setpriority(tid, 10)` + `ioprio_set(IDLE)`); macOS is a
  logged no-op in W02. The goroutine exits without unlocking, so the runtime discards the thread.
- **DECISION W02-d — every `security_scan` threat is attributed `provider = 'breeze'`.** Today the
  ingest stamps scan threats with the device's AV status provider
  (`normalizeProvider(parsedStatus?.provider)` in `routes/agents/helpers.ts`), which mislabels
  Breeze's own legacy-signature hits as e.g. `windows_defender`. Both engines are Breeze's.

---

## File structure

| Path | Create/Modify | Responsibility |
|---|---|---|
| `agent/go.mod`, `agent/go.sum` | Modify | add `github.com/niallnsec/yaraxwasm` (pins `tetratelabs/wazero`) |
| `agent/internal/yarascan/yarac/yarac.go` | Create | `breeze-yarac` core: `Policy`, `ValidateBundle`, `CompileBundles` |
| `agent/internal/yarascan/yarac/yarac_test.go` | Create | bans, caps, per-rule errors, namespaces |
| `agent/internal/yarascan/bundle.go` | Create | `Bundle`, `BundleRule`, `ParseBundle`, `RuleSetRef`, `ParseRuleSetRefs`, `RuleSetError` |
| `agent/internal/yarascan/bundle_test.go` | Create | golden fixture, sha256 pin, ref validation |
| `agent/internal/yarascan/testdata/bundle-v1.golden.json` (+ `.sha256`) | Create | the C2 contract, executable |
| `agent/internal/yarascan/testdata/*.yar`, `testdata/files/*` | Create | benign fixtures |
| `agent/internal/yarascan/fetch.go`, `fetch_test.go` | Create | `HTTPFetcher` (C1 URL rules, 16 MiB cap, sha256 verify) |
| `agent/internal/yarascan/cache.go`, `cache_test.go` | Create | C4 envelope, LRU prune |
| `agent/internal/yarascan/matcher.go`, `matcher_test.go` | Create | `Matcher`/`Worker`/`Match`, `LoadMatcher`, YARA impl, string capping |
| `agent/internal/yarascan/lowprio_windows.go`, `lowprio_linux.go`, `lowprio_other.go` | Create | `EnterBackgroundThread()` |
| `agent/internal/security/threats.go` | Modify | `Threat` fields; `legacyMatcher`; walk → pool |
| `agent/internal/security/walkpool.go`, `walkpool_test.go` | Create | producer/worker walk driving a `yarascan.Matcher` |
| `agent/internal/security/scanner.go` | Modify | `SecurityScanner.Matcher`, `Engine`; `ScanOutcome.Engine` |
| `agent/internal/security/quarantine.go` | Modify | manifest v2 |
| `agent/internal/heartbeat/handlers_security.go` | Modify | parse `ruleSets`, build matcher, result keys |
| `agent/internal/heartbeat/handlers_security_yara_test.go` | Create | handler end-to-end with httptest |
| `agent/cmd/breeze-yarac/main.go`, `main_test.go` | Create | `validate`, `compile`, `scan` subcommands |
| `agent/Makefile`, `.github/workflows/ci.yml` | Modify | build `breeze-yarac`; run binary signature guard on it |
| `apps/api/migrations/<newest+1>-security-provider-breeze.sql` | Create | enum value |
| `apps/api/src/db/schema/security.ts` | Modify | `'breeze'` in `securityProviderEnum` |
| `apps/api/src/routes/security/schemas.ts` | Modify | provider catalog entry `breeze` |
| `apps/api/src/routes/agents/helpers.ts` | Modify | scan threats → `provider: 'breeze'`; log `ruleSetErrors` |
| `apps/api/src/routes/agents/helpers.securityScan.test.ts` | Modify | attribution + rule fields land in `details` |
| `docs/superpowers/specs/security-auth/2026-09-18-yara-ioc-scanning-design.md` | Modify | §14 benchmark numbers + sidecar go/no-go (Task 11) |

---

### Task 1: Engine spike — pin `yaraxwasm` and record what it actually does

This is a verification task with a committed, executable outcome (`spike_test.go`), not a throwaway.
Everything later tasks assume about the engine is asserted here; if an assertion fails, **stop and
update this plan's Open Decisions before continuing**.

**Files:**
- Modify: `agent/go.mod`, `agent/go.sum`
- Create: `agent/internal/yarascan/yarac/spike_test.go`
- Create: `agent/internal/yarascan/testdata/modules.yar`, `testdata/files/fixture-a.bin`

**Interfaces:**
- Consumes: nothing.
- Produces: the pinned module version (recorded in this plan's §"Spike outcomes" by the implementer),
  and the confirmed API names used verbatim by Tasks 4 and 6: `yaraxwasm.NewCompiler`,
  `(*Compiler).NewNamespace`, `AddSource`, `Build`, `Errors`, `BanModule`, `ErrorOnSlowPattern`,
  `ErrorOnSlowLoop`, `Globals`, `(*Rules).WriteTo`, `yaraxwasm.ReadFrom`, `NewScanner`,
  `(*Scanner).SetTimeout`, `SetGlobal`, `ScanFile`, `Destroy`.

- [ ] **Step 1: Add the dependency at the newest version**

```bash
cd agent
go list -m -versions github.com/niallnsec/yaraxwasm
go get github.com/niallnsec/yaraxwasm@v1.1.0   # use the newest listed
go mod tidy
```

- [ ] **Step 2: Write the spike tests (they fail to compile until the names are right)**

`agent/internal/yarascan/testdata/modules.yar`:

```yara
import "pe"
import "elf"
import "hash"
import "math"
rule fixture_modules_load { condition: filesize >= 0 and math.entropy(0, 0) >= 0 }
```

`agent/internal/yarascan/testdata/files/fixture-a.bin`: the ASCII text
`header breeze_yara_fixture_marker_7f3a trailer\n`.

`agent/internal/yarascan/yarac/spike_test.go`:

```go
package yarac

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"

	yx "github.com/niallnsec/yaraxwasm"
)

const markerRule = `rule fixture_marker { strings: $a = "breeze_yara_fixture_marker_7f3a" condition: $a }`

func td(p string) string { return filepath.Join("..", "testdata", p) }

// Spec §13 Q1: public packs import pe/elf/hash/math. If this fails, W03's
// pack filter must drop rules importing the missing module (Open Decision 7).
func TestSpikeModulesAvailable(t *testing.T) {
	src, err := os.ReadFile(td("modules.yar"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := yx.Compile(string(src)); err != nil {
		t.Fatalf("pe/elf/hash/math not all available: %v", err)
	}
}

// The console module must be bannable — C5 depends on it.
func TestSpikeConsoleBannable(t *testing.T) {
	_, err := yx.Compile(`import "console" rule r { condition: console.log("x") }`,
		yx.BanModule("console", "banned module", "console is not allowed in Breeze rules"))
	if err == nil {
		t.Fatal("BanModule(console) did not reject an import")
	}
}

// Serialize → deserialize round trip on THIS arch, and record whether the
// bytes are arch-specific (they are compared across arches in CI by Step 4).
func TestSpikeSerializeRoundTrip(t *testing.T) {
	rules, err := yx.Compile(markerRule)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if _, err := rules.WriteTo(&buf); err != nil {
		t.Fatal(err)
	}
	again, err := yx.ReadFrom(&buf)
	if err != nil {
		t.Fatal(err)
	}
	s := yx.NewScanner(again)
	defer s.Destroy()
	res, err := s.ScanFile(td("files/fixture-a.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if n := len(res.MatchingRules()); n != 1 {
		t.Fatalf("want 1 match after round trip, got %d", n)
	}
	t.Logf("serialized size=%d goos=%s goarch=%s", buf.Len(), runtime.GOOS, runtime.GOARCH)
}

// One scanner per goroutine must be safe (DECISION W02-b relies on it).
func TestSpikeScannerPerGoroutineRace(t *testing.T) {
	rules, err := yx.Compile(markerRule)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s := yx.NewScanner(rules)
			defer s.Destroy()
			for j := 0; j < 20; j++ {
				if _, err := s.ScanFile(td("files/fixture-a.bin")); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	wg.Wait()
}

// Memory per scanner instance: logged, asserted loosely so CI catches a 10x regression.
func BenchmarkSpikeNewScanner(b *testing.B) {
	rules, err := yx.Compile(markerRule)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		s := yx.NewScanner(rules)
		s.Destroy()
	}
}
```

- [ ] **Step 3: Run until green, adjusting only API names**

Run: `cd agent && go test -race ./internal/yarascan/yarac/ -run Spike -v && go test ./internal/yarascan/yarac/ -bench SpikeNewScanner -benchmem -run '^$'`
Expected first run: FAIL (compile errors on any name that differs). Fix names **in this file only**,
re-run to PASS, then replace every API name in Tasks 4 and 6 of this plan with the confirmed ones.

- [ ] **Step 4: Cross-arch portability check (decides C4's `GOARCH` in the cache key — keep it either way)**

```bash
cd agent
go test ./internal/yarascan/yarac/ -run SpikeSerializeRoundTrip -v 2>&1 | grep 'serialized size'
# On an arm64 Mac, also run under Rosetta for amd64 and compare the two WriteTo outputs:
GOARCH=amd64 go test ./internal/yarascan/yarac/ -run SpikeSerializeRoundTrip -v 2>&1 | grep 'serialized size'
```

Record in "Spike outcomes" below: modules present (Y/N each), console bannable (Y/N), serialized size,
`NewScanner` bytes/op, and whether `ErrSignedRulesArchMismatch` applies to unsigned `WriteTo` output
(read the module source: `grep -rn CompiledArch $(go env GOMODCACHE)/github.com/niallnsec/yaraxwasm@*/`).

- [ ] **Step 5: Check binary size impact and the signature guard**

```bash
cd agent
git worktree add /tmp/agent-main origin/main && (cd /tmp/agent-main/agent && go build -o /tmp/agent-before ./cmd/breeze-agent) && git worktree remove /tmp/agent-main
go build -o /tmp/agent-after ./cmd/breeze-agent
ls -l /tmp/agent-before /tmp/agent-after
../scripts/security/check-agent-binary-signatures.sh /tmp/agent-after
```

Expected: guard PASS. Record the size delta (the embedded guest wasm is compressed; expect single-digit
MB). The agent binary does not import yaraxwasm until Task 6 — re-run this step's guard at Task 12.

- [ ] **Step 6: Commit**

```bash
git add agent/go.mod agent/go.sum agent/internal/yarascan/yarac/spike_test.go agent/internal/yarascan/testdata/
git commit -m "test(agent): pin yaraxwasm and assert engine capabilities (#6265)"
```

**Spike outcomes (implementer fills in, committed with Step 6):** version `____`; pe `_` elf `_`
hash `_` math `_`; console bannable `_`; serialized bytes `____`; NewScanner B/op `____`;
WriteTo arch-specific `_`.

---

### Task 2: Wire contract — `Bundle`, `RuleSetRef`, golden fixture

**Files:**
- Create: `agent/internal/yarascan/bundle.go`, `agent/internal/yarascan/bundle_test.go`
- Create: `agent/internal/yarascan/testdata/bundle-v1.golden.json`, `bundle-v1.golden.json.sha256`

**Interfaces:**
- Produces:
  - `const BundleFormat = "breeze-yara-bundle"`, `const BundleFormatVersion = 1`, `const MaxBundleBytes = 16 << 20`, `const MaxRuleSets = 20`
  - `type BundleRule struct { ID, Name, Severity, Source string }` (json `id,name,severity,source`)
  - `type Bundle struct { Format string; V int; RuleSetID string; Version int; AutoQuarantine bool; Rules []BundleRule }` (json `format,v,ruleSetId,version,autoQuarantine,rules`)
  - `func ParseBundle(body []byte, wantSHA256 string) (*Bundle, error)` — errors wrap `ErrSHA256Mismatch` or `ErrBundleInvalid`
  - `type RuleSetRef struct { ID string; Version int; SHA256 string; URL string }`
  - `func ParseRuleSetRefs(raw any) ([]RuleSetRef, error)` — `raw` is `cmd.Payload["ruleSets"]`; `nil` → `(nil, nil)`
  - `type RuleSetError struct { ID string; Version int; Code string; Detail string }` (json `id,version,code,detail`) and the code constants `CodeFetch`, `CodeHTTP404`, `CodeHTTP409`, `CodeSHA256Mismatch`, `CodeBundleInvalid`, `CodeCompile`, `CodeInvalidRefs`, `CodeEngineUnavailable` with the C3 string values.

- [ ] **Step 1: Create the golden fixture by hand (exact bytes, no trailing newline)**

```bash
cd agent/internal/yarascan/testdata
printf '%s' '{"format":"breeze-yara-bundle","v":1,"ruleSetId":"00000000-0000-4000-8000-000000000001","version":3,"autoQuarantine":false,"rules":[{"id":"00000000-0000-4000-8000-0000000000a1","name":"fixture_marker","severity":"high","source":"rule fixture_marker : fixture { meta: threat_type = \"pup\" strings: $a = \"breeze_yara_fixture_marker_7f3a\" condition: $a }"}]}' > bundle-v1.golden.json
shasum -a 256 bundle-v1.golden.json | cut -d' ' -f1 > bundle-v1.golden.json.sha256
```

- [ ] **Step 2: Write failing tests**

```go
package yarascan

import (
	"errors"
	"os"
	"strings"
	"testing"
)

func golden(t *testing.T) ([]byte, string) {
	t.Helper()
	body, err := os.ReadFile("testdata/bundle-v1.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	sum, err := os.ReadFile("testdata/bundle-v1.golden.json.sha256")
	if err != nil {
		t.Fatal(err)
	}
	return body, strings.TrimSpace(string(sum))
}

func TestParseBundleGolden(t *testing.T) {
	body, sum := golden(t)
	b, err := ParseBundle(body, sum)
	if err != nil {
		t.Fatal(err)
	}
	if b.RuleSetID != "00000000-0000-4000-8000-000000000001" || b.Version != 3 || len(b.Rules) != 1 || b.Rules[0].Name != "fixture_marker" {
		t.Fatalf("unexpected bundle: %+v", b)
	}
}

func TestParseBundleSHA256Mismatch(t *testing.T) {
	body, _ := golden(t)
	_, err := ParseBundle(body, strings.Repeat("0", 64))
	if !errors.Is(err, ErrSHA256Mismatch) {
		t.Fatalf("want ErrSHA256Mismatch, got %v", err)
	}
}

func TestParseBundleRejects(t *testing.T) {
	cases := map[string]string{
		"wrong format":     `{"format":"x","v":1,"ruleSetId":"a","version":1,"autoQuarantine":false,"rules":[]}`,
		"future version":   `{"format":"breeze-yara-bundle","v":2,"ruleSetId":"a","version":1,"autoQuarantine":false,"rules":[]}`,
		"duplicate name":   `{"format":"breeze-yara-bundle","v":1,"ruleSetId":"a","version":1,"autoQuarantine":false,"rules":[{"id":"1","name":"r","severity":"high","source":"rule r {condition: true}"},{"id":"2","name":"r","severity":"high","source":"rule r {condition: true}"}]}`,
		"bad severity":     `{"format":"breeze-yara-bundle","v":1,"ruleSetId":"a","version":1,"autoQuarantine":false,"rules":[{"id":"1","name":"r","severity":"extreme","source":"rule r {condition: true}"}]}`,
		"version zero":     `{"format":"breeze-yara-bundle","v":1,"ruleSetId":"a","version":0,"autoQuarantine":false,"rules":[]}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ParseBundle([]byte(body), sha256Hex([]byte(body)))
			if !errors.Is(err, ErrBundleInvalid) {
				t.Fatalf("want ErrBundleInvalid, got %v", err)
			}
		})
	}
}

func TestParseRuleSetRefsAbsent(t *testing.T) {
	refs, err := ParseRuleSetRefs(nil)
	if err != nil || refs != nil {
		t.Fatalf("absent ruleSets must be (nil,nil), got %v %v", refs, err)
	}
}

func TestParseRuleSetRefsRejectsOffHostURL(t *testing.T) {
	for _, u := range []string{
		"https://evil.example/api/v1/agents/a/yara/rule-sets/x/1",
		"//evil.example/api/v1/agents/a/yara/rule-sets/x/1",
		"/api/v1/agents/../../admin",
		"/api/v1/agents/a/yara/rule-sets/x/1?redirect=1",
		"/other/path",
		`/api/v1/agents/a\yara`,
	} {
		raw := []any{map[string]any{"id": "x", "version": float64(1), "sha256": strings.Repeat("a", 64), "url": u}}
		if _, err := ParseRuleSetRefs(raw); err == nil {
			t.Errorf("url %q accepted", u)
		}
	}
}

func TestParseRuleSetRefsCapsCount(t *testing.T) {
	var raw []any
	for i := 0; i < MaxRuleSets+1; i++ {
		raw = append(raw, map[string]any{"id": "x", "version": float64(1), "sha256": strings.Repeat("a", 64), "url": "/api/v1/agents/a/yara/rule-sets/x/1"})
	}
	if _, err := ParseRuleSetRefs(raw); err == nil {
		t.Fatal("more than MaxRuleSets accepted")
	}
}
```

- [ ] **Step 3: Run to see it fail**

Run: `cd agent && go test -race ./internal/yarascan/ -run 'ParseBundle|ParseRuleSetRefs' -v`
Expected: FAIL — `undefined: ParseBundle`.

- [ ] **Step 4: Implement `bundle.go`**

```go
// Package yarascan holds the Breeze YARA wire contract (rule-set bundles and
// payload refs), the device-side fetch + compiled-rules cache, and the
// Matcher abstraction the security scanner drives. Contract: plan
// docs/superpowers/plans/security-auth/2026-10-13-yara-ioc-scanning-w02-agent-engine.md §C1–C5.
package yarascan

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const (
	BundleFormat        = "breeze-yara-bundle"
	BundleFormatVersion = 1
	MaxBundleBytes      = 16 << 20
	MaxRuleSets         = 20
	urlPrefix           = "/api/v1/agents/"
)

const (
	CodeFetch             = "fetch"
	CodeHTTP404           = "http_404"
	CodeHTTP409           = "http_409"
	CodeSHA256Mismatch    = "sha256_mismatch"
	CodeBundleInvalid     = "bundle_invalid"
	CodeCompile           = "compile"
	CodeInvalidRefs       = "invalid_refs"
	CodeEngineUnavailable = "engine_unavailable"
)

var (
	ErrSHA256Mismatch = errors.New("bundle sha256 mismatch")
	ErrBundleInvalid  = errors.New("bundle invalid")
)

var validSeverities = map[string]struct{}{"low": {}, "medium": {}, "high": {}, "critical": {}}

type BundleRule struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Severity string `json:"severity"`
	Source   string `json:"source"`
}

type Bundle struct {
	Format         string       `json:"format"`
	V              int          `json:"v"`
	RuleSetID      string       `json:"ruleSetId"`
	Version        int          `json:"version"`
	AutoQuarantine bool         `json:"autoQuarantine"`
	Rules          []BundleRule `json:"rules"`
}

type RuleSetRef struct {
	ID      string
	Version int
	SHA256  string
	URL     string
}

type RuleSetError struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
	Code    string `json:"code"`
	Detail  string `json:"detail,omitempty"`
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrBundleInvalid, fmt.Sprintf(format, args...))
}

// ParseBundle verifies the sha256 pin over the exact bytes BEFORE decoding.
func ParseBundle(body []byte, wantSHA256 string) (*Bundle, error) {
	if len(body) > MaxBundleBytes {
		return nil, invalid("bundle exceeds %d bytes", MaxBundleBytes)
	}
	if got := sha256Hex(body); got != strings.ToLower(wantSHA256) {
		return nil, fmt.Errorf("%w: got %s", ErrSHA256Mismatch, got)
	}
	var b Bundle
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		return nil, invalid("decode: %v", err)
	}
	if b.Format != BundleFormat || b.V != BundleFormatVersion {
		return nil, invalid("unsupported format %q v%d", b.Format, b.V)
	}
	if b.RuleSetID == "" || b.Version < 1 {
		return nil, invalid("missing ruleSetId or version")
	}
	seen := make(map[string]struct{}, len(b.Rules))
	for _, r := range b.Rules {
		if r.ID == "" || r.Name == "" || r.Source == "" {
			return nil, invalid("rule missing id/name/source")
		}
		if _, ok := validSeverities[r.Severity]; !ok {
			return nil, invalid("rule %s: severity %q", r.Name, r.Severity)
		}
		if _, dup := seen[r.Name]; dup {
			return nil, invalid("duplicate rule name %s", r.Name)
		}
		seen[r.Name] = struct{}{}
	}
	return &b, nil
}

func validRefURL(u string) bool {
	if !strings.HasPrefix(u, urlPrefix) {
		return false
	}
	return !strings.ContainsAny(u, "?#\\") && !strings.Contains(u, "..") && !strings.Contains(u, "//")
}

// ParseRuleSetRefs validates the payload's ruleSets value (C1). Any malformed
// entry rejects the whole list: a half-applied rule list would report coverage
// the operator did not configure.
func ParseRuleSetRefs(raw any) ([]RuleSetRef, error) {
	if raw == nil {
		return nil, nil
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("ruleSets is not an array")
	}
	if len(items) > MaxRuleSets {
		return nil, fmt.Errorf("ruleSets has %d entries (max %d)", len(items), MaxRuleSets)
	}
	refs := make([]RuleSetRef, 0, len(items))
	for i, it := range items {
		m, ok := it.(map[string]any)
		if !ok || len(m) != 4 {
			return nil, fmt.Errorf("ruleSets[%d]: want object with id, version, sha256, url", i)
		}
		id, _ := m["id"].(string)
		verF, _ := m["version"].(float64)
		sum, _ := m["sha256"].(string)
		u, _ := m["url"].(string)
		if id == "" || verF < 1 || verF != float64(int(verF)) || len(sum) != 64 || !validRefURL(u) {
			return nil, fmt.Errorf("ruleSets[%d]: invalid field", i)
		}
		if _, err := hex.DecodeString(sum); err != nil {
			return nil, fmt.Errorf("ruleSets[%d]: sha256 not hex", i)
		}
		refs = append(refs, RuleSetRef{ID: id, Version: int(verF), SHA256: strings.ToLower(sum), URL: u})
	}
	return refs, nil
}
```

- [ ] **Step 5: Run to pass**

Run: `cd agent && go test -race ./internal/yarascan/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/yarascan/bundle.go agent/internal/yarascan/bundle_test.go agent/internal/yarascan/testdata/bundle-v1.golden.json*
git commit -m "feat(agent): YARA rule-set bundle + payload ref contract (#6265)"
```

---

### Task 3: Fetcher — device-authenticated, same-origin, size-capped

**Files:**
- Create: `agent/internal/yarascan/fetch.go`, `agent/internal/yarascan/fetch_test.go`

**Interfaces:**
- Consumes: `RuleSetRef`, `ParseBundle`, `MaxBundleBytes`, code constants (Task 2).
- Produces:
  - `type Fetcher interface { Fetch(ctx context.Context, ref RuleSetRef) (*Bundle, *RuleSetError) }`
  - `type HTTPFetcher struct { BaseURL string; Client *http.Client; AuthHeader func() string }`
  - `func (f *HTTPFetcher) Fetch(ctx context.Context, ref RuleSetRef) (*Bundle, *RuleSetError)`

- [ ] **Step 1: Write failing tests** (`fetch_test.go`)

```go
package yarascan

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func serve(t *testing.T, status int, body []byte, wantAuth string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != wantAuth {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.breeze.yara-bundle+json")
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}))
}

func TestFetchGolden(t *testing.T) {
	body, sum := golden(t)
	srv := serve(t, 200, body, "Bearer tok")
	defer srv.Close()
	f := &HTTPFetcher{BaseURL: srv.URL, Client: srv.Client(), AuthHeader: func() string { return "Bearer tok" }}
	b, rerr := f.Fetch(context.Background(), RuleSetRef{ID: "s", Version: 3, SHA256: sum, URL: "/api/v1/agents/a/yara/rule-sets/s/3"})
	if rerr != nil || b == nil || b.Version != 3 {
		t.Fatalf("fetch failed: %+v %+v", b, rerr)
	}
}

func TestFetchMapsStatusCodes(t *testing.T) {
	for status, code := range map[int]string{404: CodeHTTP404, 409: CodeHTTP409, 500: CodeFetch} {
		srv := serve(t, status, nil, "Bearer tok")
		f := &HTTPFetcher{BaseURL: srv.URL, Client: srv.Client(), AuthHeader: func() string { return "Bearer tok" }}
		_, rerr := f.Fetch(context.Background(), RuleSetRef{ID: "s", Version: 1, SHA256: strings.Repeat("a", 64), URL: "/api/v1/agents/a/yara/rule-sets/s/1"})
		srv.Close()
		if rerr == nil || rerr.Code != code {
			t.Errorf("status %d: want %s, got %+v", status, code, rerr)
		}
	}
}

func TestFetchRefusesCrossHostRedirect(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/x", http.StatusFound)
	}))
	defer srv.Close()
	f := &HTTPFetcher{BaseURL: srv.URL, Client: srv.Client(), AuthHeader: func() string { return "Bearer tok" }}
	_, rerr := f.Fetch(context.Background(), RuleSetRef{ID: "s", Version: 1, SHA256: strings.Repeat("a", 64), URL: "/api/v1/agents/a/yara/rule-sets/s/1"})
	if rerr == nil || rerr.Code != CodeFetch {
		t.Fatalf("redirect followed: %+v", rerr)
	}
}

func TestFetchCapsBody(t *testing.T) {
	big := []byte(strings.Repeat("x", MaxBundleBytes+1))
	srv := serve(t, 200, big, "Bearer tok")
	defer srv.Close()
	f := &HTTPFetcher{BaseURL: srv.URL, Client: srv.Client(), AuthHeader: func() string { return "Bearer tok" }}
	_, rerr := f.Fetch(context.Background(), RuleSetRef{ID: "s", Version: 1, SHA256: sha256Hex(big), URL: "/api/v1/agents/a/yara/rule-sets/s/1"})
	if rerr == nil || rerr.Code != CodeBundleInvalid {
		t.Fatalf("oversized body accepted: %+v", rerr)
	}
}
```

- [ ] **Step 2: Run to see it fail** — `cd agent && go test -race ./internal/yarascan/ -run Fetch -v` → FAIL `undefined: HTTPFetcher`.

- [ ] **Step 3: Implement `fetch.go`**

```go
package yarascan

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type Fetcher interface {
	Fetch(ctx context.Context, ref RuleSetRef) (*Bundle, *RuleSetError)
}

type HTTPFetcher struct {
	BaseURL    string
	Client     *http.Client
	AuthHeader func() string
}

func refErr(ref RuleSetRef, code, detail string) *RuleSetError {
	if len(detail) > 512 {
		detail = detail[:512]
	}
	return &RuleSetError{ID: ref.ID, Version: ref.Version, Code: code, Detail: detail}
}

func (f *HTTPFetcher) Fetch(ctx context.Context, ref RuleSetRef) (*Bundle, *RuleSetError) {
	base, err := url.Parse(strings.TrimRight(f.BaseURL, "/"))
	if err != nil || base.Host == "" {
		return nil, refErr(ref, CodeFetch, "agent server URL invalid")
	}
	target := *base
	target.Path = ref.URL // already validated by ParseRuleSetRefs: server-relative, no traversal
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, refErr(ref, CodeFetch, err.Error())
	}
	req.Header.Set("Authorization", f.AuthHeader())
	req.Header.Set("Accept", "application/vnd.breeze.yara-bundle+json")

	client := *f.Client // copy: never mutate the shared heartbeat client
	client.CheckRedirect = func(r *http.Request, _ []*http.Request) error {
		return errors.New("redirects are not followed for rule bundles")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, refErr(ref, CodeFetch, err.Error())
	}
	defer func() { _ = resp.Body.Close() }()

	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, refErr(ref, CodeHTTP404, "rule set not found or not visible to this device")
	case resp.StatusCode == http.StatusConflict:
		return nil, refErr(ref, CodeHTTP409, "rule set version is no longer current")
	case resp.StatusCode != http.StatusOK:
		return nil, refErr(ref, CodeFetch, fmt.Sprintf("HTTP %d", resp.StatusCode))
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxBundleBytes+1))
	if err != nil {
		return nil, refErr(ref, CodeFetch, err.Error())
	}
	if len(body) > MaxBundleBytes {
		return nil, refErr(ref, CodeBundleInvalid, "bundle exceeds size cap")
	}
	b, err := ParseBundle(body, ref.SHA256)
	switch {
	case errors.Is(err, ErrSHA256Mismatch):
		return nil, refErr(ref, CodeSHA256Mismatch, err.Error())
	case err != nil:
		return nil, refErr(ref, CodeBundleInvalid, err.Error())
	}
	if b.RuleSetID != ref.ID || b.Version != ref.Version {
		return nil, refErr(ref, CodeBundleInvalid, "bundle id/version does not match the payload ref")
	}
	return b, nil
}
```

Note: the size check happens before the hash so an oversized body reports `bundle_invalid`, not
`sha256_mismatch`. `ParseBundle` also enforces the cap for non-HTTP callers.

- [ ] **Step 4: Run to pass** — `cd agent && go test -race ./internal/yarascan/ -v` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(agent): same-origin, sha256-pinned YARA bundle fetcher (#6265)"` (add both files).

---

### Task 4: `breeze-yarac` core — validate and compile with the Breeze policy

**Files:**
- Create: `agent/internal/yarascan/yarac/yarac.go`, `agent/internal/yarascan/yarac/yarac_test.go`
- Create: `agent/internal/yarascan/testdata/bad-console.json`, `bad-include.json`, `bad-slow.json`,
  `bad-syntax.json`, `two-sets-a.json`, `two-sets-b.json` (bundle JSON fixtures; sha256 is computed in
  the test, so no `.sha256` files)

**Interfaces:**
- Consumes: `yarascan.Bundle` (Task 2) — **import direction:** `yarac` must not import `yarascan`
  (that would cycle once `yarascan` imports `yarac` in Task 6). `yarac` therefore declares its own
  minimal input type and `yarascan` converts.
- Produces:
  - `type Rule struct { ID, Name, Severity, Source string }`
  - `type Set struct { ID string; Rules []Rule }`
  - `type Policy struct { MaxRulesPerSet, MaxRuleSourceBytes, MaxStringsPerSet int }` and `var DefaultPolicy = Policy{500, 64 << 10, 10000}`
  - `type RuleError struct { RuleID, Name, Code, Message string; Line int }` (json `ruleId,name,code,message,line`)
  - `func ValidateSet(s Set, p Policy) []RuleError` — compiles the set alone; empty slice = OK
  - `func CompileSets(sets []Set, p Policy) (*yx.Rules, map[string][]RuleError, error)` — one `Rules`, namespace per set id; sets with errors are omitted and reported in the map
  - `func EngineVersion() string` — the pinned module version string (from `debug.ReadBuildInfo`, fallback `"unknown"`)

- [ ] **Step 1: Write failing tests**

```go
package yarac

import (
	"testing"
)

func set(id string, rules ...Rule) Set { return Set{ID: id, Rules: rules} }
func r(name, src string) Rule      { return Rule{ID: "id-" + name, Name: name, Severity: "high", Source: src} }

func TestValidateAcceptsMarkerRule(t *testing.T) {
	errs := ValidateSet(set("s1", r("fixture_marker", markerRule)), DefaultPolicy)
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %+v", errs)
	}
}

func TestValidateRejectsPolicyViolations(t *testing.T) {
	cases := map[string]Rule{
		"console":       r("c", `import "console" rule c { condition: console.log("x") }`),
		"include":       r("i", `include "other.yar" rule i { condition: true }`),
		// Engine-level check, not just the textual one: no space after the keyword.
		"include nospace": r("j", "include\"other.yar\"\nrule j { condition: true }"),
		"unknown ident": r("u", `rule u { condition: some_external_var == 1 }`),
		"syntax":        r("s", `rule s { condition: `),
		"name mismatch": r("expected_name", `rule other_name { condition: true }`),
		"two rules":     r("a", `rule a { condition: true } rule b { condition: true }`),
	}
	for name, rule := range cases {
		t.Run(name, func(t *testing.T) {
			errs := ValidateSet(set("s", rule), DefaultPolicy)
			if len(errs) == 0 || errs[0].RuleID != rule.ID {
				t.Fatalf("want an error attributed to %s, got %+v", rule.ID, errs)
			}
		})
	}
}

func TestValidateCaps(t *testing.T) {
	p := Policy{MaxRulesPerSet: 1, MaxRuleSourceBytes: 64, MaxStringsPerSet: 10000}
	if errs := ValidateSet(set("s", r("a", `rule a { condition: true }`), r("b", `rule b { condition: true }`)), p); len(errs) == 0 {
		t.Error("rule count cap not enforced")
	}
	long := `rule a { condition: true } // ` + string(make([]byte, 80))
	if errs := ValidateSet(set("s", r("a", long)), p); len(errs) == 0 {
		t.Error("source size cap not enforced")
	}
}

func TestFilenameGlobalsAllowed(t *testing.T) {
	src := `rule g { condition: filename == "x" or filepath contains "y" or extension == "exe" }`
	if errs := ValidateSet(set("s", r("g", src)), DefaultPolicy); len(errs) != 0 {
		t.Fatalf("filename/filepath/extension must be defined: %+v", errs)
	}
}

func TestCompileSetsIsolatesFailingSet(t *testing.T) {
	good := set("good", r("fixture_marker", markerRule))
	bad := set("bad", r("s", `rule s { condition: `))
	rules, errs, err := CompileSets([]Set{good, bad}, DefaultPolicy)
	if err != nil || rules == nil {
		t.Fatalf("compile failed: %v", err)
	}
	if len(errs["bad"]) == 0 || len(errs["good"]) != 0 {
		t.Fatalf("errors not isolated per set: %+v", errs)
	}
}

func TestCompileSetsSameRuleNameDifferentNamespaces(t *testing.T) {
	a := set("a", r("fixture_marker", markerRule))
	b := set("b", r("fixture_marker", markerRule))
	if _, errs, err := CompileSets([]Set{a, b}, DefaultPolicy); err != nil || len(errs["a"])+len(errs["b"]) != 0 {
		t.Fatalf("namespaces must keep same-named rules apart: %v %+v", err, errs)
	}
}
```

- [ ] **Step 2: Run to fail** — `cd agent && go test -race ./internal/yarascan/yarac/ -v` → FAIL `undefined: ValidateSet`.

- [ ] **Step 3: Implement `yarac.go`** (option and method names as confirmed by Task 1)

```go
// Package yarac is breeze-yarac: the single implementation of Breeze's YARA
// compile policy (spec §5.3 as amended by the 2026-10-13 owner decision —
// compilation happens on the agent; the server pre-check runs this same code
// via cmd/breeze-yarac). Nothing else in the repo may call yaraxwasm's
// compiler directly.
package yarac

import (
	"fmt"
	"regexp"
	"runtime/debug"
	"strings"

	yx "github.com/niallnsec/yaraxwasm"
)

// PolicyVersion identifies this file's compile policy (C5). Bump on ANY
// change to compilerOptions, shapeErrors or DefaultPolicy; it is part of the
// cache key and of `breeze-yarac version`, so server pre-check and agent can
// be compared in diagnostics.
const PolicyVersion = 1

type Rule struct{ ID, Name, Severity, Source string }

type Set struct {
	ID    string
	Rules []Rule
}

type Policy struct {
	MaxRulesPerSet     int
	MaxRuleSourceBytes int
	MaxStringsPerSet   int
}

var DefaultPolicy = Policy{MaxRulesPerSet: 500, MaxRuleSourceBytes: 64 << 10, MaxStringsPerSet: 10000}

type RuleError struct {
	RuleID  string `json:"ruleId"`
	Name    string `json:"name"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Line    int    `json:"line,omitempty"`
}

const modulePath = "github.com/niallnsec/yaraxwasm"

func EngineVersion() string {
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, d := range bi.Deps {
			if d.Path == modulePath {
				return d.Version
			}
		}
	}
	return "unknown"
}

// ruleDecl finds every top-level rule identifier; exactly one, equal to Name.
var includeDirective = regexp.MustCompile(`(?m)^\s*include\b`)

var ruleDecl = regexp.MustCompile(`(?m)^\s*(?:(?:private|global)\s+)*rule\s+([A-Za-z_][A-Za-z0-9_]*)`)

func compilerOptions() []yx.CompileOption {
	return []yx.CompileOption{
		yx.BanModule("console", "banned module", "the console module is not allowed in Breeze detection rules"),
		yx.ErrorOnSlowPattern(true),
		yx.ErrorOnSlowLoop(true),
		yx.Globals(map[string]any{"filename": "", "filepath": "", "extension": ""}),
		// Upstream defaults includes ON (quorum finding, compiler.go:261 @ v1.1.0).
		yx.EnableIncludes(false),
	}
}

func shapeErrors(s Set, p Policy) []RuleError {
	var out []RuleError
	if len(s.Rules) > p.MaxRulesPerSet {
		out = append(out, RuleError{Code: "cap_rules", Message: fmt.Sprintf("%d rules exceeds the cap of %d", len(s.Rules), p.MaxRulesPerSet)})
	}
	for _, r := range s.Rules {
		if len(r.Source) > p.MaxRuleSourceBytes {
			out = append(out, RuleError{RuleID: r.ID, Name: r.Name, Code: "cap_source", Message: fmt.Sprintf("rule source is %d bytes (max %d)", len(r.Source), p.MaxRuleSourceBytes)})
			continue
		}
		if includeDirective.MatchString(r.Source) {
			out = append(out, RuleError{RuleID: r.ID, Name: r.Name, Code: "include", Message: "include directives are not allowed"})
			continue
		}
		decls := ruleDecl.FindAllStringSubmatch(r.Source, -1)
		if len(decls) != 1 || decls[0][1] != r.Name {
			out = append(out, RuleError{RuleID: r.ID, Name: r.Name, Code: "one_rule", Message: "each rule source must declare exactly one rule named " + r.Name})
		}
	}
	return out
}

// compileOne compiles a single rule alone so its error is attributable.
func compileOne(r Rule) *RuleError {
	c, err := yx.NewCompiler(compilerOptions()...)
	if err != nil {
		return &RuleError{RuleID: r.ID, Name: r.Name, Code: "engine", Message: err.Error()}
	}
	if err := c.AddSource(r.Source); err != nil {
		return &RuleError{RuleID: r.ID, Name: r.Name, Code: "compile", Message: err.Error()}
	}
	return nil
}

func ValidateSet(s Set, p Policy) []RuleError {
	errs := shapeErrors(s, p)
	if len(errs) > 0 {
		return errs
	}
	for _, r := range s.Rules {
		if e := compileOne(r); e != nil {
			errs = append(errs, *e)
		}
	}
	if len(errs) > 0 {
		return errs
	}
	rules, _, err := buildSets([]Set{s})
	if err != nil {
		return []RuleError{{Code: "compile", Message: err.Error()}}
	}
	if n := countPatterns(rules); n > p.MaxStringsPerSet {
		return []RuleError{{Code: "cap_strings", Message: fmt.Sprintf("%d strings exceeds the cap of %d", n, p.MaxStringsPerSet)}}
	}
	return nil
}

func buildSets(sets []Set) (*yx.Rules, int, error) {
	c, err := yx.NewCompiler(compilerOptions()...)
	if err != nil {
		return nil, 0, err
	}
	n := 0
	for _, s := range sets {
		c.NewNamespace(s.ID)
		for _, r := range s.Rules {
			if err := c.AddSource(r.Source); err != nil {
				return nil, 0, fmt.Errorf("set %s rule %s: %w", s.ID, r.Name, err)
			}
			n++
		}
	}
	return c.Build(), n, nil
}

// countPatterns counts string definitions from the COMPILED rules — the cap
// in C5 is on what the engine holds, not on what a regex over source thinks.
// Task 1 confirms the accessor; if yaraxwasm exposes no per-rule pattern
// list, fall back to Rules.Count()×0 and record that in Spike outcomes.
func countPatterns(rules *yx.Rules) int {
	total := 0
	for _, rule := range rules.Slice() {
		total += len(rule.Patterns())
	}
	return total
}

func CompileSets(sets []Set, p Policy) (*yx.Rules, map[string][]RuleError, error) {
	errs := make(map[string][]RuleError)
	var ok []Set
	for _, s := range sets {
		if e := ValidateSet(s, p); len(e) > 0 {
			errs[s.ID] = e
			continue
		}
		ok = append(ok, s)
	}
	if len(ok) == 0 {
		return nil, errs, nil
	}
	rules, _, err := buildSets(ok)
	if err != nil {
		return nil, errs, err
	}
	return rules, errs, nil
}
```

If Task 1 showed `NewCompiler` panics rather than returning an error on guest failure, wrap both
`compileOne` and `buildSets` bodies in `defer func(){ if r := recover(); r != nil { … } }()` and turn
the panic into `Code: "engine"`.

- [ ] **Step 4: Run to pass** — `cd agent && go test -race ./internal/yarascan/yarac/ -v` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(agent): breeze-yarac compile policy (bans, caps, namespaces) (#6265)"`.

---

### Task 5: Compiled-rules cache (C4)

**Files:**
- Create: `agent/internal/yarascan/cache.go`, `agent/internal/yarascan/cache_test.go`

**Interfaces:**
- Consumes: `yarac.EngineVersion`, `obfuscate.DecodeBytes` (`internal/obfuscate`, XOR-0x5A).
- Produces:
  - `type RuleMeta struct { RuleID, Severity string }` (json `ruleId,severity`)
  - `type CacheEntry struct { Rules *yx.Rules; Index map[string]RuleMeta; AutoQuarantine map[string]bool }` — `Index` key is `"<ruleSetId>:<ruleName>"`
  - `type Cache struct { Dir string; MaxEntries int }`
  - `func CacheKey(bundleSHA256s []string) string`
  - `func (c *Cache) Load(key string) (*CacheEntry, error)` — `(nil, nil)` on miss; tampered/foreign files are deleted and reported as miss
  - `func (c *Cache) Store(key string, e *CacheEntry) error`

- [ ] **Step 1: Write failing tests**

```go
package yarascan

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/yarascan/yarac"
)

func compiledFixture(t *testing.T) *CacheEntry {
	t.Helper()
	rules, errs, err := yarac.CompileSets([]yarac.Set{{ID: "s1", Rules: []yarac.Rule{{ID: "r1", Name: "fixture_marker", Severity: "high",
		Source: `rule fixture_marker { strings: $a = "breeze_yara_fixture_marker_7f3a" condition: $a }`}}}}, yarac.DefaultPolicy)
	if err != nil || len(errs) != 0 {
		t.Fatal(err, errs)
	}
	return &CacheEntry{Rules: rules, Index: map[string]RuleMeta{"s1:fixture_marker": {RuleID: "r1", Severity: "high"}}, AutoQuarantine: map[string]bool{"s1": false}}
}

func TestCacheRoundTrip(t *testing.T) {
	c := &Cache{Dir: t.TempDir(), MaxEntries: 16}
	key := CacheKey([]string{"bb", "aa"})
	if key != CacheKey([]string{"aa", "bb"}) {
		t.Fatal("CacheKey must be order-independent")
	}
	if err := c.Store(key, compiledFixture(t)); err != nil {
		t.Fatal(err)
	}
	got, err := c.Load(key)
	if err != nil || got == nil || got.Index["s1:fixture_marker"].RuleID != "r1" {
		t.Fatalf("load failed: %+v %v", got, err)
	}
}

func TestCacheFileHasNoPlaintextPattern(t *testing.T) {
	c := &Cache{Dir: t.TempDir(), MaxEntries: 16}
	key := CacheKey([]string{"aa"})
	if err := c.Store(key, compiledFixture(t)); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(c.Dir, key+".byrc"))
	if containsBytes(raw, []byte("breeze_yara_fixture_marker_7f3a")) {
		t.Fatal("compiled cache leaks a plaintext pattern")
	}
}

func TestCacheRejectsTamperedPayload(t *testing.T) {
	c := &Cache{Dir: t.TempDir(), MaxEntries: 16}
	key := CacheKey([]string{"aa"})
	_ = c.Store(key, compiledFixture(t))
	p := filepath.Join(c.Dir, key+".byrc")
	raw, _ := os.ReadFile(p)
	raw[len(raw)-40] ^= 0xFF
	_ = os.WriteFile(p, raw, 0o600)
	got, err := c.Load(key)
	if got != nil || err != nil {
		t.Fatalf("tampered entry must be a miss, got %+v %v", got, err)
	}
	if _, statErr := os.Stat(p); !os.IsNotExist(statErr) {
		t.Fatal("tampered entry must be deleted")
	}
}

func TestCachePrunesLRU(t *testing.T) {
	c := &Cache{Dir: t.TempDir(), MaxEntries: 2}
	for _, k := range []string{"k1", "k2", "k3"} {
		if err := c.Store(CacheKey([]string{k}), compiledFixture(t)); err != nil {
			t.Fatal(err)
		}
	}
	entries, _ := filepath.Glob(filepath.Join(c.Dir, "*.byrc"))
	if len(entries) != 2 {
		t.Fatalf("want 2 entries after prune, got %d", len(entries))
	}
}
```

- [ ] **Step 2: Run to fail** — `go test -race ./internal/yarascan/ -run Cache -v` → FAIL.

- [ ] **Step 3: Implement `cache.go`**

```go
package yarascan

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	yx "github.com/niallnsec/yaraxwasm"

	"github.com/breeze-rmm/agent/internal/obfuscate"
	"github.com/breeze-rmm/agent/internal/yarascan/yarac"
)

const (
	cacheMagic   = "BYRC"
	cacheFormat  = uint16(1)
	cacheExt     = ".byrc"
	maxHeaderLen = 8 << 20
)

type RuleMeta struct {
	RuleID   string `json:"ruleId"`
	Severity string `json:"severity"`
}

type CacheEntry struct {
	Rules          *yx.Rules
	Index          map[string]RuleMeta
	AutoQuarantine map[string]bool
}

type cacheHeader struct {
	Key            string              `json:"key"`
	Engine         string              `json:"engine"`
	GOOS           string              `json:"goos"`
	GOARCH         string              `json:"goarch"`
	CreatedAt      string              `json:"createdAt"`
	Rules          map[string]RuleMeta `json:"rules"`
	AutoQuarantine map[string]bool     `json:"autoQuarantine"`
}

type Cache struct {
	Dir        string
	MaxEntries int
}

func CacheKey(bundleSHA256s []string) string {
	sorted := append([]string(nil), bundleSHA256s...)
	sort.Strings(sorted)
	material := "byrc1\n" + yarac.EngineVersion() + "\n" + strconv.Itoa(yarac.PolicyVersion) + "\n" + runtime.GOOS + "/" + runtime.GOARCH + "\n" + strings.Join(sorted, "\n")
	sum := sha256.Sum256([]byte(material))
	return hex.EncodeToString(sum[:])
}

func containsBytes(h, n []byte) bool { return bytes.Contains(h, n) }

func (c *Cache) path(key string) string { return filepath.Join(c.Dir, key+cacheExt) }

func (c *Cache) Store(key string, e *CacheEntry) error {
	if err := os.MkdirAll(c.Dir, 0o700); err != nil {
		return err
	}
	var payload bytes.Buffer
	if _, err := e.Rules.WriteTo(&payload); err != nil {
		return fmt.Errorf("serialize rules: %w", err)
	}
	plain := payload.Bytes()
	sum := sha256.Sum256(plain)
	hdr, err := json.Marshal(cacheHeader{Key: key, Engine: yarac.EngineVersion(), GOOS: runtime.GOOS, GOARCH: runtime.GOARCH,
		CreatedAt: time.Now().UTC().Format(time.RFC3339), Rules: e.Index, AutoQuarantine: e.AutoQuarantine})
	if err != nil {
		return err
	}
	var out bytes.Buffer
	out.WriteString(cacheMagic)
	_ = binary.Write(&out, binary.BigEndian, cacheFormat)
	_ = binary.Write(&out, binary.BigEndian, uint32(len(hdr)))
	out.Write(hdr)
	out.Write(obfuscate.DecodeBytes(plain)) // XOR is its own inverse
	out.Write(sum[:])

	tmp := c.path(key) + ".tmp"
	if err := os.WriteFile(tmp, out.Bytes(), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, c.path(key)); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	c.prune()
	return nil
}

func (c *Cache) discard(p, why string) {
	log.Warn("discarding YARA compiled-rules cache entry", "path", p, "reason", why)
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Warn("failed to delete cache entry", "path", p, "error", err.Error())
	}
}

func (c *Cache) Load(key string) (*CacheEntry, error) {
	p := c.path(key)
	if st, err := os.Lstat(p); err == nil && (st.Mode()&os.ModeSymlink != 0 || st.Size() > 64<<20) {
		c.discard(p, "symlink or oversized entry")
		return nil, nil
	}
	if st, err := os.Lstat(c.Dir); err == nil && st.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("YARA cache dir %s is a symlink; refusing", c.Dir)
	}
	raw, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(raw) < 4+2+4+32 || string(raw[:4]) != cacheMagic || binary.BigEndian.Uint16(raw[4:6]) != cacheFormat {
		c.discard(p, "bad magic/format")
		return nil, nil
	}
	hlen := binary.BigEndian.Uint32(raw[6:10])
	if hlen > maxHeaderLen || int(10+hlen+32) > len(raw) {
		c.discard(p, "bad header length")
		return nil, nil
	}
	var hdr cacheHeader
	if err := json.Unmarshal(raw[10:10+hlen], &hdr); err != nil {
		c.discard(p, "header decode")
		return nil, nil
	}
	if hdr.Key != key || hdr.Engine != yarac.EngineVersion() || hdr.GOOS != runtime.GOOS || hdr.GOARCH != runtime.GOARCH {
		c.discard(p, "key/engine/arch mismatch")
		return nil, nil
	}
	body := raw[10+hlen : len(raw)-32]
	plain := obfuscate.DecodeBytes(body)
	sum := sha256.Sum256(plain)
	if !bytes.Equal(sum[:], raw[len(raw)-32:]) {
		c.discard(p, "payload hash mismatch")
		return nil, nil
	}
	rules, err := yx.ReadFrom(bytes.NewReader(plain))
	if err != nil {
		c.discard(p, "deserialize: "+err.Error())
		return nil, nil
	}
	now := time.Now()
	_ = os.Chtimes(p, now, now) // LRU touch
	return &CacheEntry{Rules: rules, Index: hdr.Rules, AutoQuarantine: hdr.AutoQuarantine}, nil
}

func (c *Cache) prune() {
	if c.MaxEntries <= 0 {
		return
	}
	paths, _ := filepath.Glob(filepath.Join(c.Dir, "*"+cacheExt))
	if len(paths) <= c.MaxEntries {
		return
	}
	type fe struct {
		p string
		t time.Time
	}
	var all []fe
	for _, p := range paths {
		if st, err := os.Stat(p); err == nil {
			all = append(all, fe{p, st.ModTime()})
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].t.After(all[j].t) })
	for _, f := range all[c.MaxEntries:] {
		c.discard(f.p, "lru prune")
	}
}
```

Add `var log = logging.L("yarascan")` in `bundle.go` (import `github.com/breeze-rmm/agent/internal/logging`).

- [ ] **Step 4: Run to pass** — `go test -race ./internal/yarascan/ -v` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent): obfuscated, integrity-checked YARA compiled-rules cache (#6265)"`.

---

### Task 6: `Matcher` — load sets (fetch → cache → compile) and scan a file

**Files:**
- Create: `agent/internal/yarascan/matcher.go`, `agent/internal/yarascan/matcher_test.go`
- Create: `agent/internal/yarascan/lowprio_windows.go`, `lowprio_linux.go`, `lowprio_other.go`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `type MatchedString struct { ID string; Offset int64; Data string }` (json `id,offset,data`)
  - `type Match struct { RuleSetID, RuleID, RuleName, Severity, ThreatType string; Tags []string; Strings []MatchedString; AutoQuarantine bool }`
  - `type Worker interface { ScanFile(path string) ([]Match, error); Close() }`
  - `type Matcher interface { Engine() string; NewWorker() (Worker, error); Close() }`
  - `func LoadMatcher(ctx context.Context, refs []RuleSetRef, f Fetcher, c *Cache) (Matcher, []RuleSetError)` — returns `(nil, errs)` when no set is usable; never panics
  - `const PerFileTimeout = 60 * time.Second`, `const MaxMatchedStrings = 10`, `const MaxMatchedBytes = 128`
  - `func EnterBackgroundThread()` — call after `runtime.LockOSThread()` in a worker goroutine

- [ ] **Step 1: Write failing tests**

```go
package yarascan

import (
	"context"
	"strings"
	"testing"
)

type fakeFetcher map[string]*Bundle

func (f fakeFetcher) Fetch(_ context.Context, ref RuleSetRef) (*Bundle, *RuleSetError) {
	if b, ok := f[ref.ID]; ok {
		return b, nil
	}
	return nil, &RuleSetError{ID: ref.ID, Version: ref.Version, Code: CodeHTTP404}
}

func bundle(id string, rules ...BundleRule) *Bundle {
	return &Bundle{Format: BundleFormat, V: 1, RuleSetID: id, Version: 1, Rules: rules}
}

const marker = `rule fixture_marker : fixture { meta: threat_type = "pup" strings: $a = "breeze_yara_fixture_marker_7f3a" condition: $a }`

func TestLoadMatcherScansFixture(t *testing.T) {
	f := fakeFetcher{"s1": bundle("s1", BundleRule{ID: "r1", Name: "fixture_marker", Severity: "critical", Source: marker})}
	m, errs := LoadMatcher(context.Background(), []RuleSetRef{{ID: "s1", Version: 1, SHA256: strings.Repeat("a", 64)}}, f, &Cache{Dir: t.TempDir(), MaxEntries: 16})
	if m == nil || len(errs) != 0 {
		t.Fatalf("load failed: %+v", errs)
	}
	defer m.Close()
	w, err := m.NewWorker()
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	got, err := w.ScanFile("testdata/files/fixture-a.bin")
	if err != nil || len(got) != 1 {
		t.Fatalf("want 1 match, got %+v %v", got, err)
	}
	g := got[0]
	if g.RuleSetID != "s1" || g.RuleID != "r1" || g.Severity != "critical" || g.ThreatType != "pup" || len(g.Tags) != 1 || g.Tags[0] != "fixture" {
		t.Fatalf("match metadata wrong: %+v", g)
	}
	if len(g.Strings) != 1 || g.Strings[0].ID != "$a" || g.Strings[0].Offset != 7 {
		t.Fatalf("matched string wrong: %+v", g.Strings)
	}
}

func TestLoadMatcherIsolatesFailingBundle(t *testing.T) {
	f := fakeFetcher{
		"good": bundle("good", BundleRule{ID: "r1", Name: "fixture_marker", Severity: "high", Source: marker}),
		"bad":  bundle("bad", BundleRule{ID: "r2", Name: "broken", Severity: "high", Source: `rule broken { condition: `}),
	}
	refs := []RuleSetRef{{ID: "good", Version: 1}, {ID: "bad", Version: 1}, {ID: "gone", Version: 1}}
	m, errs := LoadMatcher(context.Background(), refs, f, &Cache{Dir: t.TempDir(), MaxEntries: 16})
	if m == nil {
		t.Fatal("one usable set must still produce a matcher")
	}
	defer m.Close()
	codes := map[string]string{}
	for _, e := range errs {
		codes[e.ID] = e.Code
	}
	if codes["bad"] != CodeCompile || codes["gone"] != CodeHTTP404 || codes["good"] != "" {
		t.Fatalf("per-set errors wrong: %+v", errs)
	}
}

func TestLoadMatcherAllFailReturnsNil(t *testing.T) {
	m, errs := LoadMatcher(context.Background(), []RuleSetRef{{ID: "gone", Version: 1}}, fakeFetcher{}, &Cache{Dir: t.TempDir(), MaxEntries: 16})
	if m != nil || len(errs) != 1 {
		t.Fatalf("want nil matcher + 1 error, got %v %+v", m, errs)
	}
}

func TestCapMatchedStrings(t *testing.T) {
	data := []byte("A\x00" + strings.Repeat("B", 200))
	s := escapeMatched(data)
	if !strings.HasPrefix(s, `A\x00`) || len(s) > MaxMatchedBytes*4 {
		t.Fatalf("escape/cap wrong: %q", s)
	}
}
```

- [ ] **Step 2: Run to fail** — `go test -race ./internal/yarascan/ -run 'LoadMatcher|CapMatched' -v` → FAIL.

- [ ] **Step 3: Implement `matcher.go`**

```go
package yarascan

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	yx "github.com/niallnsec/yaraxwasm"

	"github.com/breeze-rmm/agent/internal/yarascan/yarac"
)

const (
	PerFileTimeout    = 60 * time.Second
	MaxMatchedStrings = 10
	MaxMatchedBytes   = 128
)

var allowedThreatTypes = map[string]struct{}{"malware": {}, "trojan": {}, "ransomware": {}, "pup": {}, "exploit": {}, "hacktool": {}, "webshell": {}, "suspicious": {}}

type MatchedString struct {
	ID     string `json:"id"`
	Offset int64  `json:"offset"`
	Data   string `json:"data"`
}

type Match struct {
	RuleSetID, RuleID, RuleName, Severity, ThreatType string
	Tags                                              []string
	Strings                                           []MatchedString
	AutoQuarantine                                    bool
}

type Worker interface {
	ScanFile(path string) ([]Match, error)
	Close()
}

type Matcher interface {
	Engine() string
	NewWorker() (Worker, error)
	Close()
}

type yaraMatcher struct{ entry *CacheEntry }

func (m *yaraMatcher) Engine() string { return "yara" }
func (m *yaraMatcher) Close()         {}

func (m *yaraMatcher) NewWorker() (w Worker, err error) {
	defer func() {
		if r := recover(); r != nil { // yaraxwasm.NewScanner panics on guest failure
			w, err = nil, fmt.Errorf("YARA scanner init failed: %v", r)
		}
	}()
	s := yx.NewScanner(m.entry.Rules)
	s.SetTimeout(PerFileTimeout)
	return &yaraWorker{s: s, entry: m.entry}, nil
}

type yaraWorker struct {
	s     *yx.Scanner
	entry *CacheEntry
}

func (w *yaraWorker) Close() { w.s.Destroy() }

func (w *yaraWorker) ScanFile(path string) (out []Match, err error) {
	defer func() {
		if r := recover(); r != nil {
			out, err = nil, fmt.Errorf("YARA scan panicked on %s: %v", path, r)
		}
	}()
	base := filepath.Base(path)
	_ = w.s.SetGlobal("filename", base)
	_ = w.s.SetGlobal("filepath", path)
	_ = w.s.SetGlobal("extension", strings.TrimPrefix(strings.ToLower(filepath.Ext(base)), "."))
	res, err := w.s.ScanFile(path)
	if err != nil {
		return nil, err
	}
	for _, rule := range res.MatchingRules() {
		ns, name := rule.Namespace(), rule.Identifier()
		meta := w.entry.Index[ns+":"+name]
		m := Match{RuleSetID: ns, RuleID: meta.RuleID, RuleName: name, Severity: meta.Severity,
			ThreatType: "malware", Tags: rule.Tags(), AutoQuarantine: w.entry.AutoQuarantine[ns]}
		for _, md := range rule.Metadata() {
			if md.Identifier() == "threat_type" {
				if v, ok := md.Value().(string); ok {
					if _, ok := allowedThreatTypes[v]; ok {
						m.ThreatType = v
					}
				}
			}
		}
		m.Strings = collectStrings(path, rule)
		out = append(out, m)
	}
	return out, nil
}

// collectStrings re-reads at most MaxMatchedBytes per match from the file:
// the engine reports offsets/lengths, and we never hold more than 10×128
// bytes of customer file content in a result (spec §9).
func collectStrings(path string, rule *yx.Rule) []MatchedString {
	var out []MatchedString
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()
	for _, p := range rule.Patterns() {
		for _, mt := range p.Matches() {
			if len(out) >= MaxMatchedStrings {
				return out
			}
			n := mt.Length()
			if n > MaxMatchedBytes {
				n = MaxMatchedBytes
			}
			buf := make([]byte, n)
			k, _ := f.ReadAt(buf, int64(mt.Offset()))
			out = append(out, MatchedString{ID: p.Identifier(), Offset: int64(mt.Offset()), Data: escapeMatched(buf[:k])})
		}
	}
	return out
}

func escapeMatched(b []byte) string {
	if len(b) > MaxMatchedBytes {
		b = b[:MaxMatchedBytes]
	}
	var sb strings.Builder
	for _, c := range b {
		if c >= 0x20 && c < 0x7f && c != '\\' {
			sb.WriteByte(c)
		} else {
			fmt.Fprintf(&sb, `\x%02x`, c)
		}
	}
	return sb.String()
}

func toYaracSet(b *Bundle) yarac.Set {
	s := yarac.Set{ID: b.RuleSetID}
	for _, r := range b.Rules {
		s.Rules = append(s.Rules, yarac.Rule{ID: r.ID, Name: r.Name, Severity: r.Severity, Source: r.Source})
	}
	return s
}

// LoadMatcher: fetch every ref, compile the usable ones together (cache hit
// skips both compile steps), report per-set failures. Rule source lives only
// in memory for the duration of this call.
func LoadMatcher(ctx context.Context, refs []RuleSetRef, f Fetcher, c *Cache) (m Matcher, errs []RuleSetError) {
	defer func() {
		if r := recover(); r != nil {
			m = nil
			errs = append(errs, RuleSetError{ID: "*", Code: CodeEngineUnavailable, Detail: fmt.Sprint(r)})
		}
	}()
	var bundles []*Bundle
	var sums []string
	for _, ref := range refs {
		b, rerr := f.Fetch(ctx, ref)
		if rerr != nil {
			errs = append(errs, *rerr)
			continue
		}
		bundles = append(bundles, b)
		sums = append(sums, ref.SHA256+"@"+ref.ID)
	}
	if len(bundles) == 0 {
		return nil, errs
	}
	key := CacheKey(sums)
	if entry, err := c.Load(key); err == nil && entry != nil {
		return &yaraMatcher{entry: entry}, errs
	}
	var sets []yarac.Set
	byID := map[string]*Bundle{}
	for _, b := range bundles {
		sets = append(sets, toYaracSet(b))
		byID[b.RuleSetID] = b
	}
	rules, setErrs, err := yarac.CompileSets(sets, yarac.DefaultPolicy)
	for id, re := range setErrs {
		detail := re[0].Message
		if re[0].Name != "" {
			detail = re[0].Name + ": " + detail
		}
		errs = append(errs, RuleSetError{ID: id, Version: byID[id].Version, Code: CodeCompile, Detail: truncate(detail, 512)})
	}
	if err != nil || rules == nil {
		if err != nil {
			errs = append(errs, RuleSetError{ID: "*", Code: CodeCompile, Detail: truncate(err.Error(), 512)})
		}
		return nil, errs
	}
	entry := &CacheEntry{Rules: rules, Index: map[string]RuleMeta{}, AutoQuarantine: map[string]bool{}}
	for _, b := range bundles {
		if _, failed := setErrs[b.RuleSetID]; failed {
			continue
		}
		entry.AutoQuarantine[b.RuleSetID] = b.AutoQuarantine
		for _, r := range b.Rules {
			entry.Index[b.RuleSetID+":"+r.Name] = RuleMeta{RuleID: r.ID, Severity: r.Severity}
		}
	}
	// Only cache a fully-successful compile: a partial set list would be
	// served from cache next time without re-reporting the failed set.
	if len(setErrs) == 0 {
		if err := c.Store(key, entry); err != nil {
			log.Warn("failed to cache compiled YARA rules", "error", err.Error())
		}
	}
	return &yaraMatcher{entry: entry}, errs
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
```

Low-priority files:

```go
//go:build windows

package yarascan

import "golang.org/x/sys/windows"

const threadModeBackgroundBegin = 0x00010000

// EnterBackgroundThread lowers CPU and I/O priority of the CURRENT OS thread
// (caller must have called runtime.LockOSThread). DECISION W02-c.
func EnterBackgroundThread() {
	if err := windows.SetThreadPriority(windows.CurrentThread(), threadModeBackgroundBegin); err != nil {
		log.Warn("could not enter background thread mode", "error", err.Error())
	}
}
```

```go
//go:build linux

package yarascan

import "golang.org/x/sys/unix"

const (
	ioprioClassIdle  = 3
	ioprioClassShift = 13
	ioprioWhoProcess = 1
)

func EnterBackgroundThread() {
	tid := unix.Gettid()
	if err := unix.Setpriority(unix.PRIO_PROCESS, tid, 10); err != nil {
		log.Warn("could not lower scan thread CPU priority", "error", err.Error())
	}
	if _, _, errno := unix.Syscall(unix.SYS_IOPRIO_SET, ioprioWhoProcess, uintptr(tid), uintptr(ioprioClassIdle<<ioprioClassShift)); errno != 0 {
		log.Warn("could not lower scan thread I/O priority", "error", errno.Error())
	}
}
```

```go
//go:build !windows && !linux

package yarascan

func EnterBackgroundThread() {} // macOS: per-thread I/O policy needs setiopolicy_np (cgo); deferred.
```

- [ ] **Step 4: Run to pass** — `go test -race ./internal/yarascan/... -v` and `GOOS=windows go vet ./internal/yarascan/...` and `GOOS=darwin go vet ./internal/yarascan/...` → PASS/clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent): YARA matcher with per-set error isolation and background-priority workers (#6265)"`.

---

### Task 7: Worker-pool walk driving any `Matcher`; legacy table becomes `legacyMatcher`

**Files:**
- Create: `agent/internal/security/walkpool.go`, `agent/internal/security/walkpool_test.go`
- Modify: `agent/internal/security/threats.go` (add `Threat` fields; add `legacyMatcher`; make
  `detectThreatsCtx` delegate to `walkAndMatch` with `legacyMatcher{options}`)

**Interfaces:**
- Consumes: `yarascan.Matcher`, `yarascan.Worker`, `yarascan.Match`, `yarascan.EnterBackgroundThread`.
- Produces:
  - `Threat` gains: `RuleName string \`json:"ruleName,omitempty"\``, `RuleSetID string \`json:"ruleSetId,omitempty"\``, `RuleID string \`json:"ruleId,omitempty"\``, `Tags []string \`json:"tags,omitempty"\``, `MatchedStrings []yarascan.MatchedString \`json:"matchedStrings,omitempty"\``, `SHA256 string \`json:"sha256,omitempty"\``, and unexported `autoQuarantine bool` (per-set D7 flag; not serialized).
  - `func walkAndMatch(ctx context.Context, paths []string, options threatScanOptions, m yarascan.Matcher, workers int) ([]Threat, int, error)`
  - `type legacyMatcher struct{ options threatScanOptions }` implementing `yarascan.Matcher` (`Engine() == "legacy"`)
  - `func defaultScanWorkers() int` = `clamp(runtime.NumCPU()/2, 1, 4)`
  - `const maxHashBytes = 256 << 20` (files larger than this get `SHA256 == ""`)

- [ ] **Step 1: Write failing tests** (`walkpool_test.go`)

```go
package security

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/yarascan"
)

type stubMatcher struct {
	delay time.Duration
	hits  map[string]bool
	calls atomic.Int64
}

func (s *stubMatcher) Engine() string { return "stub" }
func (s *stubMatcher) Close()         {}
func (s *stubMatcher) NewWorker() (yarascan.Worker, error) {
	return stubWorker{s}, nil
}

type stubWorker struct{ s *stubMatcher }

func (w stubWorker) Close() {}
func (w stubWorker) ScanFile(p string) ([]yarascan.Match, error) {
	w.s.calls.Add(1)
	time.Sleep(w.s.delay)
	if w.s.hits[filepath.Base(p)] {
		return []yarascan.Match{{RuleSetID: "s", RuleID: "r", RuleName: "stub_rule", Severity: "high", ThreatType: "malware"}}, nil
	}
	return nil, nil
}

func tree(t *testing.T, n int) string {
	t.Helper()
	dir := t.TempDir()
	for i := 0; i < n; i++ {
		if err := os.WriteFile(filepath.Join(dir, "f"+string(rune('a'+i%26))+string(rune('0'+i/26))), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestWalkPoolFindsAndAttributes(t *testing.T) {
	dir := tree(t, 30)
	m := &stubMatcher{hits: map[string]bool{"fc0": true}}
	threats, scanned, err := walkAndMatch(context.Background(), []string{dir}, defaultThreatScanOptions(), m, 4)
	if err != nil || scanned != 30 || len(threats) != 1 {
		t.Fatalf("got %d threats, %d scanned, err %v", len(threats), scanned, err)
	}
	th := threats[0]
	if th.RuleName != "stub_rule" || th.RuleSetID != "s" || th.Name != "stub_rule" || th.SHA256 == "" {
		t.Fatalf("threat not attributed: %+v", th)
	}
}

func TestWalkPoolHonoursDeadlineWithSlowWorker(t *testing.T) {
	dir := tree(t, 200)
	m := &stubMatcher{delay: 20 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, scanned, err := walkAndMatch(ctx, []string{dir}, defaultThreatScanOptions(), m, 2)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want deadline error, got %v", err)
	}
	if time.Since(start) > 2*time.Second || scanned >= 200 {
		t.Fatalf("deadline not honoured: %v elapsed, %d scanned", time.Since(start), scanned)
	}
}

func TestWalkPoolHonoursExclusions(t *testing.T) {
	dir := tree(t, 5)
	sub := filepath.Join(dir, "skip")
	_ = os.Mkdir(sub, 0o700)
	_ = os.WriteFile(filepath.Join(sub, "fa0"), []byte("x"), 0o600)
	opts := defaultThreatScanOptions()
	opts.ExcludePaths = append(opts.ExcludePaths, sub)
	m := &stubMatcher{}
	_, scanned, _ := walkAndMatch(context.Background(), []string{dir}, opts, m, 2)
	if scanned != 5 {
		t.Fatalf("excluded dir scanned: %d", scanned)
	}
}

func TestLegacyMatcherStillDetectsViaPool(t *testing.T) {
	// The existing threats_test.go table-driven cases must pass unchanged
	// through detectThreatsCtx → walkAndMatch(legacyMatcher). This test only
	// pins the engine label.
	if (legacyMatcher{}).Engine() != "legacy" {
		t.Fatal("legacy engine label changed")
	}
}
```

- [ ] **Step 2: Run to fail** — `go test -race ./internal/security/ -run 'WalkPool|LegacyMatcher' -v` → FAIL.

- [ ] **Step 3: Implement `walkpool.go`** (the walk rules are lifted verbatim from the current
  `detectThreatsCtx`: `os.Lstat`, symlinks skipped, permission errors skipped, exclusions by
  `isExcludedPath`, regular files only, size cap from `options.MaxFileSize`)

```go
package security

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/breeze-rmm/agent/internal/yarascan"
)

const maxHashBytes = 256 << 20

func defaultScanWorkers() int {
	n := runtime.NumCPU() / 2
	if n < 1 {
		n = 1
	}
	if n > 4 {
		n = 4
	}
	return n
}

type fileJob struct {
	path string
	size int64
}

// walkAndMatch: one producer walks, `workers` goroutines each own one
// matcher Worker (one wasm instance) for the whole scan.
func walkAndMatch(ctx context.Context, paths []string, options threatScanOptions, m yarascan.Matcher, workers int) ([]Threat, int, error) {
	if workers < 1 {
		workers = 1
	}
	jobs := make(chan fileJob, workers*4)
	var (
		mu      sync.Mutex
		threats []Threat
		seen    = map[string]struct{}{}
		errs    []error
		scanned int
	)
	addErr := func(err error) { mu.Lock(); errs = append(errs, err); mu.Unlock() }

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			runtime.LockOSThread() // never unlocked: the runtime retires this thread (W02-c)
			yarascan.EnterBackgroundThread()
			w, err := m.NewWorker()
			if err != nil {
				addErr(err)
				for range jobs { // drain so the producer never blocks
				}
				return
			}
			defer w.Close()
			for job := range jobs {
				if ctx.Err() != nil {
					continue
				}
				matches, err := w.ScanFile(job.path)
				mu.Lock()
				scanned++
				mu.Unlock()
				if err != nil {
					if !os.IsPermission(err) {
						addErr(err)
					}
					continue
				}
				if len(matches) == 0 {
					continue
				}
				sum := ""
				if job.size <= maxHashBytes {
					sum = fileSHA256(job.path)
				}
				mu.Lock()
				for _, mt := range matches {
					key := mt.RuleSetID + "|" + mt.RuleName + "|" + job.path
					if _, dup := seen[key]; dup {
						continue
					}
					seen[key] = struct{}{}
					threats = append(threats, threatFromMatch(mt, job.path, sum))
				}
				mu.Unlock()
			}
		}()
	}

	walkErr := produce(ctx, uniquePaths(paths), options, jobs, addErr)
	close(jobs)
	wg.Wait()
	if walkErr != nil {
		errs = append(errs, walkErr)
	}
	return threats, scanned, errors.Join(errs...)
}

func threatFromMatch(mt yarascan.Match, path, sum string) Threat {
	t := Threat{
		Name: mt.RuleName, Type: mt.ThreatType, Severity: mt.Severity, Path: path,
		RuleName: mt.RuleName, RuleSetID: mt.RuleSetID, RuleID: mt.RuleID,
		Tags: mt.Tags, MatchedStrings: mt.Strings, SHA256: sum, autoQuarantine: mt.AutoQuarantine,
	}
	if mt.RuleSetID == "" {
		t.RuleName = "" // legacy signature hit: keep the W01 result shape (name/type/severity/path + sha256)
	}
	return t
}

func fileSHA256(p string) string {
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, io.LimitReader(f, maxHashBytes)); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

func produce(ctx context.Context, roots []string, options threatScanOptions, jobs chan<- fileJob, addErr func(error)) error {
	send := func(p string, size int64) error {
		if options.MaxFileSize > 0 && size > options.MaxFileSize {
			return nil
		}
		select {
		case jobs <- fileJob{path: p, size: size}:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	for _, root := range roots {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if isExcludedPath(root, options.ExcludePaths) {
			continue
		}
		info, err := os.Lstat(root)
		if err != nil {
			if !os.IsNotExist(err) {
				addErr(err)
			}
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		if !info.IsDir() {
			if info.Mode().IsRegular() {
				if err := send(root, info.Size()); err != nil {
					return err
				}
			}
			continue
		}
		err = filepath.WalkDir(root, func(cur string, d fs.DirEntry, werr error) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if werr != nil {
				if os.IsPermission(werr) {
					return fs.SkipDir
				}
				addErr(werr)
				return nil
			}
			if isExcludedPath(cur, options.ExcludePaths) {
				if d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if d.Type()&os.ModeSymlink != 0 || d.IsDir() {
				return nil
			}
			fi, err := d.Info()
			if err != nil || !fi.Mode().IsRegular() {
				return nil
			}
			return send(cur, fi.Size())
		})
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		if err != nil && !os.IsPermission(err) {
			addErr(err)
		}
	}
	return nil
}
```

Then in `threats.go`: add the `Threat` fields listed above; add

```go
// legacyMatcher adapts the XOR-obfuscated signature table to the Matcher
// interface so both engines share one walk. Used whenever no rule set is
// usable (no ruleSets, all failed, or engine unavailable).
type legacyMatcher struct{ options threatScanOptions }

func (legacyMatcher) Engine() string { return "legacy" }
func (legacyMatcher) Close()         {}
func (l legacyMatcher) NewWorker() (yarascan.Worker, error) { return legacyWorker(l), nil }

type legacyWorker legacyMatcher

func (legacyWorker) Close() {}
func (l legacyWorker) ScanFile(path string) ([]yarascan.Match, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	found, err := scanFileForThreats(path, info, l.options)
	out := make([]yarascan.Match, 0, len(found))
	for _, th := range found {
		out = append(out, yarascan.Match{RuleName: th.Name, Severity: th.Severity, ThreatType: th.Type})
	}
	return out, err
}
```

and replace the body of `detectThreatsCtx` with
`return walkAndMatch(ctx, paths, options, legacyMatcher{options: options}, 1)`. Keep worker count
`1` for legacy (W01 behaviour; cheap matcher). For legacy matches `threatFromMatch` sets
`RuleName` = signature name and `RuleSetID == ""`; **clear `RuleName` when `RuleSetID == ""`** so the
legacy result shape stays identical to W01 (`name/type/severity/path` only, plus `sha256`).

- [ ] **Step 4: Run the whole package, including every pre-existing threats/scanner test unchanged**

Run: `cd agent && go test -race ./internal/security/... -v`
Expected: PASS, with `threats_test.go` and `scanner_test.go` untouched.

- [ ] **Step 5: Commit** — `git commit -m "feat(agent): worker-pool scan walk behind a Matcher; legacy signatures as fallback matcher (#6265)"`.

---

### Task 8: Scanner + handler — parse `ruleSets`, pick the engine, report `engine`/`ruleSetErrors`; D7 per-set auto-quarantine

**Files:**
- Modify: `agent/internal/security/scanner.go`
- Modify: `agent/internal/heartbeat/handlers_security.go`
- Create: `agent/internal/heartbeat/handlers_security_yara_test.go`

**Interfaces:**
- Consumes: `yarascan.ParseRuleSetRefs`, `yarascan.LoadMatcher`, `yarascan.HTTPFetcher`, `yarascan.Cache`, `config.GetDataDir()`, `h.httpClient()`, `h.authHeader()`, `h.config.ServerURL` (confirm field name with `grep -n "ServerURL" agent/internal/config/config.go`).
- Produces:
  - `SecurityScanner.Matcher yarascan.Matcher` (nil ⇒ legacy) and `ScanOutcome.Engine string`.
  - Result keys `engine`, `ruleSetErrors` (C3).
  - Auto-quarantine rule: a YARA threat is auto-quarantined only when **policy** `autoQuarantine` is
    true **and** the bundle's `autoQuarantine` is true (spec D7). Legacy threats keep W01 behaviour
    (policy flag alone).

- [ ] **Step 1: Write failing handler tests**

```go
package heartbeat

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func goldenBundle(t *testing.T) ([]byte, string) {
	t.Helper()
	b, err := os.ReadFile("../yarascan/testdata/bundle-v1.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	s, _ := os.ReadFile("../yarascan/testdata/bundle-v1.golden.json.sha256")
	return b, strings.TrimSpace(string(s))
}

func TestHandleSecurityScanWithRuleSetsUsesYara(t *testing.T) {
	body, sum := goldenBundle(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(body) }))
	defer srv.Close()
	h := newTestHeartbeatWithServer(t, srv) // helper: sets config.ServerURL=srv.URL, auth token, data dir = t.TempDir()
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "x.bin"), []byte("..breeze_yara_fixture_marker_7f3a.."), 0o600)

	res := handleSecurityScan(h, Command{ID: "c1", Type: tools.CmdSecurityScan, Payload: map[string]any{
		"scanType": "custom", "paths": []any{dir},
		"ruleSets": []any{map[string]any{"id": "00000000-0000-4000-8000-000000000001", "version": float64(3), "sha256": sum,
			"url": "/api/v1/agents/a/yara/rule-sets/00000000-0000-4000-8000-000000000001/3"}},
	}})
	out := decodeResult(t, res)
	if out["engine"] != "yara" || out["threatsFound"].(float64) != 1 {
		t.Fatalf("want yara engine and 1 threat, got %+v", out)
	}
	th := out["threats"].([]any)[0].(map[string]any)
	if th["ruleName"] != "fixture_marker" || th["type"] != "pup" || th["sha256"] == "" {
		t.Fatalf("threat missing rule detail: %+v", th)
	}
}

func TestHandleSecurityScanIgnoresMalformedRuleSets(t *testing.T) {
	h := newTestHeartbeatWithServer(t, nil)
	res := handleSecurityScan(h, Command{ID: "c2", Type: tools.CmdSecurityScan, Payload: map[string]any{
		"scanType": "custom", "paths": []any{t.TempDir()}, "ruleSets": "not-an-array",
	}})
	out := decodeResult(t, res)
	if out["engine"] != "legacy" {
		t.Fatalf("malformed ruleSets must fall back to legacy, got %+v", out)
	}
	errs := out["ruleSetErrors"].([]any)
	if len(errs) != 1 || errs[0].(map[string]any)["code"] != "invalid_refs" {
		t.Fatalf("want invalid_refs, got %+v", errs)
	}
}

func TestHandleSecurityScanNoRuleSetsIsW01Shape(t *testing.T) {
	h := newTestHeartbeatWithServer(t, nil)
	res := handleSecurityScan(h, Command{ID: "c3", Type: tools.CmdSecurityScan, Payload: map[string]any{"scanType": "custom", "paths": []any{t.TempDir()}}})
	out := decodeResult(t, res)
	if out["engine"] != "legacy" || len(out["ruleSetErrors"].([]any)) != 0 {
		t.Fatalf("no ruleSets must be legacy with no errors, got %+v", out)
	}
}

func TestYaraAutoQuarantineNeedsBothFlags(t *testing.T) {
	// Golden bundle has autoQuarantine=false; policy autoQuarantine=true must NOT quarantine (D7).
	body, sum := goldenBundle(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(body) }))
	defer srv.Close()
	h := newTestHeartbeatWithServer(t, srv)
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "x.bin"), []byte("breeze_yara_fixture_marker_7f3a"), 0o600)
	res := handleSecurityScan(h, Command{ID: "c4", Type: tools.CmdSecurityScan, Payload: map[string]any{
		"scanType": "custom", "paths": []any{dir}, "autoQuarantine": true,
		"ruleSets": []any{map[string]any{"id": "00000000-0000-4000-8000-000000000001", "version": float64(3), "sha256": sum,
			"url": "/api/v1/agents/a/yara/rule-sets/00000000-0000-4000-8000-000000000001/3"}},
	}})
	th := decodeResult(t, res)["threats"].([]any)[0].(map[string]any)
	if th["quarantinedTo"] != nil && th["quarantinedTo"] != "" {
		t.Fatal("custom set with autoQuarantine=false was quarantined")
	}
	if _, err := os.Stat(filepath.Join(dir, "x.bin")); err != nil {
		t.Fatal("file was moved")
	}
}
```

Add `newTestHeartbeatWithServer` and `decodeResult` to this test file, modelled on the existing
helpers in `handlers_security_test.go` (`grep -n "func newTestHeartbeat\|securityScanner:" agent/internal/heartbeat/*_test.go`).

- [ ] **Step 2: Run to fail** — `go test -race ./internal/heartbeat/ -run 'HandleSecurityScan|YaraAutoQuarantine' -v` → FAIL.

- [ ] **Step 3: Implement**

`scanner.go`: add field `Matcher yarascan.Matcher` to `SecurityScanner`, field `Engine string` to
`ScanOutcome`. In `ScanWithContext` replace the `detectThreatsCtx(...)` call with:

```go
	engine := "legacy"
	var threats []Threat
	var filesScanned int
	var scanErr error
	if s.Matcher != nil {
		engine = s.Matcher.Engine()
		threats, filesScanned, scanErr = walkAndMatch(scanCtx, targets, options, s.Matcher, defaultScanWorkers())
	} else {
		threats, filesScanned, scanErr = detectThreatsCtx(scanCtx, targets, options)
	}
```

and replace the auto-quarantine loop so it (a) honours D7 per threat, (b) quarantines each **file**
once even when several rules matched it (today's per-threat loop would report the second threat on
the same path as `quarantineFailed` because the file is already gone — quorum finding), and (c)
re-verifies the file's identity before moving it (the file may have changed since it was hashed):

```go
	if s.AutoQuarantine && len(threats) > 0 {
		dir := s.quarantineDir()
		done := map[string]string{} // path -> quarantinedTo ("" = attempted and failed)
		for i := range threats {
			th := &threats[i]
			if th.RuleSetID != "" && !th.autoQuarantine {
				continue // D7: a custom rule set never auto-quarantines unless the set opts in
			}
			if dest, seen := done[th.Path]; seen {
				th.QuarantinedTo, th.QuarantineFailed = dest, dest == ""
				continue
			}
			if th.SHA256 != "" && fileSHA256(th.Path) != th.SHA256 {
				log.Warn("skipping auto-quarantine: file changed since it was scanned", "path", th.Path)
				done[th.Path], th.QuarantineFailed = "", true
				continue
			}
			dest, qErr := QuarantineThreat(*th, dir)
			if qErr != nil {
				log.Warn("auto-quarantine failed", "path", th.Path, "name", th.Name, "error", qErr.Error())
				done[th.Path], th.QuarantineFailed = "", true
				continue
			}
			done[th.Path], th.QuarantinedTo = dest, dest
		}
	}
```

Add to the Step 1 tests:

```go
func TestAutoQuarantineOncePerFile(t *testing.T) {
	setID := "00000000-0000-4000-8000-000000000002"
	body := []byte(`{"format":"breeze-yara-bundle","v":1,"ruleSetId":"` + setID + `","version":1,"autoQuarantine":true,"rules":[` +
		`{"id":"r1","name":"m_one","severity":"high","source":"rule m_one { strings: $a = \"breeze_yara_fixture_marker_7f3a\" condition: $a }"},` +
		`{"id":"r2","name":"m_two","severity":"high","source":"rule m_two { strings: $a = \"fixture_marker_7f3a\" condition: $a }"}]}`)
	sum := sha256.Sum256(body)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(body) }))
	defer srv.Close()
	h := newTestHeartbeatWithServer(t, srv)
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "x.bin"), []byte("breeze_yara_fixture_marker_7f3a"), 0o600)
	res := handleSecurityScan(h, Command{ID: "c5", Type: tools.CmdSecurityScan, Payload: map[string]any{
		"scanType": "custom", "paths": []any{dir}, "autoQuarantine": true,
		"ruleSets": []any{map[string]any{"id": setID, "version": float64(1), "sha256": hex.EncodeToString(sum[:]),
			"url": "/api/v1/agents/a/yara/rule-sets/" + setID + "/1"}},
	}})
	ths := decodeResult(t, res)["threats"].([]any)
	if len(ths) != 2 {
		t.Fatalf("want 2 threats, got %d", len(ths))
	}
	a, b := ths[0].(map[string]any), ths[1].(map[string]any)
	if a["quarantinedTo"] == "" || a["quarantinedTo"] != b["quarantinedTo"] || a["quarantineFailed"] == true || b["quarantineFailed"] == true {
		t.Fatalf("file must be quarantined once and shared: %+v / %+v", a, b)
	}
	bqz, _ := filepath.Glob(filepath.Join(h.securityScanner.QuarantineDir, "*.bqz"))
	if len(bqz) != 1 {
		t.Fatalf("want exactly one .bqz, got %d", len(bqz))
	}
}
```

(`newTestHeartbeatWithServer` must set `securityScanner.QuarantineDir` to a `t.TempDir()`; add
`crypto/sha256` and `encoding/hex` to the test imports.)

and set `Engine: engine` in the returned `ScanOutcome`.

`handlers_security.go`, before `scanner.ScanWithContext`:

```go
	var ruleSetErrors []yarascan.RuleSetError
	refs, refErr := yarascan.ParseRuleSetRefs(cmd.Payload["ruleSets"])
	if refErr != nil {
		ruleSetErrors = append(ruleSetErrors, yarascan.RuleSetError{ID: "*", Code: yarascan.CodeInvalidRefs, Detail: refErr.Error()})
		cmdLog.Warn("ignoring malformed ruleSets; scanning with built-in signatures", "error", refErr.Error())
	}
	if len(refs) > 0 {
		fetcher := &yarascan.HTTPFetcher{BaseURL: h.config.ServerURL, Client: h.httpClient(), AuthHeader: h.authHeader}
		cache := &yarascan.Cache{Dir: filepath.Join(config.GetDataDir(), "yara", "cache"), MaxEntries: 16}
		loadCtx, cancelLoad := context.WithTimeout(context.Background(), 5*time.Minute)
		m, errs := yarascan.LoadMatcher(loadCtx, refs, fetcher, cache)
		cancelLoad()
		ruleSetErrors = append(ruleSetErrors, errs...)
		if m != nil {
			defer m.Close()
			scanner.Matcher = m
		} else {
			cmdLog.Warn("no YARA rule set usable; scanning with built-in signatures", "errors", len(errs))
		}
	}
	if ruleSetErrors == nil {
		ruleSetErrors = []yarascan.RuleSetError{} // always an array on the wire
	}
```

and add `"engine": outcome.Engine, "ruleSetErrors": ruleSetErrors` to the success result map.

- [ ] **Step 4: Run** — `go test -race ./internal/heartbeat/ ./internal/security/ ./internal/yarascan/... -v` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent): security_scan accepts ruleSets and reports engine + per-set errors (#6265)"`.

---

### Task 9: Quarantine manifest v2

**Files:**
- Modify: `agent/internal/security/quarantine.go`, `agent/internal/security/quarantine_test.go`

**Interfaces:**
- Produces: `QuarantineManifest` gains `RuleName string \`json:"ruleName,omitempty"\`` and `RuleSetID string \`json:"ruleSetId,omitempty"\``; `quarantineManifestVersion = 2`; readers accept `v ∈ {1, 2}`.

- [ ] **Step 1: Failing tests**

```go
func TestQuarantineManifestV2CarriesRule(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.bin")
	_ = os.WriteFile(src, []byte("payload"), 0o600)
	dest, err := QuarantineThreat(Threat{Name: "r", Path: src, RuleName: "r", RuleSetID: "s1"}, filepath.Join(dir, "q"))
	if err != nil {
		t.Fatal(err)
	}
	var m QuarantineManifest
	raw, _ := os.ReadFile(dest + ".json")
	_ = json.Unmarshal(raw, &m)
	if m.V != 2 || m.RuleName != "r" || m.RuleSetID != "s1" {
		t.Fatalf("manifest v2 fields missing: %+v", m)
	}
}

func TestRestoreReadsManifestV1(t *testing.T) {
	// Write a v1 manifest + payload by hand (format from W01) and restore it.
	dir := t.TempDir()
	payload := filepath.Join(dir, "a-1.bqz")
	_ = os.WriteFile(payload, obfuscateForTest([]byte("hello")), 0o600)
	v1 := `{"v":1,"originalPath":"` + filepath.ToSlash(filepath.Join(dir, "a.bin")) + `","sha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824","name":"n","type":"malware","severity":"high","quarantinedAt":"2026-10-13T00:00:00Z"}`
	_ = os.WriteFile(payload+".json", []byte(v1), 0o600)
	if _, err := RestoreQuarantined(payload, filepath.Join(dir, "a.bin")); err != nil {
		t.Fatalf("v1 manifest must still restore: %v", err)
	}
}
```

(`obfuscateForTest` = `obfuscate.DecodeBytes`. Check the actual manifest path convention in
`quarantine.go` — the manifest is `<payload>.json` per the W01 index (`.bqz.json`).)

- [ ] **Step 2: Run to fail**, **Step 3:** add the two fields, populate them from `threat.RuleName` /
  `threat.RuleSetID` where the manifest is built, bump the constant, change the reader's
  `m.V != quarantineManifestVersion` check to `m.V != 1 && m.V != 2`. **Step 4:** `go test -race
  ./internal/security/ -run Quarantine -v` → PASS. **Step 5:** commit
  `feat(agent): quarantine manifest v2 records the matching rule (#6265)`.

---

### Task 10: `breeze-yarac` CLI + build/CI wiring

**Files:**
- Create: `agent/cmd/breeze-yarac/main.go`, `agent/cmd/breeze-yarac/main_test.go`
- Modify: `agent/Makefile` (target `build-yarac`), `.github/workflows/ci.yml` (agent build job: build
  `breeze-yarac` for linux/amd64 and run `scripts/security/check-agent-binary-signatures.sh` on it)

**Interfaces:**
- Consumes: `yarac.ValidateSet`, `yarac.CompileSets`, `yarascan.Bundle`, `yarascan.ParseBundle`, `yarascan.Matcher` pieces.
- Produces (W03 depends on `validate`):
  - `breeze-yarac validate < bundle.json` → stdout C5 JSON `{"ok":bool,"errors":[RuleError…]}`, exit 0 when ok, 1 when rule errors, 2 on usage/IO error. Input is a bundle **without** sha256 verification (the caller is the server that just built it). Reads ≤ 16 MiB from stdin.
  - `breeze-yarac compile --out rules.bin bundle.json…` → writes `Rules.WriteTo` bytes (CI and benchmark only; never shipped).
  - `breeze-yarac scan --bundle b.json [--bundle …] [--workers N] [--max-file-mb 50] <path>…` → JSON lines per match + a final summary line `{"filesScanned":n,"durationMs":n,"matches":n,"peakRssMb":n}` (benchmark harness).
  - `breeze-yarac version` → `{"engine":"<yaraxwasm version>","policy":<yarac.PolicyVersion>,"format":1}`.

- [ ] **Step 1: Failing test**

```go
package main

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

func TestValidateGoldenOK(t *testing.T) {
	in, _ := os.ReadFile("../../internal/yarascan/testdata/bundle-v1.golden.json")
	var out bytes.Buffer
	code := run([]string{"validate"}, bytes.NewReader(in), &out)
	var res struct {
		OK     bool `json:"ok"`
		Errors []any
	}
	_ = json.Unmarshal(out.Bytes(), &res)
	if code != 0 || !res.OK {
		t.Fatalf("golden bundle must validate: code=%d out=%s", code, out.String())
	}
}

func TestValidateReportsRuleError(t *testing.T) {
	in := []byte(`{"format":"breeze-yara-bundle","v":1,"ruleSetId":"s","version":1,"autoQuarantine":false,"rules":[{"id":"r1","name":"broken","severity":"high","source":"rule broken { condition: "}]}`)
	var out bytes.Buffer
	code := run([]string{"validate"}, bytes.NewReader(in), &out)
	if code != 1 || !bytes.Contains(out.Bytes(), []byte(`"ruleId":"r1"`)) {
		t.Fatalf("want exit 1 with r1 error, got %d %s", code, out.String())
	}
}

func TestUsageError(t *testing.T) {
	var out bytes.Buffer
	if code := run([]string{"bogus"}, bytes.NewReader(nil), &out); code != 2 {
		t.Fatalf("want exit 2, got %d", code)
	}
}
```

- [ ] **Step 2: Run to fail** — `go test -race ./cmd/breeze-yarac/ -v`.
- [ ] **Step 3: Implement `main.go`** with `func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout)) }`
  and `run` dispatching on `args[0]`. `validate` decodes with `DisallowUnknownFields` into
  `yarascan.Bundle`, converts to `yarac.Set` (same mapping as `toYaracSet`, exported from
  `yarascan` as `ToYaracSet` for this purpose), calls `yarac.ValidateSet`, prints JSON. `scan` builds
  the matcher via `yarac.CompileSets` + a `yarascan.CacheEntry` and drives the same
  `security.walkAndMatch`-equivalent — **export** `security.WalkAndMatch` as a thin exported wrapper
  for this one caller rather than duplicating the walk. Peak RSS: `runtime.ReadMemStats` `Sys` on
  each tick is acceptable for the CLI; note in the benchmark doc it under-reports wasm linear memory
  mapped outside the Go heap — also capture OS-level RSS in Task 11.
- [ ] **Step 4: Wire the build**

`agent/Makefile`:

```make
build-yarac:
	go build $(LDFLAGS) -o bin/breeze-yarac ./cmd/breeze-yarac
```

`.github/workflows/ci.yml`, in the existing agent build/test job, after the agent binary is built
and the signature guard runs on it (search `check-agent-binary-signatures.sh` in that file), add:

```yaml
      - name: Build breeze-yarac and run the binary signature guard on it
        working-directory: agent
        run: |
          CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o breeze-yarac-linux-amd64 ./cmd/breeze-yarac
          ../scripts/security/check-agent-binary-signatures.sh breeze-yarac-linux-amd64
```

`breeze-yarac` is **not** added to `release.yml` in W02 (W03 Task 6 builds it inside the API image
from source; no release artifact needed).

- [ ] **Step 5: Run** — `go test -race ./cmd/breeze-yarac/ -v` → PASS; `make -C agent build-yarac` → builds.
- [ ] **Step 6: Commit** — `git commit -m "feat(agent): breeze-yarac CLI (validate/compile/scan/version) + CI signature guard (#6265)"`.

---

### Task 11: Lab benchmark + sidecar go/no-go (spec §10 gate)

Not code; a recorded measurement that gates W03's start (plan index "Gates").

**Files:**
- Modify: `docs/superpowers/specs/security-auth/2026-09-18-yara-ioc-scanning-design.md` §14 (append a
  "W02 benchmark" table)

- [ ] **Step 1: Build** `GOOS=windows GOARCH=amd64 go build -o breeze-yarac.exe ./cmd/breeze-yarac`.
- [ ] **Step 2: Prepare the pack.** Download the YARA Forge **core** release locally (not committed),
  convert to one bundle JSON with a throwaway script under `/tmp`, run
  `breeze-yarac validate < forge-core.json`, drop failing rules, record kept/dropped counts.
- [ ] **Step 3: Run on the Windows lab rig** (`lab-windows-server-vm`; confirm it does **not** run an
  installed Breeze agent first). Three runs each, cold then warm cache:
  `breeze-yarac scan --bundle forge-core.json --workers 2 %TEMP% %USERPROFILE%\Downloads` (quick-scan
  equivalent) and a full `C:\` run with `--max-file-mb 50`. Capture wall-clock, files scanned, CPU %
  of one core (Task Manager / `Get-Process breeze-yarac | Select CPU,WorkingSet64` sampled every 5 s),
  peak working set, and compile time for the pack.
- [ ] **Step 4: Decide.** Acceptance (spec §10): quick scan ≤ 2 min and ≤ 25 % of one core averaged.
  Additional W02 gate: peak working set ≤ 300 MB with 2 workers. **Go** (stay on wasm) if met.
  **No-go** ⇒ file a follow-up "native breeze-scanner sidecar" wave issue under #6263 and record it;
  W03 may still start (the `Matcher` interface isolates the swap).
- [ ] **Step 5: Commit** the §14 table — `docs(spec): record W02 YARA benchmark and sidecar decision (#6265)`.

---

### Task 12: API — `security_provider += 'breeze'` and correct attribution at ingest

**Files:**
- Create: `apps/api/migrations/<YYYY-MM-DD-HHMMSS>-security-provider-breeze.sql` (sorts after the
  newest file in `apps/api/migrations/`; check with `ls apps/api/migrations/*.sql | sort | tail -1`)
- Modify: `apps/api/src/db/schema/security.ts`, `apps/api/src/routes/security/schemas.ts`,
  `apps/api/src/routes/agents/helpers.ts`
- Test: `apps/api/src/routes/agents/helpers.securityScan.test.ts`

**Interfaces:**
- Produces: enum value `'breeze'`; provider catalog entry `breeze: { id: 'breeze', name: 'Breeze IOC scan', vendor: 'Breeze' }`.

- [ ] **Step 1: Failing tests** (append to `helpers.securityScan.test.ts`, following the existing
  mock shape in that file)

```ts
it('attributes every security_scan threat to provider breeze (DECISION W02-d)', async () => {
  const inserted = await runScanResult({
    status: 'completed',
    threats: [{ name: 'Legacy-Sig', type: 'malware', severity: 'high', path: 'C:\\a.exe' }],
    statusProvider: 'windows_defender',
  });
  expect(inserted[0].provider).toBe('breeze');
});

it('keeps YARA rule detail in details (redacted blob)', async () => {
  const inserted = await runScanResult({
    status: 'completed',
    engine: 'yara',
    threats: [{
      name: 'fixture_marker', type: 'pup', severity: 'high', path: '/tmp/x',
      ruleName: 'fixture_marker', ruleSetId: 's1', ruleId: 'r1', tags: ['fixture'],
      matchedStrings: [{ id: '$a', offset: 7, data: 'breeze_yara_fixture_marker_7f3a' }], sha256: 'ab'.repeat(32),
    }],
  });
  expect(inserted[0].details).toMatchObject({ ruleName: 'fixture_marker', ruleSetId: 's1', sha256: 'ab'.repeat(32) });
});

it('does not fail the ingest when ruleSetErrors are present', async () => {
  const inserted = await runScanResult({
    status: 'completed', engine: 'legacy',
    ruleSetErrors: [{ id: 's1', version: 3, code: 'compile', detail: 'x' }],
    threats: [],
  });
  expect(inserted).toEqual([]);
});
```

(`runScanResult` = a local helper wrapping the file's existing invocation of
`handleSecurityCommandResult` with a mocked `db.insert(securityThreats).values` capture; reuse the
mocks already in the file.)

- [ ] **Step 2: Run to fail** — `cd apps/api && npx vitest run src/routes/agents/helpers.securityScan.test.ts`
  → FAIL (`provider` is `windows_defender`).

- [ ] **Step 3: Migration**

```sql
-- #6263 W02: Breeze's own IOC scanner (YARA-X engine and the legacy
-- signature table) gets its own provider so security_threats rows from a
-- security_scan command stop inheriting the device's AV product name.
-- ADD VALUE IF NOT EXISTS is a no-op on re-apply. No row writes.
ALTER TYPE security_provider ADD VALUE IF NOT EXISTS 'breeze';
```

- [ ] **Step 4: Code.** Add `'breeze'` to `securityProviderEnum` (after `'unknown'`, keeping the
  comment). Add the catalog entry. In `helpers.ts` scan branch replace
  `const provider = normalizeProvider(parsedStatus?.provider);` with `const provider = 'breeze' as const;`
  and, before the insert, `if (Array.isArray(resultJson?.ruleSetErrors) && resultJson.ruleSetErrors.length > 0) logger.warn(...)`
  using the file's existing logger with `{ deviceId: command.deviceId, scanRecordId, ruleSetErrors: resultJson.ruleSetErrors.slice(0, 20) }`.
  Do **not** add `'breeze'` to `apps/api/src/routes/agents/schemas.ts`'s status-ingest provider list —
  that list is for AV *status* reports, which Breeze never sends about itself.
- [ ] **Step 5: Sweep for exhaustive switches** over `SecurityProviderValue` / `securityProviderEnum`
  that TypeScript now flags: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p . ; echo EXIT=$?`
  (check the exit code — piping to `tail` masks OOM). Also `grep -rn "'withsecure'" apps/web/src packages`
  for any web/shared provider label map and add `breeze` there with label "Breeze IOC scan".
- [ ] **Step 6: Run** — `npx vitest run src/routes/agents/helpers.securityScan.test.ts src/routes/security`
  → PASS; `pnpm db:check-drift` against a local DB → clean.
- [ ] **Step 7: Commit** — `feat(api): attribute security_scan threats to provider 'breeze' (#6265)`.

---

### Task 13: Whole-wave verification + PR

- [ ] **Step 1: Agent matrix**

```bash
cd agent
go test -race ./...
golangci-lint run ./internal/security/... ./internal/yarascan/... ./internal/heartbeat/... ./cmd/breeze-yarac/...
GOOS=windows go vet ./... && GOOS=darwin go vet ./...
go build -o /tmp/breeze-agent ./cmd/breeze-agent && ../scripts/security/check-agent-binary-signatures.sh /tmp/breeze-agent
../scripts/security/check-agent-binary-signatures.sh --source
../scripts/security/run-govulncheck.sh   # new deps: yaraxwasm, wazero
```

- [ ] **Step 2: API matrix** — `cd apps/api && npx vitest run src/routes/agents src/routes/security src/jobs/securityScanJobs` and the `tsc` check above.
- [ ] **Step 3: Confirm the dark launch** — `grep -rn "ruleSets" apps/api/src` returns nothing outside
  tests: no server code sends `ruleSets` in W02.
- [ ] **Step 4: Open the PR** from `feature/6263-yara-ioc-scanning/wave-6265`, body `Closes #6265`,
  listing DECISIONS W02-a…d, the Spike outcomes, the benchmark table, and the binary size delta.
  It is not stacked (base `main`), so CI runs normally; the enum migration is exercised by
  **Integration Tests** (`pnpm test` does not run them).

---

## Self-review

- Spec coverage (W02 row of §12): `internal/yarascan` ✔ (T2–T6), matcher swap ✔ (T7–T8),
  worker-pool walk ✔ (T7), bytecode cache ✔ (T5, now compiled-on-device per owner decision), fetch
  ✔ (client T3; **route moved to W03**, DECISION W02-a), benchmark + sidecar go/no-go ✔ (T11), §6
  payload/result additions ✔ (T8, C1/C3), §6 low-priority I/O ✔ (T6, DECISION W02-c), D6 manifest
  rule fields ✔ (T9), D7 per-set auto-quarantine ✔ (T8), D9 `provider = 'breeze'` ✔ (T12), §9
  matched-string caps ✔ (T6), §13 Q1 ✔ (T1).
- Not in W02 by design: tables, CRUD, pre-check route, fetch route, built-in pack, `ruleSetIds`
  (W03); UI (W04); sweep/AI/audit (W05).
