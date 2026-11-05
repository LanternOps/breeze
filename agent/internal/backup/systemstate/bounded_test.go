package systemstate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// setCollectionDeadlines shortens the package's deadlines for one test.
func setCollectionDeadlines(t *testing.T, step, collection, grace time.Duration) {
	t.Helper()
	origStep, origCollection, origGrace := stepTimeout, collectionTimeout, abandonGrace
	t.Cleanup(func() { stepTimeout, collectionTimeout, abandonGrace = origStep, origCollection, origGrace })
	stepTimeout, collectionTimeout, abandonGrace = step, collection, grace
}

// returnsWithin fails the test if fn is still running after limit. The limit is
// the point of these tests: without it a regression hangs to the package's
// 10-minute timeout, which is the bug.
func returnsWithin(t *testing.T, limit time.Duration, fn func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		fn()
	}()
	select {
	case <-done:
	case <-time.After(limit):
		t.Fatalf("did not return within %s", limit)
	}
}

// stuckStep ignores its context and blocks until the test ends, the way a read
// of a dead mount sits in the kernel.
func stuckStep(t *testing.T) func(context.Context, string) ([]Artifact, error) {
	t.Helper()
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	return func(context.Context, string) ([]Artifact, error) {
		<-release
		return nil, nil
	}
}

func healthyStep(name string) func(context.Context, string) ([]Artifact, error) {
	return func(context.Context, string) ([]Artifact, error) {
		return []Artifact{{Name: name}}, nil
	}
}

func artifactNames(arts []Artifact) []string {
	names := make([]string, 0, len(arts))
	for _, a := range arts {
		names = append(names, a.Name)
	}
	return names
}

// flipContext answers Err() with nil for its first `remaining` calls and with
// context.Canceled after that, so a test can end the context at an exact point
// in a copy without racing a timer.
type flipContext struct {
	context.Context
	remaining atomic.Int32
}

func newFlipContext(checks int32) *flipContext {
	c := &flipContext{Context: context.Background()}
	c.remaining.Store(checks)
	return c
}

func (c *flipContext) Err() error {
	if c.remaining.Add(-1) < 0 {
		return context.Canceled
	}
	return nil
}

// #11201: a stuck step costs its own state and nothing else.
func TestRunBestEffortSteps_StuckStepIsReportedAndTheRunContinues(t *testing.T) {
	setCollectionDeadlines(t, 500*time.Millisecond, time.Minute, 200*time.Millisecond)

	manifest := &SystemStateManifest{}
	steps := []collectionStep{
		{"before", healthyStep("before")},
		{"stuck", stuckStep(t)},
		{"after", healthyStep("after")},
	}
	var err error
	returnsWithin(t, 10*time.Second, func() {
		err = runBestEffortSteps(context.Background(), manifest, steps, t.TempDir())
	})
	if err != nil {
		t.Fatalf("a stuck step must not fail a run that captured other state: %v", err)
	}
	if !slices.Equal(manifest.IncompleteSteps, []string{"stuck"}) {
		t.Errorf("IncompleteSteps = %v, want [stuck]", manifest.IncompleteSteps)
	}
	if got := artifactNames(manifest.Artifacts); !slices.Equal(got, []string{"before", "after"}) {
		t.Errorf("artifacts = %v, want the steps either side of the stuck one", got)
	}
}

// A step failing on its own stays a log line on Linux/macOS: it is permanent
// for the host (no systemctl) and would otherwise warn on every run.
func TestRunBestEffortSteps_OrdinaryFailureStaysOutOfIncompleteSteps(t *testing.T) {
	manifest := &SystemStateManifest{}
	steps := []collectionStep{
		{"services", func(context.Context, string) ([]Artifact, error) { return nil, errors.New("no systemctl") }},
		{"etc", healthyStep("etc")},
	}
	if err := runBestEffortSteps(context.Background(), manifest, steps, t.TempDir()); err != nil {
		t.Fatalf("runBestEffortSteps: %v", err)
	}
	if len(manifest.IncompleteSteps) != 0 {
		t.Errorf("IncompleteSteps = %v, want none", manifest.IncompleteSteps)
	}
}

func TestRunBestEffortSteps_NothingCapturedIsAnError(t *testing.T) {
	setCollectionDeadlines(t, 50*time.Millisecond, time.Minute, 50*time.Millisecond)

	manifest := &SystemStateManifest{}
	var err error
	returnsWithin(t, 10*time.Second, func() {
		err = runBestEffortSteps(context.Background(), manifest, []collectionStep{{"stuck", stuckStep(t)}}, t.TempDir())
	})
	if err == nil || !strings.Contains(err.Error(), "produced no artifacts") || !strings.Contains(err.Error(), "stuck: stopped by its deadline") {
		t.Fatalf("err = %v, want the no-artifacts error", err)
	}
	if !slices.Equal(manifest.IncompleteSteps, []string{"stuck"}) {
		t.Errorf("IncompleteSteps = %v, want [stuck]", manifest.IncompleteSteps)
	}
}

// The Windows path: a stuck required step fails the run hard (an image without
// its registry would not boot) and says why; the reason reaches error_log.
func TestRunCollectionSteps_StuckRequiredStepFailsWithItsReason(t *testing.T) {
	setCollectionDeadlines(t, 500*time.Millisecond, time.Minute, 200*time.Millisecond)

	manifest := &SystemStateManifest{}
	steps := []collectionStep{
		{"registry", stuckStep(t)},
		{"services", healthyStep("services")},
	}
	var err error
	returnsWithin(t, 10*time.Second, func() {
		err = runCollectionSteps(context.Background(), manifest, steps, t.TempDir(), map[string]bool{"registry": true})
	})
	var reqErr *requiredStepsError
	if !errors.As(err, &reqErr) {
		t.Fatalf("err = %v (%T), want *requiredStepsError", err, err)
	}
	if !slices.Equal(reqErr.Missing, []string{"registry"}) {
		t.Errorf("Missing = %v, want [registry]", reqErr.Missing)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err = %v, want it to carry the deadline", err)
	}
	if !strings.Contains(err.Error(), "stopped by its deadline") {
		t.Errorf("err = %q, want it to say the step ran out of time", err)
	}
	if got := artifactNames(manifest.Artifacts); !slices.Equal(got, []string{"services"}) {
		t.Errorf("artifacts = %v, want the later step to have run", got)
	}
}

func TestRunCollectionSteps_StuckOptionalStepOnlyWarns(t *testing.T) {
	setCollectionDeadlines(t, 500*time.Millisecond, time.Minute, 200*time.Millisecond)

	manifest := &SystemStateManifest{}
	steps := []collectionStep{
		{"registry", healthyStep("registry")},
		{"features", stuckStep(t)},
	}
	var err error
	returnsWithin(t, 10*time.Second, func() {
		err = runCollectionSteps(context.Background(), manifest, steps, t.TempDir(), map[string]bool{"registry": true})
	})
	if err != nil {
		t.Fatalf("a stuck best-effort step must not fail the run: %v", err)
	}
	if !slices.Equal(manifest.IncompleteSteps, []string{"features"}) {
		t.Errorf("IncompleteSteps = %v, want [features]", manifest.IncompleteSteps)
	}
}

// A step that notices the deadline keeps what it captured, and is still flagged.
func TestRunBounded_StepHonouringItsContextKeepsPartialResult(t *testing.T) {
	setCollectionDeadlines(t, 50*time.Millisecond, time.Minute, 10*time.Second)

	manifest := &SystemStateManifest{}
	steps := []collectionStep{{"etc", func(ctx context.Context, _ string) ([]Artifact, error) {
		<-ctx.Done()
		return []Artifact{{Name: "passwd"}}, ctx.Err()
	}}}
	if err := runBestEffortSteps(context.Background(), manifest, steps, t.TempDir()); err != nil {
		t.Fatalf("runBestEffortSteps: %v", err)
	}
	if got := artifactNames(manifest.Artifacts); !slices.Equal(got, []string{"passwd"}) {
		t.Errorf("artifacts = %v, want the partial capture", got)
	}
	if !slices.Equal(manifest.IncompleteSteps, []string{"etc"}) {
		t.Errorf("IncompleteSteps = %v, want [etc]", manifest.IncompleteSteps)
	}
}

// collectPackages ignores a failed dpkg, so a dpkg killed by the deadline looks
// like a clean step that found nothing. It must still be reported.
func TestRunBounded_StepSwallowingTheDeadlineIsStillReported(t *testing.T) {
	setCollectionDeadlines(t, 50*time.Millisecond, time.Minute, 10*time.Second)

	_, err := runBounded(context.Background(), "packages", stepTimeout, func(ctx context.Context) ([]Artifact, error) {
		<-ctx.Done()
		return nil, nil // the killed subprocess's error was dropped
	})
	if !isCollectionInterrupted(err) {
		t.Fatalf("err = %v, want an interrupted step", err)
	}
}

func TestRunBounded_LeavesAFastStepAlone(t *testing.T) {
	want := errors.New("no systemctl")
	got, err := runBounded(context.Background(), "services", time.Minute, func(context.Context) (string, error) {
		return "partial", want
	})
	if got != "partial" || !errors.Is(err, want) {
		t.Errorf("got (%q, %v), want the step's own result", got, err)
	}
	if isCollectionInterrupted(err) {
		t.Errorf("err = %v: a step that failed in time was reported as interrupted", err)
	}
}

func TestRunBounded_PanicBecomesAnError(t *testing.T) {
	_, err := runBounded(context.Background(), "services", time.Minute, func(context.Context) (string, error) {
		panic("boom")
	})
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v, want the panic reported", err)
	}
}

// The run's context, not just the step deadline: cancelling a backup stops the
// step it is in.
func TestRunBounded_RunCancellationStopsTheStep(t *testing.T) {
	setCollectionDeadlines(t, time.Hour, time.Hour, 10*time.Second)

	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	go func() {
		<-started
		cancel()
	}()
	var err error
	returnsWithin(t, 10*time.Second, func() {
		_, err = runBounded(ctx, "etc", stepTimeout, func(stepCtx context.Context) ([]Artifact, error) {
			close(started)
			<-stepCtx.Done()
			return nil, stepCtx.Err()
		})
	})
	if !isCollectionInterrupted(err) || !errors.Is(err, context.Canceled) || !strings.Contains(err.Error(), "the run's cancellation") {
		t.Fatalf("err = %v, want an interrupted step caused by cancellation", err)
	}
}

// Every step sees the whole-collection budget, however many there are.
func TestCollectSystemStateWithOptions_BudgetCoversTheWholeCollection(t *testing.T) {
	setCollectionDeadlines(t, time.Hour, 600*time.Millisecond, 200*time.Millisecond)

	stubPlatformCollector(t, func(ctx context.Context, stagingDir string) (*SystemStateManifest, error) {
		manifest := &SystemStateManifest{}
		steps := []collectionStep{
			{"first", healthyStep("first")},
			{"stuck", stuckStep(t)},
			{"second_stuck", stuckStep(t)},
		}
		return manifest, runBestEffortSteps(ctx, manifest, steps, stagingDir)
	})

	var manifest *SystemStateManifest
	var stagingDir string
	var err error
	returnsWithin(t, 10*time.Second, func() {
		manifest, stagingDir, err = CollectSystemStateWithOptions(context.Background(), CollectOptions{})
	})
	if err != nil {
		t.Fatalf("CollectSystemStateWithOptions: %v", err)
	}
	defer func() { _ = os.RemoveAll(stagingDir) }()
	if !slices.Equal(manifest.IncompleteSteps, []string{"stuck", "second_stuck"}) {
		t.Errorf("IncompleteSteps = %v, want both stuck steps", manifest.IncompleteSteps)
	}
}

func TestAttachHardwareProfile_StuckProbeIsReported(t *testing.T) {
	setCollectionDeadlines(t, 50*time.Millisecond, time.Minute, 50*time.Millisecond)

	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	manifest := &SystemStateManifest{}
	returnsWithin(t, 10*time.Second, func() {
		attachHardwareProfile(context.Background(), manifest, func(context.Context) (*HardwareProfile, error) {
			<-release
			return &HardwareProfile{}, nil
		})
	})
	if manifest.HardwareProfile != nil {
		t.Errorf("HardwareProfile = %+v, want none from a probe that never finished", manifest.HardwareProfile)
	}
	if !slices.Equal(manifest.IncompleteSteps, []string{hardwareProfileStep}) {
		t.Errorf("IncompleteSteps = %v, want [%s]", manifest.IncompleteSteps, hardwareProfileStep)
	}
}

// A hardware profile the collector could not produce is not an incomplete
// capture: the step list decides that, as it always has.
func TestAttachHardwareProfile_CollectorErrorIsOnlyLogged(t *testing.T) {
	manifest := &SystemStateManifest{}
	attachHardwareProfile(context.Background(), manifest, func(context.Context) (*HardwareProfile, error) {
		return nil, errors.New("unsupported")
	})
	if len(manifest.IncompleteSteps) != 0 {
		t.Errorf("IncompleteSteps = %v, want none", manifest.IncompleteSteps)
	}
}

func TestOSVersion_StuckProbeFallsBack(t *testing.T) {
	setCollectionDeadlines(t, time.Minute, time.Minute, 50*time.Millisecond)
	origVersion := versionTimeout
	t.Cleanup(func() { versionTimeout = origVersion })
	versionTimeout = 50 * time.Millisecond

	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	var got string
	returnsWithin(t, 10*time.Second, func() {
		got = osVersion(context.Background(), "linux", func(context.Context) string {
			<-release
			return "never"
		})
	})
	if got != "linux" {
		t.Errorf("version = %q, want the fallback", got)
	}
}

// writeTree creates count files under root; names sort a0, a1, ...
func writeTree(t *testing.T, root string, count int) {
	t.Helper()
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	for i := range count {
		name := "a" + string(rune('0'+i))
		if err := os.WriteFile(filepath.Join(root, name), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// #11201's copy: copyTree stops at the context and says so, where an unreadable
// file only gets skipped.
func TestCopyTree_StopsWhenTheContextEnds(t *testing.T) {
	src := filepath.Join(t.TempDir(), "src")
	dst := filepath.Join(t.TempDir(), "dst")
	writeTree(t, src, 5)

	// The root dir's walk check, then a0's walk, post-open and read-loop checks.
	err := copyTree(newFlipContext(5), src, dst)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("copyTree err = %v, want the context's error", err)
	}
	entries, readErr := os.ReadDir(dst)
	if readErr != nil {
		t.Fatalf("read dst: %v", readErr)
	}
	if len(entries) >= 5 {
		t.Errorf("copied %d of 5 files after the context ended", len(entries))
	}
}

func TestCopyTree_EndedContextStagesNothing(t *testing.T) {
	src := filepath.Join(t.TempDir(), "src")
	dst := filepath.Join(t.TempDir(), "dst")
	writeTree(t, src, 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := copyTree(ctx, src, dst); !errors.Is(err, context.Canceled) {
		t.Fatalf("copyTree err = %v, want the context's error", err)
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Errorf("copyTree created the destination after the context ended: %v", err)
	}
}

// The tree's LAST file: nothing later in the walk would notice the context, so
// the failed copy itself must not be skipped as if the file were unreadable.
func TestCopyTree_ContextEndingOnTheLastFileIsNotSkipped(t *testing.T) {
	src := filepath.Join(t.TempDir(), "src")
	dst := filepath.Join(t.TempDir(), "dst")
	writeTree(t, src, 1)

	// The root dir's walk check, the file's walk check; copyFile's check fails.
	if err := copyTree(newFlipContext(2), src, dst); !errors.Is(err, context.Canceled) {
		t.Fatalf("copyTree err = %v, want the context's error", err)
	}
}

// A step left behind resumes after the run removed its staging dir; it must not
// put that tree back (the staged copy holds secret material).
func TestCopyFile_EndedContextStagesNothing(t *testing.T) {
	src := filepath.Join(t.TempDir(), "src")
	if err := os.WriteFile(src, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	removedDir := filepath.Join(t.TempDir(), "removed-staging")
	if err := copyFile(ctx, src, filepath.Join(removedDir, "dst")); !errors.Is(err, context.Canceled) {
		t.Fatalf("copyFile err = %v, want the context's error", err)
	}
	if _, err := os.Stat(removedDir); !os.IsNotExist(err) {
		t.Errorf("copyFile recreated the staging tree: %v", err)
	}
}

func TestCopyFile_ContextEndingMidCopyRemovesThePartialFile(t *testing.T) {
	src := filepath.Join(t.TempDir(), "src")
	if err := os.WriteFile(src, make([]byte, 1<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(t.TempDir(), "dst")

	// One check after open, one before the first read; the second read fails.
	err := copyFile(newFlipContext(2), src, dst)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("copyFile err = %v, want the context's error", err)
	}
	if _, statErr := os.Stat(dst); !os.IsNotExist(statErr) {
		t.Errorf("partial file left at dst: %v", statErr)
	}
}

func TestCollectArtifactsInDir_StopsWhenTheContextEnds(t *testing.T) {
	staging := t.TempDir()
	dir := filepath.Join(staging, "etc")
	writeTree(t, dir, 5)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	arts, err := collectArtifactsInDir(ctx, "etc_tree", dir, staging)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want the context's error", err)
	}
	if len(arts) != 0 {
		t.Errorf("listed %d artifacts after the context ended", len(arts))
	}
}

// A symlink has nothing to hash, so only the walk's own check can stop it.
func TestCollectArtifactsInDir_EndedContextListsNoSymlink(t *testing.T) {
	staging := t.TempDir()
	dir := filepath.Join(staging, "etc")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("target", filepath.Join(dir, "link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	arts, err := collectArtifactsInDir(ctx, "etc_tree", dir, staging)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want the context's error", err)
	}
	if len(arts) != 0 {
		t.Errorf("artifacts = %+v, want none", arts)
	}
}

// The run out of time must not read as a bad file: no checksum-less artifact.
func TestCollectArtifactsInDir_ContextEndingWhileHashingListsNoArtifact(t *testing.T) {
	staging := t.TempDir()
	dir := filepath.Join(staging, "etc")
	writeTree(t, dir, 1)

	// The dir's walk check, the file's walk check, then the hash's read fails.
	arts, err := collectArtifactsInDir(newFlipContext(2), "etc_tree", dir, staging)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want the context's error", err)
	}
	if len(arts) != 0 {
		t.Errorf("artifacts = %+v, want none", arts)
	}
}

func TestCollectRegistryHives_RunsRegSaveUnderTheStepContext(t *testing.T) {
	orig := runRegSave
	t.Cleanup(func() { runRegSave = orig })
	type ctxKey struct{}
	var got []any
	runRegSave = func(ctx context.Context, _, outPath string) ([]byte, error) {
		got = append(got, ctx.Value(ctxKey{}))
		return nil, os.WriteFile(outPath, []byte("hive"), 0o600)
	}

	dir := t.TempDir()
	ctx := context.WithValue(context.Background(), ctxKey{}, "step")
	if _, err := collectRegistryHives(ctx, dir, dir, []string{"SYSTEM"}); err != nil {
		t.Fatalf("collectRegistryHives: %v", err)
	}
	if len(got) != 1 || got[0] != "step" {
		t.Errorf("reg save contexts = %v, want the step's", got)
	}
}

// Running out of time inside a hive copy names the hive, like any hive failure.
func TestCollectRegistryHivesFromShadow_EndedContextNamesTheHive(t *testing.T) {
	configDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(configDir, "SYSTEM"), []byte("hive"), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	arts, err := collectRegistryHivesFromShadow(ctx, dir, dir, configDir, []string{"SYSTEM"})
	var regErr *registrySaveError
	if !errors.As(err, &regErr) || !slices.Equal(regErr.FailedHives, []string{"SYSTEM"}) {
		t.Fatalf("err = %v, want SYSTEM named as failed", err)
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want it to carry the context's error", err)
	}
	if len(arts) != 0 {
		t.Errorf("artifacts = %+v, want none", arts)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "SYSTEM")); !os.IsNotExist(statErr) {
		t.Errorf("partial hive left staged: %v", statErr)
	}
}
