package heartbeat

import (
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/updater"
)

// --- prefetchBackupHelper: unlike prefetchUserHelper this runs on every
// platform and surfaces the download error to the caller. ---

func TestPrefetchBackupHelper_HappyPath(t *testing.T) {
	tempPath := filepath.Join(t.TempDir(), "breeze-backup-dl-12345")
	overridePath := filepath.Join(t.TempDir(), "custom-backup")
	var calls atomic.Int32
	h := &Heartbeat{
		config:           &config.Config{},
		agentVersion:     "1.2.3",
		backupBinaryPath: overridePath,
		backupHelperDownloader: func(targetVersion string) (string, error) {
			calls.Add(1)
			if targetVersion != "1.2.4" {
				t.Fatalf("expected targetVersion=1.2.4, got %q", targetVersion)
			}
			return tempPath, nil
		},
	}

	pair, err := h.prefetchBackupHelper("1.2.4")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pair == nil {
		t.Fatal("expected non-nil BinaryPair on happy path")
	}
	if pair.Temp != tempPath {
		t.Fatalf("Temp: expected %q, got %q", tempPath, pair.Temp)
	}
	if pair.Target != overridePath {
		t.Fatalf("Target: expected the resolved (overridden) path %q, got %q", overridePath, pair.Target)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("downloader call count: expected 1, got %d", got)
	}
}

func TestPrefetchBackupHelper_DownloadFails_ReturnsError(t *testing.T) {
	var calls atomic.Int32
	wantErr := errors.New("404 status: not found")
	h := &Heartbeat{
		config:           &config.Config{},
		agentVersion:     "1.2.3",
		backupBinaryPath: filepath.Join(t.TempDir(), "custom-backup"),
		backupHelperDownloader: func(targetVersion string) (string, error) {
			calls.Add(1)
			return "", wantErr
		},
	}

	pair, err := h.prefetchBackupHelper("1.2.4")
	if pair != nil {
		t.Fatalf("expected nil BinaryPair on download failure, got %+v", pair)
	}
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected the download error to be returned, got %v", err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("downloader should be called exactly once, got %d", got)
	}
}

// --- backupUpgradeCompanion: the present->abort / absent->proceed policy,
// plus the Finding-1 consecutive-failure escape hatch. ---

func TestBackupUpgradeCompanion_PresentAndPrefetchFails_Aborts(t *testing.T) {
	dir := t.TempDir()
	installPath := filepath.Join(dir, "custom-backup")
	if err := os.WriteFile(installPath, []byte("existing backup binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	h := &Heartbeat{
		config:           &config.Config{},
		agentVersion:     "1.2.3",
		backupBinaryPath: installPath,
		backupHelperDownloader: func(string) (string, error) {
			return "", errors.New("network unreachable")
		},
	}

	pair, abort := h.backupUpgradeCompanion("1.2.4")
	if !abort {
		t.Fatal("expected abort=true on the first failure with a backup binary present")
	}
	if pair != nil {
		t.Fatalf("expected nil pair on abort, got %+v", pair)
	}
}

func TestBackupUpgradeCompanion_AbsentAndPrefetchFails_Proceeds(t *testing.T) {
	dir := t.TempDir()
	// No breeze-backup binary written at all.

	h := &Heartbeat{
		config:           &config.Config{},
		agentVersion:     "1.2.3",
		backupBinaryPath: filepath.Join(dir, "custom-backup"),
		backupHelperDownloader: func(string) (string, error) {
			return "", errors.New("network unreachable")
		},
	}

	pair, abort := h.backupUpgradeCompanion("1.2.4")
	if abort {
		t.Fatal("expected abort=false when no backup binary is installed, even if the prefetch fails")
	}
	if pair != nil {
		t.Fatalf("expected nil pair when the prefetch failed, got %+v", pair)
	}
}

func TestBackupUpgradeCompanion_ZeroLengthPresent_TreatedAsAbsent(t *testing.T) {
	dir := t.TempDir()
	installPath := filepath.Join(dir, "custom-backup")
	if err := os.WriteFile(installPath, nil, 0o755); err != nil {
		t.Fatal(err)
	}

	h := &Heartbeat{
		config:           &config.Config{},
		agentVersion:     "1.2.3",
		backupBinaryPath: installPath,
		backupHelperDownloader: func(string) (string, error) {
			return "", errors.New("network unreachable")
		},
	}

	pair, abort := h.backupUpgradeCompanion("1.2.4")
	if abort {
		t.Fatal("expected abort=false: a zero-length binary on disk is not a legitimate install worth protecting")
	}
	if pair != nil {
		t.Fatalf("expected nil pair when the prefetch failed, got %+v", pair)
	}
}

func TestBackupUpgradeCompanion_PrefetchSucceeds_ReturnsPairRegardlessOfPresence(t *testing.T) {
	dir := t.TempDir()
	installPath := filepath.Join(dir, "custom-backup")
	if err := os.WriteFile(installPath, []byte("existing"), 0o755); err != nil {
		t.Fatal(err)
	}
	tempDL := filepath.Join(dir, "dl")
	if err := os.WriteFile(tempDL, []byte("new bytes"), 0o644); err != nil {
		t.Fatal(err)
	}

	h := &Heartbeat{
		config:           &config.Config{},
		agentVersion:     "1.2.3",
		backupBinaryPath: installPath,
		backupHelperDownloader: func(string) (string, error) {
			return tempDL, nil
		},
	}

	pair, abort := h.backupUpgradeCompanion("1.2.4")
	if abort {
		t.Fatal("expected abort=false on a successful prefetch")
	}
	if pair == nil || pair.Temp != tempDL {
		t.Fatalf("expected a pair pointing at the downloaded temp file, got %+v", pair)
	}
}

// TestBackupUpgradeCompanion_ThirdConsecutiveFailure_ProceedsAgentOnly is
// Finding 1: a target version whose breeze-backup artifact is permanently
// missing must not wedge agent upgrades forever. After backupPrefetchFailureCap
// (3) consecutive failures for the SAME target version, the third abort
// becomes a proceed.
func TestBackupUpgradeCompanion_ThirdConsecutiveFailure_ProceedsAgentOnly(t *testing.T) {
	dir := t.TempDir()
	installPath := filepath.Join(dir, "custom-backup")
	if err := os.WriteFile(installPath, []byte("existing backup binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	h := &Heartbeat{
		config:           &config.Config{},
		agentVersion:     "1.2.3",
		backupBinaryPath: installPath,
		backupHelperDownloader: func(string) (string, error) {
			return "", errors.New("404 not found")
		},
	}

	if _, abort := h.backupUpgradeCompanion("1.2.4"); !abort {
		t.Fatal("attempt 1: expected abort=true")
	}
	if _, abort := h.backupUpgradeCompanion("1.2.4"); !abort {
		t.Fatal("attempt 2: expected abort=true")
	}
	pair, abort := h.backupUpgradeCompanion("1.2.4")
	if abort {
		t.Fatal("attempt 3: expected abort=false — the failure cap must proceed agent-only")
	}
	if pair != nil {
		t.Fatalf("attempt 3: expected nil pair, got %+v", pair)
	}
}

// TestBackupUpgradeCompanion_FailureCap_ResetsOnTargetVersionChange verifies
// a new release doesn't inherit a stale failure streak from a prior one — an
// operator cutting v1.2.5 after v1.2.4's artifact was missing should get the
// full retry budget again, not an immediate proceed.
func TestBackupUpgradeCompanion_FailureCap_ResetsOnTargetVersionChange(t *testing.T) {
	dir := t.TempDir()
	installPath := filepath.Join(dir, "custom-backup")
	if err := os.WriteFile(installPath, []byte("existing backup binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	h := &Heartbeat{
		config:           &config.Config{},
		agentVersion:     "1.2.3",
		backupBinaryPath: installPath,
		backupHelperDownloader: func(string) (string, error) {
			return "", errors.New("404 not found")
		},
	}

	if _, abort := h.backupUpgradeCompanion("1.2.4"); !abort {
		t.Fatal("v1.2.4 attempt 1: expected abort=true")
	}
	if _, abort := h.backupUpgradeCompanion("1.2.4"); !abort {
		t.Fatal("v1.2.4 attempt 2: expected abort=true")
	}
	// A different target version resets the streak — must abort again, not
	// immediately proceed as if this were attempt 3.
	if _, abort := h.backupUpgradeCompanion("1.2.5"); !abort {
		t.Fatal("v1.2.5 attempt 1: expected abort=true (streak must reset on version change)")
	}
}

// TestBackupUpgradeCompanion_FailureCap_ResetsOnSuccess verifies a successful
// prefetch clears the streak, so a later failure (even for the same target
// version) starts counting from zero again.
func TestBackupUpgradeCompanion_FailureCap_ResetsOnSuccess(t *testing.T) {
	dir := t.TempDir()
	installPath := filepath.Join(dir, "custom-backup")
	if err := os.WriteFile(installPath, []byte("existing backup binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	tempDL := filepath.Join(dir, "dl")
	if err := os.WriteFile(tempDL, []byte("new bytes"), 0o644); err != nil {
		t.Fatal(err)
	}

	fail := true
	h := &Heartbeat{
		config:           &config.Config{},
		agentVersion:     "1.2.3",
		backupBinaryPath: installPath,
		backupHelperDownloader: func(string) (string, error) {
			if fail {
				return "", errors.New("404 not found")
			}
			return tempDL, nil
		},
	}

	if _, abort := h.backupUpgradeCompanion("1.2.4"); !abort {
		t.Fatal("attempt 1: expected abort=true")
	}
	fail = false
	if _, abort := h.backupUpgradeCompanion("1.2.4"); abort {
		t.Fatal("attempt 2 (success): expected abort=false")
	}
	fail = true
	if _, abort := h.backupUpgradeCompanion("1.2.4"); !abort {
		t.Fatal("attempt 3 (fails again after a success): expected abort=true, not an immediate proceed")
	}
}

// --- removeStagedUpgradeTemps: Finding 2's cleanup helper for doUpgrade's
// early-return paths (abort, busy-defer). ---

func TestRemoveStagedUpgradeTemps_RemovesAllNonNilPairs(t *testing.T) {
	dir := t.TempDir()
	tempA := filepath.Join(dir, "a")
	tempB := filepath.Join(dir, "b")
	if err := os.WriteFile(tempA, []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tempB, []byte("b"), 0o644); err != nil {
		t.Fatal(err)
	}

	removeStagedUpgradeTemps(
		&updater.BinaryPair{Temp: tempA, Target: "unused"},
		nil,
		&updater.BinaryPair{Temp: tempB, Target: "unused"},
		&updater.BinaryPair{Temp: "", Target: "unused"}, // empty Temp must be a no-op, not attempt os.Remove("")
	)

	if _, err := os.Stat(tempA); !os.IsNotExist(err) {
		t.Fatalf("expected tempA removed, stat err=%v", err)
	}
	if _, err := os.Stat(tempB); !os.IsNotExist(err) {
		t.Fatalf("expected tempB removed, stat err=%v", err)
	}
}

func TestRemoveStagedUpgradeTemps_MissingFileIsNotAnError(t *testing.T) {
	// Must not panic or otherwise misbehave when the temp is already gone.
	removeStagedUpgradeTemps(&updater.BinaryPair{Temp: filepath.Join(t.TempDir(), "already-gone"), Target: "unused"})
}

// --- backupHelperIdle: the shared idle-check seam resolution used by both
// doUpgrade's pre-swap gate (Finding 3) and reconcile's TOCTOU re-check
// (Finding 4). ---

func TestBackupHelperIdle_NilSessionBrokerAndNoSeam_ProceedsIdle(t *testing.T) {
	h := &Heartbeat{}
	if !h.backupHelperIdle() {
		t.Fatal("expected idle=true when there is nothing to stop (nil sessionBroker, no test seam)")
	}
}

func TestBackupHelperIdle_SeamReportsBusy(t *testing.T) {
	h := &Heartbeat{backupHelperStopIfIdle: func() bool { return false }}
	if h.backupHelperIdle() {
		t.Fatal("expected idle=false when the seam reports busy")
	}
}

func TestBackupHelperIdle_SeamReportsIdle(t *testing.T) {
	h := &Heartbeat{backupHelperStopIfIdle: func() bool { return true }}
	if !h.backupHelperIdle() {
		t.Fatal("expected idle=true when the seam reports idle")
	}
}

// --- reconcileBackupHelper: version-aware self-heal ---

func TestReconcileBackupHelper_Missing_DownloadsAndInstalls(t *testing.T) {
	dir := t.TempDir()
	wantInstall := filepath.Join(dir, "custom-backup")
	tempDL := filepath.Join(dir, "breeze-backup-dl-999")
	if err := os.WriteFile(tempDL, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}

	var instCalls atomic.Int32
	var gotDLVersion, gotTemp, gotInstallPath, gotInstallVersion string
	h := &Heartbeat{
		config:                 &config.Config{},
		agentVersion:           "1.2.3",
		backupBinaryPath:       wantInstall,
		backupHelperDownloader: func(v string) (string, error) { gotDLVersion = v; return tempDL, nil },
		backupHelperInstaller: func(temp, installPath, version string) error {
			instCalls.Add(1)
			gotTemp, gotInstallPath, gotInstallVersion = temp, installPath, version
			return nil
		},
	}

	h.reconcileBackupHelper()

	if gotDLVersion != "1.2.3" {
		t.Fatalf("download version: want current 1.2.3, got %q", gotDLVersion)
	}
	if instCalls.Load() != 1 {
		t.Fatalf("installer calls: want 1, got %d", instCalls.Load())
	}
	if gotTemp != tempDL {
		t.Fatalf("install temp: want %q, got %q", tempDL, gotTemp)
	}
	if gotInstallPath != wantInstall {
		t.Fatalf("install path: want %q, got %q", wantInstall, gotInstallPath)
	}
	if gotInstallVersion != "1.2.3" {
		t.Fatalf("install version: want 1.2.3, got %q", gotInstallVersion)
	}
	if _, err := os.Stat(tempDL); !os.IsNotExist(err) {
		t.Fatalf("temp download must be removed after a successful install, stat err=%v", err)
	}
}

func TestReconcileBackupHelper_PresentSameVersion_NoOp(t *testing.T) {
	dir := t.TempDir()
	installPath := filepath.Join(dir, "custom-backup")
	if err := os.WriteFile(installPath, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}

	var dlCalls, instCalls atomic.Int32
	h := &Heartbeat{
		config:                 &config.Config{},
		agentVersion:           "1.2.3",
		backupBinaryPath:       installPath,
		backupVersionReader:    func() (string, backupProbeOutcome) { return "1.2.3", backupProbeOK },
		backupHelperDownloader: func(string) (string, error) { dlCalls.Add(1); return "", nil },
		backupHelperInstaller:  func(string, string, string) error { instCalls.Add(1); return nil },
	}

	h.reconcileBackupHelper()

	if dlCalls.Load() != 0 || instCalls.Load() != 0 {
		t.Fatalf("matching version must be a no-op; downloader=%d installer=%d", dlCalls.Load(), instCalls.Load())
	}
}

// TestReconcileBackupHelper_VersionMismatch_Reinstalls is the core
// version-aware behavior that distinguishes this from reconcileUserHelper's
// stat-only check: a PRESENT, non-empty binary whose reported version differs
// from the agent's must still trigger a re-fetch.
func TestReconcileBackupHelper_VersionMismatch_Reinstalls(t *testing.T) {
	dir := t.TempDir()
	installPath := filepath.Join(dir, "custom-backup")
	if err := os.WriteFile(installPath, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}
	tempDL := filepath.Join(dir, "dl")
	if err := os.WriteFile(tempDL, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}

	var instCalls atomic.Int32
	h := &Heartbeat{
		config:                 &config.Config{},
		agentVersion:           "1.3.0",
		backupBinaryPath:       installPath,
		backupVersionReader:    func() (string, backupProbeOutcome) { return "1.2.3", backupProbeOK }, // stale
		backupHelperDownloader: func(string) (string, error) { return tempDL, nil },
		backupHelperInstaller:  func(string, string, string) error { instCalls.Add(1); return nil },
	}

	h.reconcileBackupHelper()

	if instCalls.Load() != 1 {
		t.Fatalf("version mismatch must trigger a re-fetch+install; installer calls=%d", instCalls.Load())
	}
}

// TestReconcileBackupHelper_ProbeFailed_Reinstalls is Finding 7(b): a binary
// that IS present but whose --version probe completed and failed (legacy
// pre-#1802 binary, or otherwise broken) must be treated as a version
// mismatch and replaced — not as healthy. The old `installed != ""` guard
// stranded exactly this binary in the fleet forever.
func TestReconcileBackupHelper_ProbeFailed_Reinstalls(t *testing.T) {
	dir := t.TempDir()
	installPath := filepath.Join(dir, "custom-backup")
	if err := os.WriteFile(installPath, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}
	tempDL := filepath.Join(dir, "dl")
	if err := os.WriteFile(tempDL, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}

	var instCalls atomic.Int32
	h := &Heartbeat{
		config:                 &config.Config{},
		agentVersion:           "1.3.0",
		backupBinaryPath:       installPath,
		backupVersionReader:    func() (string, backupProbeOutcome) { return "", backupProbeFailed },
		backupHelperDownloader: func(string) (string, error) { return tempDL, nil },
		backupHelperInstaller:  func(string, string, string) error { instCalls.Add(1); return nil },
	}

	h.reconcileBackupHelper()

	if instCalls.Load() != 1 {
		t.Fatalf("a present-but-probe-failed binary must trigger a re-fetch+install; installer calls=%d", instCalls.Load())
	}
}

// TestReconcileBackupHelper_DevVersion_SkipsMismatchCheck: a dev-prefixed
// agent version must not chase a version-mismatch reconcile — there is no
// published backup artifact for a dev version to converge on.
func TestReconcileBackupHelper_DevVersion_SkipsMismatchCheck(t *testing.T) {
	dir := t.TempDir()
	installPath := filepath.Join(dir, "custom-backup")
	if err := os.WriteFile(installPath, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}

	var dlCalls, instCalls atomic.Int32
	h := &Heartbeat{
		config:                 &config.Config{},
		agentVersion:           "dev-abc123",
		backupBinaryPath:       installPath,
		backupVersionReader:    func() (string, backupProbeOutcome) { return "1.2.3", backupProbeOK }, // "mismatched" but irrelevant
		backupHelperDownloader: func(string) (string, error) { dlCalls.Add(1); return "", nil },
		backupHelperInstaller:  func(string, string, string) error { instCalls.Add(1); return nil },
	}

	h.reconcileBackupHelper()

	if dlCalls.Load() != 0 || instCalls.Load() != 0 {
		t.Fatalf("dev- agent version must skip the mismatch reconcile; downloader=%d installer=%d", dlCalls.Load(), instCalls.Load())
	}
}

func TestReconcileBackupHelper_ZeroLength_Refetches(t *testing.T) {
	dir := t.TempDir()
	installPath := filepath.Join(dir, "custom-backup")
	if err := os.WriteFile(installPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	tempDL := filepath.Join(dir, "dl")
	if err := os.WriteFile(tempDL, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}

	var instCalls atomic.Int32
	h := &Heartbeat{
		config:                 &config.Config{},
		agentVersion:           "1.2.3",
		backupBinaryPath:       installPath,
		backupHelperDownloader: func(string) (string, error) { return tempDL, nil },
		backupHelperInstaller:  func(string, string, string) error { instCalls.Add(1); return nil },
	}

	h.reconcileBackupHelper()

	if instCalls.Load() != 1 {
		t.Fatalf("zero-length binary must trigger re-fetch+install; installer calls=%d", instCalls.Load())
	}
}

func TestReconcileBackupHelper_UnexpectedStatError_NoDownload(t *testing.T) {
	dir := t.TempDir()
	fakeDir := filepath.Join(dir, "agent-dir-that-is-a-file")
	if err := os.WriteFile(fakeDir, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	installPath := filepath.Join(fakeDir, "custom-backup")

	var dlCalls, instCalls atomic.Int32
	h := &Heartbeat{
		config:                 &config.Config{},
		agentVersion:           "1.2.3",
		backupBinaryPath:       installPath,
		backupHelperDownloader: func(string) (string, error) { dlCalls.Add(1); return "", nil },
		backupHelperInstaller:  func(string, string, string) error { instCalls.Add(1); return nil },
	}

	h.reconcileBackupHelper()

	if dlCalls.Load() != 0 || instCalls.Load() != 0 {
		t.Fatalf("unexpected stat error must skip; downloader=%d installer=%d", dlCalls.Load(), instCalls.Load())
	}
}

// TestReconcileBackupHelper_Busy_Defers verifies the active-run deferral:
// when the injected idle-check reports busy, reconcile must not download or
// install anything, and must not touch the failure counter (busy is routine,
// not a failure).
func TestReconcileBackupHelper_Busy_Defers(t *testing.T) {
	dir := t.TempDir()
	// Missing binary would otherwise trigger a fetch — busy must still defer.

	var dlCalls, instCalls atomic.Int32
	h := &Heartbeat{
		config:                 &config.Config{},
		agentVersion:           "1.2.3",
		backupBinaryPath:       filepath.Join(dir, "custom-backup"),
		backupHelperStopIfIdle: func() bool { return false },
		backupHelperDownloader: func(string) (string, error) { dlCalls.Add(1); return "", nil },
		backupHelperInstaller:  func(string, string, string) error { instCalls.Add(1); return nil },
	}

	h.reconcileBackupHelper()

	if dlCalls.Load() != 0 || instCalls.Load() != 0 {
		t.Fatalf("busy broker must defer without downloading/installing; downloader=%d installer=%d", dlCalls.Load(), instCalls.Load())
	}
	if got := h.backupHelperReconcileFailures.Load(); got != 0 {
		t.Fatalf("busy must not count against the failure/escalation budget, got %d", got)
	}
}

// TestReconcileBackupHelper_Idle_Proceeds is the flip side: an idle broker
// must not block the fetch+install.
func TestReconcileBackupHelper_Idle_Proceeds(t *testing.T) {
	dir := t.TempDir()
	tempDL := filepath.Join(dir, "dl")
	if err := os.WriteFile(tempDL, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}

	var instCalls atomic.Int32
	h := &Heartbeat{
		config:                 &config.Config{},
		agentVersion:           "1.2.3",
		backupBinaryPath:       filepath.Join(dir, "custom-backup"),
		backupHelperStopIfIdle: func() bool { return true },
		backupHelperDownloader: func(string) (string, error) { return tempDL, nil },
		backupHelperInstaller:  func(string, string, string) error { instCalls.Add(1); return nil },
	}

	h.reconcileBackupHelper()

	if instCalls.Load() != 1 {
		t.Fatalf("idle broker must allow the install to proceed, got %d calls", instCalls.Load())
	}
}

// TestReconcileBackupHelper_BusyAfterDownload_DefersInstall is Finding 4: the
// TOCTOU re-check. Idle at the pre-download check, but busy by the time the
// download finishes — install must not proceed, and the downloaded temp must
// still be cleaned up.
func TestReconcileBackupHelper_BusyAfterDownload_DefersInstall(t *testing.T) {
	dir := t.TempDir()
	tempDL := filepath.Join(dir, "dl")
	if err := os.WriteFile(tempDL, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}

	idleCalls := 0
	var instCalls atomic.Int32
	h := &Heartbeat{
		config:           &config.Config{},
		agentVersion:     "1.2.3",
		backupBinaryPath: filepath.Join(dir, "custom-backup"),
		backupHelperStopIfIdle: func() bool {
			idleCalls++
			// Idle on the first (pre-download) check, busy on the second
			// (pre-install, post-download) check.
			return idleCalls == 1
		},
		backupHelperDownloader: func(string) (string, error) { return tempDL, nil },
		backupHelperInstaller:  func(string, string, string) error { instCalls.Add(1); return nil },
	}

	h.reconcileBackupHelper()

	if idleCalls != 2 {
		t.Fatalf("expected the idle check to run twice (pre-download and pre-install), got %d", idleCalls)
	}
	if instCalls.Load() != 0 {
		t.Fatalf("install must not proceed when the re-check finds a job started during the download, got %d calls", instCalls.Load())
	}
	if _, err := os.Stat(tempDL); !os.IsNotExist(err) {
		t.Fatalf("downloaded temp must still be cleaned up on a busy-deferred install, stat err=%v", err)
	}
	if got := h.backupHelperReconcileFailures.Load(); got != 0 {
		t.Fatalf("busy-after-download must not count against the failure/escalation budget, got %d", got)
	}
}

func TestReconcileBackupHelper_DownloadFails_NoInstall(t *testing.T) {
	dir := t.TempDir()
	var instCalls atomic.Int32
	h := &Heartbeat{
		config:                 &config.Config{},
		agentVersion:           "1.2.3",
		backupBinaryPath:       filepath.Join(dir, "custom-backup"),
		backupHelperDownloader: func(string) (string, error) { return "", errors.New("404 not found") },
		backupHelperInstaller:  func(string, string, string) error { instCalls.Add(1); return nil },
	}

	h.reconcileBackupHelper()

	if instCalls.Load() != 0 {
		t.Fatalf("installer must not run when download fails; got %d calls", instCalls.Load())
	}
	if got := h.backupHelperReconcileFailures.Load(); got != 1 {
		t.Fatalf("expected failure counter to advance to 1, got %d", got)
	}
}

func TestReconcileBackupHelper_InstallFails_NonFatal_RemovesTemp(t *testing.T) {
	dir := t.TempDir()
	tempDL := filepath.Join(dir, "breeze-backup-dl-777")
	if err := os.WriteFile(tempDL, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}

	h := &Heartbeat{
		config:                 &config.Config{},
		agentVersion:           "1.2.3",
		backupBinaryPath:       filepath.Join(dir, "custom-backup"),
		backupHelperDownloader: func(string) (string, error) { return tempDL, nil },
		backupHelperInstaller:  func(string, string, string) error { return errors.New("sharing violation") },
	}

	h.reconcileBackupHelper() // must not panic

	if _, err := os.Stat(tempDL); !os.IsNotExist(err) {
		t.Fatalf("temp download must be removed after a failed install, stat err=%v", err)
	}
	if got := h.backupHelperReconcileFailures.Load(); got != 1 {
		t.Fatalf("failure counter: want 1 after one install failure, got %d", got)
	}
}

func TestReconcileBackupHelper_ConsecutiveFailures_TrackedAndReset(t *testing.T) {
	dir := t.TempDir()
	tempDL := filepath.Join(dir, "dl")
	if err := os.WriteFile(tempDL, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}

	failDownload := true
	h := &Heartbeat{
		config:           &config.Config{},
		agentVersion:     "1.2.3",
		backupBinaryPath: filepath.Join(dir, "custom-backup"),
		backupHelperDownloader: func(string) (string, error) {
			if failDownload {
				return "", errors.New("404 not found")
			}
			return tempDL, nil
		},
		backupHelperInstaller: func(string, string, string) error { return nil },
	}

	h.reconcileBackupHelper()
	h.reconcileBackupHelper()
	if got := h.backupHelperReconcileFailures.Load(); got != 2 {
		t.Fatalf("failure counter: want 2 after two download failures, got %d", got)
	}

	failDownload = false
	h.reconcileBackupHelper()
	if got := h.backupHelperReconcileFailures.Load(); got != 0 {
		t.Fatalf("failure counter: want reset to 0 after success, got %d", got)
	}
}

func TestReconcileBackupHelper_PresentHealthy_ResetsFailureCounter(t *testing.T) {
	dir := t.TempDir()
	installPath := filepath.Join(dir, "custom-backup")
	if err := os.WriteFile(installPath, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := &Heartbeat{
		config:                 &config.Config{},
		agentVersion:           "1.2.3",
		backupBinaryPath:       installPath,
		backupVersionReader:    func() (string, backupProbeOutcome) { return "1.2.3", backupProbeOK },
		backupHelperDownloader: func(string) (string, error) { t.Fatal("must not download when helper is healthy"); return "", nil },
		backupHelperInstaller:  func(string, string, string) error { t.Fatal("must not install when helper is healthy"); return nil },
	}
	h.backupHelperReconcileFailures.Store(5)

	h.reconcileBackupHelper()

	if got := h.backupHelperReconcileFailures.Load(); got != 0 {
		t.Fatalf("present healthy helper must reset stale failure counter, got %d", got)
	}
}
