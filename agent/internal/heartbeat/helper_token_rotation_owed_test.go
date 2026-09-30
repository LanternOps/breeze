package heartbeat

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/spf13/viper"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/tunnel"
)

// seedLegacyHelperTokenInAgentYAML reproduces an older agent's agent.yaml (helper
// token inline) and runs the scrub a config write performs, which records that
// a rotation is owed.
func seedLegacyHelperTokenInAgentYAML(t *testing.T, cfgPath string) {
	t.Helper()
	f, err := os.OpenFile(cfgPath, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("open agent.yaml: %v", err)
	}
	if _, err := f.WriteString("helper_auth_token: brz_current_helper\n"); err != nil {
		t.Fatalf("append helper token: %v", err)
	}
	f.Close()
	if err := config.SetAndPersist("log_level", "info"); err != nil {
		t.Fatalf("SetAndPersist (scrub): %v", err)
	}
	if !config.HelperTokenRotationOwed() {
		t.Fatal("precondition: scrubbing a legacy helper token must record a rotation as owed")
	}
}

func TestOwedHelperTokenRotationScheduling(t *testing.T) {
	srv := newRotationServer(t)
	t0 := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)

	t.Run("nothing owed", func(t *testing.T) {
		h, _ := newRotationTestHeartbeat(t, srv.URL)
		if h.maybeStartOwedHelperTokenRotation(t0) {
			t.Fatal("started a rotation although none is owed")
		}
	})

	t.Run("first successful beat starts it, then bounded backoff", func(t *testing.T) {
		h, cfgPath := newRotationTestHeartbeat(t, srv.URL)
		seedLegacyHelperTokenInAgentYAML(t, cfgPath)

		steps := []struct {
			at   time.Duration
			want bool
		}{
			{0, true},                               // first attempt immediately
			{time.Minute, false},                    // inside the first backoff
			{owedRotationInitialBackoff, true},      // retry once it elapses
			{owedRotationInitialBackoff * 2, false}, // backoff doubled
			{owedRotationInitialBackoff * 3, true},
		}
		for _, s := range steps {
			if got := h.maybeStartOwedHelperTokenRotation(t0.Add(s.at)); got != s.want {
				t.Fatalf("at +%v: started = %v, want %v", s.at, got, s.want)
			}
		}
	})

	t.Run("backoff is capped", func(t *testing.T) {
		h, cfgPath := newRotationTestHeartbeat(t, srv.URL)
		seedLegacyHelperTokenInAgentYAML(t, cfgPath)
		now := t0
		for i := 0; i < 20; i++ {
			if !h.maybeStartOwedHelperTokenRotation(now) {
				t.Fatalf("attempt %d at %v did not start", i, now)
			}
			now = now.Add(owedRotationMaxBackoff)
		}
	})

	t.Run("busy or staged rotation defers without consuming the attempt", func(t *testing.T) {
		h, cfgPath := newRotationTestHeartbeat(t, srv.URL)
		seedLegacyHelperTokenInAgentYAML(t, cfgPath)

		h.tokenRotating.Store(true)
		if h.maybeStartOwedHelperTokenRotation(t0) {
			t.Fatal("started while another rotation holds the rotation slot")
		}
		h.tokenRotating.Store(false)

		h.pendingRotationOnDisk.Store(true)
		if h.maybeStartOwedHelperTokenRotation(t0) {
			t.Fatal("started while a staged rotation is still being confirmed")
		}
		h.pendingRotationOnDisk.Store(false)

		if !h.maybeStartOwedHelperTokenRotation(t0) {
			t.Fatal("a deferred attempt must still be available immediately afterwards")
		}
	})
}

// End to end: the owed rotation runs through the normal two-phase rotation,
// the helper token that sat in agent.yaml is replaced, and the debt is settled
// so no further rotations are started.
func TestOwedHelperTokenRotationRetiresLegacyToken(t *testing.T) {
	srv := newRotationServer(t)
	h, cfgPath := newRotationTestHeartbeat(t, srv.URL)
	seedLegacyHelperTokenInAgentYAML(t, cfgPath)
	t0 := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)

	if !h.maybeStartOwedHelperTokenRotation(t0) {
		t.Fatal("owed rotation not started")
	}
	h.handleTokenRotation()

	if rotate, confirm := srv.counts(); rotate != 1 || confirm != 1 {
		t.Fatalf("rotate=%d confirm=%d, want 1 and 1", rotate, confirm)
	}
	persisted, err := config.ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials: %v", err)
	}
	if persisted.HelperAuthToken != "brz_staged_helper" {
		t.Fatalf("helper token = %q, want the rotated brz_staged_helper", persisted.HelperAuthToken)
	}
	if config.HelperTokenRotationOwed() {
		t.Fatal("rotation still recorded as owed after a promoted rotation")
	}
	if h.maybeStartOwedHelperTokenRotation(t0.Add(owedRotationMaxBackoff)) {
		t.Fatal("started another rotation after the debt was settled")
	}
}

// The trigger lives in processHeartbeatResponse: a successful heartbeat that
// did not itself ask for a rotation starts the owed one. A response that asks
// the agent to confirm a staged rotation must not start (or spend an attempt
// on) a second one; that promotion settles the debt by itself.
func TestHeartbeatResponseStartsOwedHelperTokenRotation(t *testing.T) {
	waitIdle := func(h *Heartbeat) {
		time.Sleep(100 * time.Millisecond) // let started goroutines claim the rotation slot
		for deadline := time.Now().Add(5 * time.Second); h.tokenRotating.Load() && time.Now().Before(deadline); {
			time.Sleep(10 * time.Millisecond)
		}
	}

	t.Run("plain successful heartbeat starts it", func(t *testing.T) {
		srv := newRotationServer(t)
		h, cfgPath := newRotationTestHeartbeat(t, srv.URL)
		h.tunnelMgr = &tunnel.Manager{} // processHeartbeatResponse updates its policy flag
		seedLegacyHelperTokenInAgentYAML(t, cfgPath)

		h.processHeartbeatResponse(&HeartbeatResponse{})
		for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
			if _, confirm := srv.counts(); confirm > 0 && !h.tokenRotating.Load() {
				break
			}
		}

		if rotate, _ := srv.counts(); rotate != 1 {
			t.Fatalf("rotate calls = %d, want 1", rotate)
		}
		if config.HelperTokenRotationOwed() {
			t.Fatal("rotation still owed after the heartbeat-started rotation promoted")
		}
	})

	t.Run("confirm-rotation response leaves the owed attempt unspent", func(t *testing.T) {
		srv := newRotationServer(t)
		h, cfgPath := newRotationTestHeartbeat(t, srv.URL)
		h.tunnelMgr = &tunnel.Manager{}
		seedLegacyHelperTokenInAgentYAML(t, cfgPath)

		h.processHeartbeatResponse(&HeartbeatResponse{ConfirmTokenRotation: true})
		waitIdle(h)

		if rotate, _ := srv.counts(); rotate != 0 {
			t.Fatalf("rotate calls = %d, want 0", rotate)
		}
		if !h.maybeStartOwedHelperTokenRotation(time.Now()) {
			t.Fatal("the confirm-rotation heartbeat consumed the owed rotation attempt")
		}
	})
}

// Upgrade path from an agent that kept the helper token in agent.yaml (Windows
// up to this release) to this one, step by step as a restarted agent runs it,
// with Breeze Assist taking its token over IPC the whole time. The property
// that keeps Assist working: the token the agent holds for IPC delivery is, at
// every step, one the server accepts — the pre-upgrade token until the server
// promotes the rotated set, the rotated token from then on — and agent.yaml
// never carries a helper token again after the first scrub.
func TestUpgradeFromAgentYAMLHelperTokenKeepsAssistTokenValid(t *testing.T) {
	var (
		mu            sync.Mutex
		ipcAtConfirm  []string
		h             *Heartbeat
		rotateCalls   int
		confirmCalls  int
		stagedHelper  = "brz_staged_helper"
		currentHelper = "brz_current_helper"
	)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agents/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case pathHasSuffix(r.URL.Path, "/rotate-token/confirm"):
			mu.Lock()
			confirmCalls++
			// Phase two has not completed yet: the server still treats the
			// pre-upgrade set as current, so that is what Assist must hold.
			ipcAtConfirm = append(ipcAtConfirm, h.currentHelperToken())
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"confirmed": true})
		case pathHasSuffix(r.URL.Path, "/rotate-token"):
			mu.Lock()
			rotateCalls++
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"authToken":            "brz_staged_agent",
				"watchdogAuthToken":    "brz_staged_watchdog",
				"helperAuthToken":      stagedHelper,
				"rotatedAt":            "2026-09-30T00:00:00Z",
				"confirmationRequired": true,
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	// 1. On disk as the previous release left it: helper token in agent.yaml
	//    as well as in secrets.yaml.
	_, cfgPath := newRotationTestHeartbeat(t, srv.URL)
	f, err := os.OpenFile(cfgPath, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("open agent.yaml: %v", err)
	}
	if _, err := f.WriteString("helper_auth_token: " + currentHelper + "\n"); err != nil {
		t.Fatalf("append helper token: %v", err)
	}
	f.Close()
	agentYAMLHasHelperToken := func(step string) bool {
		t.Helper()
		data, err := os.ReadFile(cfgPath)
		if err != nil {
			t.Fatalf("%s: read agent.yaml: %v", step, err)
		}
		return strings.Contains(string(data), "helper_auth_token")
	}
	if !agentYAMLHasHelperToken("seed") {
		t.Fatal("precondition: seeded agent.yaml must carry the helper token")
	}

	// 2. The upgraded agent starts: Load, then the startup scrub (the same
	//    migration FixConfigPermissions and every persisted write run).
	viper.Reset()
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.HelperAuthToken != currentHelper {
		t.Fatalf("loaded helper token = %q, want %q (Assist would get nothing over IPC)", cfg.HelperAuthToken, currentHelper)
	}
	if err := config.SetAndPersist("log_level", "info"); err != nil {
		t.Fatalf("SetAndPersist (scrub): %v", err)
	}
	if agentYAMLHasHelperToken("after scrub") {
		t.Fatal("agent.yaml still carries the helper token after the startup scrub")
	}
	if !config.HelperTokenRotationOwed() {
		t.Fatal("the scrub did not record the owed rotation")
	}
	persisted, err := config.ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials: %v", err)
	}
	if persisted.HelperAuthToken != currentHelper {
		t.Fatalf("secrets.yaml helper token = %q after scrub, want %q", persisted.HelperAuthToken, currentHelper)
	}

	// 3. Heartbeat comes up and retains the token it delivers to Assist.
	h = &Heartbeat{
		config:      cfg,
		secureToken: secmem.NewSecureString("brz_current_agent"),
		client:      &http.Client{},
		tunnelMgr:   &tunnel.Manager{},
	}
	h.setHelperToken(cfg.HelperAuthToken)
	if got := h.currentHelperToken(); got != currentHelper {
		t.Fatalf("IPC token before rotation = %q, want %q", got, currentHelper)
	}

	// A later unrelated config write must not bring the token back.
	if err := config.SetAndPersist("log_level", "debug"); err != nil {
		t.Fatalf("SetAndPersist: %v", err)
	}
	if agentYAMLHasHelperToken("after a later write") {
		t.Fatal("a persisted write put the helper token back in agent.yaml")
	}

	// 4. First successful heartbeat starts the owed two-phase rotation.
	h.processHeartbeatResponse(&HeartbeatResponse{})
	// Wait on the outcome, not a fixed sleep: the rotation runs in a goroutine.
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		mu.Lock()
		done := confirmCalls > 0
		mu.Unlock()
		if done && !h.tokenRotating.Load() {
			break
		}
	}

	mu.Lock()
	gotRotate, gotConfirm, gotAtConfirm := rotateCalls, confirmCalls, append([]string(nil), ipcAtConfirm...)
	mu.Unlock()
	if gotRotate != 1 || gotConfirm != 1 {
		t.Fatalf("rotate=%d confirm=%d, want exactly one two-phase rotation", gotRotate, gotConfirm)
	}
	if len(gotAtConfirm) != 1 || gotAtConfirm[0] != currentHelper {
		t.Fatalf("IPC token while the rotation was staged = %v, want [%s]: Assist must not get a token the server has not promoted", gotAtConfirm, currentHelper)
	}

	// 5. After promotion: Assist gets the rotated token, the debt is settled,
	//    and agent.yaml is still clean.
	if got := h.currentHelperToken(); got != stagedHelper {
		t.Fatalf("IPC token after promotion = %q, want %q", got, stagedHelper)
	}
	persisted, err = config.ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials: %v", err)
	}
	if persisted.HelperAuthToken != stagedHelper {
		t.Fatalf("secrets.yaml helper token = %q after promotion, want %q", persisted.HelperAuthToken, stagedHelper)
	}
	if config.HelperTokenRotationOwed() {
		t.Fatal("rotation still owed after the promoted rotation")
	}
	if agentYAMLHasHelperToken("after rotation") {
		t.Fatal("the rotation wrote the helper token into agent.yaml")
	}
	// Unix keeps the group-scoped helper token file in step (the Assist
	// on-disk fallback there); on Windows no user-readable file carries it.
	hc, err := config.LoadHelperConfig(cfgPath)
	if err != nil {
		t.Fatalf("LoadHelperConfig: %v", err)
	}
	wantFile := stagedHelper
	if runtime.GOOS == "windows" {
		wantFile = ""
	}
	if hc.HelperAuthToken != wantFile {
		t.Fatalf("user-readable helper token = %q, want %q", hc.HelperAuthToken, wantFile)
	}

	// 6. No further rotation once the debt is settled — even with the retry
	//    backoff out of the way, so only the cleared debt can hold it back.
	h.owedRotationMu.Lock()
	h.owedRotationNextAttempt = time.Time{}
	h.owedRotationMu.Unlock()
	h.processHeartbeatResponse(&HeartbeatResponse{})
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if rotateCalls != 1 {
		t.Fatalf("rotate calls = %d after the debt was settled, want 1", rotateCalls)
	}
}
