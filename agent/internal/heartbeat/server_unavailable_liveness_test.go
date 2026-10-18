package heartbeat

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
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
