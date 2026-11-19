package agentapp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/spf13/viper"
)

// #8318: an installed agent's enrollment declares
// securityCapabilities.rebindProtocolVersion = 1 — a freshly enrolled install
// is exactly the device a reinstall reattach makes the source. A Quick
// Support client's enrollment (enrollSupportSession) declares nothing: a
// disposable install must never become an existing device's identity.
func TestEnrollDeclaresTheRebindProtocolOnlyOutsideSupportMode(t *testing.T) {
	for _, tc := range []struct {
		name    string
		support bool
	}{
		{name: "installed agent", support: false},
		{name: "Quick Support client", support: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			quietEnrollForTest(t)
			viper.Reset()
			t.Cleanup(viper.Reset)
			var body map[string]any
			mux := http.NewServeMux()
			mux.HandleFunc("/api/v1/agents/enroll", func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewDecoder(r.Body).Decode(&body)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				_, _ = w.Write([]byte(`{"agentId":"ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776","deviceId":"00000000-0000-4000-8000-000000008318","authToken":"tok","orgId":"org1","siteId":"site1","config":{}}`))
			})
			srv := httptest.NewServer(mux)
			t.Cleanup(srv.Close)

			cfg := config.Default()
			cfg.ServerURL = srv.URL
			cfgPath := filepath.Join(t.TempDir(), "agent.yaml")
			var err error
			if tc.support {
				cfg.SupportMode = true
				err = enrollSupportSession(cfg, cfgPath, "key", "secret")
			} else {
				origSave := saveEnrollmentFn
				t.Cleanup(func() { saveEnrollmentFn = origSave })
				saveEnrollmentFn = func(*config.Config, string) error { return nil }
				err = enrollWithConfig(cfg, cfgPath, "key", "secret")
			}
			if err != nil {
				t.Fatalf("enrollment: %v", err)
			}
			caps, declared := body["securityCapabilities"].(map[string]any)
			if tc.support {
				if declared {
					t.Fatalf("a Quick Support client declared %v", caps)
				}
				return
			}
			if v, _ := caps["rebindProtocolVersion"].(float64); v != 1 {
				t.Fatalf("enroll securityCapabilities = %v, want rebindProtocolVersion 1", body["securityCapabilities"])
			}
		})
	}
}
