package agentapp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// #8318: enrollment declares securityCapabilities.rebindProtocolVersion = 1 —
// a freshly enrolled install is exactly the device a reinstall reattach makes
// the source, before its first heartbeat.
func TestEnrollDeclaresTheRebindProtocol(t *testing.T) {
	quietEnrollForTest(t)
	var body map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agents/enroll", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"agentId":"agent-8318","deviceId":"device-8318","authToken":"tok","orgId":"org1","siteId":"site1","config":{}}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	origSave := saveEnrollmentFn
	t.Cleanup(func() { saveEnrollmentFn = origSave })
	saveEnrollmentFn = func(*config.Config, string) error { return nil }

	cfg := config.Default()
	cfg.ServerURL = srv.URL
	if err := enrollWithConfig(cfg, filepath.Join(t.TempDir(), "agent.yaml"), "key", "secret"); err != nil {
		t.Fatalf("enrollWithConfig: %v", err)
	}
	caps, _ := body["securityCapabilities"].(map[string]any)
	if v, _ := caps["rebindProtocolVersion"].(float64); v != 1 {
		t.Fatalf("enroll securityCapabilities = %v, want rebindProtocolVersion 1", body["securityCapabilities"])
	}
}
