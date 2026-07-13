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
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/health"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/tunnel"
	"github.com/breeze-rmm/agent/internal/websocket"
	"github.com/breeze-rmm/agent/internal/workerpool"
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
		h.promoteBackupServerURL(backupURL)
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

// TestBackupProbePromotesProbedURLWhenResponseClearsBackup pins the straggler
// scenario from the migration playbook: the API sends backup_server_url on
// EVERY heartbeat, so a backup instance with the env var unset answers the
// probe itself with a clear (""). That configUpdate is applied inside
// postHeartbeat BEFORE promotion runs — promotion must still swap to the URL
// that actually passed the authenticated probe, never re-read the (now
// cleared) config value. Regression: promote once re-read config and
// persisted server_url="" here, bricking the agent.
func TestBackupProbePromotesProbedURLWhenResponseClearsBackup(t *testing.T) {
	const (
		deadURL   = "https://primary.invalid"
		backupURL = "https://backup.invalid"
	)

	cfg := swapTestConfig(t, deadURL, backupURL)
	h := newFailoverTestHeartbeat(cfg, failoverRoundTripper(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host != "backup.invalid" {
			return nil, errors.New("unexpected heartbeat host: " + req.URL.Host)
		}
		// Realistic new-instance response: env var unset ⇒ push a clear.
		return failoverResponse(req, http.StatusOK, `{
			"commands":[],
			"configUpdate":{"backup_server_url":""}
		}`), nil
	}))
	payload := &HeartbeatPayload{Status: "ok", AgentVersion: "test"}

	for range backupProbeThreshold {
		h.recordHeartbeatFailure(payload)
	}

	if got := h.serverURL(); got != backupURL {
		t.Fatalf("promoted server URL = %q, want probed backup %q", got, backupURL)
	}
	reloaded, err := config.Reload()
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.ServerURL != backupURL {
		t.Fatalf("persisted server_url = %q, want %q (never empty)", reloaded.ServerURL, backupURL)
	}
	if reloaded.BackupServerURL != deadURL {
		t.Fatalf("persisted backup_server_url = %q, want rollback %q", reloaded.BackupServerURL, deadURL)
	}
}

// TestPromoteRefusesEmptyURL is the belt-and-braces guard for the same class:
// an empty promotion target must be a logged no-op, never a persisted swap.
func TestPromoteRefusesEmptyURL(t *testing.T) {
	const (
		primaryURL = "https://primary.invalid"
		backupURL  = "https://backup.invalid"
	)
	cfg := swapTestConfig(t, primaryURL, backupURL)
	h := newFailoverTestHeartbeat(cfg, failoverRoundTripper(func(req *http.Request) (*http.Response, error) {
		return nil, errors.New("no requests expected")
	}))

	h.promoteBackupServerURL("")

	if got := h.serverURL(); got != primaryURL {
		t.Fatalf("server URL after empty promote = %q, want unchanged %q", got, primaryURL)
	}
	reloaded, err := config.Reload()
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.ServerURL != primaryURL || reloaded.BackupServerURL != backupURL {
		t.Fatalf("config mutated by empty promote: server_url=%q backup=%q", reloaded.ServerURL, reloaded.BackupServerURL)
	}
}

// TestHeartbeatFailureStreakResetPreventsProbe pins that the threshold counts
// CONSECUTIVE failures: a success mid-streak (sendHeartbeat's success branch
// calls resetHeartbeatFailures) restarts the count, so a chronically flaky
// link never accumulates a lifetime total that trips a spurious probe.
func TestHeartbeatFailureStreakResetPreventsProbe(t *testing.T) {
	const (
		deadURL   = "https://primary.invalid"
		backupURL = "https://backup.invalid"
	)
	var backupRequests atomic.Int32

	cfg := swapTestConfig(t, deadURL, backupURL)
	h := newFailoverTestHeartbeat(cfg, failoverRoundTripper(func(req *http.Request) (*http.Response, error) {
		backupRequests.Add(1)
		return failoverResponse(req, http.StatusOK, `{"commands":[]}`), nil
	}))
	payload := &HeartbeatPayload{Status: "ok", AgentVersion: "test"}

	for range backupProbeThreshold - 1 {
		h.recordHeartbeatFailure(payload)
	}
	h.resetHeartbeatFailures() // a successful primary heartbeat mid-streak
	for range backupProbeThreshold - 1 {
		h.recordHeartbeatFailure(payload)
	}

	if got := backupRequests.Load(); got != 0 {
		t.Fatalf("backup probed despite reset streak: requests=%d", got)
	}
	if got := h.serverURL(); got != deadURL {
		t.Fatalf("server URL changed without probe: %q", got)
	}
}

// TestProbeCommandResultsGoToPromotedURL pins the promote-before-process
// ordering: a command delivered in the backup PROBE's response must submit
// its result to the just-promoted backup URL — never to the dead primary,
// which is where results went when the response was processed before the
// swap (commands stranded 'sent' server-side, operator retries duplicated
// the side effect).
func TestProbeCommandResultsGoToPromotedURL(t *testing.T) {
	const (
		deadURL   = "https://primary.invalid"
		backupURL = "https://backup.invalid"
	)
	resultHost := make(chan string, 1)

	cfg := swapTestConfig(t, deadURL, backupURL)
	h := newFailoverTestHeartbeat(cfg, failoverRoundTripper(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/result") {
			select {
			case resultHost <- req.URL.Host:
			default:
			}
			return failoverResponse(req, http.StatusOK, `{}`), nil
		}
		if req.URL.Host != "backup.invalid" {
			return nil, errors.New("unexpected heartbeat host: " + req.URL.Host)
		}
		return failoverResponse(req, http.StatusOK, `{
			"commands":[{"id":"probe-cmd-1","type":"set_auto_update","payload":{"enabled":false}}]
		}`), nil
	}))
	h.pool = workerpool.New(1, 4)
	h.accepting.Store(true)
	payload := &HeartbeatPayload{Status: "ok", AgentVersion: "test"}

	for range backupProbeThreshold {
		h.recordHeartbeatFailure(payload)
	}

	select {
	case host := <-resultHost:
		if host != "backup.invalid" {
			t.Fatalf("command result submitted to %q, want promoted backup host", host)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("probe-delivered command result was never submitted")
	}
	if got := h.serverURL(); got != backupURL {
		t.Fatalf("server URL after probe = %q, want %q", got, backupURL)
	}
}
