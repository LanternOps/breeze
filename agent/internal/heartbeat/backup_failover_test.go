package heartbeat

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/filetransfer"
	"github.com/breeze-rmm/agent/internal/health"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/tunnel"
	"github.com/breeze-rmm/agent/internal/websocket"
	"github.com/spf13/viper"
)

const failoverTestAgentID = "123e4567-e89b-12d3-a456-426614174000"

type failoverRoundTripper func(*http.Request) (*http.Response, error)

func (f failoverRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func failoverResponse(req *http.Request, status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}
}

func newFailoverTestHeartbeat(cfg *config.Config, transport http.RoundTripper) *Heartbeat {
	return &Heartbeat{
		config:          cfg,
		client:          &http.Client{Transport: transport},
		healthMon:       health.NewMonitor(),
		fileTransferMgr: filetransfer.NewManager(&filetransfer.Config{ServerURL: cfg.ServerURL}),
		tunnelMgr:       &tunnel.Manager{},
		retryCfg:        httputil.RetryConfig{MaxRetries: 0},
	}
}

// swapTestConfig loads a real temp agent.yaml so SetAndPersist has a file to
// write (viper.ConfigFileUsed must be non-empty).
func swapTestConfig(t *testing.T, primary, backup string) *config.Config {
	t.Helper()
	viper.Reset()
	t.Cleanup(viper.Reset)

	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	yaml := "agent_id: " + failoverTestAgentID + "\n" +
		"server_url: " + primary + "\n" +
		"backup_server_url: " + backup + "\n" +
		"auth_token: test-token\n"
	if err := os.WriteFile(cfgPath, []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestBackupProbeAndPromote(t *testing.T) {
	const (
		deadURL   = "https://primary.invalid"
		backupURL = "https://backup.invalid"
	)
	var backupRequests atomic.Int32

	cfg := swapTestConfig(t, deadURL, backupURL)
	h := newFailoverTestHeartbeat(cfg, failoverRoundTripper(func(req *http.Request) (*http.Response, error) {
		switch req.URL.Host {
		case "backup.invalid":
			backupRequests.Add(1)
			if got := req.URL.Path; got != "/api/v1/agents/"+failoverTestAgentID+"/heartbeat" {
				t.Errorf("backup heartbeat path = %q", got)
			}
			if got := req.Header.Get("Authorization"); got != "Bearer test-token" {
				t.Errorf("backup heartbeat Authorization = %q, want authenticated request", got)
				return failoverResponse(req, http.StatusUnauthorized, `{}`), nil
			}
			return failoverResponse(req, http.StatusOK, `{
				"commands":[],
				"configUpdate":{"policy_registry_state_probes":[{
					"registry_path":"HKLM\\Software\\Breeze",
					"value_name":"Mode"
				}]}
			}`), nil
		default:
			return nil, errors.New("unexpected heartbeat host: " + req.URL.Host)
		}
	}))
	wsCfg := &websocket.Config{ServerURL: deadURL}
	h.SetWebSocketClient(websocket.New(wsCfg, nil))
	payload := &HeartbeatPayload{Status: "ok", AgentVersion: "test"}

	// Drive failures up to the threshold: below it, no probe, no swap.
	for range backupProbeThreshold - 1 {
		h.recordHeartbeatFailure(payload)
	}
	if got := h.serverURL(); got != deadURL {
		t.Fatalf("swapped before threshold: serverURL=%q", got)
	}
	if got := backupRequests.Load(); got != 0 {
		t.Fatalf("backup probed before threshold: requests=%d", got)
	}

	// Threshold-crossing failure triggers the probe; backup answers 200 → swap.
	h.recordHeartbeatFailure(payload)
	if got := h.serverURL(); got != backupURL {
		t.Fatalf("expected promote-and-swap to %q, got %q", backupURL, got)
	}
	if got := backupRequests.Load(); got != 1 {
		t.Fatalf("threshold failure backup requests=%d, want 1", got)
	}
	if got := wsCfg.ServerURL; got != backupURL {
		t.Fatalf("WebSocket client server URL = %q, want promoted URL %q", got, backupURL)
	}
	if got := cfg.PolicyRegistryStateProbes; len(got) != 1 || got[0].ValueName != "Mode" {
		t.Fatalf("backup response configUpdate was not processed: %#v", got)
	}

	// Old primary retained as rollback backup, and both persisted to disk.
	reloaded, err := config.Reload()
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.ServerURL != backupURL || reloaded.BackupServerURL != deadURL {
		t.Fatalf("persisted swap wrong: server_url=%q backup=%q", reloaded.ServerURL, reloaded.BackupServerURL)
	}
}

func TestBackupProbeFailureDoesNotSwap(t *testing.T) {
	const (
		u1 = "https://primary.invalid"
		u2 = "https://backup.invalid"
	)
	var backupRequests atomic.Int32

	cfg := swapTestConfig(t, u1, u2)
	h := newFailoverTestHeartbeat(cfg, failoverRoundTripper(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host == "backup.invalid" {
			backupRequests.Add(1)
		}
		return nil, errors.New("connection refused")
	}))
	payload := &HeartbeatPayload{Status: "ok", AgentVersion: "test"}
	for range backupProbeThreshold + 3 {
		h.recordHeartbeatFailure(payload)
	}
	if got := h.serverURL(); got != u1 {
		t.Fatalf("swapped to dead backup: %q", got)
	}
	if got := backupRequests.Load(); got != 4 {
		t.Fatalf("dead backup probes=%d, want 4 (threshold and every subsequent failure)", got)
	}
}

func TestServerURLReadersDuringPromotion(t *testing.T) {
	const (
		primaryURL = "https://primary.invalid"
		backupURL  = "https://backup.invalid"
	)

	cfg := swapTestConfig(t, primaryURL, backupURL)
	h := newFailoverTestHeartbeat(cfg, failoverRoundTripper(func(req *http.Request) (*http.Response, error) {
		return failoverResponse(req, http.StatusOK, `{}`), nil
	}))

	start := make(chan struct{})
	readerErr := make(chan string, 1)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		for range 1000 {
			serverURL := h.serverURL()
			if serverURL != primaryURL && serverURL != backupURL {
				select {
				case readerErr <- "unexpected server URL: " + serverURL:
				default:
				}
				return
			}

			monitoringURL := h.monitoringResultsURL()
			primaryMonitoringURL := primaryURL + "/api/v1/agents/" + failoverTestAgentID + "/monitoring-results"
			backupMonitoringURL := backupURL + "/api/v1/agents/" + failoverTestAgentID + "/monitoring-results"
			if monitoringURL != primaryMonitoringURL && monitoringURL != backupMonitoringURL {
				select {
				case readerErr <- "unexpected monitoring results URL: " + monitoringURL:
				default:
				}
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		<-start
		h.promoteBackupServerURL()
	}()

	close(start)
	wg.Wait()

	select {
	case err := <-readerErr:
		t.Fatal(err)
	default:
	}
	if got := h.serverURL(); got != backupURL {
		t.Fatalf("server URL after promotion = %q, want %q", got, backupURL)
	}
	if got := h.monitoringResultsURL(); got != backupURL+"/api/v1/agents/"+failoverTestAgentID+"/monitoring-results" {
		t.Fatalf("monitoring results URL after promotion = %q", got)
	}
}
