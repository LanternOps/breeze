package heartbeat

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/authstate"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/state"
)

// #2796 defect A, agent half: state.UpdateHeartbeat runs only on HTTP 200,
// so an agent whose credentials the server rejects never refreshed its
// liveness and the watchdog restart-churned it. A 401/403 must now write the
// auth-rejected marker — and must NOT touch LastHeartbeat.
func TestDoHeartbeatPost_AuthRejectionWritesLivenessMarker(t *testing.T) {
	for _, code := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(code)
			}))
			defer srv.Close()

			statePath := filepath.Join(t.TempDir(), state.FileName)
			hb := time.Now().Add(-2 * time.Hour).UTC().Truncate(time.Second)
			if err := state.Write(statePath, &state.AgentState{Status: state.StatusRunning, PID: 7, LastHeartbeat: hb}); err != nil {
				t.Fatal(err)
			}

			h := newRecoveryMarkerTestHeartbeat(&config.Config{AgentID: "agent-1", ServerURL: srv.URL, AuthToken: "t"})
			h.statePath = statePath
			before := time.Now().Add(-time.Second)

			if _, ok := h.doHeartbeatPost(srv.URL, &HeartbeatPayload{Status: "ok"}); ok {
				t.Fatal("doHeartbeatPost reported success on a rejection")
			}

			s, err := state.Read(statePath)
			if err != nil || s == nil {
				t.Fatalf("read state: %v %v", s, err)
			}
			if !s.AuthRejectedAt.After(before) {
				t.Fatalf("AuthRejectedAt = %v, want a fresh timestamp after a %d", s.AuthRejectedAt, code)
			}
			if !s.LastHeartbeat.Equal(hb) {
				t.Fatalf("LastHeartbeat moved to %v on a rejected heartbeat", s.LastHeartbeat)
			}
		})
	}
}

// A 5xx is a server problem, not a credential rejection: no marker, so the
// watchdog's ordinary staleness handling is unchanged for it.
func TestDoHeartbeatPost_ServerErrorWritesNoMarker(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	statePath := filepath.Join(t.TempDir(), state.FileName)
	h := newRecoveryMarkerTestHeartbeat(&config.Config{AgentID: "agent-1", ServerURL: srv.URL, AuthToken: "t"})
	h.statePath = statePath
	_, _ = h.doHeartbeatPost(srv.URL, &HeartbeatPayload{Status: "ok"})
	s, _ := state.Read(statePath)
	if s != nil && !s.AuthRejectedAt.IsZero() {
		t.Fatalf("AuthRejectedAt = %v after a 500", s.AuthRejectedAt)
	}
}

// While auth-dead the tick loop skips the request entirely. The skip must
// still refresh the marker, or an agent in a 30-minute backoff window reads
// as wedged within one stale threshold.
func TestAuthDeadSkipTickRefreshesLivenessMarker(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), state.FileName)
	h := newRecoveryMarkerTestHeartbeat(&config.Config{AgentID: "agent-1"})
	h.statePath = statePath
	mon := authstate.NewMonitor(1)
	h.SetAuthMonitor(mon)

	if h.skipTickIfAuthDead() {
		t.Fatal("skipped a tick on a healthy auth monitor")
	}
	if s, _ := state.Read(statePath); s != nil && !s.AuthRejectedAt.IsZero() {
		t.Fatal("marker written while auth is healthy")
	}

	mon.RecordAuthFailure() // dead; 1s window
	before := time.Now().Add(-time.Second)
	if !h.skipTickIfAuthDead() {
		t.Fatal("did not skip inside the auth-dead backoff window")
	}
	s, err := state.Read(statePath)
	if err != nil || s == nil || !s.AuthRejectedAt.After(before) {
		t.Fatalf("skip tick did not refresh the marker: %+v %v", s, err)
	}
}
