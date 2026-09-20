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
func (t *drainingTestTree) release() { t.events = append(t.events, "release") }

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
