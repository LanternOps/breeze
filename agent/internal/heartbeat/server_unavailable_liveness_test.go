package heartbeat

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/state"
)

func postAgainst(t *testing.T, srvURL string) (*state.AgentState, time.Time, time.Time) {
	t.Helper()
	statePath := filepath.Join(t.TempDir(), state.FileName)
	hb := time.Now().Add(-2 * time.Hour).UTC().Truncate(time.Second)
	if err := state.Write(statePath, &state.AgentState{Status: state.StatusRunning, PID: 7, LastHeartbeat: hb}); err != nil {
		t.Fatal(err)
	}
	h := newRecoveryMarkerTestHeartbeat(&config.Config{AgentID: "agent-1", ServerURL: srvURL, AuthToken: "t"})
	h.statePath = statePath
	before := time.Now().Add(-time.Second)
	if _, ok := h.doHeartbeatPost(srvURL, &HeartbeatPayload{Status: "ok"}); ok {
		t.Fatal("doHeartbeatPost reported success on a failed heartbeat")
	}
	s, err := state.Read(statePath)
	if err != nil || s == nil {
		t.Fatalf("read state: %v %v", s, err)
	}
	return s, before, hb
}

// #8934, agent half: LastHeartbeat only advances on HTTP 200, so an agent
// whose heartbeats an overloaded API answers with 503/429 (W08 admission and
// DB-saturation shedding) read as wedged and was restarted — adding one more
// reconnect to the storm. Such an answer proves the loop is running and the
// transport reached the server: write the server-unavailable marker, and
// leave LastHeartbeat alone.
func TestDoHeartbeatPost_OverloadAnswerWritesLivenessMarker(t *testing.T) {
	codes := []int{
		http.StatusTooManyRequests,
		http.StatusBadGateway,
		http.StatusServiceUnavailable,
		http.StatusGatewayTimeout,
	}
	for _, code := range codes {
		t.Run(http.StatusText(code), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Retry-After", "30")
				w.WriteHeader(code)
			}))
			defer srv.Close()

			s, before, hb := postAgainst(t, srv.URL)
			if !s.ServerUnavailableAt.After(before) {
				t.Fatalf("ServerUnavailableAt = %v, want a fresh timestamp after a %d", s.ServerUnavailableAt, code)
			}
			if !s.LastHeartbeat.Equal(hb) {
				t.Fatalf("LastHeartbeat moved to %v on a %d", s.LastHeartbeat, code)
			}
			if !s.AuthRejectedAt.IsZero() {
				t.Fatalf("AuthRejectedAt = %v on a %d — overload is not a credential rejection", s.AuthRejectedAt, code)
			}
		})
	}
}

// Answers that are not overload keep today's staleness handling: a 500 can be
// caused by what this agent sent, and a 401/403 has its own marker.
func TestDoHeartbeatPost_NonOverloadAnswerWritesNoServerUnavailableMarker(t *testing.T) {
	for _, code := range []int{http.StatusInternalServerError, http.StatusUnauthorized, http.StatusForbidden, http.StatusBadRequest} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(code)
			}))
			defer srv.Close()
			s, _, _ := postAgainst(t, srv.URL)
			if !s.ServerUnavailableAt.IsZero() {
				t.Fatalf("ServerUnavailableAt = %v after a %d", s.ServerUnavailableAt, code)
			}
		})
	}
}

// No HTTP answer, no marker: a refused or timed-out connection cannot tell a
// down server from this agent's own broken transport (ECH, proxy, mTLS, a bad
// promoted URL), and the restart / watchdog-FAILOVER path is the escape hatch
// for the latter.
func TestDoHeartbeatPost_TransportFailureWritesNoServerUnavailableMarker(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close()
	s, _, _ := postAgainst(t, url)
	if !s.ServerUnavailableAt.IsZero() {
		t.Fatalf("ServerUnavailableAt = %v after a refused connection", s.ServerUnavailableAt)
	}
}

// On AV/EDR hosts agent.state is unwritable (#2763) and the IPC state_sync is
// the only liveness channel left, so the marker must actually reach the
// watchdog session — and must never look like a successful heartbeat.
func TestNoteServerUnavailableLivenessSendsStateSync(t *testing.T) {
	watchdogServerConn, watchdogClientConn := createTestSocketPair(t)
	watchdogSession := sessionbroker.NewSession(ipc.NewConn(watchdogServerConn), 0, "watchdog-1", "tester", "", "watchdog-1", []string{"watchdog"})
	go watchdogSession.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	broker := newTestBrokerWithSessions(t, watchdogSession)

	h := &Heartbeat{sessionBroker: broker, agentVersion: "1.2.3"}
	before := time.Now().Add(-time.Second)
	h.noteServerUnavailableLiveness(http.StatusServiceUnavailable)

	_ = watchdogClientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	env, err := ipc.NewConn(watchdogClientConn).Recv()
	if err != nil {
		t.Fatalf("watchdog did not receive a state_sync frame: %v", err)
	}
	if env.Type != ipc.TypeStateSync {
		t.Fatalf("frame type = %s, want %s", env.Type, ipc.TypeStateSync)
	}
	var sync ipc.StateSync
	if err := json.Unmarshal(env.Payload, &sync); err != nil {
		t.Fatalf("unmarshal state_sync: %v", err)
	}
	at, err := time.Parse(time.RFC3339, sync.ServerUnavailableAt)
	if err != nil || at.Before(before.Truncate(time.Second)) {
		t.Fatalf("ServerUnavailableAt = %q (%v), want a fresh RFC3339 timestamp", sync.ServerUnavailableAt, err)
	}
	if sync.LastHeartbeat != "" || sync.Connected {
		t.Fatalf("state_sync reads as a successful heartbeat: LastHeartbeat=%q Connected=%v", sync.LastHeartbeat, sync.Connected)
	}
	if sync.AuthRejectedAt != "" {
		t.Fatalf("AuthRejectedAt = %q on an overload sync", sync.AuthRejectedAt)
	}
}
