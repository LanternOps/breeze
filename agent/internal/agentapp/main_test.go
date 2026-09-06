package agentapp

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/spf13/viper"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/pamlifetime"
	"github.com/breeze-rmm/agent/pkg/api"
)

type recordingPamStartup struct {
	order       []string
	hadDeadline bool
}

func (s *recordingPamStartup) SetStatePath(path string) {
	s.order = append(s.order, "ledger:"+filepath.Base(path))
}
func (s *recordingPamStartup) ReconcilePAMLifetime(ctx context.Context) []pamlifetime.Result {
	s.order = append(s.order, "reconcile")
	_, s.hadDeadline = ctx.Deadline()
	return nil
}

func TestPreparePAMLifetimeStartupAttachesLedgerBeforeReconcile(t *testing.T) {
	startup := &recordingPamStartup{}
	preparePAMLifetimeStartup(context.Background(), startup, filepath.Join(t.TempDir(), "agent.state"))
	if got, want := strings.Join(startup.order, ","), "ledger:agent.state,reconcile"; got != want {
		t.Fatalf("startup order = %q, want %q", got, want)
	}
	if !startup.hadDeadline {
		t.Fatal("startup reconciliation context had no finite deadline")
	}
}

func TestProcessStartupFieldsContainRoleEvidenceOnly(t *testing.T) {
	startup := ProcessStartup{
		Binary:             "breeze-agent.exe",
		ExecutablePath:     `C:\Program Files\Breeze\breeze-agent.exe`,
		PID:                42,
		ParentPID:          4,
		WindowsSessionID:   7,
		LaunchMode:         "user-helper",
		HelperRole:         "user",
		LifecycleKey:       "7-user",
		MainBinaryFallback: true,
		Version:            "0.70.0",
		CreatedAt:          time.Unix(100, 0),
	}
	fields := processStartupFields(startup)
	for _, key := range []string{"pid", "parentPid", "windowsSessionId", "launchMode", "helperRole", "lifecycleKey", "mainBinaryFallback"} {
		if _, ok := fields[key]; !ok {
			t.Fatalf("missing field %q", key)
		}
	}
	for _, forbidden := range []string{"authToken", "helperAuthToken", "mtlsKey"} {
		if _, ok := fields[forbidden]; ok {
			t.Fatalf("forbidden field %q", forbidden)
		}
	}
}

func TestLogProcessStartupEmitsOneStructuredEvent(t *testing.T) {
	var output bytes.Buffer
	logging.Init("json", "info", &output)
	t.Cleanup(func() { logging.Init("text", "info", nil) })

	startup := ProcessStartup{
		Binary:             "breeze-agent.exe",
		ExecutablePath:     `C:\Program Files\Breeze\breeze-agent.exe`,
		PID:                42,
		ParentPID:          4,
		WindowsSessionID:   7,
		LaunchMode:         "user-helper",
		HelperRole:         "user",
		LifecycleKey:       "7-user",
		MainBinaryFallback: true,
		Version:            "0.70.0",
		CreatedAt:          time.Unix(100, 0),
	}
	logProcessStartup(startup)

	got := output.String()
	if count := strings.Count(got, `"msg":"process startup"`); count != 1 {
		t.Fatalf("process startup event count = %d, want 1; log=%s", count, got)
	}
	for _, evidence := range []string{
		`"windowsSessionId":7`,
		`"launchMode":"user-helper"`,
		`"helperRole":"user"`,
		`"lifecycleKey":"7-user"`,
		`"mainBinaryFallback":true`,
	} {
		if !strings.Contains(got, evidence) {
			t.Fatalf("process startup log missing %s: %s", evidence, got)
		}
	}
	for _, forbidden := range []string{"authToken", "helperAuthToken", "mtlsKey"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("process startup log contains forbidden field %q: %s", forbidden, got)
		}
	}
}

func TestCachedMainProcessStartupUsesGuardRecord(t *testing.T) {
	mainProcessStartupCache.Lock()
	original := mainProcessStartupCache.startup
	mainProcessStartupCache.startup = ProcessStartup{}
	mainProcessStartupCache.Unlock()
	t.Cleanup(func() {
		mainProcessStartupCache.Lock()
		mainProcessStartupCache.startup = original
		mainProcessStartupCache.Unlock()
	})

	want := ProcessStartup{
		Binary:           "breeze-agent.exe",
		ExecutablePath:   `C:\Program Files\Breeze\breeze-agent.exe`,
		PID:              42,
		ParentPID:        4,
		WindowsSessionID: 7,
		LaunchMode:       "service-run",
		Version:          "0.70.0",
		CreatedAt:        time.Unix(100, 0),
	}
	cacheMainProcessStartup(want)
	if got := cachedMainProcessStartup(); got != want {
		t.Fatalf("cachedMainProcessStartup() = %+v, want %+v", got, want)
	}
}

func TestRunAgentDuplicateStopsBeforeInitialization(t *testing.T) {
	testRunAgentGuardFailureStopsBeforeInitialization(t, ErrMainAgentAlreadyRunning, exitAlreadyRunning)
}

func TestRunAgentSecurityFailureStopsBeforeInitialization(t *testing.T) {
	testRunAgentGuardFailureStopsBeforeInitialization(t, errors.New("lock ACL verification failed"), exitInstanceGuardError)
}

func testRunAgentGuardFailureStopsBeforeInitialization(t *testing.T, guardErr error, wantExit int) {
	t.Helper()

	origAcquire := acquireMainAgentGuardFn
	origExit := mainAgentExitFn
	origMarker := writeInstanceGuardMarkerFn
	origWriteEvent := writeInstanceGuardEventFn
	origReconcile := reconcileServiceUnitIfNeededFn
	origStart := startAgentFn
	t.Cleanup(func() {
		acquireMainAgentGuardFn = origAcquire
		mainAgentExitFn = origExit
		writeInstanceGuardMarkerFn = origMarker
		writeInstanceGuardEventFn = origWriteEvent
		reconcileServiceUnitIfNeededFn = origReconcile
		startAgentFn = origStart
	})

	reconciled, started, markerWritten, exitCode := false, false, false, 0
	acquireMainAgentGuardFn = func(ProcessStartup) (mainAgentGuard, error) {
		return nil, guardErr
	}
	writeInstanceGuardMarkerFn = writeInstanceGuardMarker
	writeInstanceGuardEventFn = func(source, message string) error {
		markerWritten = true
		if source != "BreezeAgent" || !strings.Contains(message, guardErr.Error()) {
			t.Errorf("marker = source:%q message:%q", source, message)
		}
		return nil
	}
	mainAgentExitFn = func(code int) { exitCode = code }
	reconcileServiceUnitIfNeededFn = func() { reconciled = true }
	startAgentFn = func(*config.Config) (*agentComponents, error) {
		started = true
		return nil, nil
	}

	runAgent()

	if exitCode != wantExit || reconciled || started || !markerWritten {
		t.Fatalf("exit=%d, want=%d reconciled=%v started=%v marker=%v", exitCode, wantExit, reconciled, started, markerWritten)
	}
}

// TestTrimEnrollInputs verifies that the template-MSI space-padded sentinel
// format is stripped before the values reach url.Parse / HTTP request
// construction. Regression test for the v0.62.22 → v0.62.23 hotfix where the
// direct-exe enrollment CA introduced in #410 dropped the .Trim() calls that
// the old enroll-agent.ps1 wrapper used to do. Without trimming, a byte-
// patched template MSI would pass a 512-char right-padded server URL to the
// agent and url.Parse would reject it with "invalid character \" \" in host
// name".
func TestTrimEnrollInputs(t *testing.T) {
	t.Parallel()

	// Mirrors the padding size used by installer/build-msi.ps1 when -Template
	// is set. Keep in sync if that padding width changes.
	const templatePadWidth = 512

	pad := func(s string) string {
		if len(s) >= templatePadWidth {
			return s
		}
		return s + strings.Repeat(" ", templatePadWidth-len(s))
	}

	tests := []struct {
		name                            string
		inKey, inServer, inSecret       string
		wantKey, wantServer, wantSecret string
	}{
		{
			name:       "all clean",
			inKey:      "brz_abc123",
			inServer:   "https://app.example.com",
			inSecret:   "secret456",
			wantKey:    "brz_abc123",
			wantServer: "https://app.example.com",
			wantSecret: "secret456",
		},
		{
			name:       "empty inputs",
			inKey:      "",
			inServer:   "",
			inSecret:   "",
			wantKey:    "",
			wantServer: "",
			wantSecret: "",
		},
		{
			name:       "whitespace-only inputs collapse to empty",
			inKey:      "   ",
			inServer:   "\t\t",
			inSecret:   " \r\n ",
			wantKey:    "",
			wantServer: "",
			wantSecret: "",
		},
		{
			name:       "trailing space only",
			inKey:      "brz_abc123 ",
			inServer:   "https://app.example.com   ",
			inSecret:   "secret456\n",
			wantKey:    "brz_abc123",
			wantServer: "https://app.example.com",
			wantSecret: "secret456",
		},
		{
			name:       "leading whitespace only",
			inKey:      "  brz_abc123",
			inServer:   "\thttps://app.example.com",
			inSecret:   " secret456",
			wantKey:    "brz_abc123",
			wantServer: "https://app.example.com",
			wantSecret: "secret456",
		},
		{
			name:       "template MSI 512-char space padding (the regression)",
			inKey:      pad("enroll_b9297caef01ceb804a59af044f5f02aa08605178a06c1833"),
			inServer:   pad("https://us.2breeze.app"),
			inSecret:   pad("41d9a8a62f54c28e12b1055dec82173fd7e073c4c7f2314442da7abbc2c5e68d"),
			wantKey:    "enroll_b9297caef01ceb804a59af044f5f02aa08605178a06c1833",
			wantServer: "https://us.2breeze.app",
			wantSecret: "41d9a8a62f54c28e12b1055dec82173fd7e073c4c7f2314442da7abbc2c5e68d",
		},
		{
			name:       "optional secret left empty after padding trim",
			inKey:      pad("brz_abc123"),
			inServer:   pad("https://app.example.com"),
			inSecret:   strings.Repeat(" ", templatePadWidth),
			wantKey:    "brz_abc123",
			wantServer: "https://app.example.com",
			wantSecret: "",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			gotKey, gotServer, gotSecret := trimEnrollInputs(tc.inKey, tc.inServer, tc.inSecret)
			if gotKey != tc.wantKey {
				t.Errorf("key: got %q, want %q", gotKey, tc.wantKey)
			}
			if gotServer != tc.wantServer {
				t.Errorf("server: got %q, want %q", gotServer, tc.wantServer)
			}
			if gotSecret != tc.wantSecret {
				t.Errorf("secret: got %q, want %q", gotSecret, tc.wantSecret)
			}
		})
	}
}

func TestResolveBackupServerURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		enrollSeed    string
		bootstrapSeed string
		primaryURL    string
		want          string
		wantErr       bool
	}{
		{
			name:          "enroll wins over bootstrap",
			enrollSeed:    "https://enroll.example.com",
			bootstrapSeed: "https://bootstrap.example.com",
			primaryURL:    "https://primary.example.com",
			want:          "https://enroll.example.com",
		},
		{
			name:          "bootstrap fallback",
			bootstrapSeed: "https://bootstrap.example.com",
			primaryURL:    "https://primary.example.com",
			want:          "https://bootstrap.example.com",
		},
		{
			name:       "both empty",
			primaryURL: "https://primary.example.com",
		},
		{
			name:       "equal to primary skipped",
			enrollSeed: "https://primary.example.com",
			primaryURL: "https://primary.example.com",
		},
		{
			name:       "invalid http non-localhost skipped",
			enrollSeed: "http://backup.example.com",
			primaryURL: "https://primary.example.com",
			wantErr:    true,
		},
		{
			name:       "valid https accepted",
			enrollSeed: "https://backup.example.com",
			primaryURL: "https://primary.example.com",
			want:       "https://backup.example.com",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got, err := resolveBackupServerURL(tc.enrollSeed, tc.bootstrapSeed, tc.primaryURL)
			if got != tc.want {
				t.Errorf("resolveBackupServerURL(%q, %q, %q) = %q, want %q", tc.enrollSeed, tc.bootstrapSeed, tc.primaryURL, got, tc.want)
			}
			if (err != nil) != tc.wantErr {
				t.Errorf("resolveBackupServerURL(%q, %q, %q) err = %v, wantErr %v", tc.enrollSeed, tc.bootstrapSeed, tc.primaryURL, err, tc.wantErr)
			}
		})
	}
}

// TestApplyEnrollResponseIdentityCopiesDeviceID is the regression test for
// the DeviceID enrollment-plumbing gap (security remediation Wave 5 Task 5
// follow-up): the enrollment route has always returned deviceId, but nothing
// copied EnrollResponse.DeviceID into the persisted config, leaving the
// expired-certificate mTLS renewal recovery proof inert end-to-end despite
// every other piece (signing, canonicalization, wire format) being
// implemented and tested. This pins that applyEnrollResponseIdentity copies
// every identity/credential field the enrollment response carries —
// including DeviceID — alongside a full SaveTo+Load round trip, so a
// regression here would be caught even if a future change stopped short of
// actually persisting the field.
func TestApplyEnrollResponseIdentityCopiesDeviceID(t *testing.T) {
	// Deliberately not t.Parallel(): the subtests below call config.SaveTo /
	// config.Load, which read and write the config package's global viper
	// singleton (Load has no lock at all — only Save/SaveTo serialize via
	// persistMu — and Set() values persist in viper's override layer across
	// ReadInConfig calls until Reset()). Running them concurrently with each
	// other would race that shared state; no other test in this package
	// currently touches config.Load/SaveTo from a t.Parallel() subtest, so
	// this doesn't collide with anything else either.
	tests := []struct {
		name       string
		enrollResp *api.EnrollResponse
		wantCfg    config.Config
	}{
		{
			name: "full identity including DeviceID",
			enrollResp: &api.EnrollResponse{
				AgentID:           "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776",
				DeviceID:          "550e8400-e29b-41d4-a716-446655440000",
				AuthToken:         "brz_auth",
				WatchdogAuthToken: "brz_watchdog",
				HelperAuthToken:   "brz_helper",
				OrgID:             "org-1",
				SiteID:            "site-1",
			},
			wantCfg: config.Config{
				AgentID:           "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776",
				DeviceID:          "550e8400-e29b-41d4-a716-446655440000",
				AuthToken:         "brz_auth",
				WatchdogAuthToken: "brz_watchdog",
				HelperAuthToken:   "brz_helper",
				OrgID:             "org-1",
				SiteID:            "site-1",
			},
		},
		{
			// A server predating the deviceId response field (or a response
			// that simply omits it) must not crash or leave a stale value —
			// json.Unmarshal already leaves DeviceID as the zero value, and
			// this must propagate through as empty, not panic or default to
			// something else. This is also the shape a rollout produces for
			// any request that lands on a not-yet-upgraded replica.
			name: "empty DeviceID propagates as empty, not left over from a stale cfg",
			enrollResp: &api.EnrollResponse{
				AgentID:   "6ba7b8109dad11d180b400c04fd430c86ba7b8109dad11d180b400c04fd430c",
				AuthToken: "brz_auth_2",
				OrgID:     "org-2",
				SiteID:    "site-2",
			},
			wantCfg: config.Config{
				AgentID:   "6ba7b8109dad11d180b400c04fd430c86ba7b8109dad11d180b400c04fd430c",
				DeviceID:  "",
				AuthToken: "brz_auth_2",
				OrgID:     "org-2",
				SiteID:    "site-2",
			},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			viper.Reset()
			t.Cleanup(viper.Reset)

			// Start from a config that already has a (stale, pre-re-enroll)
			// DeviceID set, proving the copy overwrites rather than only
			// filling in when empty.
			cfg := config.Default()
			cfg.DeviceID = "stale-device-id-from-before-re-enroll"

			applyEnrollResponseIdentity(cfg, tc.enrollResp)

			if cfg.AgentID != tc.wantCfg.AgentID {
				t.Errorf("AgentID = %q, want %q", cfg.AgentID, tc.wantCfg.AgentID)
			}
			if cfg.DeviceID != tc.wantCfg.DeviceID {
				t.Errorf("DeviceID = %q, want %q", cfg.DeviceID, tc.wantCfg.DeviceID)
			}
			if cfg.AuthToken != tc.wantCfg.AuthToken {
				t.Errorf("AuthToken = %q, want %q", cfg.AuthToken, tc.wantCfg.AuthToken)
			}
			if cfg.WatchdogAuthToken != tc.wantCfg.WatchdogAuthToken {
				t.Errorf("WatchdogAuthToken = %q, want %q", cfg.WatchdogAuthToken, tc.wantCfg.WatchdogAuthToken)
			}
			if cfg.HelperAuthToken != tc.wantCfg.HelperAuthToken {
				t.Errorf("HelperAuthToken = %q, want %q", cfg.HelperAuthToken, tc.wantCfg.HelperAuthToken)
			}
			if cfg.OrgID != tc.wantCfg.OrgID {
				t.Errorf("OrgID = %q, want %q", cfg.OrgID, tc.wantCfg.OrgID)
			}
			if cfg.SiteID != tc.wantCfg.SiteID {
				t.Errorf("SiteID = %q, want %q", cfg.SiteID, tc.wantCfg.SiteID)
			}

			// End-to-end: prove DeviceID actually survives a durable
			// SaveTo -> Load round trip, not just the in-memory struct copy —
			// this is what makes it available to a LATER process (the
			// heartbeat's mTLS renewal driver) rather than just this one.
			dir := t.TempDir()
			cfgPath := filepath.Join(dir, "agent.yaml")
			if err := config.SaveTo(cfg, cfgPath); err != nil {
				t.Fatalf("SaveTo: %v", err)
			}
			loaded, err := config.Load(cfgPath)
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if loaded.DeviceID != tc.wantCfg.DeviceID {
				t.Errorf("persisted DeviceID = %q, want %q", loaded.DeviceID, tc.wantCfg.DeviceID)
			}
		})
	}
}

// writeEnrolledConfig writes a minimal agent.yaml + secrets.yaml pair
// that config.Load will parse into a config with both AgentID and
// AuthToken set (IsEnrolled returns true).
func writeEnrolledConfig(t *testing.T, dir string) string {
	t.Helper()
	agentPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(agentPath, []byte("agent_id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\nserver_url: https://test.example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	secretsPath := filepath.Join(dir, "secrets.yaml")
	if err := os.WriteFile(secretsPath, []byte("auth_token: test-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return agentPath
}

// writeTornConfig writes only agent.yaml (with AgentID) but no secrets
// file, simulating the race window where SaveTo has flushed agent.yaml
// but not yet written secrets.yaml.
func writeTornConfig(t *testing.T, dir string) string {
	t.Helper()
	agentPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(agentPath, []byte("agent_id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\nserver_url: https://test.example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return agentPath
}

func TestWaitForEnrollment_UnblocksWhenConfigBecomesValid(t *testing.T) {
	origInterval := waitForEnrollmentPollInterval
	waitForEnrollmentPollInterval = 10 * time.Millisecond
	t.Cleanup(func() { waitForEnrollmentPollInterval = origInterval })

	dir := t.TempDir()
	agentPath := filepath.Join(dir, "agent.yaml")

	// Start with no config file at all.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	done := make(chan *config.Config, 1)
	go func() {
		done <- waitForEnrollment(ctx, agentPath)
	}()

	// Write a valid enrolled config after 50ms.
	time.Sleep(50 * time.Millisecond)
	_ = writeEnrolledConfig(t, dir)

	select {
	case cfg := <-done:
		if cfg == nil {
			t.Fatal("waitForEnrollment returned nil; expected enrolled config")
		}
		if cfg.AgentID != "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" {
			t.Errorf("AgentID = %q, want aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", cfg.AgentID)
		}
	case <-time.After(1500 * time.Millisecond):
		t.Fatal("waitForEnrollment did not return within 1.5s")
	}
}

func TestWaitForEnrollment_RespectsContextCancel(t *testing.T) {
	origInterval := waitForEnrollmentPollInterval
	waitForEnrollmentPollInterval = 10 * time.Millisecond
	t.Cleanup(func() { waitForEnrollmentPollInterval = origInterval })

	dir := t.TempDir()
	agentPath := filepath.Join(dir, "does-not-exist.yaml")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan *config.Config, 1)
	go func() {
		done <- waitForEnrollment(ctx, agentPath)
	}()

	// Cancel after 30ms — waitForEnrollment should return nil within
	// another 30ms (next ticker fire).
	time.Sleep(30 * time.Millisecond)
	cancel()

	select {
	case cfg := <-done:
		if cfg != nil {
			t.Errorf("expected nil on ctx cancel, got %+v", cfg)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("waitForEnrollment did not return within 500ms of cancel")
	}
}

func TestWaitForEnrollment_IgnoresTornWrite(t *testing.T) {
	origInterval := waitForEnrollmentPollInterval
	waitForEnrollmentPollInterval = 10 * time.Millisecond
	t.Cleanup(func() { waitForEnrollmentPollInterval = origInterval })

	dir := t.TempDir()
	// Write only agent.yaml — no secrets file (torn SaveTo state).
	agentPath := writeTornConfig(t, dir)

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	done := make(chan *config.Config, 1)
	go func() {
		done <- waitForEnrollment(ctx, agentPath)
	}()

	// Verify it stays blocked for 100ms (IsEnrolled returns false on torn state).
	time.Sleep(100 * time.Millisecond)
	select {
	case cfg := <-done:
		t.Fatalf("waitForEnrollment returned %+v on torn write; must stay blocked until secrets.yaml lands", cfg)
	default:
	}

	// Now write secrets.yaml — waitForEnrollment should unblock on the next tick.
	secretsPath := filepath.Join(dir, "secrets.yaml")
	if err := os.WriteFile(secretsPath, []byte("auth_token: test-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	select {
	case cfg := <-done:
		if cfg == nil {
			t.Fatal("expected enrolled config, got nil")
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("waitForEnrollment did not unblock after secrets.yaml was written")
	}
}

// TestUserHelperRoleDefault locks in the cobra default for `breeze-agent
// user-helper --role`. The Windows AgentUserHelper Scheduled Task invokes
// `breeze-agent user-helper` (historically with no flags) under
// BUILTIN\Users at LeastPrivilege, so the default must be "user". The
// previous "system" default caused the helper to claim HelperRoleSystem,
// which the sessionbroker correctly rejected with "system role requires
// SYSTEM identity", crash-looping every Windows customer on 0.63.x/0.64.x.
// The legitimate desktop-capture path uses the separate `desktop-helper`
// cobra command. On Unix/macOS it must not claim system role unless it is
// actually running as UID 0.
func TestUserHelperRoleDefault(t *testing.T) {
	roleFlag := userHelperCmd.Flags().Lookup("role")
	if roleFlag == nil {
		t.Fatal("role flag not registered on userHelperCmd")
	}
	if roleFlag.DefValue != "user" {
		t.Errorf("user-helper --role default = %q, want %q (system role requires SYSTEM identity; user-mode helpers must default to user)", roleFlag.DefValue, "user")
	}
}

func TestDesktopHelperRoleDoesNotClaimSystemOnDarwin(t *testing.T) {
	got := desktopHelperRole()
	if runtime.GOOS == "darwin" {
		if got != "user" {
			t.Fatalf("desktopHelperRole() = %q on darwin, want user", got)
		}
		return
	}
	if got != "system" {
		t.Fatalf("desktopHelperRole() = %q on %s, want system", got, runtime.GOOS)
	}
}

// TestAssertHostnameNonEmpty guards the #439 contract at the enroll
// boundary: enrollment must refuse to proceed with an empty or
// whitespace-only hostname. This is the last line of defense against a
// regression in the collectors fallback chain or a new code path that
// bypasses it — the message string and the os.Exit flow both live in
// enrollDevice, so this test pins the pure predicate. A failure here
// would mean the predicate itself drifted; a review of enrollDevice
// would still be required to confirm the call site still fires.
func TestAssertHostnameNonEmpty(t *testing.T) {
	tests := []struct {
		name    string
		info    *collectors.SystemInfo
		wantErr bool
	}{
		{"nil info", nil, true},
		{"empty hostname", &collectors.SystemInfo{Hostname: ""}, true},
		{"whitespace only", &collectors.SystemInfo{Hostname: "  \n\t"}, true},
		{"single space", &collectors.SystemInfo{Hostname: " "}, true},
		{"valid hostname", &collectors.SystemInfo{Hostname: "desktop-01"}, false},
		{"leading/trailing whitespace around valid name", &collectors.SystemInfo{Hostname: "  desktop-02  "}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := assertHostnameNonEmpty(tc.info)
			if (err != nil) != tc.wantErr {
				t.Fatalf("got err=%v, wantErr=%v", err, tc.wantErr)
			}
		})
	}
}

// TestLogPAMActuatorStrategy verifies the startup PAM-strategy log: known
// strategies (and the empty/default case) log at INFO, and an unrecognized
// non-empty value logs a WARN calling out the fallback to sendinput, so a
// typo like "token-launch" is visible in agent logs instead of silently
// falling back (the VM validation doc requires confirming from logs which
// strategy is active).
func TestLogPAMActuatorStrategy(t *testing.T) {
	tests := []struct {
		name       string
		configured string
		wantLevel  string
	}{
		{"sendinput is INFO", "sendinput", "INFO"},
		{"token_launch is INFO", "token_launch", "INFO"},
		{"empty defaults to INFO", "", "INFO"},
		{"unrecognized value is WARN", "token-launch", "WARN"},
		{"garbage value is WARN", "not-a-strategy", "WARN"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			l := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo}))

			logPAMActuatorStrategy(l, tc.configured)

			out := buf.String()
			if !strings.Contains(out, "level="+tc.wantLevel) {
				t.Fatalf("configured=%q: got log %q, want level=%s", tc.configured, out, tc.wantLevel)
			}
			if tc.wantLevel == "WARN" && !strings.Contains(out, tc.configured) {
				t.Fatalf("configured=%q: WARN log %q should mention the bad configured value", tc.configured, out)
			}
		})
	}
}

// TestInitBootstrapLoggingUnsafeLogPathDisablesFileOutputOnly proves the
// P1-AGENT-LOG-001 contract at the agentapp boundary: when the configured
// log path is a symlink (logging.NewRotatingWriter returns
// *logging.ErrUnsafeLogPath), initBootstrapLogging must disable file
// logging only — the system/stderr logger must remain fully usable — and
// must never write, truncate, chmod, or rename through the symlink.
func TestInitBootstrapLoggingUnsafeLogPathDisablesFileOutputOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink-based log path rejection is Unix-specific; Windows retains pre-existing os.OpenFile behavior")
	}

	dir := t.TempDir()
	target := filepath.Join(dir, "outside-target")
	const sentinel = "SENTINEL-DO-NOT-TOUCH"
	if err := os.WriteFile(target, []byte(sentinel), 0600); err != nil {
		t.Fatalf("write attack target: %v", err)
	}
	logFile := filepath.Join(dir, "agent.log")
	if err := os.Symlink(target, logFile); err != nil {
		t.Fatalf("symlink log file: %v", err)
	}

	cfg := &config.Config{
		LogFile:       logFile,
		LogFormat:     "text",
		LogLevel:      "info",
		LogMaxSizeMB:  1,
		LogMaxBackups: 1,
	}

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	origStderr := os.Stderr
	os.Stderr = w
	t.Cleanup(func() {
		os.Stderr = origStderr
		logging.Init("text", "info", nil)
	})

	initBootstrapLogging(cfg)

	// The system/stderr logger must still work after file logging was
	// disabled — losing all logging is a worse failure than losing file
	// logging.
	log.Warn("probe-message-after-unsafe-log-path")

	_ = w.Close()
	os.Stderr = origStderr
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, r); err != nil {
		t.Fatalf("read captured stderr: %v", err)
	}
	captured := buf.String()

	if !strings.Contains(captured, "probe-message-after-unsafe-log-path") {
		t.Fatalf("expected stderr logger to remain usable after an unsafe log path, got: %s", captured)
	}
	if !strings.Contains(captured, "log file unavailable during bootstrap") {
		t.Fatalf("expected a bootstrap fallback warning in stderr output, got: %s", captured)
	}
	if !strings.Contains(captured, "symlink") {
		t.Fatalf("expected the fallback warning to call out the symlink condition, got: %s", captured)
	}

	// Zero bytes must have reached the symlink target, and the log path
	// itself must never have been renamed, truncated, or replaced.
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read attack target: %v", err)
	}
	if string(got) != sentinel {
		t.Fatalf("symlink target was modified: got %q, want %q", got, sentinel)
	}
	info, err := os.Lstat(logFile)
	if err != nil {
		t.Fatalf("lstat log file: %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("expected log path to remain a symlink (never renamed away), got mode %v", info.Mode())
	}
}

// withUninstallNotifyConfig points cfgFile at a temp agent.yaml (+
// secrets.yaml, written by config.SaveTo) built from cfg, and restores the
// package globals runUninstallNotify reads on cleanup.
func withUninstallNotifyConfig(t *testing.T, cfg *config.Config) {
	t.Helper()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	if err := config.SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	origCfg, origQuiet := cfgFile, quietEnroll
	t.Cleanup(func() { cfgFile, quietEnroll = origCfg, origQuiet })
	cfgFile, quietEnroll = cfgPath, true
}

// TestRunUninstallNotify_NoConfig_NoOp asserts the "missing secrets.yaml"
// case from the Task 6 self-review checklist: config.Load errors (no
// agent.yaml at all — the uninstaller ran after everything was already torn
// down, or the agent was never installed at all), and runUninstallNotify
// must return without panicking or attempting any HTTP call.
func TestRunUninstallNotify_NoConfig_NoOp(t *testing.T) {
	dir := t.TempDir()
	origCfg, origQuiet := cfgFile, quietEnroll
	t.Cleanup(func() { cfgFile, quietEnroll = origCfg, origQuiet })
	cfgFile, quietEnroll = filepath.Join(dir, "does-not-exist.yaml"), true

	runUninstallNotify() // must not panic
}

// TestRunUninstallNotify_UnenrolledConfig_NoOp covers an agent.yaml that
// exists but was never enrolled (no secrets.yaml, so AuthToken is empty) —
// config.IsEnrolled must gate the HTTP call.
func TestRunUninstallNotify_UnenrolledConfig_NoOp(t *testing.T) {
	var called bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	cfg := config.Default()
	cfg.ServerURL = srv.URL // present, but no AgentID/AuthToken -> not enrolled
	withUninstallNotifyConfig(t, cfg)

	runUninstallNotify()

	if called {
		t.Fatal("uninstall-intent endpoint was called for an unenrolled config")
	}
}

// TestRunUninstallNotify_Enrolled_PostsUninstallIntent is the happy path:
// an enrolled config posts to /agents/<id>/uninstall-intent with the
// device's bearer token.
func TestRunUninstallNotify_Enrolled_PostsUninstallIntent(t *testing.T) {
	var called bool
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"acknowledged":true}`))
	}))
	defer srv.Close()

	cfg := config.Default()
	cfg.AgentID = "0f0e0d0c-0b0a-4908-8706-050403020100"
	cfg.AuthToken = "brz_token"
	cfg.ServerURL = srv.URL
	withUninstallNotifyConfig(t, cfg)

	runUninstallNotify()

	if !called {
		t.Fatal("uninstall-intent endpoint was not called for an enrolled config")
	}
	if gotPath != "/api/v1/agents/0f0e0d0c-0b0a-4908-8706-050403020100/uninstall-intent" {
		t.Errorf("path = %q, want /api/v1/agents/0f0e0d0c-0b0a-4908-8706-050403020100/uninstall-intent", gotPath)
	}
	if gotAuth != "Bearer brz_token" {
		t.Errorf("Authorization = %q, want Bearer brz_token", gotAuth)
	}
}

// TestRunUninstallNotify_ServerErrorIsNonFatal covers the self-review
// checklist's "including ... the 403 drain response" requirement: neither a
// 403 tenant_offboarding drain response nor any other non-2xx status may
// panic or otherwise fail this call — always non-fatal.
func TestRunUninstallNotify_ServerErrorIsNonFatal(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
	}{
		{"tenant offboarding drain", http.StatusForbidden, `{"error":"tenant_offboarding"}`},
		{"generic server error", http.StatusInternalServerError, `{"error":"boom"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer srv.Close()

			cfg := config.Default()
			cfg.AgentID = "0f0e0d0c-0b0a-4908-8706-050403020100"
			cfg.AuthToken = "brz_token"
			cfg.ServerURL = srv.URL
			withUninstallNotifyConfig(t, cfg)

			runUninstallNotify() // must not panic
		})
	}
}

// TestRunUninstallNotify_NetworkErrorIsNonFatal covers the self-review
// checklist's "network error" case: an unreachable server must not panic
// or otherwise fail this call.
func TestRunUninstallNotify_NetworkErrorIsNonFatal(t *testing.T) {
	cfg := config.Default()
	cfg.AgentID = "0f0e0d0c-0b0a-4908-8706-050403020100"
	cfg.AuthToken = "brz_token"
	cfg.ServerURL = "http://127.0.0.1:1" // nothing listening; connection refused
	withUninstallNotifyConfig(t, cfg)

	runUninstallNotify() // must not panic
}
