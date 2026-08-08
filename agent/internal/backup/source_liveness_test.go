package backup

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// fakeStat drives snapshotRootStat from a per-path script so a test can retire
// a shadow root mid-run without a real VSS session. Absent paths report
// fs.ErrNotExist; a path can be given a non-not-exist error to model an
// inconclusive stat.
type fakeStat struct {
	mu      sync.Mutex
	present map[string]bool
	errFor  map[string]error
}

func newFakeStat(present ...string) *fakeStat {
	f := &fakeStat{present: map[string]bool{}, errFor: map[string]error{}}
	for _, p := range present {
		f.present[p] = true
	}
	return f
}

func (f *fakeStat) stat(path string) (os.FileInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err, ok := f.errFor[path]; ok {
		return nil, err
	}
	if !f.present[path] {
		return nil, &fs.PathError{Op: "stat", Path: path, Err: syscall.ENOENT}
	}
	// The probe only ever inspects the error, never the FileInfo.
	return nil, nil
}

func (f *fakeStat) set(path string, present bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.present[path] = present
}

func (f *fakeStat) setErr(path string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.errFor[path] = err
}

// install swaps in the fake stat and neutralises the confirmation delay so the
// suite does not pay it on every probe. Tests that care about the confirmation
// behaviour drive it explicitly.
func (f *fakeStat) install(t *testing.T) {
	t.Helper()
	t.Cleanup(setSnapshotRootStatForTest(f.stat))
	t.Cleanup(setShadowRootConfirmDelayForTest(0))
}

const (
	shadowC = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy26`
	shadowD = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy27`
	// A source path as rewritePathsForVSS produces it: the shadow device path
	// with the volume-relative remainder appended.
	fileOnC = shadowC + `\Users\u\Documents\report.docx`
	fileOnD = shadowD + `\Data\db.mdf`
)

func TestNewShadowRootLiveness(t *testing.T) {
	tests := []struct {
		name        string
		present     []string
		shadowPaths map[string]string
		wantNil     bool
		// retire is applied after construction, before probing.
		retire    []string
		probePath string
		wantGone  bool
		wantNames string
	}{
		{
			name:        "no VSS session means nothing to defend",
			shadowPaths: nil,
			wantNil:     true,
		},
		{
			name:        "empty device path is not watchable",
			shadowPaths: map[string]string{`C:`: ""},
			wantNil:     true,
		},
		{
			// The self-calibration guard: a root that never stat'd cleanly is
			// excluded, so its later failure can never abort a healthy run.
			name:        "root that does not resolve at construction is excluded",
			present:     nil,
			shadowPaths: map[string]string{`C:`: shadowC},
			wantNil:     true,
		},
		{
			name:        "live root reports alive",
			present:     []string{shadowC},
			shadowPaths: map[string]string{`C:`: shadowC},
			probePath:   fileOnC,
			wantGone:    false,
		},
		{
			name:        "root that resolved then vanished reports gone",
			present:     []string{shadowC},
			shadowPaths: map[string]string{`C:`: shadowC},
			retire:      []string{shadowC},
			probePath:   fileOnC,
			wantGone:    true,
			wantNames:   shadowC,
		},
		{
			// Per-volume scoping: losing D's shadow copy must not abort a run
			// that is still reading healthy files from C.
			name:        "losing another volume's root does not condemn this file",
			present:     []string{shadowC, shadowD},
			shadowPaths: map[string]string{`C:`: shadowC, `D:`: shadowD},
			retire:      []string{shadowD},
			probePath:   fileOnC,
			wantGone:    false,
		},
		{
			name:        "the volume that actually vanished does condemn its own files",
			present:     []string{shadowC, shadowD},
			shadowPaths: map[string]string{`C:`: shadowC, `D:`: shadowD},
			retire:      []string{shadowD},
			probePath:   fileOnD,
			wantGone:    true,
			wantNames:   shadowD,
		},
		{
			// A staging/live-read path never went through a shadow root, so
			// there is no snapshot behind it to have gone away.
			name:        "path outside every watched root is never condemned",
			present:     []string{shadowC},
			shadowPaths: map[string]string{`C:`: shadowC},
			retire:      []string{shadowC},
			probePath:   `C:\ProgramData\breeze\staging\systemstate.bin`,
			wantGone:    false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeStat(tc.present...)
			f.install(t)

			probe := newShadowRootLiveness(tc.shadowPaths)
			if tc.wantNil {
				if probe != nil {
					t.Fatal("want a nil probe (nothing watchable), got one")
				}
				return
			}
			if probe == nil {
				t.Fatal("want a probe over the live roots, got nil")
			}
			for _, p := range tc.retire {
				f.set(p, false)
			}
			err := probe(tc.probePath)
			if !tc.wantGone {
				if err != nil {
					t.Fatalf("want the snapshot reported alive for %q, got %v", tc.probePath, err)
				}
				return
			}
			if err == nil {
				t.Fatalf("want the vanished shadow root reported gone for %q, got nil", tc.probePath)
			}
			if !errors.Is(err, errSourceSnapshotGone) {
				t.Fatalf("want errSourceSnapshotGone, got %v", err)
			}
			// The abort message must name the root — #3260's own complaint is
			// that the operator-visible failure said nothing usable.
			if !strings.Contains(err.Error(), tc.wantNames) {
				t.Fatalf("error %q does not name the vanished root %q", err, tc.wantNames)
			}
		})
	}
}

// Shadow-copy device paths are NUMBERED, so `...ShadowCopy2` is a bare string
// prefix of `...ShadowCopy26`. Matching must be on a path boundary: otherwise a
// file rooted under an UNWATCHED ShadowCopy26 would be checked against
// ShadowCopy2, and losing that unrelated volume would abort a healthy run.
func TestMatchShadowRoot_MatchesOnPathBoundaryNotBarePrefix(t *testing.T) {
	const shortRoot = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy2`
	// Longest-first, as newShadowRootLiveness orders them.
	roots := []string{shadowC, shortRoot}

	tests := []struct {
		name     string
		path     string
		wantRoot string
		wantOK   bool
	}{
		{
			name:     "path under the short root matches it",
			path:     shortRoot + `\Users\u\a.txt`,
			wantRoot: shortRoot,
			wantOK:   true,
		},
		{
			name:     "path under the long root matches the long root, not the short one",
			path:     shadowC + `\Users\u\a.txt`,
			wantRoot: shadowC,
			wantOK:   true,
		},
		{
			// The regression this boundary check exists for: ShadowCopy27 is
			// not watched, and must NOT fall through onto ShadowCopy2.
			name:   "path under an unwatched sibling root matches nothing",
			path:   shadowD + `\Data\db.mdf`,
			wantOK: false,
		},
		{
			name:     "the bare root itself matches",
			path:     shortRoot,
			wantRoot: shortRoot,
			wantOK:   true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root, ok := matchShadowRoot(roots, tc.path)
			if ok != tc.wantOK {
				t.Fatalf("matchShadowRoot(%q) ok = %v, want %v (root %q)", tc.path, ok, tc.wantOK, root)
			}
			if ok && root != tc.wantRoot {
				t.Fatalf("matchShadowRoot(%q) = %q, want %q", tc.path, root, tc.wantRoot)
			}
		})
	}
}

// A stat that fails for a reason OTHER than "does not exist" is not evidence
// the snapshot went away. Aborting a whole run on a transient I/O hiccup would
// recreate #3260 in a new form.
func TestShadowRootLiveness_InconclusiveStatIsNotGone(t *testing.T) {
	f := newFakeStat(shadowC)
	f.install(t)
	probe := newShadowRootLiveness(map[string]string{`C:`: shadowC})
	if probe == nil {
		t.Fatal("want a probe, got nil")
	}
	f.setErr(shadowC, errors.New("the device is not ready"))

	if err := probe(fileOnC); err != nil {
		t.Fatalf("an inconclusive stat error must not report the snapshot gone, got %v", err)
	}
}

// Killing a whole backup is drastic enough to require confirmation: a root that
// is missing once but back on the confirmation look must not abort the run.
func TestShadowRootLiveness_TransientMissRequiresConfirmation(t *testing.T) {
	// Scripted stat: construction sees it present, the first probe sees it
	// missing, every look after that sees it present again.
	var mu sync.Mutex
	calls := 0
	t.Cleanup(setSnapshotRootStatForTest(func(string) (os.FileInfo, error) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if calls == 2 {
			return nil, &fs.PathError{Op: "stat", Path: shadowC, Err: syscall.ENOENT}
		}
		return nil, nil
	}))
	t.Cleanup(setShadowRootConfirmDelayForTest(0))

	probe := newShadowRootLiveness(map[string]string{`C:`: shadowC})
	if probe == nil {
		t.Fatal("want a probe, got nil")
	}
	if err := probe(fileOnC); err != nil {
		t.Fatalf("a single anomalous stat must not abort the run, got %v", err)
	}
	mu.Lock()
	got := calls
	mu.Unlock()
	if got != 3 {
		t.Fatalf("want 3 stats (construction + miss + confirmation), got %d", got)
	}
}

// ...and a root that is still missing on the confirmation look IS gone.
func TestShadowRootLiveness_ConfirmedMissIsGone(t *testing.T) {
	f := newFakeStat(shadowC)
	f.install(t)
	probe := newShadowRootLiveness(map[string]string{`C:`: shadowC})
	f.set(shadowC, false)

	err := probe(fileOnC)
	if !errors.Is(err, errSourceSnapshotGone) {
		t.Fatalf("want errSourceSnapshotGone for a confirmed-missing root, got %v", err)
	}
}

// expiringProvider fails a chosen file, and from that moment on every
// subsequent file fails too — the exact #3260 shape, where a dead shadow copy
// makes every remaining healthy file unreadable.
type expiringProvider struct {
	mu sync.Mutex
	// killAfter is the source path whose failure kills the snapshot.
	killAfter string
	dead      bool
	onDeath   func()
	attempts  []string
}

func (p *expiringProvider) UploadContext(_ context.Context, localPath, _ string) error {
	p.mu.Lock()
	p.attempts = append(p.attempts, localPath)
	dead := p.dead
	trigger := localPath == p.killAfter
	if trigger && !dead {
		p.dead = true
	}
	onDeath := p.onDeath
	p.mu.Unlock()

	if trigger {
		if onDeath != nil {
			onDeath()
		}
		// The denial that starts it all (#3259's ACL case).
		return permissionErr(localPath)
	}
	if dead {
		// Everything read after the snapshot dies looks like
		// ERROR_PATH_NOT_FOUND.
		return notFoundErr(localPath)
	}
	return nil
}

func (p *expiringProvider) Upload(localPath, remotePath string) error {
	return p.UploadContext(context.Background(), localPath, remotePath)
}
func (p *expiringProvider) Download(string, string) error { return nil }
func (p *expiringProvider) List(string) ([]string, error) { return nil, nil }
func (p *expiringProvider) Delete(string) error           { return nil }

func (p *expiringProvider) attemptCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.attempts)
}

// The #3260 regression test. A shadow copy that goes away mid-run must abort
// the run with an explicit error, NOT record every remaining healthy file as an
// individual per-file failure.
func TestCreateSnapshot_ShadowCopyLostMidRun_AbortsExplicitly(t *testing.T) {
	defer setShortUploadRetryDelayForTest(0)()
	defer setUploadRetryDelayForTest(0)()

	f := newFakeStat(shadowC)
	f.install(t)

	// Real files under ONE directory (the loop checksums and compresses through
	// them), with that directory standing in for the shadow root: it exercises
	// the real prefix matching without needing a Windows device path.
	root, files := filesUnderCommonRoot(t, 6)
	f.set(root, true)

	provider := &expiringProvider{
		killAfter: files[2].sourcePath,
		// The snapshot goes away at the same instant the third file fails.
		onDeath: func() { f.set(root, false) },
	}
	liveness := newShadowRootLiveness(map[string]string{`C:`: root})
	if liveness == nil {
		t.Fatal("test setup: want a liveness probe, got nil")
	}

	snap, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, liveness)

	if err == nil {
		t.Fatal("want the run aborted when the shadow copy is lost, got nil error")
	}
	if !errors.Is(err, errSourceSnapshotGone) {
		t.Fatalf("want errSourceSnapshotGone, got %v", err)
	}
	if snap != nil {
		t.Fatalf("want no snapshot from an aborted run, got one with %d files", len(snap.Files))
	}
	// The whole point: files 4-6 were healthy and must never have been tried
	// against a dead snapshot, let alone recorded as bad. Files 1-2 uploaded,
	// file 3 failed and triggered the abort.
	if got := provider.attemptCount(); got != 3 {
		t.Fatalf("want the run to stop at the failing file (3 attempts), got %d — it kept walking a dead snapshot", got)
	}
	// The operator-visible error has to say what happened and how far it got.
	for _, want := range []string{"no longer available", root, "2 of 6 files uploaded"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("abort error %q is missing %q", err, want)
		}
	}
}

// filesUnderCommonRoot writes n real files into a single directory and returns
// that directory plus the backupFiles for them. The shared directory stands in
// for a VSS shadow root so matchShadowRoot's prefix logic is exercised for real
// on any OS (writeTempFile puts each file in its own subdirectory, which would
// give the files no common prefix to match on).
func filesUnderCommonRoot(t *testing.T, n int) (string, []backupFile) {
	t.Helper()
	root := t.TempDir()
	files := make([]backupFile, 0, n)
	for i := 0; i < n; i++ {
		body := []byte(fmt.Sprintf("file-%d", i))
		p := filepath.Join(root, fmt.Sprintf("f%d.txt", i))
		if err := os.WriteFile(p, body, 0o600); err != nil {
			t.Fatalf("write %s: %v", p, err)
		}
		files = append(files, backupFile{
			sourcePath:   p,
			snapshotPath: fmt.Sprintf("f%d", i),
			size:         int64(len(body)),
		})
	}
	return root, files
}

// dyingOnRetryProvider fails a file's FIRST attempt with a permission denial
// (the #3259 case, which takes the short retry) while the snapshot is still
// alive, then kills the snapshot as part of serving the RETRY. Every other file
// uploads cleanly.
//
// That last part is what makes this test isolate the SECOND liveness probe:
// with only healthy files afterwards, no later per-file failure ever occurs, so
// the pre-retry probe can never fire again. If the post-retry probe in
// createSnapshotWithProgress were removed, the dead snapshot would be recorded
// as a lone per-file failure and the run would report success.
type dyingOnRetryProvider struct {
	mu       sync.Mutex
	target   string
	attempts map[string]int
	onDeath  func()
}

func (p *dyingOnRetryProvider) UploadContext(_ context.Context, localPath, _ string) error {
	p.mu.Lock()
	p.attempts[localPath]++
	n := p.attempts[localPath]
	isTarget := localPath == p.target
	onDeath := p.onDeath
	p.mu.Unlock()

	if !isTarget {
		return nil
	}
	if n == 1 {
		// Snapshot still healthy here — the pre-retry probe must say "alive".
		return permissionErr(localPath)
	}
	// The retry itself is where the shadow copy goes away. #3260's tell was
	// exactly this: one file's error flipping ACCESS_DENIED -> PATH_NOT_FOUND
	// between the first attempt and the retry.
	if onDeath != nil {
		onDeath()
	}
	return notFoundErr(localPath)
}

func (p *dyingOnRetryProvider) Upload(localPath, remotePath string) error {
	return p.UploadContext(context.Background(), localPath, remotePath)
}
func (p *dyingOnRetryProvider) Download(string, string) error { return nil }
func (p *dyingOnRetryProvider) List(string) ([]string, error) { return nil, nil }
func (p *dyingOnRetryProvider) Delete(string) error           { return nil }

// The snapshot can die during the retry backoff, not just before it — the
// upload loop probes liveness on both sides of the retry, and this pins the
// second probe specifically.
func TestCreateSnapshot_ShadowCopyLostDuringRetry_AbortsExplicitly(t *testing.T) {
	defer setShortUploadRetryDelayForTest(0)()
	defer setUploadRetryDelayForTest(0)()

	f := newFakeStat()
	f.install(t)

	root, files := filesUnderCommonRoot(t, 4)
	f.set(root, true)

	provider := &dyingOnRetryProvider{
		target:   files[1].sourcePath,
		attempts: map[string]int{},
		onDeath:  func() { f.set(root, false) },
	}
	liveness := newShadowRootLiveness(map[string]string{`C:`: root})
	if liveness == nil {
		t.Fatal("test setup: want a liveness probe, got nil")
	}

	snap, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, liveness)

	if !errors.Is(err, errSourceSnapshotGone) {
		t.Fatalf("want errSourceSnapshotGone when the snapshot dies during the retry, got %v", err)
	}
	if snap != nil {
		t.Fatalf("want no snapshot from an aborted run, got one with %d files", len(snap.Files))
	}
	// File 2 was attempted twice (initial + retry); files 3-4 must never have
	// been reached.
	provider.mu.Lock()
	defer provider.mu.Unlock()
	if got := provider.attempts[files[1].sourcePath]; got != 2 {
		t.Fatalf("want 2 attempts on the failing file (initial + retry), got %d", got)
	}
	for _, later := range files[2:] {
		if got := provider.attempts[later.sourcePath]; got != 0 {
			t.Fatalf("file %s was uploaded against a dead snapshot (%d attempts)", later.snapshotPath, got)
		}
	}
}

// A run with no snapshot to defend (nil probe — the non-VSS case) must behave
// exactly as before: per-file failures stay per-file, the job carries on.
func TestCreateSnapshot_NilLiveness_KeepsPerFileFailureBehaviour(t *testing.T) {
	defer setUploadRetryDelayForTest(0)()

	good := writeTempFile(t, "good")
	bad := writeTempFile(t, "bad")
	p := newFixedErrorProvider(notFoundErr(bad), bad)
	files := []backupFile{
		{sourcePath: good, snapshotPath: "good", size: 4},
		{sourcePath: bad, snapshotPath: "bad", size: 3},
	}

	snap, err := createSnapshotWithProgress(context.Background(), p, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("a per-file failure must not abort a run with no snapshot to defend, got %v", err)
	}
	if snap == nil || len(snap.Files) != 1 || len(snap.UploadFailures) != 1 {
		t.Fatalf("want 1 uploaded + 1 recorded failure, got %+v", snap)
	}
}

// A live snapshot must not abort: the probe answering "alive" leaves the
// existing skip-and-continue behaviour completely untouched.
func TestCreateSnapshot_LiveSnapshot_DoesNotAbortOnPerFileFailure(t *testing.T) {
	defer setUploadRetryDelayForTest(0)()

	f := newFakeStat()
	f.install(t)

	root, files := filesUnderCommonRoot(t, 2)
	f.set(root, true)
	liveness := newShadowRootLiveness(map[string]string{`C:`: root})
	if liveness == nil {
		t.Fatal("test setup: want a liveness probe, got nil")
	}

	p := newFixedErrorProvider(notFoundErr(files[1].sourcePath), files[1].sourcePath)

	snap, err := createSnapshotWithProgress(context.Background(), p, files, nil, nil, nil, liveness)
	if err != nil {
		t.Fatalf("a live snapshot must not abort on a per-file failure, got %v", err)
	}
	if snap == nil || len(snap.Files) != 1 || len(snap.UploadFailures) != 1 {
		t.Fatalf("want 1 uploaded + 1 recorded failure, got %+v", snap)
	}
}

// Job cancellation must still win: a cancelled run reports errBackupStopped
// (which the manager maps to "stopped"), never the snapshot-loss abort.
func TestCreateSnapshot_CancelBeatsLivenessAbort(t *testing.T) {
	defer setUploadRetryDelayForTest(10 * time.Millisecond)()

	f := newFakeStat()
	f.install(t)

	root, files := filesUnderCommonRoot(t, 1)
	f.set(root, true)
	liveness := newShadowRootLiveness(map[string]string{`C:`: root})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := createSnapshotWithProgress(ctx, newMockProvider(), files, nil, nil, nil, liveness)
	if !errors.Is(err, errBackupStopped) {
		t.Fatalf("want errBackupStopped for a cancelled run, got %v", err)
	}
}
