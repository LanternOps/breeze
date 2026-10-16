package heartbeat

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/updater"
	"github.com/breeze-rmm/agent/internal/watchdoginstall"
)

const ensureAgentVersion = "1.5.0"

// ensureFake drives the Ensure seams: a host whose watchdog is Missing until a
// register call "installs" it.
type ensureFake struct {
	mu          sync.Mutex
	now         time.Time
	status      watchdoginstall.Status // detect result while not installed
	installed   bool
	stayMissing bool // register "succeeds" but the host is still Missing
	notRunning  bool // installed but never reaches running
	downloadErr error
	registerErr error
	downloads   atomic.Int32
	registers   atomic.Int32
	onDownload  func()
}

func (f *ensureFake) clock() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

func (f *ensureFake) advance(d time.Duration) {
	f.mu.Lock()
	f.now = f.now.Add(d)
	f.mu.Unlock()
}

func (f *ensureFake) detect() watchdoginstall.Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.installed && !f.stayMissing {
		return watchdoginstall.StatusRegistered
	}
	return f.status
}

func (f *ensureFake) download(version, dir string) (string, error) {
	f.downloads.Add(1)
	if f.onDownload != nil {
		f.onDownload()
	}
	if f.downloadErr != nil {
		return "", f.downloadErr
	}
	p := filepath.Join(dir, "breeze-agent-dev-123")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"), 0o600); err != nil {
		return "", err
	}
	return p, nil
}

func (f *ensureFake) register(path string) error {
	f.registers.Add(1)
	if f.registerErr != nil {
		return f.registerErr
	}
	f.mu.Lock()
	f.installed = true
	f.mu.Unlock()
	return nil
}

func (f *ensureFake) waitRunning(time.Duration) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.installed && !f.notRunning
}

func newEnsureHeartbeat(t *testing.T, dir string, f *ensureFake) *Heartbeat {
	t.Helper()
	if f.now.IsZero() {
		f.now = time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	}
	if f.status == 0 {
		f.status = watchdoginstall.StatusMissing
	}
	legacy := func(string) error {
		t.Error("the legacy version-swap installer must not run for a missing watchdog")
		return nil
	}
	h := &Heartbeat{
		config:            &config.Config{AutoUpdate: true, AgentID: "agent-1"},
		agentVersion:      ensureAgentVersion,
		secureToken:       secmem.NewSecureString("token"),
		watchdogInstaller: legacy,
	}
	h.watchdogEnsure = &watchdogEnsureState{
		store:       watchdoginstall.Store{Dir: dir, Now: f.clock},
		plan:        watchdoginstall.DefaultPlan,
		stageRoot:   filepath.Join(dir, "stage"),
		detect:      f.detect,
		download:    f.download,
		verifySig:   func(string) error { return nil },
		register:    f.register,
		waitRunning: f.waitRunning,
		now:         f.clock,
		rnd:         func() float64 { return 0.5 },
	}
	return h
}

func loadRec(t *testing.T, dir string) watchdoginstall.Record {
	t.Helper()
	rec, corrupt, err := watchdoginstall.Store{Dir: dir}.Load()
	if err != nil || corrupt {
		t.Fatalf("load: corrupt=%v err=%v", corrupt, err)
	}
	return rec
}

func stateExists(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, watchdoginstall.StateFileName))
	return err == nil
}

var errSig = fmt.Errorf("verify: %w", updater.ErrManifestSignature)

func TestReconcile_UnenrolledDoesNothing(t *testing.T) {
	for name, mut := range map[string]func(h *Heartbeat){
		"no agent id": func(h *Heartbeat) { h.config.AgentID = "" },
		"no token":    func(h *Heartbeat) { h.secureToken = nil },
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			f := &ensureFake{}
			h := newEnsureHeartbeat(t, dir, f)
			mut(h)
			h.handleWatchdogUpgrade(ensureAgentVersion)
			if f.downloads.Load() != 0 || stateExists(dir) {
				t.Fatalf("unenrolled agent must not download or burn budget (downloads=%d)", f.downloads.Load())
			}
		})
	}
}

func TestReconcile_OptedOutDoesNothing(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{}
	h := newEnsureHeartbeat(t, dir, f)
	if err := (watchdoginstall.Store{Dir: dir}).SetOptedOut(true); err != nil {
		t.Fatal(err)
	}
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 0 || f.registers.Load() != 0 || stateExists(dir) {
		t.Fatal("opted-out host must not be touched")
	}
	if r := h.watchdogInstallReport(); r == nil || r.State != "opted_out" {
		t.Fatalf("report=%+v want opted_out", r)
	}
}

func TestReconcile_AutoUpdateDisabledReportsPolicy(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{}
	h := newEnsureHeartbeat(t, dir, f)
	h.config.AutoUpdate = false
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 0 || stateExists(dir) {
		t.Fatal("auto_update=false must not download")
	}
	if r := h.watchdogInstallReport(); r == nil || r.State != "disabled_by_policy" {
		t.Fatalf("report=%+v want disabled_by_policy", r)
	}
}

func TestReconcile_MissingWatchdogInstallsOnceAndClearsState(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{}
	h := newEnsureHeartbeat(t, dir, f)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 1 || f.registers.Load() != 1 {
		t.Fatalf("downloads=%d registers=%d", f.downloads.Load(), f.registers.Load())
	}
	if stateExists(dir) {
		t.Fatal("success must clear the retry state")
	}
	if r := h.watchdogInstallReport(); r != nil {
		t.Fatalf("healthy host must omit the report, got %+v", r)
	}
	// The per-attempt stage dir is removed after the attempt.
	entries, _ := os.ReadDir(filepath.Join(dir, "stage"))
	if len(entries) != 0 {
		t.Fatalf("stage dir not cleaned: %v", entries)
	}
	// Next beat: registered → the legacy version path owns it; no reinstall.
	h.watchdogInstaller = func(string) error { return nil }
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.registers.Load() != 1 {
		t.Fatal("must not reinstall a registered watchdog")
	}
}

func TestReconcile_SuccessUpdatesVersionTelemetry(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{}
	h := newEnsureHeartbeat(t, dir, f)
	h.watchdogVersionReader = func() (string, bool) {
		t.Error("version must come from the successful install, not a disk read")
		return "", true
	}
	h.watchdogVersionRead = true // a cached "not installed" from startup
	h.handleWatchdogUpgrade("1.6.0")
	if got := h.installedWatchdogVersion(); got != "1.6.0" {
		t.Fatalf("installedWatchdogVersion=%q want the server-supplied target 1.6.0", got)
	}
}

func TestReconcile_TransientFailureBacksOffAndPersists(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{downloadErr: &url.Error{Op: "Get", URL: "https://cdn.example/x?sig=secret", Err: errors.New("connection reset")}}
	h := newEnsureHeartbeat(t, dir, f)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	f.advance(time.Minute)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 1 {
		t.Fatalf("two beats inside the backoff window: downloads=%d want 1", f.downloads.Load())
	}
	rec := loadRec(t, dir)
	if rec.Attempts != 1 || rec.LastClass != watchdoginstall.ClassNetwork || rec.Terminal {
		t.Fatalf("persisted %+v", rec)
	}
	r := h.watchdogInstallReport()
	if r == nil || r.State != "retrying" || r.LastErrorClass != "network" || r.Attempts != 1 {
		t.Fatalf("report=%+v", r)
	}
	f.advance(5 * time.Minute)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 2 {
		t.Fatalf("due after the backoff: downloads=%d want 2", f.downloads.Load())
	}
}

func TestReconcile_PoisonedHost_BoundedThenSilent(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{downloadErr: errSig}
	h := newEnsureHeartbeat(t, dir, f)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 1 {
		t.Fatalf("downloads=%d want 1", f.downloads.Load())
	}
	rec := loadRec(t, dir)
	if !rec.Terminal || rec.LastClass != watchdoginstall.ClassSignature {
		t.Fatalf("want terminal signature, got %+v", rec)
	}
	// 1000 heartbeats across ~6 days: zero further network calls.
	step := 6 * 24 * time.Hour / 1000
	for i := 0; i < 1000; i++ {
		f.advance(step)
		h.handleWatchdogUpgrade(ensureAgentVersion)
	}
	if f.downloads.Load() != 1 {
		t.Fatalf("poisoned host made %d further downloads", f.downloads.Load()-1)
	}
	if r := h.watchdogInstallReport(); r == nil || r.State != "gave_up" || r.LastErrorClass != "signature" {
		t.Fatalf("report=%+v", r)
	}
	// At +7d exactly one probe.
	f.advance(24 * time.Hour)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 2 {
		t.Fatalf("security probe: downloads=%d want 2", f.downloads.Load())
	}
}

func TestReconcile_RestartPersistence(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{downloadErr: &updater.HTTPStatusError{Code: 503}}
	h := newEnsureHeartbeat(t, dir, f)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	f.advance(5 * time.Minute)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 2 {
		t.Fatalf("setup downloads=%d", f.downloads.Load())
	}
	rec := loadRec(t, dir)
	// "Restart": a brand-new Heartbeat sharing only the state directory.
	f.advance(time.Minute)
	h2 := newEnsureHeartbeat(t, dir, f)
	h2.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 2 {
		t.Fatal("a restarted agent must honour the persisted NextAttemptAt")
	}
	f.mu.Lock()
	f.now = rec.NextAttemptAt
	f.mu.Unlock()
	h2.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 3 {
		t.Fatalf("due at NextAttemptAt: downloads=%d", f.downloads.Load())
	}
}

func TestReconcile_CorruptStateFailsClosed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, watchdoginstall.StateFileName), []byte(`{"v":1,"attem`), 0o600); err != nil {
		t.Fatal(err)
	}
	f := &ensureFake{}
	h := newEnsureHeartbeat(t, dir, f)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 0 {
		t.Fatal("corrupt state must not retry immediately")
	}
	// The deferral is persisted, so a restart does not escape it either.
	h2 := newEnsureHeartbeat(t, dir, f)
	f.advance(23 * time.Hour)
	h2.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 0 {
		t.Fatal("corrupt-state deferral must survive a restart")
	}
	f.advance(2 * time.Hour)
	h2.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 1 {
		t.Fatalf("after the slow cadence: downloads=%d want 1", f.downloads.Load())
	}
}

func TestReconcile_LeaseHeldDefersWithoutCountingAttempt(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{}
	h := newEnsureHeartbeat(t, dir, f)
	lease, ok := updater.TryBeginProcessMutation("other-updater")
	if !ok {
		t.Fatal("lease unexpectedly held")
	}
	h.handleWatchdogUpgrade(ensureAgentVersion)
	lease.Release()
	if f.downloads.Load() != 0 || stateExists(dir) {
		t.Fatal("a held lease must defer without counting an attempt")
	}
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.registers.Load() != 1 {
		t.Fatal("after the lease is released the install proceeds")
	}
}

func TestReconcile_CrossProcessLockHeldDefers(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{}
	h := newEnsureHeartbeat(t, dir, f)
	lock, err := watchdoginstall.AcquireLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	h.handleWatchdogUpgrade(ensureAgentVersion)
	lock.Release()
	if f.downloads.Load() != 0 || stateExists(dir) {
		t.Fatal("a held install lock must defer without counting an attempt")
	}
}

func TestReconcile_ConcurrentHeartbeatsInstallOnce(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{}
	release := make(chan struct{})
	f.onDownload = func() { <-release }
	h := newEnsureHeartbeat(t, dir, f)
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h.handleWatchdogUpgrade(ensureAgentVersion)
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	// Late beats after success see a registered watchdog.
	h.watchdogInstaller = func(string) error { return nil }
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.registers.Load() != 1 || f.downloads.Load() != 1 {
		t.Fatalf("downloads=%d registers=%d want 1/1", f.downloads.Load(), f.registers.Load())
	}
}

func TestReconcile_RegisterSucceedsButStillMissingIsFailure(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{stayMissing: true}
	h := newEnsureHeartbeat(t, dir, f)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	rec := loadRec(t, dir)
	if rec.LastClass != watchdoginstall.ClassInstallCmd || rec.Attempts != 1 {
		t.Fatalf("want an install_cmd failure, got %+v", rec)
	}
}

func TestReconcile_InstalledButNotStartedIsFailure(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{notRunning: true}
	h := newEnsureHeartbeat(t, dir, f)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	rec := loadRec(t, dir)
	if rec.LastClass != watchdoginstall.ClassInstallCmd {
		t.Fatalf("want install_cmd, got %+v", rec)
	}
	// An interrupted install (registered but not running, our record open)
	// is completed on the next due beat rather than erased.
	f.mu.Lock()
	f.notRunning = false
	f.mu.Unlock()
	h.watchdogInstallerSet(t)
	f.advance(6 * time.Minute)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if stateExists(dir) {
		t.Fatal("a now-running watchdog clears the open record")
	}
}

// watchdogInstallerSet makes a Registered beat legal (the legacy path may run).
func (h *Heartbeat) watchdogInstallerSet(t *testing.T) {
	t.Helper()
	h.watchdogInstaller = func(string) error { return nil }
}

func TestReconcile_RegisteredNotRunningWithOpenRecordIsRetried(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{installed: true, notRunning: true}
	h := newEnsureHeartbeat(t, dir, f)
	// An open record from an attempt killed between "definition written" and
	// "started".
	store := watchdoginstall.Store{Dir: dir}
	_ = store.Save(watchdoginstall.DefaultPlan.Reserve(watchdoginstall.Record{}, ensureAgentVersion, f.clock().Add(-time.Hour)))
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.registers.Load() != 1 {
		t.Fatal("registered-but-stopped with an open record must be completed")
	}
}

func TestReconcile_RegisteredWithoutRecordUsesLegacyPath(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{installed: true}
	h := newEnsureHeartbeat(t, dir, f)
	called := 0
	h.watchdogInstaller = func(string) error { called++; return nil }
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if called != 1 || f.downloads.Load() != 0 {
		t.Fatalf("registered host: legacy=%d ensureDownloads=%d", called, f.downloads.Load())
	}
}

func TestReconcile_UnknownDetectNeverInstalls(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{}
	h := newEnsureHeartbeat(t, dir, f)
	f.status = watchdoginstall.StatusUnknown // the zero value; set after the helper's default
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 0 || stateExists(dir) {
		t.Fatal("unknown registration state must not install or count")
	}
}

func TestReconcile_UnsupportedReports(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{status: watchdoginstall.StatusUnsupported}
	h := newEnsureHeartbeat(t, dir, f)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 0 {
		t.Fatal("unsupported must not download")
	}
	if r := h.watchdogInstallReport(); r == nil || r.State != "unsupported" {
		t.Fatalf("report=%+v", r)
	}
}

func TestReconcile_DevBuildNeverDownloads(t *testing.T) {
	for _, v := range []string{"dev", "dev-abc123", ""} {
		t.Run(v, func(t *testing.T) {
			dir := t.TempDir()
			f := &ensureFake{}
			h := newEnsureHeartbeat(t, dir, f)
			h.agentVersion = v
			for i := 0; i < 5; i++ {
				h.handleWatchdogUpgrade(ensureAgentVersion)
			}
			if f.downloads.Load() != 0 {
				t.Fatal("dev build must never touch the network")
			}
			r := h.watchdogInstallReport()
			if r == nil || r.State != "gave_up" || r.LastErrorClass != "dev_build" {
				t.Fatalf("report=%+v", r)
			}
		})
	}
}

func TestReconcile_RefusesDowngradeTarget(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{}
	h := newEnsureHeartbeat(t, dir, f)
	h.handleWatchdogUpgrade("1.0.0") // older than the running agent
	if f.downloads.Load() != 0 || stateExists(dir) {
		t.Fatal("a target older than the agent must be refused before any download")
	}
}

func TestReconcile_ServerSignalHonoursPersistedBackoffAndOptOut(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{downloadErr: &updater.HTTPStatusError{Code: 502}}
	h := newEnsureHeartbeat(t, dir, f)
	// 1000 heartbeats 60s apart (~16.7h), each carrying watchdogUpgradeTo.
	for i := 0; i < 1000; i++ {
		h.handleWatchdogUpgrade(ensureAgentVersion)
		f.advance(time.Minute)
	}
	// Schedule (minutes): 0, 5, 20, 65, 200, 560, 920 (6h cap) → 7 in 1000.
	if got := f.downloads.Load(); got != 7 {
		t.Fatalf("downloads=%d want exactly the 7 scheduled attempts (legacy path did ~33)", got)
	}
	// Opt out: zero further downloads, ever.
	if err := (watchdoginstall.Store{Dir: dir}).SetOptedOut(true); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 1000; i++ {
		f.advance(time.Hour)
		h.handleWatchdogUpgrade(ensureAgentVersion)
	}
	if got := f.downloads.Load(); got != 7 {
		t.Fatalf("opted-out host downloaded %d more times", got-7)
	}
}

// The reservation is persisted before any side effect: an agent killed mid-
// download (simulated by a panic the Recoverer swallows) has still spent the
// attempt, and its replacement does not re-enter the work for free.
func TestReconcile_KilledMidAttemptStillSpendsBudget(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{}
	var reservedAttempts int
	f.onDownload = func() {
		rec := loadRec(t, dir)
		reservedAttempts = rec.Attempts
		panic("simulated kill mid-download")
	}
	h := newEnsureHeartbeat(t, dir, f)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if reservedAttempts != 1 {
		t.Fatalf("reservation not persisted before the download (attempts=%d)", reservedAttempts)
	}
	f.onDownload = nil
	h2 := newEnsureHeartbeat(t, dir, f)
	h2.handleWatchdogUpgrade(ensureAgentVersion)
	if f.downloads.Load() != 1 {
		t.Fatal("a restart after a kill must not retry immediately")
	}
	// The panicking attempt must not leave the lease or lock held.
	if lease, ok := updater.TryBeginProcessMutation("probe"); !ok {
		t.Fatal("lease leaked by the panicking attempt")
	} else {
		lease.Release()
	}
}

func TestReconcile_VersionChangeRearmsOnce(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{downloadErr: errSig}
	h := newEnsureHeartbeat(t, dir, f)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	h2 := newEnsureHeartbeat(t, dir, f)
	h2.agentVersion = "1.5.1" // upgraded agent
	h2.handleWatchdogUpgrade("1.5.1")
	h2.handleWatchdogUpgrade("1.5.1")
	if f.downloads.Load() != 2 {
		t.Fatalf("a new agent version re-arms exactly once: downloads=%d want 2", f.downloads.Load())
	}
}

// --- real updater wiring --------------------------------------------------------

// TestReconcile_RealDownloaderFailuresClassified drives the PRODUCTION download
// seam (downloadWatchdogBinaryTo → the real netpolicy-enforcing updater)
// through Ensure. netpolicy refuses a loopback control plane, which is exactly
// a real policy failure: permanent, terminal, never executed, attempt dir
// cleaned. The per-class matrix against a real control plane (checksum,
// signature, key id, 5xx/429) lives in updater's
// TestRealDownloaderFailuresClassified, where the test client can reach
// httptest.
func TestReconcile_RealDownloaderFailuresClassified(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	f := &ensureFake{}
	h := newEnsureHeartbeat(t, dir, f)
	h.config.ServerURL = srv.URL
	h.config.PinnedManifestPubKeys = []string{"test-pinned:" + base64.StdEncoding.EncodeToString(pub)}
	h.watchdogEnsure.download = h.downloadWatchdogBinaryTo
	h.handleWatchdogUpgrade(ensureAgentVersion)
	rec := loadRec(t, dir)
	if rec.LastClass != watchdoginstall.ClassPolicy || !rec.Terminal {
		t.Fatalf("want terminal policy, got %+v", rec)
	}
	if hits.Load() != 0 {
		t.Fatal("a policy-refused destination must never be contacted")
	}
	if f.registers.Load() != 0 {
		t.Fatal("a failed download must never be executed")
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "stage"))
	if len(entries) != 0 {
		t.Fatalf("attempt dir not cleaned: %v", entries)
	}
	// Bounded: further beats inside the security probe make no request.
	for i := 0; i < 50; i++ {
		f.advance(time.Hour)
		h.handleWatchdogUpgrade(ensureAgentVersion)
	}
	if rec2 := loadRec(t, dir); rec2.Attempts != 1 {
		t.Fatalf("attempts=%d want 1", rec2.Attempts)
	}
}

// The verified file is renamed to the watchdog's own name inside the private
// attempt dir and made root-only executable before it is run.
func TestReconcile_StagesVerifiedFileForExec(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{}
	h := newEnsureHeartbeat(t, dir, f)
	var gotPath string
	var gotMode os.FileMode
	h.watchdogEnsure.register = func(p string) error {
		gotPath = p
		if fi, err := os.Stat(p); err == nil {
			gotMode = fi.Mode().Perm()
		}
		return f.register(p)
	}
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if !strings.HasPrefix(gotPath, filepath.Join(dir, "stage", watchdoginstall.StageDirPrefix)) {
		t.Fatalf("executed %q, want a file in the private attempt dir", gotPath)
	}
	if base := filepath.Base(gotPath); base != watchdogExecutableName() {
		t.Fatalf("staged name %q want %q", base, watchdogExecutableName())
	}
	if runtime.GOOS != "windows" && gotMode != 0o700 {
		t.Fatalf("staged mode %v want 0700", gotMode)
	}
}

func TestReconcile_SignatureGateRunsBeforeExec(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{}
	h := newEnsureHeartbeat(t, dir, f)
	h.watchdogEnsure.verifySig = func(string) error {
		return fmt.Errorf("%w: unsigned", updater.ErrCodeSignatureInvalid)
	}
	h.handleWatchdogUpgrade(ensureAgentVersion)
	if f.registers.Load() != 0 {
		t.Fatal("a binary failing the code-signature gate must never be executed")
	}
	if rec := loadRec(t, dir); rec.LastClass != watchdoginstall.ClassSignature || !rec.Terminal {
		t.Fatalf("want terminal signature, got %+v", rec)
	}
}

// --- Task 8: heartbeat payload ------------------------------------------------

func TestHeartbeatPayload_WatchdogInstall_OmittedBeforeEvaluationAndWhenHealthy(t *testing.T) {
	h := &Heartbeat{}
	if h.watchdogInstallReport() != nil {
		t.Fatal("no ensure wired → nothing to report")
	}
	dir := t.TempDir()
	f := &ensureFake{}
	h = newEnsureHeartbeat(t, dir, f)
	if h.watchdogInstallReport() != nil {
		t.Fatal("omitted before first evaluation")
	}
	h.handleWatchdogUpgrade(ensureAgentVersion) // installs successfully
	b, _ := json.Marshal(HeartbeatPayload{WatchdogInstall: h.watchdogInstallReport()})
	if strings.Contains(string(b), "watchdogInstall") {
		t.Fatalf("healthy host must omit the key: %s", b)
	}
}

func TestHeartbeatPayload_WatchdogInstall_RetryingAndGaveUp(t *testing.T) {
	dir := t.TempDir()
	f := &ensureFake{downloadErr: &updater.HTTPStatusError{Code: 503}}
	h := newEnsureHeartbeat(t, dir, f)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	r := h.watchdogInstallReport()
	if r == nil || r.State != "retrying" || r.LastErrorClass != "server" || r.Attempts != 1 {
		t.Fatalf("retrying report=%+v", r)
	}
	if _, err := time.Parse(time.RFC3339, r.LastAttemptAt); err != nil || !strings.HasSuffix(r.LastAttemptAt, "Z") {
		t.Fatalf("lastAttemptAt %q must be RFC3339 UTC", r.LastAttemptAt)
	}
	for i := 0; i < 20; i++ {
		f.advance(7 * time.Hour)
		h.handleWatchdogUpgrade(ensureAgentVersion)
	}
	r = h.watchdogInstallReport()
	if r == nil || r.State != "gave_up" {
		t.Fatalf("gave_up report=%+v", r)
	}
}

func TestHeartbeatPayload_WatchdogInstall_SizeBound(t *testing.T) {
	r := &WatchdogInstallReport{State: "disabled_by_policy", Attempts: 1000, LastAttemptAt: "2026-10-12T12:00:00Z", LastErrorClass: "unsupported_os"}
	b, _ := json.Marshal(HeartbeatPayload{WatchdogInstall: r})
	var m map[string]json.RawMessage
	_ = json.Unmarshal(b, &m)
	if len(m["watchdogInstall"]) >= 200 {
		t.Fatalf("watchdogInstall is %d bytes", len(m["watchdogInstall"]))
	}
}

// An error whose text carries a URL with a capability query string flows
// through the whole path; neither the URL nor the text may reach the payload.
func TestHeartbeatPayload_WatchdogInstall_NeverCarriesErrorText(t *testing.T) {
	dir := t.TempDir()
	secretURL := "https://cdn.example.invalid/watchdog?X-Amz-Signature=deadbeefcafe&token=s3cr3t"
	f := &ensureFake{downloadErr: &url.Error{Op: "Get", URL: secretURL, Err: errors.New("tls: handshake failure s3cr3t")}}
	h := newEnsureHeartbeat(t, dir, f)
	h.handleWatchdogUpgrade(ensureAgentVersion)
	b, _ := json.Marshal(HeartbeatPayload{WatchdogInstall: h.watchdogInstallReport()})
	s := string(b)
	for _, leak := range []string{"cdn.example", "X-Amz", "s3cr3t", "deadbeef", "handshake"} {
		if strings.Contains(s, leak) {
			t.Fatalf("payload leaked %q: %s", leak, s)
		}
	}
	if !strings.Contains(s, `"lastErrorClass":"network"`) {
		t.Fatalf("expected the closed class only: %s", s)
	}
	// The persisted state file is equally free of error text.
	raw, _ := os.ReadFile(filepath.Join(dir, watchdoginstall.StateFileName))
	if strings.Contains(string(raw), "s3cr3t") || strings.Contains(string(raw), "cdn.example") {
		t.Fatalf("state file leaked error text: %s", raw)
	}
}
