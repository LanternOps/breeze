package heartbeat

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/prompthost"
	"github.com/breeze-rmm/agent/internal/promptkinds"
)

// #10190 W07: the submit names the renderer the agent expects to ask the
// first question with, and the ingest answer's pendingExpiresAt becomes the
// waiting card's deadline.

func TestFirstQuestionRendererPrediction(t *testing.T) {
	for _, tc := range []struct {
		name      string
		secure    bool
		renderers []prompthost.RendererSession
		enabled   []string
		want      string
	}{
		{"secure desktop: the SYSTEM helper (native)", true, []prompthost.RendererSession{elevAssist("assist-1"), elevSystem("system-1")}, elevEnabled, elevationRendererNative},
		{"no secure desktop + Assist: assist", false, []prompthost.RendererSession{elevAssist("assist-1"), elevSystem("system-1")}, elevEnabled, elevationRendererAssist},
		{"no secure desktop, kind disabled: native", false, []prompthost.RendererSession{elevAssist("assist-1")}, nil, elevationRendererNative},
		{"no secure desktop, no Assist: native", false, []prompthost.RendererSession{elevSystem("system-1")}, elevEnabled, elevationRendererNative},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newElevRig(t, tc.secure, tc.enabled, tc.renderers...)
			if got := r.h.firstQuestionRendererFor("3"); got != tc.want {
				t.Fatalf("renderer = %q, want %q", got, tc.want)
			}
		})
	}
	if got := (&Heartbeat{}).firstQuestionRendererFor(""); got != "" {
		t.Fatalf("no session: %q", got)
	}
}

func TestSendElevationRequestSendsTheRendererAndReadsTheDeadline(t *testing.T) {
	var body map[string]any
	expires := time.Date(2027, 1, 15, 10, 15, 0, 0, time.UTC)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"` + elevReq + `","status":"pending","pendingExpiresAt":"` + expires.Format(time.RFC3339Nano) + `"}`))
	}))
	defer ts.Close()
	h := NewWithVersion(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"}, "test", nil, nil)
	host := prompthost.New(prompthost.Deps{Broker: &rcDir{rs: []prompthost.RendererSession{elevAssist("assist-1")}}})
	promptkinds.Register(host)
	host.SetEnabledKinds(elevEnabled)
	h.promptHost = host
	h.pamSecureDesktop = func() (bool, error) { return false, nil }
	h.pamElevationOwner = func(string) (prompthost.Owner, bool) { return elevOwner, true }

	ev := sampleElevationEvent()
	ev.SubjectSessionID = 3
	outcome, err := h.SendElevationRequest(ev)
	if err != nil {
		t.Fatal(err)
	}
	if body["first_question_renderer"] != elevationRendererAssist {
		t.Fatalf("first_question_renderer = %v", body["first_question_renderer"])
	}
	if !outcome.PendingExpiresAt.Equal(expires) {
		t.Fatalf("pendingExpiresAt = %v, want %v", outcome.PendingExpiresAt, expires)
	}
	// The SubjectSessionID and consent instance never leave the agent.
	if _, ok := body["SubjectSessionID"]; ok {
		t.Fatal("the session id was sent")
	}
}

func TestSendElevationRequestIgnoresAMalformedDeadline(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"` + elevReq + `","status":"pending","pendingExpiresAt":42}`))
	}))
	defer ts.Close()
	h := NewWithVersion(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"}, "test", nil, nil)
	outcome, err := h.SendElevationRequest(sampleElevationEvent())
	if err != nil || outcome.Status != "pending" || !outcome.PendingExpiresAt.IsZero() {
		t.Fatalf("outcome = %+v, %v (a bad deadline must not cost the decision)", outcome, err)
	}
}
