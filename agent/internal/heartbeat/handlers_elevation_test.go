package heartbeat

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/etwlua"
)

func sampleElevationEvent() etwlua.Event {
	return etwlua.Event{
		SubjectUsername:      "CORP\\alice",
		TargetExecutablePath: `C:\Windows\System32\cmd.exe`,
		TargetExecutableHash: "deadbeef",
		PID:                  4321,
		ObservedAt:           time.Now().UTC(),
	}
}

func TestSendElevationRequestParsesIngestDecision(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"req-123","status":"auto_approved"}`))
	}))
	defer ts.Close()

	h := NewWithVersion(&config.Config{
		AgentID:   "agent-1",
		ServerURL: ts.URL,
		AuthToken: "token",
	}, "test", nil, nil)

	outcome, err := h.SendElevationRequest(sampleElevationEvent())
	if err != nil {
		t.Fatalf("SendElevationRequest returned error: %v", err)
	}
	if outcome.RequestID != "req-123" {
		t.Fatalf("RequestID = %q, want %q", outcome.RequestID, "req-123")
	}
	if outcome.Status != "auto_approved" {
		t.Fatalf("Status = %q, want %q", outcome.Status, "auto_approved")
	}
}

func TestSendElevationRequestErrorsOnServerError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	}))
	defer ts.Close()

	h := NewWithVersion(&config.Config{
		AgentID:   "agent-1",
		ServerURL: ts.URL,
		AuthToken: "token",
	}, "test", nil, nil)

	_, err := h.SendElevationRequest(sampleElevationEvent())
	if err == nil {
		t.Fatal("SendElevationRequest returned nil error on 500, want non-nil")
	}
}
