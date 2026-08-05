package heartbeat

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/spf13/viper"

	"github.com/breeze-rmm/agent/internal/authstate"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/secmem"
)

// Issue #2621 — ordering regression tests for agent credential rotation.
//
// The bug: the server committed new credential hashes BEFORE the agent had
// persisted the matching plaintext. When config.Save failed, the agent logged
// the error and carried on in memory; after a restart it loaded stale
// credentials from secrets.yaml and every request 401'd once the 5-minute
// previous-token grace window closed, with no automatic recovery.
//
// The contract these tests pin down is the ordering that fixes it: the server
// only commits when the agent CONFIRMS, and the agent only confirms after the
// credentials are durably on disk and verified by readback.

type rotationServer struct {
	*httptest.Server
	mu           sync.Mutex
	rotateCalls  int
	confirmCalls int
	// confirmedWith records the bearer token each confirm arrived with — the
	// server's proof-of-possession check depends on it being the NEW token.
	confirmedWith []string
}

func (s *rotationServer) counts() (rotate, confirm int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rotateCalls, s.confirmCalls
}

func (s *rotationServer) tokensUsedForConfirm() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.confirmedWith...)
}

// newRotationServer stands up a two-phase-capable rotation endpoint pair.
func newRotationServer(t *testing.T) *rotationServer {
	t.Helper()
	rs := &rotationServer{}
	mux := http.NewServeMux()

	mux.HandleFunc("/api/v1/agents/", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case pathHasSuffix(r.URL.Path, "/rotate-token/confirm"):
			rs.mu.Lock()
			rs.confirmCalls++
			rs.confirmedWith = append(rs.confirmedWith, r.Header.Get("Authorization"))
			rs.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"confirmed": true})
		case pathHasSuffix(r.URL.Path, "/rotate-token"):
			rs.mu.Lock()
			rs.rotateCalls++
			rs.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"authToken":            "brz_staged_agent",
				"watchdogAuthToken":    "brz_staged_watchdog",
				"helperAuthToken":      "brz_staged_helper",
				"rotatedAt":            "2026-07-19T00:00:00Z",
				"confirmationRequired": true,
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	rs.Server = httptest.NewServer(mux)
	t.Cleanup(rs.Close)
	return rs
}

func pathHasSuffix(path, suffix string) bool {
	return len(path) >= len(suffix) && path[len(path)-len(suffix):] == suffix
}

// newRotationTestHeartbeat wires a Heartbeat against a real temp config so the
// credential-persistence path exercises actual file I/O.
func newRotationTestHeartbeat(t *testing.T, serverURL string) (*Heartbeat, string) {
	t.Helper()
	viper.Reset()
	t.Cleanup(viper.Reset)

	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")

	cfg := config.Default()
	cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
	cfg.ServerURL = serverURL
	cfg.AuthToken = "brz_current_agent"
	cfg.WatchdogAuthToken = "brz_current_watchdog"
	cfg.HelperAuthToken = "brz_current_helper"
	cfg.OrgID = "org-1"
	cfg.SiteID = "site-1"

	if err := config.SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	viper.SetConfigFile(cfgPath)

	h := &Heartbeat{
		config:      cfg,
		secureToken: secmem.NewSecureString("brz_current_agent"),
		client:      &http.Client{},
	}
	return h, cfgPath
}

// THE regression test for #2621.
//
// With the secrets file unwritable, rotation must abort BEFORE confirming. If
// the agent confirmed here, the server would commit hashes whose plaintext
// exists nowhere on disk — the agent would run fine until its next restart and
// then be permanently locked out.
func TestTokenRotationDoesNotConfirmWhenPersistenceFails(t *testing.T) {
	srv := newRotationServer(t)
	h, cfgPath := newRotationTestHeartbeat(t, srv.URL)

	// Block the secrets write with a non-empty directory at the target path.
	secretsPath := secretsPathFor(cfgPath)
	if err := os.Remove(secretsPath); err != nil {
		t.Fatalf("remove secrets file: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(secretsPath, "occupied"), 0700); err != nil {
		t.Fatalf("create blocking directory: %v", err)
	}

	h.handleTokenRotation()

	rotate, confirm := srv.counts()
	if rotate != 1 {
		t.Fatalf("rotate-token calls = %d, want 1", rotate)
	}
	if confirm != 0 {
		t.Fatalf("rotate-token/confirm was called %d time(s) after a failed disk write — "+
			"the server would commit credentials the agent cannot reproduce after a restart (#2621)", confirm)
	}

	// THE load-bearing assertion. Pre-fix, handleTokenRotation called
	// secureToken.Replace BEFORE config.Save and treated a save error as a log
	// line, so this would read "brz_staged_agent". Do not weaken this to
	// t.Errorf-and-continue or delete it as redundant — the confirm-count checks
	// above are vacuous against the old code (it had no confirm endpoint at all),
	// and this is what actually pins the bug.
	if got := h.secureToken.Reveal(); got != "brz_current_agent" {
		t.Fatalf("in-memory token = %q, want brz_current_agent — the agent swapped to "+
			"credentials it failed to persist (#2621)", got)
	}
}

// A pre-#2621 server commits the rotation in the initial call and has no confirm
// endpoint. Taking the two-phase path against it would be fatal: the confirm
// 404s, the agent never promotes locally, and it keeps using a credential the
// server has already demoted — stranded permanently once the grace lapses.
func TestTokenRotationPromotesImmediatelyAgainstLegacyServer(t *testing.T) {
	rs := &rotationServer{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agents/", func(w http.ResponseWriter, r *http.Request) {
		if pathHasSuffix(r.URL.Path, "/rotate-token/confirm") {
			rs.mu.Lock()
			rs.confirmCalls++
			rs.mu.Unlock()
			w.WriteHeader(http.StatusNotFound)
			return
		}
		rs.mu.Lock()
		rs.rotateCalls++
		rs.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		// No confirmationRequired: the legacy server already committed.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"authToken":         "brz_staged_agent",
			"watchdogAuthToken": "brz_staged_watchdog",
			"helperAuthToken":   "brz_staged_helper",
			"rotatedAt":         "2026-07-19T00:00:00Z",
		})
	})
	rs.Server = httptest.NewServer(mux)
	t.Cleanup(rs.Close)

	h, _ := newRotationTestHeartbeat(t, rs.URL)
	h.handleTokenRotation()

	if _, confirm := rs.counts(); confirm != 0 {
		t.Errorf("confirm was called %d time(s) against a server that has no confirm phase", confirm)
	}

	persisted, err := config.ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials: %v", err)
	}
	if persisted.AuthToken != "brz_staged_agent" {
		t.Errorf("persisted auth token = %q, want brz_staged_agent — against a legacy "+
			"server the agent must promote locally or it strands itself", persisted.AuthToken)
	}
	if persisted.PendingAuthToken != "" {
		t.Errorf("staged credentials were left behind: %q", persisted.PendingAuthToken)
	}
	if got := h.secureToken.Reveal(); got != "brz_staged_agent" {
		t.Errorf("in-memory token = %q, want brz_staged_agent", got)
	}
}

// The Helper runs as the logged-in user, cannot read the root-only secrets.yaml,
// and reads helper_auth_token from agent.yaml. A promotion that only rewrote
// secrets.yaml would leave it on the superseded token.
func TestTokenRotationUpdatesHelperTokenInAgentYAML(t *testing.T) {
	srv := newRotationServer(t)
	h, cfgPath := newRotationTestHeartbeat(t, srv.URL)

	h.handleTokenRotation()

	agentYAML, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read agent.yaml: %v", err)
	}
	if !strings.Contains(string(agentYAML), "brz_staged_helper") {
		t.Errorf("agent.yaml does not carry the rotated helper token — the Breeze Helper "+
			"reads it from here and would 401 after the grace window:\n%s", agentYAML)
	}
	if strings.Contains(string(agentYAML), "brz_current_helper") {
		t.Errorf("agent.yaml still carries the superseded helper token:\n%s", agentYAML)
	}
}

// Happy path: persist, verify, confirm, promote — in that order.
func TestTokenRotationPersistsBeforeConfirming(t *testing.T) {
	srv := newRotationServer(t)
	h, _ := newRotationTestHeartbeat(t, srv.URL)

	h.handleTokenRotation()

	rotate, confirm := srv.counts()
	if rotate != 1 || confirm != 1 {
		t.Fatalf("rotate=%d confirm=%d, want 1 and 1", rotate, confirm)
	}

	// Confirmation must be authenticated with the NEW token: that is the
	// server's evidence the endpoint holds a durable copy. Confirming with the
	// old token would prove nothing about what got written.
	used := srv.tokensUsedForConfirm()
	if len(used) != 1 || used[0] != "Bearer brz_staged_agent" {
		t.Fatalf("confirm authenticated with %v, want [Bearer brz_staged_agent]", used)
	}

	persisted, err := config.ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials: %v", err)
	}
	if persisted.AuthToken != "brz_staged_agent" {
		t.Errorf("persisted auth token = %q, want brz_staged_agent", persisted.AuthToken)
	}
	if persisted.WatchdogAuthToken != "brz_staged_watchdog" {
		t.Errorf("persisted watchdog token = %q, want brz_staged_watchdog", persisted.WatchdogAuthToken)
	}
	if persisted.HelperAuthToken != "brz_staged_helper" {
		t.Errorf("persisted helper token = %q, want brz_staged_helper", persisted.HelperAuthToken)
	}
	// A confirmed rotation collapses to a single credential set.
	if persisted.PendingAuthToken != "" {
		t.Errorf("staged credentials survived a confirmed rotation: %q", persisted.PendingAuthToken)
	}
	if got := h.secureToken.Reveal(); got != "brz_staged_agent" {
		t.Errorf("in-memory token = %q, want brz_staged_agent", got)
	}
}

// A confirm that never lands leaves BOTH sets on disk. That is deliberate: the
// server still accepts the old credentials (it never promoted) and also accepts
// the staged ones, so a restart in this window authenticates either way.
func TestTokenRotationKeepsBothCredentialSetsWhenConfirmFails(t *testing.T) {
	rs := &rotationServer{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agents/", func(w http.ResponseWriter, r *http.Request) {
		if pathHasSuffix(r.URL.Path, "/rotate-token/confirm") {
			rs.mu.Lock()
			rs.confirmCalls++
			rs.mu.Unlock()
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"boom"}`))
			return
		}
		rs.mu.Lock()
		rs.rotateCalls++
		rs.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"authToken":            "brz_staged_agent",
			"watchdogAuthToken":    "brz_staged_watchdog",
			"helperAuthToken":      "brz_staged_helper",
			"confirmationRequired": true,
		})
	})
	rs.Server = httptest.NewServer(mux)
	t.Cleanup(rs.Close)

	h, _ := newRotationTestHeartbeat(t, rs.URL)
	h.handleTokenRotation()

	persisted, err := config.ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials: %v", err)
	}
	if persisted.AuthToken != "brz_current_agent" {
		t.Errorf("current auth token = %q, want brz_current_agent — the agent must not "+
			"promote credentials the server never confirmed", persisted.AuthToken)
	}
	if persisted.PendingAuthToken != "brz_staged_agent" {
		t.Errorf("staged auth token = %q, want brz_staged_agent — dropping it would lose "+
			"the credential the server may already accept", persisted.PendingAuthToken)
	}
}

// Startup reconciliation: the agent finds a staged set on disk (it crashed
// after persisting but before confirming) and finishes the handshake. This is
// the recovery path for the crash window.
func TestReconcilePendingRotationConfirmsStagedCredentials(t *testing.T) {
	srv := newRotationServer(t)
	h, _ := newRotationTestHeartbeat(t, srv.URL)

	if err := config.StagePendingCredentials("brz_staged_agent", "brz_staged_watchdog", "brz_staged_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}

	h.reconcilePendingRotation()

	_, confirm := srv.counts()
	if confirm != 1 {
		t.Fatalf("confirm calls = %d, want 1", confirm)
	}
	used := srv.tokensUsedForConfirm()
	if len(used) != 1 || used[0] != "Bearer brz_staged_agent" {
		t.Fatalf("reconciliation confirmed with %v, want [Bearer brz_staged_agent]", used)
	}

	persisted, err := config.ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials: %v", err)
	}
	if persisted.AuthToken != "brz_staged_agent" {
		t.Errorf("auth token = %q, want brz_staged_agent", persisted.AuthToken)
	}
	if persisted.PendingAuthToken != "" {
		t.Errorf("staged credentials survived reconciliation: %q", persisted.PendingAuthToken)
	}
}

// Nothing staged => nothing to do. Reconciliation runs on every startup, so it
// must be a cheap no-op that never touches the server.
func TestReconcilePendingRotationNoOpWithoutStagedCredentials(t *testing.T) {
	srv := newRotationServer(t)
	h, _ := newRotationTestHeartbeat(t, srv.URL)

	h.reconcilePendingRotation()

	rotate, confirm := srv.counts()
	if rotate != 0 || confirm != 0 {
		t.Fatalf("rotate=%d confirm=%d, want no server calls", rotate, confirm)
	}
}

// An expired staged set can never be promoted. The agent must discard it rather
// than retry forever — and must keep its durable current credentials.
func TestReconcilePendingRotationDiscardsExpiredStagedSet(t *testing.T) {
	rs := &rotationServer{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agents/", func(w http.ResponseWriter, r *http.Request) {
		rs.mu.Lock()
		rs.confirmCalls++
		rs.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": "Pending rotation has expired; request a new rotation",
			"code":  "pending_rotation_expired",
		})
	})
	rs.Server = httptest.NewServer(mux)
	t.Cleanup(rs.Close)

	h, _ := newRotationTestHeartbeat(t, rs.URL)
	if err := config.StagePendingCredentials("brz_staged_agent", "brz_staged_watchdog", "brz_staged_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}

	h.reconcilePendingRotation()

	persisted, err := config.ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials: %v", err)
	}
	if persisted.PendingAuthToken != "" {
		t.Errorf("expired staged credentials were retained: %q", persisted.PendingAuthToken)
	}
	if persisted.AuthToken != "brz_current_agent" {
		t.Errorf("current auth token = %q, want brz_current_agent — an expired rotation "+
			"must not cost the agent its working credentials", persisted.AuthToken)
	}
}

// Issue #2894 — the confirm 409s the server can return, and whether each one
// means "this staged set is dead, drop it" or "try again later".
//
// The asymmetry is the whole point of the table. Discarding a staged set the
// server may still be authenticating the device with is unrecoverable
// (#2772/#2773); retrying a genuinely dead one only costs a request per tick.
// So a code must be on the terminal list EXPLICITLY — an unrecognised code from
// a newer server, and any non-409 failure, must fall through to retry.
func TestConfirmRotationDiscardsOnlyTerminalConflicts(t *testing.T) {
	tests := []struct {
		name string
		// status/body the stubbed confirm endpoint returns. rawBody wins when set,
		// for responses that are not valid JSON at all.
		status  int
		body    map[string]any
		rawBody string
		// true => the staged credentials must be gone from disk afterwards.
		wantDiscarded bool
	}{
		{
			name:          "expired staged set is terminal",
			status:        http.StatusConflict,
			body:          map[string]any{"error": "expired", "code": "pending_rotation_expired"},
			wantDiscarded: true,
		},
		{
			name:          "superseded staged set is terminal",
			status:        http.StatusConflict,
			body:          map[string]any{"error": "superseded", "code": "rotation_unresolvable"},
			wantDiscarded: true,
		},
		{
			name:   "staged token rejected outright is terminal",
			status: http.StatusUnauthorized,
			body:   map[string]any{"error": "unauthorized"},
			// A 401 means the server would not accept the staged token at all, so
			// it can never be promoted.
			wantDiscarded: true,
		},
		{
			name:   "compare-and-swap conflict is retryable",
			status: http.StatusConflict,
			body:   map[string]any{"error": "conflict", "code": "rotation_conflict"},
			// The row moved between the server's read and its write. A retry
			// re-reads and may well promote — dropping the set here would throw
			// away a live credential.
			wantDiscarded: false,
		},
		{
			name:   "presenting the current token is retryable",
			status: http.StatusConflict,
			body:   map[string]any{"error": "wrong token", "code": "pending_token_required"},
			// The staged copy on disk IS the device's current credential here.
			// Discarding it strands the device.
			wantDiscarded: false,
		},
		{
			name:   "unknown code from a newer server is retryable",
			status: http.StatusConflict,
			body:   map[string]any{"error": "something new", "code": "rotation_some_future_code"},
			// Fail safe: never infer terminality from a code we do not know.
			wantDiscarded: false,
		},
		{
			name:          "server error is retryable",
			status:        http.StatusInternalServerError,
			body:          map[string]any{"error": "boom"},
			wantDiscarded: false,
		},
		{
			// A proxy or captive portal answering 200 with HTML. This must be a
			// visible, retryable failure — not a zero-valued "unconfirmed" that
			// loops every tick without ever logging why.
			name:          "200 with an undecodable body is retryable",
			status:        http.StatusOK,
			rawBody:       `<html>captive portal</html>`,
			wantDiscarded: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var confirmCalls int
			mux := http.NewServeMux()
			mux.HandleFunc("/api/v1/agents/", func(w http.ResponseWriter, r *http.Request) {
				confirmCalls++
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				if tc.rawBody != "" {
					_, _ = w.Write([]byte(tc.rawBody))
					return
				}
				_ = json.NewEncoder(w).Encode(tc.body)
			})
			srv := httptest.NewServer(mux)
			t.Cleanup(srv.Close)

			h, _ := newRotationTestHeartbeat(t, srv.URL)
			if err := config.StagePendingCredentials("brz_staged_agent", "brz_staged_watchdog", "brz_staged_helper"); err != nil {
				t.Fatalf("StagePendingCredentials: %v", err)
			}

			h.reconcilePendingRotation()

			if confirmCalls != 1 {
				t.Fatalf("confirm calls = %d, want 1", confirmCalls)
			}

			persisted, err := config.ReadPersistedCredentials()
			if err != nil {
				t.Fatalf("ReadPersistedCredentials: %v", err)
			}

			if tc.wantDiscarded {
				if persisted.PendingAuthToken != "" {
					t.Errorf("staged credentials survived a terminal conflict (%q): the agent will "+
						"re-confirm on every tick until the pending TTL expires (#2894)", persisted.PendingAuthToken)
				}
				if h.pendingRotationOnDisk.Load() {
					t.Error("pendingRotationOnDisk still set after discarding the staged set — the per-tick retry stays armed")
				}
			} else {
				if persisted.PendingAuthToken != "brz_staged_agent" {
					t.Errorf("staged auth token = %q, want brz_staged_agent — a retryable conflict "+
						"must not cost the agent a credential the server may still accept", persisted.PendingAuthToken)
				}
				// Retaining the staged set is only half of "retryable". The
				// per-tick reconcile is gated on this flag, so clearing it here
				// would leave the set on disk with nothing scheduled to promote
				// it — recoverable only at the next process start.
				if !h.pendingRotationOnDisk.Load() {
					t.Error("pendingRotationOnDisk cleared after a retryable conflict — the staged set " +
						"is still on disk but the per-tick retry is disarmed")
				}
			}

			// Non-negotiable in BOTH directions: a failed confirm never touches the
			// durable current credentials.
			if persisted.AuthToken != "brz_current_agent" {
				t.Errorf("current auth token = %q, want brz_current_agent — a failed confirm must "+
					"never disturb the credentials the agent is actually authenticated on", persisted.AuthToken)
			}
		})
	}
}

// secretsPathFor mirrors the config package's secrets-file layout for tests
// that need to manipulate the file directly.
func secretsPathFor(cfgPath string) string {
	return filepath.Join(filepath.Dir(cfgPath), "secrets.yaml")
}

// An agent that 401'd its way into auth-dead and then repaired its credential
// via the per-tick reconcile must be allowed to use it immediately.
//
// reconcilePendingRotation deliberately runs BEFORE the ShouldSkip() gate,
// precisely so a stranded agent can recover mid-backoff. If applying the
// rotated credentials doesn't clear the monitor, the agent holds a known-good
// token and still sits out the remaining window before it may prove it — a wait
// bounded only by maxBackoff, which is 30 minutes.
func TestApplyRotatedCredentialsClearsAuthDeadState(t *testing.T) {
	h, _ := newRotationTestHeartbeat(t, "http://127.0.0.1:1")
	h.authMon = authstate.NewMonitor(1)

	h.authMon.RecordAuthFailure() // threshold=1 -> auth-dead
	if !h.authMon.ShouldSkip() {
		t.Fatal("precondition: expected auth-dead after the failure threshold")
	}

	h.applyRotatedCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper")

	if h.authMon.ShouldSkip() {
		t.Fatal("expected the auth monitor cleared after a confirmed rotation — " +
			"the agent holds known-good credentials and must not serve out the backoff")
	}
}
