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
		// Agent telemetry endpoints are mounted under /api/v1/agents/<agentId>/ —
		// the /api/v1 prefix is mandatory (matches heartbeat & every other agent
		// call); dropping it 404s and pins the collector at status=pending.
		if r.URL.Path == "/api/v1/agents/agent-1/unifi-telemetry" {
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
	if gotPath != "/api/v1/agents/agent-1/unifi-telemetry" {
		t.Fatalf("telemetry posted to unexpected path: %q", gotPath)
	}
	if got["collectorId"] != "c1" || got["firmwareOk"] != true {
		t.Fatalf("unexpected payload: %+v", got)
	}
	// The uploaded device must carry the camelCase unifiDeviceId the API requires;
	// posting the controller's snake_case shape would 400 (regression guard, C2).
	devs, ok := got["devices"].([]any)
	if !ok || len(devs) != 1 {
		t.Fatalf("expected 1 device in payload, got %+v", got["devices"])
	}
	if d0, _ := devs[0].(map[string]any); d0["unifiDeviceId"] != "d1" {
		t.Fatalf("device missing camelCase unifiDeviceId: %+v", devs[0])
	}
}

func TestRunOnceUploadsSites(t *testing.T) {
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/proxy/network/integration/v1/sites":
			w.Write([]byte(`{"data":[{"id":"s1","name":"HQ"},{"id":"s2","name":"Branch"}]}`))
		default:
			w.Write([]byte(`{"data":[]}`))
		}
	}))
	defer controller.Close()

	var mu sync.Mutex
	var got map[string]any
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/agents/agent-1/unifi-telemetry" {
			mu.Lock()
			defer mu.Unlock()
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
	sitesRaw, ok := got["sites"].([]any)
	if !ok || len(sitesRaw) != 2 {
		t.Fatalf("expected 2 sites in payload, got %+v", got["sites"])
	}
	s0, _ := sitesRaw[0].(map[string]any)
	if s0["id"] != "s1" || s0["name"] != "HQ" {
		t.Fatalf("unexpected first site: %+v", sitesRaw[0])
	}
}

// fetchConfigs must GET the agent-scoped path /api/v1/agents/<id>/unifi-collectors.
// Dropping the /api/v1 prefix (as the loop did before the fix) 404s and never
// returns configs, so the collector stays status=pending forever — C3.
func TestFetchConfigsHitsAgentScopedPath(t *testing.T) {
	var gotPath string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if r.URL.Path == "/api/v1/agents/agent-1/unifi-collectors" {
			w.Write([]byte(`{"collectors":[{"collectorId":"c1","controllerUrl":"https://10.0.0.1","apiKey":"k","pollIntervalSeconds":60}]}`))
			return
		}
		w.WriteHeader(404)
	}))
	defer api.Close()

	configs, err := fetchConfigs(context.Background(), CollectorDeps{APIBaseURL: api.URL, AgentID: "agent-1", HTTP: api.Client()})
	if err != nil {
		t.Fatalf("fetchConfigs: %v", err)
	}
	if gotPath != "/api/v1/agents/agent-1/unifi-collectors" {
		t.Fatalf("fetchConfigs hit unexpected path: %q", gotPath)
	}
	if len(configs) != 1 || configs[0].CollectorID != "c1" {
		t.Fatalf("unexpected configs: %+v", configs)
	}
}
