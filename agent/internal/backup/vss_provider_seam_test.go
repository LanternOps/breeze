package backup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/vss"
)

// fakeVSSProvider is a cross-platform stand-in for the real, Windows-only VSS
// provider. It exists so RunBackupContext's snapshot-liveness wiring — build
// the shadow-root probe from the live session, hand it to the upload loop
// (#3260/#3266) — can be exercised on the linux/race CI job, which is the only
// place the backup package is actually tested.
//
// It implements vss.Provider and nothing else: no build tags, no syscall
// imports, no knowledge of how a session is created or torn down beyond the
// interface. That is deliberate — the COM-lifetime rewrite in #3269 changes
// session plumbing, not this surface.
type fakeVSSProvider struct {
	mu sync.Mutex

	// session is returned verbatim from CreateShadowCopy when createErr is nil.
	// A nil session with a nil createErr models a provider that violates the
	// interface contract.
	session   *vss.VSSSession
	createErr error

	createCalls      int
	releaseCalls     int
	requestedVolumes []string
}

func (f *fakeVSSProvider) CreateShadowCopy(_ context.Context, volumes []string) (*vss.VSSSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createCalls++
	f.requestedVolumes = append([]string(nil), volumes...)
	if f.createErr != nil {
		return nil, f.createErr
	}
	return f.session, nil
}

func (f *fakeVSSProvider) ReleaseShadowCopy(_ *vss.VSSSession) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.releaseCalls++
	return nil
}

func (f *fakeVSSProvider) ListWriters(_ context.Context) ([]vss.WriterStatus, error) {
	return nil, nil
}

func (f *fakeVSSProvider) GetShadowPath(_ *vss.VSSSession, volume string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.session == nil {
		return "", vss.ErrVSSNotSupported
	}
	return f.session.ShadowPaths[volume], nil
}

func (f *fakeVSSProvider) counts() (create, release int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.createCalls, f.releaseCalls
}

// hookProvider wraps mockProvider to fail every upload of one source file,
// running a hook once immediately before the first of those failures. The hook
// is what retires the shadow root at the exact moment the upload loop is about
// to consult the liveness probe.
//
// Keyed on the file rather than on a call ordinal because the upload loop
// retries a failed file once: failing "the first call" would let the retry
// succeed and produce a clean run, which is not the scenario either case is
// about. Keying on the file also makes both cases independent of the order the
// scan happens to walk the directory in.
type hookProvider struct {
	*mockProvider

	failBase   string // base name of the source file whose uploads always fail
	failErr    error
	onFail     func()
	onFailOnce sync.Once
}

func (h *hookProvider) Upload(localPath, remotePath string) error {
	if filepath.Base(localPath) == h.failBase {
		if h.onFail != nil {
			h.onFailOnce.Do(h.onFail)
		}
		return h.failErr
	}
	return h.mockProvider.Upload(localPath, remotePath)
}

// shadowedSourceDir returns the path rewritePathsForVSS will produce for
// srcDir under shadowRoot, and creates it. Computed the same way the
// production rewrite computes it (shadow root + the volume-relative
// remainder), so the test tracks the real mapping on both Windows — where
// filepath.VolumeName yields a drive letter — and Unix, where it yields "".
func shadowedSourceDir(t *testing.T, shadowRoot, srcDir string) string {
	t.Helper()
	vol := filepath.VolumeName(srcDir)
	shadowed := shadowRoot + srcDir[len(vol):]
	if err := os.MkdirAll(shadowed, 0o755); err != nil {
		t.Fatalf("MkdirAll(%s): %v", shadowed, err)
	}
	return shadowed
}

// TestRunBackupContext_InjectedVSSProviderDrivesSnapshotLiveness is the point
// of the seam (#3270). It runs the WHOLE manager path — provider acquisition,
// session creation, path rewrite, liveness-probe construction, upload loop —
// against an injected provider, and pins the two outcomes that the wiring is
// responsible for telling apart:
//
//   - the shadow root goes away mid-run: the run aborts with
//     errSourceSnapshotGone rather than recording every remaining file as
//     individually bad, which is #3260 verbatim.
//   - the shadow root survives: the same upload failure is recorded as one
//     ordinary per-file failure and the run finishes.
//
// Both cases run the real os.Stat against a real directory. Nothing here stubs
// snapshotRootStat, because the thing under test is precisely whether the
// session's ShadowPaths reach newShadowRootLiveness and its result reaches
// createSnapshotWithProgress — a probe driven by a stubbed stat would pass
// even with that wiring cut.
func TestRunBackupContext_InjectedVSSProviderDrivesSnapshotLiveness(t *testing.T) {
	tests := []struct {
		name string
		// retireShadowRoot removes the shadow root at the moment the first
		// upload fails, modelling the snapshot disappearing mid-run.
		retireShadowRoot bool
		wantAbort        bool
	}{
		{
			name:             "shadow root disappears mid-run aborts the whole run",
			retireShadowRoot: true,
			wantAbort:        true,
		},
		{
			name:             "shadow root survives so the same failure stays per-file",
			retireShadowRoot: false,
			wantAbort:        false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// The confirmation delay and the retry backoff are both real
			// wall-clock waits on the path under test; neither is what this
			// test is about.
			t.Cleanup(setShadowRootConfirmDelayForTest(0))
			t.Cleanup(setUploadRetryDelayForTest(0))

			shadowRoot := t.TempDir()
			srcDir := t.TempDir()
			shadowed := shadowedSourceDir(t, shadowRoot, srcDir)
			createTempFile(t, shadowed, "a.txt", "alpha")
			createTempFile(t, shadowed, "b.txt", "bravo")

			vssProvider := &fakeVSSProvider{
				session: &vss.VSSSession{
					ID:          "shadow-set-1",
					Volumes:     []string{filepath.VolumeName(srcDir)},
					ShadowPaths: map[string]string{filepath.VolumeName(srcDir): shadowRoot},
					CreatedAt:   time.Now().UTC(),
				},
			}

			backing := newMockProvider()
			storage := &hookProvider{
				mockProvider: backing,
				failBase:     "a.txt",
				failErr:      errors.New("destination refused the object"),
			}
			if tt.retireShadowRoot {
				storage.onFail = func() {
					if err := os.RemoveAll(shadowRoot); err != nil {
						t.Errorf("failed to retire the shadow root: %v", err)
					}
				}
			}

			mgr := NewBackupManager(BackupConfig{
				Provider:    storage,
				Paths:       []string{srcDir},
				VSSEnabled:  true,
				VSSProvider: vssProvider,
				StagingDir:  t.TempDir(),
			})

			job, err := mgr.RunBackupContext(context.Background(), nil)

			if create, release := vssProvider.counts(); create != 1 || release != 1 {
				t.Errorf("injected VSS provider: createCalls=%d releaseCalls=%d, want 1 and 1 — "+
					"the run must acquire the session from the injected provider and release it", create, release)
			}
			if job == nil {
				t.Fatalf("RunBackupContext returned a nil job (err=%v)", err)
			}

			if !tt.wantAbort {
				if err != nil {
					t.Fatalf("a live shadow root must not abort the run, got %v", err)
				}
				if errors.Is(err, errSourceSnapshotGone) {
					t.Fatalf("a live shadow root must never report the snapshot as gone")
				}
				if job.ErrorCount != 1 {
					t.Errorf("ErrorCount = %d, want 1 (the single per-file upload failure)", job.ErrorCount)
				}
				if job.Snapshot == nil || len(job.Snapshot.Files) != 1 {
					t.Errorf("want a snapshot holding the one file that did upload, got %+v", job.Snapshot)
				}
				return
			}

			if !errors.Is(err, errSourceSnapshotGone) {
				t.Fatalf("want the run to abort with errSourceSnapshotGone, got %v", err)
			}
			if job.Status != jobStatusFailed {
				t.Errorf("job.Status = %q, want %q", job.Status, jobStatusFailed)
			}
			// The abort must not be laundered into per-file verdicts: that
			// misattribution — 15 bad files recorded as 40 — is the whole of
			// #3260.
			if job.ErrorCount != 0 {
				t.Errorf("ErrorCount = %d, want 0: a snapshot-gone abort is a RUN failure, not a pile of per-file failures", job.ErrorCount)
			}
			// A journal is open (StagingDir is set), so the abort must leave
			// the partial prefix intact for the resume rather than deleting it.
			if len(backing.deleteCalls) != 0 {
				t.Errorf("a resumable snapshot-gone abort must not delete the partial remote prefix, deletes=%v", backing.deleteCalls)
			}
		})
	}
}

// TestRunBackupContext_InjectedVSSProviderReceivesRequestedVolumes pins the
// other half of the acquisition wiring: the volumes the run asks the provider
// to snapshot are derived from the CONFIGURED paths, not from the rewritten
// ones. Getting this backwards would ask VSS to snapshot a shadow device.
func TestRunBackupContext_InjectedVSSProviderReceivesRequestedVolumes(t *testing.T) {
	srcDir := t.TempDir()
	createTempFile(t, srcDir, "a.txt", "alpha")

	// No session: the run proceeds without VSS, which is all this test needs.
	vssProvider := &fakeVSSProvider{createErr: errors.New("no shadow copy for you")}

	mgr := NewBackupManager(BackupConfig{
		Provider:    newMockProvider(),
		Paths:       []string{srcDir},
		VSSEnabled:  true,
		VSSProvider: vssProvider,
		StagingDir:  t.TempDir(),
	})

	if _, err := mgr.RunBackupContext(context.Background(), nil); err != nil {
		t.Fatalf("a failed shadow copy must degrade to a live-read run, got %v", err)
	}

	want := extractVolumes([]string{srcDir})
	vssProvider.mu.Lock()
	got := vssProvider.requestedVolumes
	vssProvider.mu.Unlock()
	if len(got) != len(want) {
		t.Fatalf("requested volumes = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("requested volumes = %v, want %v", got, want)
		}
	}
}

// TestRunBackupContext_VSSProviderReturningNoSessionDoesNotPanic covers the
// contract violation the seam newly makes reachable: before the provider was
// injectable, only vss.NewProvider could reach the success branch, and it
// never returns (nil, nil). An injected provider can, and the success branch
// dereferences the session immediately — so this must degrade to the ordinary
// "VSS failed, read live" outcome instead of taking the agent down.
func TestRunBackupContext_VSSProviderReturningNoSessionDoesNotPanic(t *testing.T) {
	srcDir := t.TempDir()
	createTempFile(t, srcDir, "a.txt", "alpha")

	vssProvider := &fakeVSSProvider{} // nil session, nil error

	mgr := NewBackupManager(BackupConfig{
		Provider:    newMockProvider(),
		Paths:       []string{srcDir},
		VSSEnabled:  true,
		VSSProvider: vssProvider,
		StagingDir:  t.TempDir(),
	})

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("want the run to complete without VSS, got %v", err)
	}
	if job.VSSMetadata != nil {
		t.Errorf("no session means no VSS metadata, got %+v", job.VSSMetadata)
	}
	if job.Warning == "" {
		t.Error("a run that silently lost its shadow copy must carry a warning; an unwarned live-read run is #3027")
	}
	// Nothing was released, because nothing was ever created.
	if _, release := vssProvider.counts(); release != 0 {
		t.Errorf("releaseCalls = %d, want 0", release)
	}
}

// TestRunBackupContext_ConcurrentSessionRejectionDegradesToLiveRead pins what a
// run does when it gives up waiting for the process-wide snapshot-creation gate
// (#3269): it backs the data up from the live volume and says so, loudly.
//
// It matters because that gate is new. breeze-backup dispatches every IPC command
// in its own goroutine and builds an ephemeral BackupManager per
// server-dispatched backup_run, so overlapping runs are ordinary, not exotic.
// They normally all get a shadow copy — creation is merely queued — but a run
// whose creation deadline expires while it waits comes back with
// ErrVSSSessionInProgress, and it must NOT fail: a live-read backup is worth
// vastly more than no backup. It must also not be silent, or it becomes #3027 (a
// run indistinguishable from a clean VSS-backed backup while every locked file
// was skipped).
func TestRunBackupContext_ConcurrentSessionRejectionDegradesToLiveRead(t *testing.T) {
	srcDir := t.TempDir()
	createTempFile(t, srcDir, "a.txt", "alpha")

	vssProvider := &fakeVSSProvider{createErr: vss.ErrVSSSessionInProgress}

	mgr := NewBackupManager(BackupConfig{
		Provider:    newMockProvider(),
		Paths:       []string{srcDir},
		VSSEnabled:  true,
		VSSProvider: vssProvider,
		StagingDir:  t.TempDir(),
	})

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("losing the VSS session race must not fail the run, got %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Errorf("job.Status = %q, want %q", job.Status, jobStatusCompleted)
	}
	if job.Snapshot == nil || len(job.Snapshot.Files) != 1 {
		t.Errorf("the file must still be backed up from the live volume, got %+v", job.Snapshot)
	}
	if job.Warning == "" {
		t.Error("a live-read run must carry a warning saying so; an unwarned one is #3027")
	}
	if job.VSSMetadata != nil {
		t.Errorf("no session means no VSS metadata, got %+v", job.VSSMetadata)
	}
	// Nothing was created, so nothing may be released — releasing a session the
	// provider never handed out is how the real provider would tear down another
	// run's live snapshot.
	if create, release := vssProvider.counts(); create != 1 || release != 0 {
		t.Errorf("createCalls=%d releaseCalls=%d, want 1 and 0", create, release)
	}
}

// TestResolveVSSProvider pins the resolution matrix itself, including the one
// judgement call in it: an injected provider overrides the runtime.GOOS gate,
// because that gate is about the built-in provider being a stub off Windows,
// not about the platform being incapable.
func TestResolveVSSProvider(t *testing.T) {
	injected := &fakeVSSProvider{}

	tests := []struct {
		name        string
		config      BackupConfig
		wantUse     bool
		wantSame    vss.Provider // non-nil when the exact injected value must come back
		windowsOnly bool         // wantUse is only true on Windows
	}{
		{
			name:    "VSS disabled and no provider",
			config:  BackupConfig{},
			wantUse: false,
		},
		{
			name:   "VSS disabled beats an injected provider",
			config: BackupConfig{VSSProvider: injected},
			// VSSEnabled stays the master switch: injecting a provider must
			// not switch VSS on for a run that did not ask for it.
			wantUse: false,
		},
		{
			name:        "VSS enabled with no provider falls back to the platform default",
			config:      BackupConfig{VSSEnabled: true},
			windowsOnly: true,
		},
		{
			name:     "VSS enabled with an injected provider uses it on every platform",
			config:   BackupConfig{VSSEnabled: true, VSSProvider: injected},
			wantUse:  true,
			wantSame: injected,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			wantUse := tt.wantUse
			if tt.windowsOnly {
				wantUse = runtime.GOOS == "windows"
			}
			provider, use := NewBackupManager(tt.config).resolveVSSProvider()
			if use != wantUse {
				t.Fatalf("useVSS = %v, want %v", use, wantUse)
			}
			if !use {
				if provider != nil {
					t.Errorf("provider = %v, want nil when VSS is off for the run", provider)
				}
				return
			}
			if provider == nil {
				t.Fatal("useVSS is true but the provider is nil")
			}
			if tt.wantSame != nil && provider != tt.wantSame {
				t.Errorf("provider = %v, want the injected instance", provider)
			}
		})
	}
}
