package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/watchdog"
)

// collectDiagnosticsHarness spins up a fake API that routes /logs and
// /commands/.../result, drives handleFailoverCommand with a collect_diagnostics
// command against a journal pre-seeded with `entryCount` on-disk entries, and
// returns the submitted command-result body. The logsStatus callback decides
// the HTTP status for each /logs POST (1-indexed call number) so a test can
// stage a mixed 201/500 (partial) or all-201 (full success) ship outcome.
func collectDiagnosticsHarness(t *testing.T, entryCount int, logsStatus func(call int) int) map[string]any {
	t.Helper()

	journal, err := watchdog.NewJournal(t.TempDir(), 10, 3)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	defer journal.Close()
	for i := 0; i < entryCount; i++ {
		journal.Log(watchdog.LevelInfo, "seed.entry", map[string]any{"i": i})
	}

	var logsCalls int
	var resultBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/result"):
			raw, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(raw, &resultBody); err != nil {
				t.Errorf("decode result body: %v", err)
			}
			w.WriteHeader(http.StatusOK)
		case strings.HasSuffix(r.URL.Path, "/logs"):
			logsCalls++
			w.WriteHeader(logsStatus(logsCalls))
			w.Write([]byte(`{}`)) //nolint:errcheck
		default:
			t.Errorf("unexpected request path %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	fc := watchdog.NewFailoverClient(srv.URL, "agent-1", "tok", nil)
	wd := watchdog.NewWatchdog(watchdog.Config{})
	cfg := &config.Config{AgentID: "agent-1", ServerURL: srv.URL}
	tokens := &tokenHolder{}
	recovery := watchdog.NewRecoveryManager(3, 0)

	cmd := watchdog.FailoverCommand{ID: "cmd-diag", Type: "collect_diagnostics"}
	handleFailoverCommand(fc, cmd, wd, journal, cfg, tokens, recovery)

	if resultBody == nil {
		t.Fatal("no command result was submitted")
	}
	return resultBody
}

// nestedResult extracts the "result" object submitted alongside the status.
func nestedResult(t *testing.T, body map[string]any) map[string]any {
	t.Helper()
	res, ok := body["result"].(map[string]any)
	if !ok {
		t.Fatalf("result field missing/not an object: %#v", body["result"])
	}
	return res
}

// TestCollectDiagnosticsPartialShipFailsWithPartialFlag drives collect_diagnostics
// with >200 seeded entries so ShipLogs splits into two batches; the first lands
// (201) and the second fails (500). The submitted result must report
// status=failed, partial=true, and shipped_logs=200 (only the first batch) — the
// headline of finding #7: an operator sees a truthful partial, not a false
// "completed" for diagnostics that only half-reached the API.
func TestCollectDiagnosticsPartialShipFailsWithPartialFlag(t *testing.T) {
	// 250 seeded + the "failover.command" entry handleFailoverCommand itself
	// logs = 251 entries → batches of 200 + 51. First 201, rest 500.
	body := collectDiagnosticsHarness(t, 250, func(call int) int {
		if call == 1 {
			return http.StatusCreated
		}
		return http.StatusInternalServerError
	})

	if got, _ := body["status"].(string); got != "failed" {
		t.Errorf("status = %v, want failed", body["status"])
	}
	res := nestedResult(t, body)
	if got := res["partial"]; got != true {
		t.Errorf("result.partial = %v, want true", got)
	}
	if got := res["shipped_logs"]; got != float64(200) {
		t.Errorf("result.shipped_logs = %v, want 200 (first batch only)", got)
	}
	if _, ok := res["ship_error"]; !ok {
		t.Errorf("result.ship_error missing, want the ship failure detail")
	}
}

// TestCollectDiagnosticsFullShipCompletes drives collect_diagnostics when every
// /logs batch lands (201). The result must report status=completed, carry a
// positive shipped_logs count, and NOT flag a partial.
func TestCollectDiagnosticsFullShipCompletes(t *testing.T) {
	body := collectDiagnosticsHarness(t, 250, func(int) int { return http.StatusCreated })

	if got, _ := body["status"].(string); got != "completed" {
		t.Errorf("status = %v, want completed", body["status"])
	}
	res := nestedResult(t, body)
	shipped, _ := res["shipped_logs"].(float64)
	if shipped <= 0 {
		t.Errorf("result.shipped_logs = %v, want > 0", res["shipped_logs"])
	}
	if got, ok := res["partial"]; ok && got == true {
		t.Errorf("result.partial = true on full success, want absent/false")
	}
}
