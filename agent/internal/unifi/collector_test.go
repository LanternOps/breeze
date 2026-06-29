package unifi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestRunOnceUploadsTelemetry(t *testing.T) {
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/proxy/network/integration/v1/sites":
			w.Write([]byte(`{"data":[{"id":"s1"}]}`))
		case "/proxy/network/integration/v1/sites/s1/devices":
			w.Write([]byte(`{"data":[{"id":"d1","mac":"aa:bb"}]}`))
		case "/proxy/network/integration/v1/sites/s1/clients":
			w.Write([]byte(`{"data":[{"mac":"cc:dd"}]}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer controller.Close()

	var mu sync.Mutex
	var got map[string]any
	var gotPath string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Agent telemetry endpoints are mounted under /agents/<agentId>/.
		if r.URL.Path == "/agents/agent-1/unifi-telemetry" {
			mu.Lock()
			defer mu.Unlock()
			gotPath = r.URL.Path
			_ = json.NewDecoder(r.Body).Decode(&got)
			w.WriteHeader(202)
			return
		}
		w.WriteHeader(404)
	}))
	defer api.Close()

	cfg := CollectorConfig{CollectorID: "c1", ControllerURL: controller.URL, APIKey: "k"}
	err := RunOnce(context.Background(), CollectorDeps{APIBaseURL: api.URL, AgentID: "agent-1", HTTP: api.Client()}, cfg, controller.Client())
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if gotPath != "/agents/agent-1/unifi-telemetry" {
		t.Fatalf("telemetry posted to unexpected path: %q", gotPath)
	}
	if got["collectorId"] != "c1" || got["firmwareOk"] != true {
		t.Fatalf("unexpected payload: %+v", got)
	}
}
