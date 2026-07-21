# Agent Backup Server URL (Control-Plane Failover) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/agent/2026-07-09-agent-backup-server-url-design.md` (read it first — it is the authority on semantics). Issue: #2288.

**Goal:** Agents get a server-pushed backup control-plane URL, fail over to it automatically when the primary dies (promote-and-swap with validate-before-persist), survive DNS outages via a last-known-good IP cache, and report their active server URL to a new device-list "Server" column.

**Architecture:** Instance-level `AGENT_BACKUP_SERVER_URL` env var on the API → delivered on every heartbeat via the existing `configUpdate` map (empty string = clear, absent = no change) → agent persists it in `agent.yaml`. The heartbeat loop is the only failure detector: 10 consecutive primary failures trigger one authenticated probe of the backup; success promotes the backup to primary (in-memory + atomic persist) and keeps the old primary as the new backup (rollback). A per-hostname DNS cache at the dialer layer (TLS hostname verification untouched) absorbs DNS-only outages.

**Tech Stack:** Go (agent, watchdog), Hono + Zod + Drizzle (API), React (web), Rust/Tauri (Breeze Assist helper), hand-written SQL migration.

## Global Constraints

- Backup URL must be `https://`; `http://` allowed only for hosts `localhost`, `127.0.0.1`, `::1`. Enforced independently on API (boot validation, refuse to boot on malformed) and agent (before persisting).
- `configUpdate.backup_server_url`: empty string = clear stored backup; key absent = no change. Agent accepts both `backup_server_url` and `backupServerUrl` keys (matches existing configUpdate convention).
- Failover threshold: constant `backupProbeThreshold = 10` consecutive heartbeat failures (any transport error or non-2xx). Not configurable in v1.
- Promote-and-swap must update the **in-memory** shared `*config.Config` AND persist via `config.SetAndPersist` (atomic write). Never persist before the backup has answered a fully authenticated heartbeat with 2xx.
- A pushed backup URL identical to the current primary is ignored (logged at debug).
- DNS cache is fallback-only: fresh DNS always wins; cache consulted only on `*net.DNSError`; cached-IP dials keep TLS `ServerName`/Host = original hostname (automatic — the dialer operates below TLS).
- Migrations: idempotent, no inner `BEGIN;`/`COMMIT;`, filename `2026-07-09-agent-server-url-column.sql` style (date prefix, lexicographic order).
- Go tests: `cd agent && go test -race ./internal/...`. API tests: `pnpm test --filter=@breeze/api`. Web: `pnpm test --filter=@breeze/web`.
- Work on a feature branch off `main` (e.g. `feat/agent-backup-server-url`). Commit the spec (`docs/superpowers/specs/agent/2026-07-09-agent-backup-server-url-design.md`) and this plan with the first commit.

---

### Task 1: Agent config field + validation helper

**Files:**
- Modify: `agent/internal/config/config.go` (Config struct ~line 45, `SaveTo` ~line 430)
- Modify: `agent/internal/config/validate.go` (~line 92, after the ServerURL block)
- Test: `agent/internal/config/backup_url_test.go` (create)

**Interfaces:**
- Produces: `Config.BackupServerURL string` (mapstructure `backup_server_url`); `config.ValidateBackupServerURL(raw string) error` (nil for `""`).

- [ ] **Step 1: Write the failing test**

```go
package config

import "testing"

func TestValidateBackupServerURL(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{"empty is valid (unset)", "", false},
		{"https ok", "https://new.example.com", false},
		{"https with port ok", "https://new.example.com:8443", false},
		{"http localhost ok", "http://localhost:3001", false},
		{"http 127.0.0.1 ok", "http://127.0.0.1:3001", false},
		{"http ::1 ok", "http://[::1]:3001", false},
		{"http non-localhost rejected", "http://new.example.com", true},
		{"garbage rejected", "://not a url", true},
		{"ftp rejected", "ftp://new.example.com", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateBackupServerURL(tc.raw)
			if (err != nil) != tc.wantErr {
				t.Fatalf("ValidateBackupServerURL(%q) err=%v, wantErr=%v", tc.raw, err, tc.wantErr)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/config/ -run TestValidateBackupServerURL -v`
Expected: FAIL — `undefined: ValidateBackupServerURL`

- [ ] **Step 3: Implement**

In `config.go`, add to the `Config` struct directly under `ServerURL` (line 45):

```go
	// BackupServerURL is a second control-plane URL delivered by the server
	// via heartbeat configUpdate (#2288). The heartbeat loop probes it after
	// backupProbeThreshold consecutive primary failures and promote-swaps on
	// a successful authenticated heartbeat. Never a secret; lives in agent.yaml.
	BackupServerURL string `mapstructure:"backup_server_url"`
```

In `SaveTo` (after `viper.Set("server_url", cfg.ServerURL)` at line 430):

```go
	viper.Set("backup_server_url", cfg.BackupServerURL)
```

In `validate.go` add (and call it from `ValidateTiered` right after the ServerURL block, appending any error to `result.Fatals`):

```go
// ValidateBackupServerURL enforces the backup control-plane URL contract:
// https only, http permitted for loopback hosts, "" means unset (valid).
func ValidateBackupServerURL(raw string) error {
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return fmt.Errorf("backup_server_url %q is not a valid URL", raw)
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		host := u.Hostname()
		if host == "localhost" || host == "127.0.0.1" || host == "::1" {
			return nil
		}
		return fmt.Errorf("backup_server_url must use https (http allowed only for localhost)")
	default:
		return fmt.Errorf("backup_server_url scheme must be http or https, got %q", u.Scheme)
	}
}
```

In `ValidateTiered` (validate.go, after the `c.ServerURL` block ending line 92):

```go
	if err := ValidateBackupServerURL(c.BackupServerURL); err != nil {
		result.Fatals = append(result.Fatals, err)
	}
```

- [ ] **Step 4: Run tests**

Run: `cd agent && go test -race ./internal/config/ -v -run 'TestValidateBackupServerURL|TestValidateTiered'`
Expected: PASS (and no regressions in existing config tests: `go test -race ./internal/config/`)

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/ docs/superpowers/specs/agent/2026-07-09-agent-backup-server-url-design.md docs/superpowers/plans/agent/2026-07-09-agent-backup-server-url.md
git commit -m "feat(agent): backup_server_url config field + validation (#2288)"
```

---

### Task 2: Agent applies `backup_server_url` from configUpdate

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (`applyConfigUpdate`, line 1650)
- Test: `agent/internal/heartbeat/backup_url_decide_test.go` (create)

**Interfaces:**
- Consumes: `config.ValidateBackupServerURL`, `Config.BackupServerURL` (Task 1).
- Produces: `decideBackupURLUpdate(raw any, primary, current string) (val string, apply bool)` — pure decision function; `(h *Heartbeat) applyBackupServerURLConfig(raw any)` — thin persisting wrapper.

- [ ] **Step 1: Write the failing test**

```go
package heartbeat

import "testing"

func TestDecideBackupURLUpdate(t *testing.T) {
	const primary = "https://old.example.com"
	cases := []struct {
		name      string
		raw       any
		current   string
		wantVal   string
		wantApply bool
	}{
		{"new value applied", "https://new.example.com", "", "https://new.example.com", true},
		{"unchanged value not reapplied", "https://new.example.com", "https://new.example.com", "", false},
		{"empty clears stored backup", "", "https://new.example.com", "", true},
		{"empty with nothing stored is a no-op", "", "", "", false},
		{"value equal to primary ignored", primary, "", "", false},
		{"http non-localhost rejected", "http://evil.example.com", "", "", false},
		{"non-string payload ignored", 42, "", "", false},
		{"whitespace trimmed", "  https://new.example.com  ", "", "https://new.example.com", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			val, apply := decideBackupURLUpdate(tc.raw, primary, tc.current)
			if apply != tc.wantApply || (apply && val != tc.wantVal) {
				t.Fatalf("decideBackupURLUpdate(%v, %q, %q) = (%q, %v), want (%q, %v)",
					tc.raw, primary, tc.current, val, apply, tc.wantVal, tc.wantApply)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/heartbeat/ -run TestDecideBackupURLUpdate -v`
Expected: FAIL — `undefined: decideBackupURLUpdate`

- [ ] **Step 3: Implement**

In `heartbeat.go`, add the pure function and wrapper (near `applyConfigUpdate`):

```go
// decideBackupURLUpdate is the pure decision core for a pushed
// backup_server_url value. Empty string = clear, equal-to-primary and
// invalid values are ignored. Returns (newValue, apply).
func decideBackupURLUpdate(raw any, primary, current string) (string, bool) {
	s, ok := raw.(string)
	if !ok {
		log.Warn("ignoring non-string backup_server_url config update payload")
		return "", false
	}
	s = strings.TrimSpace(s)
	if s == current {
		return "", false
	}
	if s == "" {
		return "", true // clear
	}
	if s == primary {
		log.Debug("ignoring backup_server_url identical to primary server_url")
		return "", false
	}
	if err := config.ValidateBackupServerURL(s); err != nil {
		log.Warn("ignoring invalid backup_server_url config update", "error", err.Error())
		return "", false
	}
	return s, true
}

func (h *Heartbeat) applyBackupServerURLConfig(raw any) {
	h.mu.Lock()
	primary, current := h.config.ServerURL, h.config.BackupServerURL
	h.mu.Unlock()

	val, apply := decideBackupURLUpdate(raw, primary, current)
	if !apply {
		return
	}
	h.mu.Lock()
	h.config.BackupServerURL = val
	h.mu.Unlock()
	if err := config.SetAndPersist("backup_server_url", val); err != nil {
		log.Warn("failed to persist backup_server_url", "error", err.Error())
		return
	}
	if val == "" {
		log.Info("cleared backup server URL")
	} else {
		log.Info("stored backup server URL", "backupServerUrl", val)
	}
}
```

In `applyConfigUpdate` (line 1650), add BEFORE the `if !hasRegistry && !hasConfig { return }` early return (i.e. alongside the `patch_source_settings` block ending line 1684):

```go
	// Backup control-plane URL (#2288). Key absent = no change; present
	// empty string = clear. Snake_case and camelCase both accepted.
	bsRaw, hasBS := update["backup_server_url"]
	if !hasBS {
		bsRaw, hasBS = update["backupServerUrl"]
	}
	if hasBS {
		h.applyBackupServerURLConfig(bsRaw)
	}
```

- [ ] **Step 4: Run tests**

Run: `cd agent && go test -race ./internal/heartbeat/ -run TestDecideBackupURLUpdate -v && go test -race ./internal/heartbeat/`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/
git commit -m "feat(agent): apply backup_server_url from heartbeat configUpdate (#2288)"
```

---

### Task 3: Heartbeat failover — failure counter, backup probe, promote-and-swap

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (`sendHeartbeat` ~lines 2533–2760, struct fields ~line 350)
- Modify: `agent/internal/filetransfer/transfer.go` (add `SetServerURL` setter on the manager type — its `Config.ServerURL` is copied at construction in `NewWithVersion`, heartbeat.go:373-377, and would otherwise go stale after a swap)
- Test: `agent/internal/heartbeat/backup_failover_test.go` (create)

**Interfaces:**
- Consumes: `decideBackupURLUpdate`/`applyBackupServerURLConfig` (Task 2), `config.SetAndPersist` (existing).
- Produces: `const backupProbeThreshold = 10`; `(h *Heartbeat) postHeartbeat(baseURL string, payload *HeartbeatPayload) bool` (marshal + POST + full response handling, returns success); `(h *Heartbeat) promoteBackupServerURL()`; `(m *Manager) SetServerURL(u string)` on the filetransfer manager.

**Refactor shape.** Today `sendHeartbeat` builds the payload (~2533), marshals, POSTs to `h.config.ServerURL` (2647), and handles the response (2656–2760: 401/non-OK/decode/configUpdate/manifest keys/commands) inline, with failure paths doing bare `return`. Split it:

1. Everything from `body, err := json.Marshal(payload)` (2641) through the end of response handling moves into `postHeartbeat(baseURL string, payload *HeartbeatPayload) bool`. The URL line becomes `fmt.Sprintf("%s/api/v1/agents/%s/heartbeat", baseURL, h.config.AgentID)`. Every current early-`return` failure path becomes `return false`; the success tail returns `true`. Response handling is identical for a backup target — commands/configUpdate from the backup ARE the new control plane and must be processed.
2. `sendHeartbeat` tail becomes:

```go
	if h.postHeartbeat(h.serverURL(), &payload) {
		h.resetHeartbeatFailures()
		return
	}
	h.recordHeartbeatFailure(&payload)
```

3. New members and logic:

```go
const backupProbeThreshold = 10

// on the Heartbeat struct (near watchdogVersionDisk, ~line 350):
	hbConsecutiveFailures int // guarded by h.mu

func (h *Heartbeat) serverURL() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.config.ServerURL
}

func (h *Heartbeat) resetHeartbeatFailures() {
	h.mu.Lock()
	h.hbConsecutiveFailures = 0
	h.mu.Unlock()
}

// recordHeartbeatFailure advances the consecutive-failure counter and, past
// the threshold, probes the backup URL with a full authenticated heartbeat.
// A 2xx from the backup is the validate-before-persist gate: only then do we
// promote-and-swap. A failed probe persists nothing; we re-probe every
// subsequent failed cycle.
func (h *Heartbeat) recordHeartbeatFailure(payload *HeartbeatPayload) {
	h.mu.Lock()
	h.hbConsecutiveFailures++
	failures := h.hbConsecutiveFailures
	backup := h.config.BackupServerURL
	h.mu.Unlock()

	if failures < backupProbeThreshold || backup == "" {
		return
	}
	log.Warn("primary server unreachable, probing backup", "failures", failures, "backupServerUrl", backup)
	if h.postHeartbeat(backup, payload) {
		h.promoteBackupServerURL()
		h.resetHeartbeatFailures()
	}
}

// promoteBackupServerURL swaps backup→primary in the shared in-memory config
// (all subsystems — WS reconnect, file transfer, updater — read it per
// request/connect) and persists both keys atomically. The old primary is
// retained as the new backup: rollback metadata, and the same probe logic
// swaps back if the promotion turns out to be a false positive.
func (h *Heartbeat) promoteBackupServerURL() {
	h.mu.Lock()
	oldPrimary := h.config.ServerURL
	newPrimary := h.config.BackupServerURL
	h.config.ServerURL = newPrimary
	h.config.BackupServerURL = oldPrimary
	h.mu.Unlock()

	h.fileTransfer.SetServerURL(newPrimary) // adjust to the actual field name in NewWithVersion

	if err := config.SetAndPersist("server_url", newPrimary); err != nil {
		log.Error("failed to persist promoted server_url", "error", err.Error())
	}
	if err := config.SetAndPersist("backup_server_url", oldPrimary); err != nil {
		log.Error("failed to persist demoted backup_server_url", "error", err.Error())
	}
	log.Warn("PROMOTED backup server URL to primary",
		"newServerUrl", newPrimary, "rollbackBackupUrl", oldPrimary)
}
```

Also update the two `api.NewClient(h.config.ServerURL, ...)` construction sites (heartbeat.go ~2899, ~2978) to use `h.serverURL()` so post-swap constructions get the new value.

- [ ] **Step 1: Write the failing test**

```go
package heartbeat

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/config" // match the module's real import path
)

// swapTestConfig loads a real temp agent.yaml so SetAndPersist has a file to
// write (viper.ConfigFileUsed must be non-empty).
func swapTestConfig(t *testing.T, primary, backup string) *config.Config {
	t.Helper()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	yaml := "agent_id: 123e4567-e89b-12d3-a456-426614174000\n" +
		"server_url: " + primary + "\n" +
		"backup_server_url: " + backup + "\n"
	if err := os.WriteFile(cfgPath, []byte(yaml), 0644); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestBackupProbeAndPromote(t *testing.T) {
	backupSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"commands":[]}`))
	}))
	defer backupSrv.Close()

	// Primary: a closed port — immediate connection refused.
	deadSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := deadSrv.URL
	deadSrv.Close()

	cfg := swapTestConfig(t, deadURL, backupSrv.URL)
	h := New(cfg) // zero-retry config below keeps this fast

	// Drive failures up to the threshold: below it, no probe, no swap.
	for i := 0; i < backupProbeThreshold-1; i++ {
		h.sendHeartbeat()
	}
	if got := h.serverURL(); got != deadURL {
		t.Fatalf("swapped before threshold: serverURL=%q", got)
	}

	// Threshold-crossing failure triggers the probe; backup answers 200 → swap.
	h.sendHeartbeat()
	if got := h.serverURL(); got != backupSrv.URL {
		t.Fatalf("expected promote-and-swap to %q, got %q", backupSrv.URL, got)
	}

	// Old primary retained as rollback backup, and both persisted to disk.
	reloaded, err := config.Reload()
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.ServerURL != backupSrv.URL || reloaded.BackupServerURL != deadURL {
		t.Fatalf("persisted swap wrong: server_url=%q backup=%q", reloaded.ServerURL, reloaded.BackupServerURL)
	}
}

func TestBackupProbeFailureDoesNotSwap(t *testing.T) {
	dead1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	u1 := dead1.URL
	dead1.Close()
	dead2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	u2 := dead2.URL
	dead2.Close()

	cfg := swapTestConfig(t, u1, u2)
	h := New(cfg)
	for i := 0; i < backupProbeThreshold+3; i++ {
		h.sendHeartbeat()
	}
	if got := h.serverURL(); got != u1 {
		t.Fatalf("swapped to dead backup: %q", got)
	}
}
```

Adjust the import path to the agent module's real path (see `agent/go.mod`), and if `sendHeartbeat` is unexported with a different name/signature, call the actual method. Set `h.retryCfg` (or the equivalent field) to zero retries in the test so each failed heartbeat is a single fast attempt — mirror how existing heartbeat tests configure retries (`grep -n "retryCfg" agent/internal/heartbeat/*_test.go`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/heartbeat/ -run 'TestBackupProbe' -v`
Expected: FAIL — `undefined: backupProbeThreshold` (and compile errors for the not-yet-extracted helpers)

- [ ] **Step 3: Implement the refactor + logic exactly as sketched above**

Also add to `agent/internal/filetransfer/transfer.go` (match the manager type name in that file; guard with the manager's existing mutex or add one):

```go
// SetServerURL updates the control-plane base URL after a backup promotion
// (#2288). File transfers build request URLs per call from this value.
func (m *Manager) SetServerURL(u string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.config.ServerURL = u
}
```

…and make the per-request reads of `m.config.ServerURL` (transfer.go lines ~197, ~233, ~305) go through a mutex-guarded getter if they don't already hold that lock.

- [ ] **Step 4: Run tests**

Run: `cd agent && go test -race ./internal/heartbeat/ ./internal/filetransfer/ ./internal/config/`
Expected: PASS, including all pre-existing heartbeat tests (the postHeartbeat extraction must not change behavior).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/ agent/internal/filetransfer/
git commit -m "feat(agent): heartbeat failover to backup server URL with promote-and-swap (#2288)"
```

---

### Task 4: API — `AGENT_BACKUP_SERVER_URL` env var, boot validation, heartbeat push

**Files:**
- Modify: `apps/api/src/config/validate.ts` (env schema ~line 403 area, superRefine)
- Modify: `apps/api/src/routes/agents/heartbeat.ts` (mergedConfigUpdate assembly, lines 799–814)
- Test: `apps/api/src/config/validate.test.ts` (extend), `apps/api/src/routes/agents/heartbeat.test.ts` (extend)

**Interfaces:**
- Produces: env var `AGENT_BACKUP_SERVER_URL`; heartbeat response `configUpdate.backup_server_url` — **always present** (value when set, `''` when unset, so agents can clear).

- [ ] **Step 1: Write the failing tests**

In `validate.test.ts` (follow the file's existing pattern of overriding env and asserting `validateConfig()` throws — see the `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` tests around line 266):

```ts
describe('AGENT_BACKUP_SERVER_URL', () => {
  it('accepts a valid https URL', () => {
    withEnv({ AGENT_BACKUP_SERVER_URL: 'https://new.example.com' }, () => {
      expect(() => validateConfig()).not.toThrow();
    });
  });
  it('accepts http for localhost (dev)', () => {
    withEnv({ AGENT_BACKUP_SERVER_URL: 'http://localhost:3001' }, () => {
      expect(() => validateConfig()).not.toThrow();
    });
  });
  it('refuses http for non-localhost', () => {
    withEnv({ AGENT_BACKUP_SERVER_URL: 'http://new.example.com' }, () => {
      expect(() => validateConfig()).toThrow('AGENT_BACKUP_SERVER_URL');
    });
  });
  it('refuses a malformed value (never silently ignored)', () => {
    withEnv({ AGENT_BACKUP_SERVER_URL: 'not a url' }, () => {
      expect(() => validateConfig()).toThrow('AGENT_BACKUP_SERVER_URL');
    });
  });
  it('unset is fine', () => {
    withEnv({ AGENT_BACKUP_SERVER_URL: '' }, () => {
      expect(() => validateConfig()).not.toThrow();
    });
  });
});
```

(`withEnv` = whatever env-override helper the file already uses; copy its idiom exactly.)

In `heartbeat.test.ts`, following the file's existing mock/route-invocation pattern, add two cases:

```ts
it('always includes backup_server_url in configUpdate — value when env set', async () => {
  process.env.AGENT_BACKUP_SERVER_URL = 'https://new.example.com';
  const res = await postHeartbeat(validPayload); // the file's existing helper idiom
  const body = await res.json();
  expect(body.configUpdate.backup_server_url).toBe('https://new.example.com');
});

it('always includes backup_server_url in configUpdate — empty string when env unset (clear signal)', async () => {
  delete process.env.AGENT_BACKUP_SERVER_URL;
  const res = await postHeartbeat(validPayload);
  const body = await res.json();
  expect(body.configUpdate.backup_server_url).toBe('');
});
```

Reset `process.env.AGENT_BACKUP_SERVER_URL` in `afterEach`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --filter=@breeze/api -- validate.test.ts heartbeat.test.ts`
Expected: FAIL — configUpdate missing the key / validator not throwing.

- [ ] **Step 3: Implement**

`validate.ts` — add to the env zod object (near `IS_HOSTED` at line 403): `AGENT_BACKUP_SERVER_URL: z.string().optional(),` and inside the existing `superRefine` add:

```ts
    // #2288 — instance-level backup control-plane URL pushed to agents.
    // Malformed value = refuse to boot; a silently-dropped backup URL would
    // defeat the whole failover story exactly when it's needed.
    const backupUrlRaw = (data.AGENT_BACKUP_SERVER_URL ?? '').trim();
    if (backupUrlRaw) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(backupUrlRaw);
      } catch {
        parsed = null;
      }
      const isLoopback =
        parsed !== null &&
        ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
      const ok =
        parsed !== null &&
        (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback));
      if (!ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AGENT_BACKUP_SERVER_URL'],
          message:
            'AGENT_BACKUP_SERVER_URL must be a valid https:// URL (http:// allowed only for localhost)',
        });
      }
    }
```

In the validator's success path (where other accepted config is logged, or right after `validateConfig()` in `apps/api/src/index.ts` if there is no such spot), log the active value once at boot:

```ts
if ((process.env.AGENT_BACKUP_SERVER_URL ?? '').trim()) {
  console.log(`[config] AGENT_BACKUP_SERVER_URL active: ${process.env.AGENT_BACKUP_SERVER_URL!.trim()}`);
}
```

`heartbeat.ts` — replace the conditional assembly at lines 799–814 so the block always produces an object and always carries the key:

```ts
  // #2288 — backup control-plane URL. ALWAYS present: the configured value,
  // or '' so agents clear a previously-pushed backup (absent = old API =
  // no change; '' = authoritative clear).
  const mergedConfigUpdate: Record<string, unknown> = {
    backup_server_url: (process.env.AGENT_BACKUP_SERVER_URL ?? '').trim(),
  };
  if (eventLogSettings) {
    mergedConfigUpdate.event_log_settings = eventLogSettings;
  }
  if (monitoringSettings) {
    mergedConfigUpdate.monitoring_settings = monitoringSettings;
  }
  if (onedriveSettings) {
    mergedConfigUpdate.onedrive_helper_settings = onedriveSettings;
  }
  if (patchSourceSettings) {
    mergedConfigUpdate.patch_source_settings = patchSourceSettings;
  }
```

(`configUpdate: mergedConfigUpdate` at line 840 stays; it is now always an object. The agent's `applyConfigUpdate` guards `len(update) == 0`, and every key handler checks its own presence, so an always-present map is safe.)

- [ ] **Step 4: Run tests**

Run: `pnpm test --filter=@breeze/api -- validate.test.ts heartbeat.test.ts`
Expected: PASS. Also run the full API suite for regressions: `pnpm test --filter=@breeze/api`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config/ apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts apps/api/src/index.ts
git commit -m "feat(api): AGENT_BACKUP_SERVER_URL env var pushed via heartbeat configUpdate (#2288)"
```

---

### Task 5: Enrollment seeding (bootstrap + enroll responses)

**Files:**
- Modify: `apps/api/src/routes/installer.ts` (bootstrap response, ~line 261 where `serverUrl` is set)
- Modify: `apps/api/src/routes/agents/enrollment.ts` (enroll success response, ~line 306 where `siteId` is returned)
- Modify: `agent/internal/agentapp/bootstrap.go` (`bootstrapResult` struct ~line 24, `runBootstrap` handoff ~line 125)
- Modify: `agent/internal/agentapp/main.go` (`enrollDevice`, response handling ~lines 1125–1140) + the API client's enroll response struct (find with `grep -rn "WatchdogAuthToken" agent/internal/api/`)
- Test: `apps/api/src/routes/installer.test.ts`, `apps/api/src/routes/agents/enrollment.test.ts` (extend both)

**Interfaces:**
- Consumes: `Config.BackupServerURL` (Task 1).
- Produces: `backupServerUrl` (camelCase) field on the bootstrap-redemption and enroll JSON responses; agent persists it at enrollment so agents are born with the backup even if they never complete a heartbeat against the old URL.

- [ ] **Step 1: Write the failing tests**

In `installer.test.ts` and `enrollment.test.ts`, following each file's existing response-shape assertions, add:

```ts
it('includes backupServerUrl when AGENT_BACKUP_SERVER_URL is set', async () => {
  process.env.AGENT_BACKUP_SERVER_URL = 'https://new.example.com';
  const body = await redeemBootstrapOk(); // / enrollOk() — the file's existing happy-path helper idiom
  expect(body.backupServerUrl).toBe('https://new.example.com');
});

it('omits/empty backupServerUrl when env unset', async () => {
  delete process.env.AGENT_BACKUP_SERVER_URL;
  const body = await redeemBootstrapOk();
  expect(body.backupServerUrl ?? '').toBe('');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --filter=@breeze/api -- installer.test.ts enrollment.test.ts`
Expected: FAIL — `backupServerUrl` undefined on the response.

- [ ] **Step 3: Implement**

API — in both response literals:

```ts
    backupServerUrl: (process.env.AGENT_BACKUP_SERVER_URL ?? '').trim() || undefined,
```

Agent — `bootstrap.go`: add `BackupServerURL string \`json:"backupServerUrl"\`` to `bootstrapResult`; in `runBootstrap`, forward it through a new package global next to `serverURL` (main.go line ~81):

```go
	backupServerURL  string // seeded by bootstrap/enroll responses (#2288)
```

```go
	serverURL = res.ServerURL
	backupServerURL = res.BackupServerURL
	enrollmentSecret = res.EnrollmentSecret
	enrollDevice(res.EnrollmentKey)
```

Agent — enroll response struct (in `agent/internal/api/`, wherever `WatchdogAuthToken` lives): add `BackupServerURL string \`json:"backupServerUrl"\``. In `enrollDevice` (main.go ~1131, where `cfg.AgentID`/`cfg.AuthToken` etc. are copied from `enrollResp`):

```go
	// Backup control-plane URL (#2288): enroll response wins; bootstrap value
	// is the fallback. Validated before persisting — a bad value must not
	// poison a fresh enrollment.
	seed := enrollResp.BackupServerURL
	if seed == "" {
		seed = backupServerURL
	}
	if seed != "" && seed != cfg.ServerURL {
		if err := config.ValidateBackupServerURL(seed); err == nil {
			cfg.BackupServerURL = seed
		}
	}
```

(`cfg` is saved by the existing enroll flow right after; `SaveTo` already writes the key from Task 1.)

- [ ] **Step 4: Run tests**

Run: `pnpm test --filter=@breeze/api -- installer.test.ts enrollment.test.ts && cd agent && go build ./... && go test -race ./internal/agentapp/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/installer.ts apps/api/src/routes/installer.test.ts apps/api/src/routes/agents/enrollment.ts apps/api/src/routes/agents/enrollment.test.ts agent/internal/agentapp/ agent/internal/api/
git commit -m "feat: seed backupServerUrl at bootstrap/enroll so new agents are born with it (#2288)"
```

---

### Task 6: Active-server visibility — heartbeat payload field, `devices.agent_server_url`, migration

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (`HeartbeatPayload` struct, line 62; `postHeartbeat` from Task 3)
- Modify: `apps/api/src/routes/agents/schemas.ts` (`heartbeatSchema`, line 116)
- Modify: `apps/api/src/routes/agents/heartbeat.ts` (`deviceUpdates`, lines 374–467)
- Modify: `apps/api/src/db/schema/devices.ts` (add column near `watchdogVersion`, line 98)
- Create: `apps/api/migrations/2026-07-09-agent-server-url-column.sql`
- Test: `apps/api/src/routes/agents/heartbeat.test.ts` (extend)

**Interfaces:**
- Produces: heartbeat payload field `serverUrl` (the base URL this heartbeat was POSTed to); `devices.agent_server_url varchar(512)` / Drizzle `devices.agentServerUrl`; heartbeat handler persists it. Web (Task 7) reads `agentServerUrl` from the device list API.

- [ ] **Step 1: Migration + schema (no test-first for DDL — the rls-coverage/autoMigrate contract tests are the net)**

`apps/api/migrations/2026-07-09-agent-server-url-column.sql`:

```sql
-- #2288: which control-plane URL each agent actually heartbeats to.
-- Reported by the agent in its heartbeat payload; powers the device-list
-- "Server" column so operators can watch a fleet migrate to a new URL.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_server_url varchar(512);
```

`devices.ts` (next to `watchdogVersion`, line 98):

```ts
  // #2288 — the control-plane URL the agent last heartbeated to. Reported by
  // the agent; shows fleet position during a server URL migration.
  agentServerUrl: varchar('agent_server_url', { length: 512 }),
```

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`
Expected: no drift. (`devices` already has RLS; a new column changes nothing.)

- [ ] **Step 2: Write the failing API test**

In `heartbeat.test.ts` (existing deviceUpdates-assertion idiom):

```ts
it('persists a valid serverUrl to devices.agent_server_url', async () => {
  await postHeartbeat({ ...validPayload, serverUrl: 'https://old.example.com' });
  expect(capturedDeviceUpdate.agentServerUrl).toBe('https://old.example.com');
});

it('ignores a malformed serverUrl instead of failing the heartbeat', async () => {
  const res = await postHeartbeat({ ...validPayload, serverUrl: 'not a url' });
  expect(res.status).toBe(200);
  expect(capturedDeviceUpdate.agentServerUrl).toBeUndefined();
});

it('leaves stored value untouched when serverUrl absent (old agent)', async () => {
  await postHeartbeat(validPayload);
  expect(capturedDeviceUpdate.agentServerUrl).toBeUndefined();
});
```

Run: `pnpm test --filter=@breeze/api -- heartbeat.test.ts` → Expected: FAIL.

- [ ] **Step 3: Implement**

`schemas.ts`, inside `heartbeatSchema` (informational field — tolerate garbage, never reject the heartbeat):

```ts
  // #2288 — the control-plane base URL the agent used for this heartbeat.
  serverUrl: z.string().max(512).optional().catch(undefined),
```

`heartbeat.ts`, in the `deviceUpdates` conditional block (after the `watchdogVersion` block at line 408):

```ts
  // #2288 — active control-plane URL. Absent (old agent) leaves the stored
  // value untouched; a malformed value is dropped, never a heartbeat failure.
  if (data.serverUrl) {
    try {
      new URL(data.serverUrl);
      deviceUpdates.agentServerUrl = data.serverUrl;
    } catch {
      // informational field — ignore garbage
    }
  }
```

Agent `heartbeat.go` — `HeartbeatPayload` gains:

```go
	// ServerURL is the control-plane base URL this heartbeat is POSTed to
	// (#2288). Set per-attempt in postHeartbeat, so a backup probe reports
	// the backup URL and the device row shows real fleet position.
	ServerURL string `json:"serverUrl,omitempty"`
```

…and `postHeartbeat` (Task 3) sets `payload.ServerURL = baseURL` before `json.Marshal`.

- [ ] **Step 4: Run tests**

Run: `pnpm test --filter=@breeze/api -- heartbeat.test.ts schemas.test.ts && cd agent && go test -race ./internal/heartbeat/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-07-09-agent-server-url-column.sql apps/api/src/db/schema/devices.ts apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts agent/internal/heartbeat/
git commit -m "feat: report + store active agent server URL (devices.agent_server_url) (#2288)"
```

---

### Task 7: Web — "Server" column on the device list

**Files:**
- Modify: `apps/web/src/components/devices/columnVisibility.ts` (COLUMN_IDS line 9, COLUMN_LABELS line 44 — NOT in `DEFAULT_VISIBLE_COLUMNS`; opt-in like `type`)
- Modify: `apps/web/src/components/devices/DeviceList.tsx` (Device interface ~line 78, sort accessor map ~line 318, column defs ~line 1073)
- Test: `apps/web/src/components/devices/columnVisibility.test.ts` (extend if it enumerates ids), `apps/web/src/components/devices/DeviceList.test.tsx` (extend — follow the file's existing column-render idiom)

**Interfaces:**
- Consumes: `device.agentServerUrl` from the device list API (Task 6 column flows through the existing device select — verify the list endpoint returns full rows; if it uses an explicit column list, add `agentServerUrl` there: `grep -n "agentVersion" apps/api/src/routes/devices.ts`).
- Produces: opt-in column id `serverUrl`, label **"Server"**, rendering the hostname only (full URL in `title` tooltip).

- [ ] **Step 1: Write the failing test**

```tsx
it('renders the Server column with the hostname of agentServerUrl', () => {
  renderDeviceList({
    devices: [{ ...baseDevice, agentServerUrl: 'https://old.example.com:8443' }],
    visibleColumns: ['hostname', 'serverUrl'],
  }); // follow the file's existing render/props idiom
  expect(screen.getByText('old.example.com')).toBeInTheDocument();
});

it('renders a dash when agentServerUrl is missing or malformed', () => {
  renderDeviceList({
    devices: [{ ...baseDevice, agentServerUrl: null }],
    visibleColumns: ['hostname', 'serverUrl'],
  });
  // dash idiom per the file's other optional columns
});
```

Run: `pnpm test --filter=@breeze/web -- DeviceList` → Expected: FAIL (unknown column id).

- [ ] **Step 2: Implement**

`columnVisibility.ts`: append `'serverUrl',` to `COLUMN_IDS` (after `'watchdogVersion'`), and `serverUrl: 'Server',` to `COLUMN_LABELS`. Do NOT add to `DEFAULT_VISIBLE_COLUMNS` (merge-on-read makes it appear in every user's column picker automatically).

`DeviceList.tsx`:
- Device interface: `agentServerUrl?: string | null;`
- Module-level helper:

```ts
// Hostname of the agent's active control-plane URL (#2288); null on
// missing/malformed values so the cell falls back to the dash.
function serverHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}
```

- Sort accessor map (line ~318): `serverUrl: d => serverHost(d.agentServerUrl),`
- Column defs (next to `agentVersion` at line 1073):

```tsx
    serverUrl: {
      header: () => sortHeader('serverUrl', 'Server', 'Sort by server URL'),
      cell: (device) => (
        <td
          key="serverUrl"
          className="px-3 py-3 text-sm text-muted-foreground whitespace-nowrap"
          title={device.agentServerUrl ?? undefined}
          data-testid={`device-${device.id}-server-url`}
        >
          {serverHost(device.agentServerUrl) || dash}
        </td>
      ),
    },
```

If the device list API endpoint uses an explicit select column list, add `agentServerUrl` to it (Step 1's consumes note).

- [ ] **Step 3: Run tests**

Run: `pnpm test --filter=@breeze/web -- DeviceList columnVisibility`
Expected: PASS, plus full web suite for regressions.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/devices/ apps/api/src/routes/devices.ts
git commit -m "feat(web): opt-in Server column showing each agent's active control-plane host (#2288)"
```

---

### Task 8: DNS last-known-good IP cache package

**Files:**
- Create: `agent/internal/netcache/netcache.go`
- Test: `agent/internal/netcache/netcache_test.go`

**Interfaces:**
- Produces: `netcache.New(path string) *Cache`; `(c *Cache) DialContext(ctx context.Context, network, addr string) (net.Conn, error)` — drop-in for `http.Transport.DialContext` / `websocket.Dialer.NetDialContext`; `netcache.Shared() *Cache` — process-wide singleton at `filepath.Join(config.GetDataDir(), "dns-cache.json")`.
- Injection seams for tests: unexported `lookup func(ctx, host) ([]string, error)` and `dial func(ctx, network, addr) (net.Conn, error)` fields.

**Semantics (from the spec, §6):** fresh DNS always preferred; cache consulted ONLY on `*net.DNSError`; connect (non-DNS) errors never consult the cache; successful dial persists the resolved IPs (write only on change, atomic tmp+rename); on cache-fallback failure surface the ORIGINAL DNS error; IP-literal hosts and unsplittable addrs pass straight through. TLS is untouched — this operates at the TCP dial layer, so `http.Transport`/`websocket.Dialer` still handshake against the URL hostname.

- [ ] **Step 1: Write the failing tests**

```go
package netcache

import (
	"context"
	"errors"
	"net"
	"path/filepath"
	"testing"
)

// fakeConn satisfies net.Conn minimally for dial stubs.
type fakeConn struct{ net.Conn }

func newTestCache(t *testing.T) (*Cache, *[]string) {
	t.Helper()
	dialed := &[]string{}
	c := New(filepath.Join(t.TempDir(), "dns-cache.json"))
	c.dial = func(_ context.Context, _ , addr string) (net.Conn, error) {
		*dialed = append(*dialed, addr)
		return fakeConn{}, nil
	}
	return c, dialed
}

func TestSuccessfulDialPersistsIPs(t *testing.T) {
	c, _ := newTestCache(t)
	c.lookup = func(_ context.Context, host string) ([]string, error) {
		return []string{"203.0.113.10"}, nil
	}
	if _, err := c.DialContext(context.Background(), "tcp", "api.example.com:443"); err != nil {
		t.Fatal(err)
	}
	// Fresh Cache reading the same file sees the persisted entry.
	c2 := New(c.path)
	if got := c2.cachedIPs("api.example.com"); len(got) != 1 || got[0] != "203.0.113.10" {
		t.Fatalf("persisted ips = %v", got)
	}
}

func TestDNSErrorFallsBackToCache(t *testing.T) {
	c, dialed := newTestCache(t)
	c.entries["api.example.com"] = []string{"203.0.113.10"}
	c.lookup = func(_ context.Context, host string) ([]string, error) {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	if _, err := c.DialContext(context.Background(), "tcp", "api.example.com:443"); err != nil {
		t.Fatal(err)
	}
	if len(*dialed) != 1 || (*dialed)[0] != "203.0.113.10:443" {
		t.Fatalf("dialed %v, want cached ip", *dialed)
	}
}

func TestDNSErrorWithEmptyCacheSurfacesOriginalError(t *testing.T) {
	c, _ := newTestCache(t)
	dnsErr := &net.DNSError{Err: "no such host", Name: "api.example.com", IsNotFound: true}
	c.lookup = func(_ context.Context, _ string) ([]string, error) { return nil, dnsErr }
	_, err := c.DialContext(context.Background(), "tcp", "api.example.com:443")
	var got *net.DNSError
	if !errors.As(err, &got) {
		t.Fatalf("want original DNS error, got %v", err)
	}
}

func TestConnectErrorDoesNotConsultCache(t *testing.T) {
	c, dialed := newTestCache(t)
	c.entries["api.example.com"] = []string{"203.0.113.10"}
	c.lookup = func(_ context.Context, _ string) ([]string, error) {
		return []string{"198.51.100.7"}, nil // DNS fine
	}
	connRefused := errors.New("connect: connection refused")
	c.dial = func(_ context.Context, _, addr string) (net.Conn, error) {
		*dialed = append(*dialed, addr)
		return nil, connRefused
	}
	_, err := c.DialContext(context.Background(), "tcp", "api.example.com:443")
	if !errors.Is(err, connRefused) {
		t.Fatalf("want connect error surfaced, got %v", err)
	}
	for _, a := range *dialed {
		if a == "203.0.113.10:443" {
			t.Fatal("cache consulted on a non-DNS failure")
		}
	}
}

func TestIPLiteralBypassesResolutionAndCache(t *testing.T) {
	c, dialed := newTestCache(t)
	c.lookup = func(_ context.Context, _ string) ([]string, error) {
		t.Fatal("lookup called for IP literal")
		return nil, nil
	}
	if _, err := c.DialContext(context.Background(), "tcp", "192.0.2.5:443"); err != nil {
		t.Fatal(err)
	}
	if (*dialed)[0] != "192.0.2.5:443" {
		t.Fatalf("dialed %v", *dialed)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test ./internal/netcache/ -v`
Expected: FAIL — package doesn't exist.

- [ ] **Step 3: Implement `netcache.go`**

```go
// Package netcache provides a last-known-good DNS→IP cache at the TCP dial
// layer (#2288). Fresh DNS always wins; the cache is consulted ONLY when
// resolution fails with *net.DNSError, so a pure DNS outage doesn't sever the
// control plane (or trigger a false backup-URL failover). TLS is untouched:
// http.Transport / websocket.Dialer still verify certificates against the URL
// hostname, so a stale or hijacked cached IP fails the handshake — the cache
// changes only where we dial, never what we trust.
package netcache

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/config" // adjust to the module's real import path
)

type Cache struct {
	path    string
	mu      sync.Mutex
	entries map[string][]string
	lookup  func(ctx context.Context, host string) ([]string, error)
	dial    func(ctx context.Context, network, addr string) (net.Conn, error)
}

func New(path string) *Cache {
	d := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	c := &Cache{
		path:    path,
		entries: map[string][]string{},
		lookup:  func(ctx context.Context, host string) ([]string, error) { return net.DefaultResolver.LookupHost(ctx, host) },
		dial:    d.DialContext,
	}
	c.load()
	return c
}

var (
	sharedOnce sync.Once
	shared     *Cache
)

// Shared is the process-wide cache, persisted in the agent data dir and thus
// shared (last-writer-wins, atomic replace) with the watchdog process.
func Shared() *Cache {
	sharedOnce.Do(func() {
		shared = New(filepath.Join(config.GetDataDir(), "dns-cache.json"))
	})
	return shared
}

func (c *Cache) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil || net.ParseIP(host) != nil {
		return c.dial(ctx, network, addr)
	}

	ips, lerr := c.lookup(ctx, host)
	if lerr == nil && len(ips) > 0 {
		conn, derr := c.dialFirst(ctx, network, ips, port)
		if derr == nil {
			c.store(host, ips)
			return conn, nil
		}
		return nil, derr // non-DNS failure: surface as-is, never consult the cache
	}

	var dnsErr *net.DNSError
	if lerr == nil || !errors.As(lerr, &dnsErr) {
		if lerr != nil {
			return nil, lerr
		}
		return nil, &net.DNSError{Err: "lookup returned no addresses", Name: host}
	}
	cached := c.cachedIPs(host)
	if len(cached) == 0 {
		return nil, lerr
	}
	conn, derr := c.dialFirst(ctx, network, cached, port)
	if derr != nil {
		return nil, lerr // surface the ORIGINAL DNS error, not the fallback's
	}
	return conn, nil
}

func (c *Cache) dialFirst(ctx context.Context, network string, ips []string, port string) (net.Conn, error) {
	var lastErr error
	for _, ip := range ips {
		conn, err := c.dial(ctx, network, net.JoinHostPort(ip, port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func (c *Cache) cachedIPs(host string) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.entries[host]...)
}

// store persists host→ips, writing the file only when the (sorted) set
// actually changed.
func (c *Cache) store(host string, ips []string) {
	sorted := append([]string(nil), ips...)
	sort.Strings(sorted)
	c.mu.Lock()
	prev := append([]string(nil), c.entries[host]...)
	sort.Strings(prev)
	changed := len(prev) != len(sorted)
	if !changed {
		for i := range prev {
			if prev[i] != sorted[i] {
				changed = true
				break
			}
		}
	}
	if changed {
		c.entries[host] = append([]string(nil), ips...)
	}
	snapshot := make(map[string][]string, len(c.entries))
	for k, v := range c.entries {
		snapshot[k] = append([]string(nil), v...)
	}
	c.mu.Unlock()
	if changed {
		c.persist(snapshot)
	}
}

func (c *Cache) load() {
	data, err := os.ReadFile(c.path)
	if err != nil {
		return // no cache yet — fine
	}
	var entries map[string][]string
	if json.Unmarshal(data, &entries) == nil && entries != nil {
		c.entries = entries
	}
}

// persist atomically replaces the cache file (tmp + rename). Corruption from
// a crash mid-write leaves either the old or the new file, both valid.
func (c *Cache) persist(entries map[string][]string) {
	data, err := json.Marshal(entries)
	if err != nil {
		return
	}
	tmp := c.path + ".partial"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return
	}
	_ = os.Rename(tmp, c.path)
}
```

(If `config.GetDataDir` has a different exact name, match it — `grep -n "func GetDataDir" agent/internal/config/config.go`, ~line 674.)

- [ ] **Step 4: Run tests**

Run: `cd agent && go test -race ./internal/netcache/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/netcache/
git commit -m "feat(agent): last-known-good DNS IP cache at the dial layer (#2288)"
```

---

### Task 9: Wire the DNS cache into agent HTTP, WebSocket, and watchdog clients

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (`newHeartbeatHTTPClient`, line 359)
- Modify: `agent/internal/websocket/client.go` (dialer construction, line 170)
- Modify: `agent/cmd/breeze-watchdog/main.go` (FailoverClient construction ~line 456; the log-shipper and updater client constructions — find with `grep -n "http.Client\|InitShipper" agent/cmd/breeze-watchdog/main.go agent/internal/watchdog/*.go`)
- Test: existing suites (behavioral change is transparent when DNS works; netcache unit tests from Task 8 carry the semantics)

**Interfaces:**
- Consumes: `netcache.Shared().DialContext` (Task 8).

- [ ] **Step 1: Wire heartbeat HTTP client**

```go
func newHeartbeatHTTPClient(tlsCfg *tls.Config) *http.Client {
	// DialContext goes through the last-known-good DNS cache (#2288); TLS
	// (including the mTLS client cert) is configured above it, so hostname
	// verification is unchanged.
	tr := &http.Transport{
		TLSClientConfig: tlsCfg,
		DialContext:     netcache.Shared().DialContext,
	}
	return &http.Client{Timeout: 30 * time.Second, Transport: tr}
}
```

- [ ] **Step 2: Wire WebSocket dialer** (client.go line 170; keep every existing dialer field):

```go
	dialer := websocket.Dialer{
		// ... existing fields unchanged ...
		NetDialContext: netcache.Shared().DialContext,
	}
```

- [ ] **Step 3: Wire watchdog clients**

`NewFailoverClient(cfg.ServerURL, cfg.AgentID, tokenStore.Reveal(), nil)` — the final param is the injectable `*http.Client` (verify against `agent/internal/watchdog/failover.go:37-60`); replace `nil` with:

```go
	&http.Client{
		Timeout:   30 * time.Second,
		Transport: &http.Transport{DialContext: netcache.Shared().DialContext},
	},
```

Apply the same transport to the watchdog's log-shipper and updater HTTP clients where they construct `http.Client` values (found via the grep in Files above). Any site that takes a nil-able client keeps its default when injection isn't possible — note such sites in the commit message rather than force-refactoring them.

- [ ] **Step 4: Run tests + build**

Run: `cd agent && go build ./... && go test -race ./internal/heartbeat/ ./internal/websocket/ ./internal/netcache/ && go test -race ./cmd/breeze-watchdog/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/heartbeat.go agent/internal/websocket/client.go agent/cmd/breeze-watchdog/ agent/internal/watchdog/
git commit -m "feat(agent): route control-plane dials through the DNS last-known-good cache (#2288)"
```

---

### Task 10: Watchdog — config re-load on failure + transient backup use

**Files:**
- Modify: `agent/cmd/breeze-watchdog/main.go` (failover branch, ~line 450+; poll ticker handling ~line 292)
- Modify: `agent/internal/watchdog/failover.go` (add `BaseURL() string` + `SetBaseURL(string)` accessors alongside the existing `UpdateToken`)
- Test: `agent/cmd/breeze-watchdog/backup_reload_test.go` (create — pure decision function)

**Interfaces:**
- Consumes: `Config.BackupServerURL` (Task 1).
- Produces: `decideWatchdogServerURL(current string, reloaded *config.Config, consecutiveFailures int) (newURL string, persistNothing bool)` — pure; plus the accessors on `FailoverClient`.

**Semantics (spec §5):** the watchdog holds a startup copy of the URL. On failover-heartbeat failures it must (a) re-`config.Load("")` to pick up a swap the agent already persisted, and (b) after `backupProbeThreshold` (10) consecutive failures, transiently point at `BackupServerURL` — in-memory only; the watchdog NEVER writes config.

- [ ] **Step 1: Write the failing test**

```go
package main

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config" // adjust import path
)

func TestDecideWatchdogServerURL(t *testing.T) {
	cases := []struct {
		name     string
		current  string
		reloaded config.Config
		failures int
		want     string
	}{
		{"agent already swapped on disk: follow it", "https://old.example.com",
			config.Config{ServerURL: "https://new.example.com"}, 1, "https://new.example.com"},
		{"below threshold, no swap on disk: stay", "https://old.example.com",
			config.Config{ServerURL: "https://old.example.com", BackupServerURL: "https://new.example.com"}, 9, "https://old.example.com"},
		{"at threshold with backup: transient backup", "https://old.example.com",
			config.Config{ServerURL: "https://old.example.com", BackupServerURL: "https://new.example.com"}, 10, "https://new.example.com"},
		{"at threshold without backup: stay", "https://old.example.com",
			config.Config{ServerURL: "https://old.example.com"}, 10, "https://old.example.com"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decideWatchdogServerURL(tc.current, &tc.reloaded, tc.failures)
			if got != tc.want {
				t.Fatalf("decideWatchdogServerURL(%q, ..., %d) = %q, want %q", tc.current, tc.failures, got, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./cmd/breeze-watchdog/ -run TestDecideWatchdogServerURL -v`
Expected: FAIL — undefined function.

- [ ] **Step 3: Implement**

In `main.go`:

```go
// decideWatchdogServerURL picks the failover client's base URL after a failed
// poll (#2288). Priority: a server_url the agent already swapped on disk;
// then, past the probe threshold, the configured backup — transiently, in
// memory only. The watchdog NEVER persists config; the agent owns that.
func decideWatchdogServerURL(current string, reloaded *config.Config, consecutiveFailures int) string {
	if reloaded.ServerURL != "" && reloaded.ServerURL != current {
		return reloaded.ServerURL
	}
	if consecutiveFailures >= backupProbeThreshold && reloaded.BackupServerURL != "" {
		return reloaded.BackupServerURL
	}
	return current
}

const backupProbeThreshold = 10 // keep in sync with agent/internal/heartbeat
```

In the failover branch, track `failoverFailures int`; on each `failoverClient.SendHeartbeat` error:

```go
	failoverFailures++
	if reloaded, rerr := config.Load(""); rerr == nil {
		if next := decideWatchdogServerURL(failoverClient.BaseURL(), reloaded, failoverFailures); next != failoverClient.BaseURL() {
			journal.Log(watchdog.LevelInfo, "failover.server_url_switch", map[string]any{"to": next})
			failoverClient.SetBaseURL(next)
		}
	}
```

…and reset `failoverFailures = 0` on any successful send. Add to `failover.go` (mirroring `UpdateToken`'s locking discipline):

```go
func (f *FailoverClient) BaseURL() string { /* mutex-guarded read of baseURL */ }
func (f *FailoverClient) SetBaseURL(u string) { /* mutex-guarded write */ }
```

- [ ] **Step 4: Run tests**

Run: `cd agent && go test -race ./cmd/breeze-watchdog/ ./internal/watchdog/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/cmd/breeze-watchdog/ agent/internal/watchdog/
git commit -m "feat(watchdog): follow agent server-URL swaps and transiently use the backup URL (#2288)"
```

---

### Task 11: Breeze Assist (Tauri helper) — re-read agent.yaml on transport failure

**Files:**
- Modify: `apps/helper/src-tauri/src/lib.rs` (`ensure_http_state` ~line 393; the request sites using `state.config.api_url` — lines ~504 and ~705; `load_agent_server_url` ~line 288)

**Interfaces:**
- Consumes: nothing new — reads the same `agent.yaml` the agent now rewrites on swap.
- Produces: `async fn invalidate_http_state()`; transport-failed requests invalidate the cached config, re-read `agent.yaml`, and retry once, so the helper self-heals after a server-URL swap without a restart.

- [ ] **Step 1: Implement `invalidate_http_state`** (next to `ensure_http_state`):

```rust
/// Drop the cached HTTP client + agent config so the next request re-reads
/// agent.yaml (#2288). Called on transport-level failures: after a backup
/// server promotion the agent rewrites server_url, and re-reading is how the
/// helper follows the swap without a restart.
async fn invalidate_http_state() {
    let lock = get_http_state_lock();
    let mut guard = lock.lock().await;
    *guard = None;
}
```

- [ ] **Step 2: Retry-once at each backend request site**

At each site that does `client.post(url)...send().await` (or `.get`) built from `state.config.api_url` (lib.rs ~504 and ~705 — find them all with `grep -n "config.api_url" apps/helper/src-tauri/src/lib.rs`), wrap the send:

```rust
    let resp = match send_once().await {
        Ok(r) => r,
        Err(e) if e.is_connect() || e.is_timeout() => {
            // Transport failure — the agent may have swapped server_url.
            // Re-read agent.yaml and retry exactly once.
            invalidate_http_state().await;
            ensure_http_state().await?;
            send_once_with_fresh_state().await.map_err(|e2| format!("request failed after config reload: {e2}"))?
        }
        Err(e) => return Err(format!("request failed: {e}")),
    };
```

Concretely: factor each site's URL construction + send into a small local closure/fn taking the state guard, so "retry with fresh state" is a second call after re-`ensure_http_state()` — the URL must be rebuilt from the RE-READ config (that's the whole point), not reused. Keep each site's existing error strings/messages for the non-transport error path.

`load_agent_server_url` (line 288) already reads the file fresh on every call — no change needed; note this in the commit message.

- [ ] **Step 3: Build + test**

Run: `cd apps/helper/src-tauri && cargo check && cargo test`
Expected: compiles; existing tests pass. (No new Rust unit test — the reqwest retry path needs a live socket; it is covered by the manual e2e pass in Task 12.)

- [ ] **Step 4: Commit**

```bash
git add apps/helper/src-tauri/src/lib.rs
git commit -m "fix(helper): re-read agent.yaml and retry once on transport failure so Assist follows server-URL swaps (#2288)"
```

---

### Task 12: Docs, .env.example, and end-to-end verification

**Files:**
- Create: `docs/deploy/agent-server-url-migration.md`
- Modify: `.env.example` (near the `IS_HOSTED` block, ~line 187)
- Modify: `docs/testing/FEATURE_TEST_LOG.md` (append the e2e result, per repo convention)

- [ ] **Step 1: `.env.example`** (generic placeholders only — no real hostnames):

```bash
# Backup control-plane URL pushed to ALL agents via heartbeat (#2288).
# Agents fail over to it automatically (and permanently, keeping the old URL
# as rollback) after ~10 consecutive failed heartbeats to the primary.
# Must be https:// (http:// allowed only for localhost). Malformed values
# refuse to boot. Leave unset to clear any previously-pushed backup.
# Remember: also map this var in the api service `environment:` block of your
# docker-compose.yml — a value in .env alone is not interpolated.
# AGENT_BACKUP_SERVER_URL=https://your-new-domain.example.com
```

- [ ] **Step 2: `docs/deploy/agent-server-url-migration.md`** — write the migration playbook from the spec verbatim (spec §"Migration playbook", all 7 steps), plus the Known Limitation paragraph ("cannot rescue agents that already lost the old URL"), the DNS-cache behavior note (spec §6), and the TURN_HOST note. Source of truth is the spec — copy, don't paraphrase semantics.

- [ ] **Step 3: End-to-end verification (two local stacks)**

1. Bring up the worktree stack (worktree-stack skill) — this is "old" at `http://localhost:<port>`.
2. Set `AGENT_BACKUP_SERVER_URL=http://localhost:<port2>` on the old API (localhost http is allowed), restart API.
3. Run a local agent enrolled against old; confirm agent log line `stored backup server URL` and `backup_server_url` in its `agent.yaml`.
4. Stand up the second stack on `<port2>` sharing the SAME Postgres (domain-rename simulation: same DB, new URL).
5. Kill the old API. Watch the agent log: 10 failure lines → `probing backup` → `PROMOTED backup server URL to primary`. Verify `agent.yaml` swapped (backup now holds the old URL).
6. In the web UI on the new stack, enable the "Server" column on Devices and confirm it shows the new host.
7. DNS-cache spot check: point the agent at a hostname via `/etc/hosts`, let it heartbeat once, remove the hosts entry (DNS now fails), confirm heartbeats continue (log stays healthy) and no failover triggers.
8. Log results (PASS/FAIL per step) in `docs/testing/FEATURE_TEST_LOG.md`.

- [ ] **Step 4: Full-suite gate**

Run: `pnpm test --filter=@breeze/api && pnpm test --filter=@breeze/web && cd agent && go test -race ./... && cd ../apps/helper/src-tauri && cargo check`
Expected: all green.

- [ ] **Step 5: Commit + PR**

```bash
git add docs/deploy/agent-server-url-migration.md .env.example docs/testing/FEATURE_TEST_LOG.md
git commit -m "docs: agent server-URL migration playbook + AGENT_BACKUP_SERVER_URL env (#2288)"
# Then open the PR (do not merge):
gh pr create --title "Agent backup server URL failover + DNS last-known-good cache (#2288)" \
  --body "$(cat <<'EOF'
Implements the backup-server-URL failover design (spec: docs/superpowers/specs/agent/2026-07-09-agent-backup-server-url-design.md).

Closes #2288

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes (already applied)

- Spec §1–§7 each map to a task: §1→T4, §2→T4, §3→T1/T2, §4→T3, §5 watchdog→T10, §5 helper→T11, §5 desktop-helper→no-op by design, §6→T8/T9, §7→T6/T7; playbook/docs→T12; enrollment seeding→T5.
- Names used consistently: `backupProbeThreshold`, `BackupServerURL`, `backup_server_url`/`backupServerUrl`, `agentServerUrl`/`agent_server_url`, `serverUrl` (column id `serverUrl`, label "Server"), `netcache.Shared().DialContext`, `decideBackupURLUpdate`, `promoteBackupServerURL`.
- Line numbers are anchors from 2026-07-09 `main`; re-locate by symbol if drifted.
- Import path `github.com/breeze-rmm/agent/...` in test snippets is a stand-in — use the real module path from `agent/go.mod`.
