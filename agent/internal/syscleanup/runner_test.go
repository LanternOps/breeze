package syscleanup

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Plan amendment 9: procoutput.ApplyEnv only sets a C locale when the
// inherited env has NO UTF-8 locale, so on a host with LC_ALL=fr_FR.UTF-8 it
// is a no-op and every parser in this package silently misses. cLocaleEnv must
// OVERRIDE, not append-if-absent.
func TestCLocaleEnvOverridesAnInheritedLocale(t *testing.T) {
	got := cLocaleEnv([]string{
		"PATH=/usr/bin",
		"LC_ALL=fr_FR.UTF-8",
		"LANG=de_DE.UTF-8",
		"LC_MESSAGES=ja_JP.UTF-8",
		"LC_NUMERIC=nl_NL.UTF-8",
		"LC_CTYPE=pt_BR.UTF-8",
		"HOME=/root",
	})
	joined := strings.Join(got, "\n")
	for _, want := range []string{"LC_ALL=C", "LANG=C", "LC_MESSAGES=C", "LC_NUMERIC=C", "LC_CTYPE=C"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("cLocaleEnv() missing %q; got %v", want, got)
		}
	}
	for _, unwanted := range []string{"fr_FR", "de_DE", "ja_JP", "nl_NL", "pt_BR"} {
		if strings.Contains(joined, unwanted) {
			t.Fatalf("cLocaleEnv() kept the inherited locale %q; got %v", unwanted, got)
		}
	}
	// Non-locale entries survive untouched.
	for _, want := range []string{"PATH=/usr/bin", "HOME=/root"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("cLocaleEnv() dropped %q; got %v", want, got)
		}
	}
}

func TestCLocaleEnvAddsTheVariablesWhenAbsent(t *testing.T) {
	got := cLocaleEnv([]string{"PATH=/usr/bin"})
	if len(got) != 6 {
		t.Fatalf("cLocaleEnv() = %v, want PATH plus the five locale variables", got)
	}
}

// Plan amendment 24 (spec §13 #14): the cap keeps the TAIL. Every parser in
// this package reads a trailing summary line, and the error a human reads in
// outputTail is at the end too — a head-preserving cap throws away exactly the
// bytes that matter on a verbose run.
func TestCapOutputKeepsTheTail(t *testing.T) {
	noise := strings.Repeat("a", maxOutputBytes+5000)
	got := capOutput([]byte(noise + "\nFreed space: 1.2 G"))

	if !strings.HasSuffix(got, "Freed space: 1.2 G") {
		t.Fatalf("capped output must END with the trailing summary; got %q", got[max(0, len(got)-40):])
	}
	if !strings.HasPrefix(got, "[truncated] ") {
		t.Fatalf("a truncated capture must say so at the start; got %q", got[:32])
	}
	if strings.Count(got, "a") > maxOutputBytes {
		t.Fatalf("capped output kept %d payload bytes, want at most %d", strings.Count(got, "a"), maxOutputBytes)
	}
}

func TestCapOutputLeavesShortOutputAlone(t *testing.T) {
	if got := capOutput([]byte("  Freed space: 1.2 G\n")); got != "Freed space: 1.2 G" {
		t.Fatalf("capOutput() = %q, want the trimmed original", got)
	}
}

func TestResolveBinaryPicksTheFirstExistingAbsolutePath(t *testing.T) {
	dir := t.TempDir()
	present := dir + "/present"
	if err := os.WriteFile(present, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, ok := resolveBinary(dir+"/missing-one", present, dir+"/missing-two")
	if !ok || got != present {
		t.Fatalf("resolveBinary() = (%q, %v), want (%q, true)", got, ok, present)
	}
	if _, ok := resolveBinary(dir + "/nope"); ok {
		t.Fatal("resolveBinary() found a binary that does not exist")
	}
	// A directory is never a binary.
	if _, ok := resolveBinary(dir); ok {
		t.Fatal("resolveBinary() accepted a directory")
	}
}

func TestRunProcessCapturesExitCodeAndOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fixture")
	}
	sh, ok := resolveBinary("/bin/sh")
	if !ok {
		t.Skip("/bin/sh not present")
	}
	res := runProcess(context.Background(), 10*time.Second, sh, "-c", "printf out; printf err 1>&2; exit 3")
	if res.ExitCode != 3 {
		t.Fatalf("ExitCode = %d, want 3", res.ExitCode)
	}
	if res.Stdout != "out" || res.Stderr != "err" {
		t.Fatalf("Stdout/Stderr = %q/%q, want \"out\"/\"err\"", res.Stdout, res.Stderr)
	}
	if res.TimedOut {
		t.Fatal("TimedOut set for a process that exited on its own")
	}
}

// A timeout must reach the whole tree, not just the wrapper. The child here
// outlives its parent deliberately; containment is what makes TimedOut
// truthful.
func TestRunProcessTimesOutAndReportsIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fixture")
	}
	sh, ok := resolveBinary("/bin/sh")
	if !ok {
		t.Skip("/bin/sh not present")
	}
	start := time.Now()
	res := runProcess(context.Background(), 200*time.Millisecond, sh, "-c", "sleep 30 & sleep 30")
	if !res.TimedOut {
		t.Fatal("TimedOut = false, want true")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("runProcess blocked for %s past its 200ms deadline", elapsed)
	}
	if res.Err == nil {
		t.Fatal("a timed-out run must carry an error")
	}
}

func TestRunProcessRefusesARelativeBinary(t *testing.T) {
	res := runProcess(context.Background(), time.Second, "sh", "-c", "true")
	if res.Err == nil {
		t.Fatal("runProcess must refuse a non-absolute binary path")
	}
	if !strings.Contains(res.Err.Error(), "absolute") {
		t.Fatalf("error = %q, want it to name the absolute-path rule", res.Err)
	}
}

// The leader exiting is not proof that a Windows job's real worker exited.
type drainingTestTree struct {
	events   []string
	drainErr error
}

func (t *drainingTestTree) prepare(*exec.Cmd) {}
func (t *drainingTestTree) adopt(*exec.Cmd)   { t.events = append(t.events, "adopt") }
func (t *drainingTestTree) kill(*exec.Cmd)    {}
func (t *drainingTestTree) drain(context.Context) error {
	t.events = append(t.events, "drain")
	return t.drainErr
}
func (t *drainingTestTree) release()                       { t.events = append(t.events, "release") }
func (t *drainingTestTree) cpuTime() (time.Duration, bool) { return 0, false }

func TestRunProcessDrainsAssignedTreeBeforeRelease(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fixture")
	}
	for _, tc := range []struct {
		name     string
		script   string
		drainErr error
		timedOut bool
		exitCode int
	}{
		{name: "leader success", script: "exit 0"},
		{name: "leader failure", script: "exit 3", exitCode: 3},
		{name: "tree deadline", script: "exit 0", drainErr: context.DeadlineExceeded, timedOut: true, exitCode: 1},
		{name: "tree query failure", script: "exit 0", drainErr: errors.New("query failed"), exitCode: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tree := &drainingTestTree{drainErr: tc.drainErr}
			result := runProcessWithTree(context.Background(), time.Second, tree, "/bin/sh", "-c", tc.script)
			if got := strings.Join(tree.events, ","); got != "adopt,drain,release" {
				t.Fatalf("events = %s", got)
			}
			if result.TimedOut != tc.timedOut {
				t.Fatalf("TimedOut = %v, want %v", result.TimedOut, tc.timedOut)
			}
			if result.ExitCode != tc.exitCode {
				t.Fatalf("ExitCode = %d, want %d", result.ExitCode, tc.exitCode)
			}
			if tc.drainErr != nil && result.Err == nil {
				t.Fatal("drain failure must be reported")
			}
		})
	}
}

// --- #6482: session-0 idle watchdog ----------------------------------------
//
// cleanmgr.exe /sagerun under the SYSTEM service executes its handlers and
// then never exits (lab: 3/3 runs wedged at ~0.2 s CPU for the whole 60-minute
// cap). The only signal that distinguishes "still working" from "wedged" is
// the process TREE's CPU accounting, which the Windows job object already
// reports. idleTracker is the pure decision half so the rule is executed on
// the Linux CI runner.

func TestIdleTrackerDeclaresIdleOnlyAfterTheMinimumRunAndAFlatCPUWindow(t *testing.T) {
	base := time.Unix(0, 0)
	tracker := newIdleTracker(base, 60*time.Second, 30*time.Second, 250*time.Millisecond)

	// The first sample only primes the baseline.
	if tracker.observe(base, 200*time.Millisecond) {
		t.Fatal("the priming sample must never declare idle")
	}
	// Flat CPU, but the minimum run has not elapsed yet.
	if tracker.observe(base.Add(45*time.Second), 200*time.Millisecond) {
		t.Fatal("declared idle before the minimum run elapsed")
	}
	// 90s in: past the minimum run and CPU has not moved since t=0.
	if !tracker.observe(base.Add(90*time.Second), 200*time.Millisecond) {
		t.Fatal("a tree with a flat CPU window past the minimum run must be declared idle")
	}
}

func TestIdleTrackerResetsWhenTheTreeConsumesCPU(t *testing.T) {
	base := time.Unix(0, 0)
	tracker := newIdleTracker(base, time.Second, 30*time.Second, 250*time.Millisecond)
	tracker.observe(base, 0)

	// Real work at t=60s resets the flat window even though minRun has passed.
	if tracker.observe(base.Add(60*time.Second), 10*time.Second) {
		t.Fatal("a tree that consumed CPU must not be declared idle")
	}
	if tracker.observe(base.Add(80*time.Second), 10*time.Second) {
		t.Fatal("the flat window must restart from the last CPU movement")
	}
	if !tracker.observe(base.Add(95*time.Second), 10*time.Second) {
		t.Fatal("30s after the last CPU movement the tree is idle")
	}
}

// Sub-second jitter is not work: scheduler noise must not hold a wedged tree
// open for the full hour.
func TestIdleTrackerIgnoresSubNoiseCPUJitter(t *testing.T) {
	base := time.Unix(0, 0)
	tracker := newIdleTracker(base, time.Second, 30*time.Second, 250*time.Millisecond)
	tracker.observe(base, 0)
	tracker.observe(base.Add(10*time.Second), 100*time.Millisecond)
	if !tracker.observe(base.Add(40*time.Second), 200*time.Millisecond) {
		t.Fatal("CPU growth below the noise floor must not reset the flat window")
	}
}

// cpuTree reports a caller-supplied CPU reading so the watchdog is exercised
// without a Windows job object.
//
// Containment (prepare + kill) is delegated to the REAL platform tree rather
// than faked: the fixtures run `sh -c "sleep N; true"`, where the shell forks
// `sleep` as a child. Killing only the leader leaves that child holding the
// stdout/stderr pipes, so cmd.Wait blocks until it exits on its own — on the
// Linux CI runner that made the idle-stop test wait the full 25 s and fail
// its "did not wait for the cap" bound, while macOS's exec-optimising sh hid
// it locally.
type cpuTree struct {
	drainingTestTree
	real   processTree
	cpu    time.Duration
	ok     bool
	killed chan struct{}
}

func newCPUTree(ok bool) *cpuTree {
	return &cpuTree{real: newProcessTree(), ok: ok, killed: make(chan struct{})}
}

func (t *cpuTree) cpuTime() (time.Duration, bool) { return t.cpu, t.ok }
func (t *cpuTree) prepare(cmd *exec.Cmd)          { t.real.prepare(cmd) }
func (t *cpuTree) release()                       { t.drainingTestTree.release(); t.real.release() }
func (t *cpuTree) kill(cmd *exec.Cmd) {
	select {
	case <-t.killed:
	default:
		close(t.killed)
	}
	t.real.kill(cmd)
}

func TestRunProcessIdleStopsAWedgedTreeWithoutCallingItATimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fixture")
	}
	sh, ok := resolveBinary("/bin/sh")
	if !ok {
		t.Skip("/bin/sh not present")
	}
	tree := newCPUTree(true)
	start := time.Now()
	res := runProcessWithTreeIdle(context.Background(), 30*time.Second,
		idleLimits{sample: 10 * time.Millisecond, minRun: 20 * time.Millisecond, idleAfter: 30 * time.Millisecond, noise: 250 * time.Millisecond},
		tree, sh, "-c", "sleep 25; true")

	if !res.IdleStopped {
		t.Fatalf("IdleStopped = false; a tree that stopped using CPU must be reported as idle-stopped: %+v", res)
	}
	if res.TimedOut {
		t.Fatal("an idle-stopped tree must NOT be reported as a timeout — it never reached its cap")
	}
	// Err stays free for a GENUINE failure. Overwriting it with a synthetic
	// "went idle" message would bury a teardown error under a result the
	// caller reports as completed.
	if res.Err != nil {
		t.Fatalf("Err = %v, want nil: going idle is how a session-0 cleanmgr ends, not an error", res.Err)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("the idle watchdog took %s to fire; the whole point is not to wait for the cap", elapsed)
	}
	select {
	case <-tree.killed:
	default:
		t.Fatal("the idle watchdog must terminate the process TREE, not just the leader")
	}
}

// A platform that cannot measure tree CPU disables the watchdog rather than
// guessing: the run still ends at its cap, reported as a timeout.
func TestRunProcessIdleLeavesUnmeasurableTreesAlone(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fixture")
	}
	sh, ok := resolveBinary("/bin/sh")
	if !ok {
		t.Skip("/bin/sh not present")
	}
	limits := idleLimits{sample: 10 * time.Millisecond, minRun: 10 * time.Millisecond, idleAfter: 50 * time.Millisecond, noise: time.Millisecond}

	unmeasurable := newCPUTree(false)
	start := time.Now()
	res := runProcessWithTreeIdle(context.Background(), 300*time.Millisecond, limits, unmeasurable, sh, "-c", "sleep 20; true")
	if res.IdleStopped {
		t.Fatal("a tree whose CPU cannot be measured must not be idle-stopped")
	}
	if !res.TimedOut {
		t.Fatal("with the watchdog disabled the run must still hit its cap")
	}
	// The cap must end the whole TREE: the forked sleep would otherwise hold
	// the pipes for its full 20 s after the leader is gone.
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("the deadline took %s to end the run; the process tree was not terminated at the cap", elapsed)
	}
}

// The boundaries are inclusive on purpose and nothing else pins them: a `>=`
// flipped to `>` silently adds a whole sample interval to every wedged run.
func TestIdleTrackerBoundariesAreExact(t *testing.T) {
	base := time.Unix(0, 0)
	tracker := newIdleTracker(base, 60*time.Second, 30*time.Second, 250*time.Millisecond)
	tracker.observe(base, 0)

	// Exactly at minRun, with the flat window (60s) already past idleAfter.
	if !tracker.observe(base.Add(60*time.Second), 0) {
		t.Fatal("minRun is inclusive: a tree flat since t=0 is idle AT the minimum run, not one sample later")
	}

	// And idleAfter measured exactly, with minRun long past.
	exact := newIdleTracker(base, time.Second, 30*time.Second, 250*time.Millisecond)
	exact.observe(base, 0)
	exact.observe(base.Add(10*time.Second), time.Minute) // CPU moved at t=10s
	if exact.observe(base.Add(39*time.Second), time.Minute) {
		t.Fatal("29s after the last CPU movement is not yet idle")
	}
	if !exact.observe(base.Add(40*time.Second), time.Minute) {
		t.Fatal("idleAfter is inclusive: exactly 30s after the last CPU movement is idle")
	}
}

// A job object should never report a DECREASING total, but if one ever did it
// must not read as fresh work — that would re-arm the watchdog on every bogus
// sample and hand a wedged tree the full 60-minute cap back.
func TestIdleTrackerTreatsADecreasingCPUReadingAsFlat(t *testing.T) {
	base := time.Unix(0, 0)
	tracker := newIdleTracker(base, time.Second, 30*time.Second, 250*time.Millisecond)
	tracker.observe(base, 10*time.Second)

	if tracker.observe(base.Add(10*time.Second), time.Second) {
		t.Fatal("too early to be idle")
	}
	if !tracker.observe(base.Add(31*time.Second), 0) {
		t.Fatal("a decreasing CPU reading must count as flat, not as a reset")
	}
}

// A teardown failure around an idle kill must survive: the caller turns
// IdleStopped into a `completed` action, so an Err swallowed here would be a
// real failure reported as success.
func TestRunProcessIdleKeepsAGenuineDrainErrorAlongsideIdleStopped(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fixture")
	}
	sh, ok := resolveBinary("/bin/sh")
	if !ok {
		t.Skip("/bin/sh not present")
	}
	tree := newCPUTree(true)
	tree.drainErr = errors.New("query cleaner job accounting: the handle is invalid")

	start := time.Now()
	res := runProcessWithTreeIdle(context.Background(), 30*time.Second,
		idleLimits{sample: 10 * time.Millisecond, minRun: 20 * time.Millisecond, idleAfter: 30 * time.Millisecond, noise: 250 * time.Millisecond},
		tree, sh, "-c", "sleep 25; true")

	if !res.IdleStopped {
		t.Fatalf("IdleStopped = false, want true: %+v", res)
	}
	if res.Err == nil || !strings.Contains(res.Err.Error(), "handle is invalid") {
		t.Fatalf("Err = %v, want the drain failure preserved for the caller to report", res.Err)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("the idle watchdog took %s to fire; the tree was not terminated", elapsed)
	}
}
