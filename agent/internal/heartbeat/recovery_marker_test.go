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

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/health"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/tunnel"
)

func TestLoadRecoveryMarker(t *testing.T) {
	dir := t.TempDir()

	if m, err := LoadRecoveryMarker(dir); m != nil || err != nil {
		t.Fatalf("absent marker: m=%v err=%v", m, err)
	}

	markerJSON := `{"recoveryId":"rec-1","nonce":"` + strings.Repeat("a", 64) + `","snapshotId":"snap-1"}`
	if err := os.WriteFile(filepath.Join(dir, recoveryMarkerFile), []byte(markerJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	m, err := LoadRecoveryMarker(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m.RecoveryID != "rec-1" || len(m.Nonce) != 64 || m.SnapshotID != "snap-1" {
		t.Fatalf("unexpected marker: %+v", m)
	}

	if err := os.WriteFile(filepath.Join(dir, recoveryMarkerFile), []byte(`{"recoveryId":""}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadRecoveryMarker(dir); err == nil {
		t.Fatal("empty recoveryId must be an error")
	}

	// Restore a valid marker before testing acknowledgement.
	if err := os.WriteFile(filepath.Join(dir, recoveryMarkerFile), []byte(markerJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := AcknowledgeRecoveryMarker(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, recoveryMarkerAckedFile)); err != nil {
		t.Fatal("acked file missing")
	}
	if _, err := os.Stat(filepath.Join(dir, recoveryMarkerFile)); !os.IsNotExist(err) {
		t.Fatal("original marker file must be gone")
	}

	// Acknowledging again (no marker left) must be a harmless no-op.
	if err := AcknowledgeRecoveryMarker(dir); err != nil {
		t.Fatalf("idempotent re-ack must not error: %v", err)
	}
}

// recoveryMarkerTestServer records every heartbeat payload it receives and
// replies with the scripted ack sequence, one entry per call (the last entry
// repeats once exhausted).
type recoveryMarkerTestServer struct {
	*httptest.Server
	mu       sync.Mutex
	payloads []HeartbeatPayload
	acks     []bool
}

func newRecoveryMarkerTestServer(t *testing.T, acks []bool) *recoveryMarkerTestServer {
	t.Helper()
	rs := &recoveryMarkerTestServer{acks: acks}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agents/", func(w http.ResponseWriter, r *http.Request) {
		var payload HeartbeatPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("failed to decode heartbeat payload: %v", err)
		}
		rs.mu.Lock()
		idx := len(rs.payloads)
		rs.payloads = append(rs.payloads, payload)
		ack := false
		if idx < len(rs.acks) {
			ack = rs.acks[idx]
		} else if len(rs.acks) > 0 {
			ack = rs.acks[len(rs.acks)-1]
		}
		rs.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(HeartbeatResponse{
			Commands:          []Command{},
			RecoveryMarkerAck: ack,
		})
	})
	rs.Server = httptest.NewServer(mux)
	t.Cleanup(rs.Close)
	return rs
}

func (rs *recoveryMarkerTestServer) payloadAt(i int) HeartbeatPayload {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return rs.payloads[i]
}

func (rs *recoveryMarkerTestServer) callCount() int {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return len(rs.payloads)
}

func newRecoveryMarkerTestHeartbeat(cfg *config.Config) *Heartbeat {
	return &Heartbeat{
		config:    cfg,
		client:    &http.Client{},
		healthMon: health.NewMonitor(),
		tunnelMgr: &tunnel.Manager{},
		retryCfg:  httputil.RetryConfig{MaxRetries: 0},
	}
}

// TestHeartbeat_SendsMarkerUntilAcked drives postHeartbeat directly (the same
// call sendHeartbeat makes) three times: the marker is present while unacked,
// absent once acked and the on-disk file has been renamed.
func TestHeartbeat_SendsMarkerUntilAcked(t *testing.T) {
	server := newRecoveryMarkerTestServer(t, []bool{false, true})
	dataDir := t.TempDir()
	prevDataDir := recoveryMarkerDataDir
	recoveryMarkerDataDir = func() string { return dataDir }
	t.Cleanup(func() { recoveryMarkerDataDir = prevDataDir })

	marker := &RecoveryMarker{RecoveryID: "rec-1", Nonce: strings.Repeat("a", 64), SnapshotID: "snap-1"}
	markerJSON, err := json.Marshal(marker)
	if err != nil {
		t.Fatal(err)
	}
	markerPath := filepath.Join(dataDir, recoveryMarkerFile)
	if err := os.WriteFile(markerPath, markerJSON, 0o600); err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{AgentID: "agent-1", ServerURL: server.URL, AuthToken: "test-token"}
	h := newRecoveryMarkerTestHeartbeat(cfg)
	h.SetRecoveryMarker(marker)

	// Beat 1: not yet acked — payload must carry the marker, and the file
	// must still be on disk afterward (no premature acknowledgement).
	if ok := h.postHeartbeat(server.URL, &HeartbeatPayload{Status: "ok", AgentVersion: "1.0.0", RecoveryMarker: h.recoveryMarker()}); !ok {
		t.Fatal("beat 1: postHeartbeat failed")
	}
	if server.payloadAt(0).RecoveryMarker == nil {
		t.Fatal("beat 1: payload missing recoveryMarker")
	}
	if h.recoveryMarker() == nil {
		t.Fatal("beat 1: marker cleared before ack")
	}
	if _, err := os.Stat(markerPath); err != nil {
		t.Fatal("beat 1: marker file must still exist before ack")
	}

	// Beat 2: server acks — the marker must be cleared and the on-disk file
	// renamed to the acked name.
	if ok := h.postHeartbeat(server.URL, &HeartbeatPayload{Status: "ok", AgentVersion: "1.0.0", RecoveryMarker: h.recoveryMarker()}); !ok {
		t.Fatal("beat 2: postHeartbeat failed")
	}
	if server.payloadAt(1).RecoveryMarker == nil {
		t.Fatal("beat 2: payload missing recoveryMarker (it was still unacked going into this beat)")
	}
	if h.recoveryMarker() != nil {
		t.Fatal("beat 2: marker must be cleared after an ack")
	}
	if _, err := os.Stat(filepath.Join(dataDir, recoveryMarkerAckedFile)); err != nil {
		t.Fatal("beat 2: acked marker file missing — AcknowledgeRecoveryMarker was not called")
	}
	if _, err := os.Stat(markerPath); !os.IsNotExist(err) {
		t.Fatal("beat 2: original marker file must be gone")
	}

	// Beat 3: nothing left to send — the payload must have no recoveryMarker.
	if ok := h.postHeartbeat(server.URL, &HeartbeatPayload{Status: "ok", AgentVersion: "1.0.0", RecoveryMarker: h.recoveryMarker()}); !ok {
		t.Fatal("beat 3: postHeartbeat failed")
	}
	if got := server.payloadAt(2).RecoveryMarker; got != nil {
		t.Fatalf("beat 3: payload must not carry a recoveryMarker, got %+v", got)
	}
	if server.callCount() != 3 {
		t.Fatalf("expected 3 heartbeat calls, got %d", server.callCount())
	}
}
