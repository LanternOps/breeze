package heartbeat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/hwhealth"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"
)

type hardwareTestSource struct {
	collect func(context.Context) (hwhealth.Result, error)
}

func (s hardwareTestSource) Name() hwhealth.Kind { return "storcli" }
func (s hardwareTestSource) Tier() hwhealth.Tier { return hwhealth.TierRAID }
func (s hardwareTestSource) Detect(context.Context) hwhealth.Availability {
	return hwhealth.Availability{Available: true}
}
func (s hardwareTestSource) Collect(c context.Context, _ hwhealth.Availability) (hwhealth.Result, error) {
	return s.collect(c)
}

type hardwareTransport func(*http.Request) (*http.Response, error)

func (f hardwareTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func newHardwareTestHeartbeat(t *testing.T, source hwhealth.Source) *Heartbeat {
	t.Helper()
	cfg := config.Default()
	cfg.AgentID = "fixture-agent"
	cfg.ServerURL = "https://hardware.example.com"
	cfg.AuthToken = "fixture-token"
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return &Heartbeat{
		config:       cfg,
		hwContext:    ctx,
		hwCancel:     cancel,
		hwConfig:     hwhealth.Config{Enabled: true, PollInterval: 10 * time.Minute, DiskHealthInterval: time.Hour},
		hwhealthCol:  hwhealth.New(hwhealth.Options{DataDir: t.TempDir(), Sources: []hwhealth.Source{source}}),
		agentVersion: "fixture-version",
		retryCfg:     httputil.DefaultRetryConfig(),
	}
}

func TestHardwareConfigAliases(t *testing.T) {
	for _, camel := range []bool{false, true} {
		h := newHardwareTestHeartbeat(t, hardwareTestSource{collect: func(context.Context) (hwhealth.Result, error) {
			return hwhealth.Result{Complete: true}, nil
		}})
		outer, a, b := "hardware_monitoring_settings", "poll_interval_minutes", "disk_health_interval_minutes"
		if camel {
			outer, a, b = "hardwareMonitoringSettings", "pollIntervalMinutes", "diskHealthIntervalMinutes"
		}
		h.applyConfigUpdate(map[string]any{outer: map[string]any{"enabled": false, a: float64(5), b: float64(15)}})
		if h.hwConfig.Enabled || h.hwConfig.PollInterval != 5*time.Minute || h.hwConfig.DiskHealthInterval != 15*time.Minute {
			t.Fatal(h.hwConfig)
		}
		before := h.hwConfig
		for _, bad := range []any{"invalid", map[string]any{"enabled": true, a: 5.5, b: 15.0}, map[string]any{"enabled": true, a: 4.0, b: 15.0}} {
			h.applyHardwareMonitoringConfig(bad)
			if h.hwConfig != before {
				t.Fatal("invalid config replaced valid config")
			}
		}
	}
}

func TestHardwareJitterAndFirstGate(t *testing.T) {
	last := time.Unix(1000, 0)
	for i := 0; i < 100; i++ {
		d := hardwareInterval(string(rune(i)), hwhealth.TierRAID, last, 10*time.Minute)
		if d < 9*time.Minute || d > 11*time.Minute {
			t.Fatal(d)
		}
	}
	h := newHardwareTestHeartbeat(t, hardwareTestSource{collect: func(context.Context) (hwhealth.Result, error) {
		return hwhealth.Result{Complete: true}, nil
	}})
	if h.hardwareTiersLocked(last, false) != nil {
		t.Fatal("ran before startup timer")
	}
	tiers := h.hardwareTiersLocked(last, true)
	if len(tiers) != 2 {
		t.Fatal(tiers)
	}
	if h.hardwareTiersLocked(last.Add(time.Hour), false) != nil {
		t.Fatal("running cycle queued")
	}
	h.hwRunning = false
	due := hardwareInterval(h.config.AgentID, hwhealth.TierRAID, last, h.hwConfig.PollInterval)
	if h.hardwareTiersLocked(last.Add(due), false) != nil {
		t.Fatal("changed strict dueForRun boundary")
	}
	if got := h.hardwareTiersLocked(last.Add(due+time.Nanosecond), false); len(got) != 1 || got[0] != hwhealth.TierRAID {
		t.Fatal(got)
	}
}

func TestHardwarePUTAndConflictNoRetry(t *testing.T) {
	for _, status := range []int{200, 409, 413, 422} {
		var calls atomic.Int32
		h := newHardwareTestHeartbeat(t, hardwareTestSource{collect: func(context.Context) (hwhealth.Result, error) {
			return hwhealth.Result{Complete: true}, nil
		}})
		h.client = &http.Client{Transport: hardwareTransport(func(r *http.Request) (*http.Response, error) {
			calls.Add(1)
			if r.Method != "PUT" || r.URL.Path != "/api/v1/agents/fixture-agent/hardware-health" {
				t.Error(r.Method, r.URL)
			}
			var s hwhealth.Snapshot
			if e := json.NewDecoder(r.Body).Decode(&s); e != nil {
				t.Error(e)
			}
			if s.AgentVersion != "fixture-version" || s.Sequence == 0 || s.SnapshotID == "" {
				t.Error(s)
			}
			return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"accepted":true}`))}, nil
		})}
		h.dispatchHardwareHealth([]hwhealth.Tier{hwhealth.TierRAID})
		h.inventoryWg.Wait()
		if calls.Load() != 1 {
			t.Fatal("unexpected retry", status, calls.Load())
		}
	}
}

func TestHardwareCancellationAndTracking(t *testing.T) {
	entered := make(chan struct{})
	h := newHardwareTestHeartbeat(t, hardwareTestSource{collect: func(ctx context.Context) (hwhealth.Result, error) {
		close(entered)
		<-ctx.Done()
		return hwhealth.Result{}, ctx.Err()
	}})
	h.dispatchHardwareHealth([]hwhealth.Tier{hwhealth.TierRAID})
	<-entered
	h.stopHardwareHealth()
	done := make(chan struct{})
	go func() { h.inventoryWg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("untracked or uncancelled cycle")
	}
	h.dispatchHardwareHealth([]hwhealth.Tier{hwhealth.TierRAID})
	h.inventoryWg.Wait()
}

func TestHardwareDisabledRetriesUntilAccepted(t *testing.T) {
	h := newHardwareTestHeartbeat(t, hardwareTestSource{collect: func(context.Context) (hwhealth.Result, error) {
		t.Fatal("disabled source executed")
		return hwhealth.Result{}, nil
	}})
	h.applyHardwareMonitoringConfig(map[string]any{"enabled": false, "poll_interval_minutes": 10.0, "disk_health_interval_minutes": 60.0})
	h.retryCfg.MaxRetries = 0
	calls := 0
	sequences := []uint64{}
	h.client = &http.Client{Transport: hardwareTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		var snap hwhealth.Snapshot
		if e := json.NewDecoder(r.Body).Decode(&snap); e != nil {
			t.Error(e)
		}
		sequences = append(sequences, snap.Sequence)
		status := 200
		if calls == 1 {
			status = 503
		}
		return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})}
	h.dispatchHardwareHealth([]hwhealth.Tier{})
	h.inventoryWg.Wait()
	if h.hwDisabledSnapshot == nil || h.hwDisabledQueued {
		t.Fatal("disabled status lost")
	}
	h.dispatchHardwareHealth([]hwhealth.Tier{})
	h.inventoryWg.Wait()
	if h.hwDisabledSnapshot != nil || calls != 2 || sequences[0] != sequences[1] {
		t.Fatal("did not acknowledge the same status snapshot")
	}
}

func TestHardwareUploadCancellation(t *testing.T) {
	entered := make(chan struct{})
	h := newHardwareTestHeartbeat(t, hardwareTestSource{collect: func(context.Context) (hwhealth.Result, error) {
		return hwhealth.Result{Complete: true}, nil
	}})
	h.retryCfg.MaxRetries = 0
	h.client = &http.Client{Transport: hardwareTransport(func(r *http.Request) (*http.Response, error) {
		close(entered)
		<-r.Context().Done()
		return nil, r.Context().Err()
	})}
	h.dispatchHardwareHealth([]hwhealth.Tier{hwhealth.TierRAID})
	<-entered
	h.stopHardwareHealth()
	done := make(chan struct{})
	go func() { h.inventoryWg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("upload ignored shutdown")
	}
}

func TestHardwareStartupTimerWiring(t *testing.T) {
	if hardwareFirstRunDelay != 60*time.Second {
		t.Fatal("first run must be 60 seconds")
	}
	body, e := os.ReadFile("heartbeat.go")
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(body), "func (h *Heartbeat) Start() {\n\th.startHardwareHealth()") {
		t.Fatal("startup dispatch is not wired before heartbeat jitter")
	}
	h := newHardwareTestHeartbeat(t, hardwareTestSource{collect: func(context.Context) (hwhealth.Result, error) {
		t.Fatal("timer fired before 60 seconds")
		return hwhealth.Result{}, nil
	}})
	h.startHardwareHealth()
	h.stopHardwareHealth()
	done := make(chan struct{})
	go func() { h.inventoryWg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("startup timer not tracked/cancelled")
	}
}
