package sim

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/pkg/api"
)

func TestEnrollSendsTheAgentsRequestShape(t *testing.T) {
	var got api.EnrollRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/agents/enroll" || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Authorization") != "" {
			t.Errorf("unexpected request %s %s auth=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(api.EnrollResponse{AgentID: "a1", AuthToken: "brz_t", DeviceID: "d1", OrgID: "o1", SiteID: "s1"})
	}))
	defer srv.Close()

	e := &Enroller{ServerURL: srv.URL, Key: "k", Secret: "sec", AgentVersion: "dev-agentsim", OSType: "linux", Client: srv.Client()}
	id, err := e.Enroll(context.Background(), 4, "agentsim-abc123-00004")
	if err != nil {
		t.Fatal(err)
	}
	if id.Index != 4 || id.AgentID != "a1" || id.DeviceID != "d1" || id.AuthToken != "brz_t" || id.OrgID != "o1" {
		t.Fatalf("identity %+v", id)
	}
	if got.EnrollmentKey != "k" || got.EnrollmentSecret != "sec" || got.Hostname != "agentsim-abc123-00004" ||
		got.OSType != "linux" || got.AgentVersion != "dev-agentsim" || got.HardwareInfo == nil ||
		got.HardwareInfo.SerialNumber != "AGENTSIM-agentsim-abc123-00004" {
		t.Fatalf("enroll request %+v", got)
	}
}

func TestEnrollHonours429RetryAfter(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(api.EnrollResponse{AgentID: "a1", AuthToken: "brz_t"})
	}))
	defer srv.Close()

	var slept []time.Duration
	e := &Enroller{ServerURL: srv.URL, Key: "k", OSType: "linux", Client: srv.Client(),
		Sleep: func(_ context.Context, d time.Duration) bool { slept = append(slept, d); return true }}
	if _, err := e.Enroll(context.Background(), 0, "h"); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 || len(slept) != 1 || slept[0] != 7*time.Second {
		t.Fatalf("calls %d slept %v, want 2 calls and one 7s wait", calls.Load(), slept)
	}
}

func TestEnrollRejectionIsTerminal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"Enrollment tenant is not active"}`))
	}))
	defer srv.Close()
	e := &Enroller{ServerURL: srv.URL, Key: "k", OSType: "linux", Client: srv.Client()}
	_, err := e.Enroll(context.Background(), 0, "h")
	if !errors.Is(err, ErrEnrollRejected) {
		t.Fatalf("want ErrEnrollRejected, got %v", err)
	}
}
