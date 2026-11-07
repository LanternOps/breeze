package agentapp

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/promptidentity"
)

// A successful (re-)enrolment drops the cached MSP identity, and the next
// identity under another scope purges the old scope's prompt list entries.
func TestReenrolClearsIdentity(t *testing.T) {
	quietEnrollForTest(t)
	resetSiteIDFlag(t)

	dataDir := t.TempDir()
	origDir := promptIdentityDataDir
	t.Cleanup(func() { promptIdentityDataDir = origDir })
	promptIdentityDataDir = func() string { return dataDir }

	const oldScope = "bad7313391508e4129c338752b2cc809"
	const newScope = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"
	if _, _, err := promptidentity.Open(dataDir, promptidentity.Options{}).Apply(&promptidentity.HeartbeatBlock{State: promptidentity.StateSet, ScopeID: oldScope, PartnerName: "Example IT"}); err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agents/enroll", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"agentId":"a","deviceId":"d","authToken":"tok","orgId":"o","siteId":"s","config":{}}`))
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

	var purged []string
	s := promptidentity.Open(dataDir, promptidentity.Options{OnScopeChange: func(old string) { purged = append(purged, old) }})
	if _, ok := s.Current(); ok {
		t.Fatal("the MSP identity survived re-enrolment")
	}
	if _, scopeChanged, err := s.Apply(&promptidentity.HeartbeatBlock{State: promptidentity.StateSet, ScopeID: newScope}); err != nil || !scopeChanged {
		t.Fatalf("first identity after re-enrolment: scopeChanged=%v err=%v", scopeChanged, err)
	}
	if len(purged) != 1 || purged[0] != oldScope {
		t.Fatalf("purged %v, want [%s]", purged, oldScope)
	}
}

// A successful (re-)enrolment drops the persisted Helper branding of every
// session but keeps the other Helper settings.
func TestReenrolClearsHelperBranding(t *testing.T) {
	quietEnrollForTest(t)
	resetSiteIDFlag(t)

	baseDir := t.TempDir()
	origDir := helperBrandingBaseDir
	t.Cleanup(func() { helperBrandingBaseDir = origDir })
	helperBrandingBaseDir = func() string { return baseDir }

	cfgPath := filepath.Join(baseDir, "sessions", "1", "helper_config.yaml")
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfgPath, []byte("show_open_portal: true\nbranding:\n  scope_id: s\n  display_name: Acme\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	srv, _ := enrollTestServer(t)
	origSave := saveEnrollmentFn
	t.Cleanup(func() { saveEnrollmentFn = origSave })
	cleared := false
	saveEnrollmentFn = func(*config.Config, string) error {
		data, _ := os.ReadFile(cfgPath)
		cleared = !strings.Contains(string(data), "branding")
		return nil
	}

	cfg := config.Default()
	cfg.ServerURL = srv.URL
	if err := enrollWithConfig(cfg, filepath.Join(t.TempDir(), "agent.yaml"), "key", "secret"); err != nil {
		t.Fatalf("enrollWithConfig: %v", err)
	}
	if !cleared {
		t.Fatal("branding must be cleared before the new enrollment is saved")
	}
	data, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(data), "show_open_portal: true") {
		t.Fatalf("other settings lost:\n%s", data)
	}
}
