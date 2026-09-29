package agentapp

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// enrollTestServer answers /api/v1/agents/enroll with a successful enrollment
// and counts how many enroll requests reached it.
func enrollTestServer(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agents/enroll", func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"agentId":"agent-7394","deviceId":"device-7394","authToken":"tok","orgId":"org1","siteId":"site1","config":{}}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &hits
}

func quietEnrollForTest(t *testing.T) {
	t.Helper()
	orig := quietEnroll
	t.Cleanup(func() { quietEnroll = orig })
	quietEnroll = true
}

// TestEnrollWithConfig_UnpreparableConfigDirSendsNoEnrollRequest: a config
// directory that cannot be created or secured must fail the enrollment BEFORE
// the enroll request, so the server never creates a device that the agent
// then cannot save credentials for (#7394).
func TestEnrollWithConfig_UnpreparableConfigDirSendsNoEnrollRequest(t *testing.T) {
	quietEnrollForTest(t)
	srv, hits := enrollTestServer(t)

	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfgPath := filepath.Join(blocker, "agent.yaml")
	cfg := config.Default()
	cfg.ServerURL = srv.URL

	err := enrollWithConfig(cfg, cfgPath, "key", "secret")

	var failure *enrollFailure
	if !errors.As(err, &failure) {
		t.Fatalf("err = %v, want *enrollFailure", err)
	}
	if failure.cat != catConfig {
		t.Errorf("category = %v, want catConfig", failure.cat)
	}
	if n := hits.Load(); n != 0 {
		t.Errorf("enroll requests sent = %d, want 0 (the pre-flight must stop enrollment before the server creates a device)", n)
	}
	if !strings.Contains(failure.friendly, filepath.Dir(cfgPath)) {
		t.Errorf("friendly = %q, want it to name the config directory %q", failure.friendly, filepath.Dir(cfgPath))
	}
	if !strings.Contains(failure.friendly, "no enrollment request was sent") {
		t.Errorf("friendly = %q, want it to say no enrollment request was sent", failure.friendly)
	}
}

// TestEnrollWithConfig_SaveFailureAfterServerEnrollExplainsTheOrphanedDevice:
// if the save still fails after the server enrolled the device, the message
// must name the real config path, identify the device the server created, and
// tell the operator how to recover (#7394: it printed an empty path and left a
// pending device with no explanation).
func TestEnrollWithConfig_SaveFailureAfterServerEnrollExplainsTheOrphanedDevice(t *testing.T) {
	quietEnrollForTest(t)
	srv, hits := enrollTestServer(t)
	origSave := saveEnrollmentFn
	t.Cleanup(func() { saveEnrollmentFn = origSave })
	saveErr := errors.New("set DACL: this security ID may not be assigned as the owner of this object")
	saveEnrollmentFn = func(*config.Config, string) error { return saveErr }

	cfgPath := filepath.Join(t.TempDir(), "agent.yaml")
	cfg := config.Default()
	cfg.ServerURL = srv.URL

	err := enrollWithConfig(cfg, cfgPath, "key", "secret")

	var failure *enrollFailure
	if !errors.As(err, &failure) {
		t.Fatalf("err = %v, want *enrollFailure", err)
	}
	if hits.Load() != 1 {
		t.Fatalf("enroll requests sent = %d, want 1", hits.Load())
	}
	if !errors.Is(failure, saveErr) {
		t.Errorf("failure does not wrap the save error: %v", failure)
	}
	for _, want := range []string{cfgPath, "agent-7394", "device-7394", "created", "delete"} {
		if !strings.Contains(failure.friendly, want) {
			t.Errorf("friendly = %q, want it to contain %q", failure.friendly, want)
		}
	}
}

// TestEnrollSaveFailureNamesDefaultConfigPath: with no --config flag the
// message must name the default agent.yaml, never an empty path.
func TestEnrollSaveFailureNamesDefaultConfigPath(t *testing.T) {
	cfg := config.Default()
	cfg.AgentID, cfg.DeviceID = "agent-1", "device-1"
	failure := enrollSaveFailure(cfg, "", errors.New("boom"))
	if !strings.Contains(failure.friendly, config.ResolveSavePath("")) {
		t.Errorf("friendly = %q, want it to name %q", failure.friendly, config.ResolveSavePath(""))
	}
	if strings.Contains(failure.friendly, "to  ") {
		t.Errorf("friendly = %q still prints an empty path", failure.friendly)
	}
}
