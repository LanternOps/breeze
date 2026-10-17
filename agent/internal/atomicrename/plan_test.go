package atomicrename

import (
	"errors"
	"os"
	"syscall"
	"testing"
)

// newTestPlanner returns a planner whose fallback warnings are counted rather
// than logged.
func newTestPlanner(infoEx, legacy renameFunc) (*planner, *int) {
	warnings := 0
	p := &planner{
		infoEx: infoEx,
		legacy: legacy,
		warn:   func(uint32, string, error) { warnings++ },
	}
	return p, &warnings
}

func TestReplacePlannedSkipsInfoExOnWindows10_1507(t *testing.T) {
	infoExCalls, legacyCalls := 0, 0
	p, warnings := newTestPlanner(
		func(string, string) error {
			infoExCalls++
			return nil
		},
		func(string, string) error {
			legacyCalls++
			return nil
		},
	)
	if err := p.replace(10240, "old", "new"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if infoExCalls != 0 || legacyCalls != 1 {
		t.Fatalf("infoEx calls = %d, legacy calls = %d, want 0 and 1", infoExCalls, legacyCalls)
	}
	// Pre-1607 builds take MoveFileEx by design; that is not a surprise worth
	// a warning.
	if *warnings != 0 {
		t.Fatalf("warnings = %d, want 0 on a pre-1607 build", *warnings)
	}
}

func TestReplacePlannedBoundary(t *testing.T) {
	// 14392 is the last build before Windows 10 1607. 14393 is 1607.
	for _, build := range []uint32{10240, 10586, 14392} {
		p, _ := newTestPlanner(boom("infoEx"), okRename)
		if err := p.replace(build, "a", "b"); err != nil {
			t.Fatalf("build %d: %v", build, err)
		}
	}
	infoExCalled := false
	p, _ := newTestPlanner(func(string, string) error {
		infoExCalled = true
		return nil
	}, boom("legacy"))
	if err := p.replace(14393, "a", "b"); err != nil || !infoExCalled {
		t.Fatalf("build 14393 err=%v infoExCalled=%v", err, infoExCalled)
	}
}

func TestReplacePlannedFallsBackWhenInfoExIsUnsupported(t *testing.T) {
	for _, errno := range []syscall.Errno{winErrInvalidParameter, winErrNotSupported, winErrInvalidFunction} {
		infoErr := &os.PathError{Op: "rename", Path: `C:\ProgramData\Breeze\agent.state`, Err: errno}
		legacyCalls := 0
		p, _ := newTestPlanner(
			func(string, string) error { return infoErr },
			func(string, string) error {
				legacyCalls++
				return nil
			},
		)
		if err := p.replace(19045, "old", "new"); err != nil {
			t.Fatalf("errno %d: rename: %v", errno, err)
		}
		if legacyCalls != 1 {
			t.Fatalf("errno %d: legacy calls = %d, want 1", errno, legacyCalls)
		}
	}
}

// TestReplacePlannedWarnsOnceWhenFallbackFires covers the #8860 ask: losing
// POSIX rename semantics on a 1607+ build must leave a trace, and a process
// that renames on every heartbeat must not flood the log doing it.
func TestReplacePlannedWarnsOnceWhenFallbackFires(t *testing.T) {
	infoErr := &os.PathError{Op: "rename", Path: "new", Err: winErrInvalidParameter}
	var warnedBuild uint32
	var warnedPath string
	var warnedErr error
	warnings := 0
	p := &planner{
		infoEx: func(string, string) error { return infoErr },
		legacy: okRename,
		warn: func(build uint32, newpath string, err error) {
			warnings++
			warnedBuild, warnedPath, warnedErr = build, newpath, err
		},
	}
	for i := 0; i < 3; i++ {
		if err := p.replace(19045, "old", "new"); err != nil {
			t.Fatalf("rename %d: %v", i, err)
		}
	}
	if warnings != 1 {
		t.Fatalf("warnings = %d, want exactly 1 across 3 fallbacks", warnings)
	}
	if warnedBuild != 19045 || warnedPath != "new" || !errors.Is(warnedErr, winErrInvalidParameter) {
		t.Fatalf("warning got build=%d path=%q err=%v, want 19045, %q and the infoEx error", warnedBuild, warnedPath, warnedErr, "new")
	}
}

// TestReplacePlannedNotesLegacyBuildOnce: a pre-1607 build has no POSIX
// rename, so a reader can make every rename fail with access denied. The
// process must say once which primitive it is on, or that failure carries no
// hint of the cause.
func TestReplacePlannedNotesLegacyBuildOnce(t *testing.T) {
	var notedBuild uint32
	notes := 0
	p := &planner{
		infoEx: boom("infoEx"),
		legacy: okRename,
		noteLegacyBuild: func(build uint32) {
			notes++
			notedBuild = build
		},
	}
	for i := 0; i < 3; i++ {
		if err := p.replace(10240, "old", "new"); err != nil {
			t.Fatalf("rename %d: %v", i, err)
		}
	}
	if notes != 1 || notedBuild != 10240 {
		t.Fatalf("notes = %d (build %d), want exactly 1 for build 10240", notes, notedBuild)
	}

	p2 := &planner{infoEx: okRename, legacy: boom("legacy"), noteLegacyBuild: func(uint32) { notes++ }}
	if err := p2.replace(14393, "old", "new"); err != nil {
		t.Fatalf("rename on 1607: %v", err)
	}
	if notes != 1 {
		t.Fatalf("notes = %d after a 1607 rename, want no note on a build with POSIX rename", notes)
	}
}

func TestReplacePlannedDoesNotWarnWithoutFallback(t *testing.T) {
	p, warnings := newTestPlanner(okRename, boom("legacy"))
	if err := p.replace(22631, "old", "new"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	accessDenied := &os.PathError{Op: "rename", Path: "new", Err: syscall.Errno(5)}
	p2, warnings2 := newTestPlanner(func(string, string) error { return accessDenied }, boom("legacy"))
	_ = p2.replace(22631, "old", "new")
	if *warnings != 0 || *warnings2 != 0 {
		t.Fatalf("warnings = %d/%d, want 0 when no fallback happened", *warnings, *warnings2)
	}
}

func TestReplacePlannedDoesNotHideSharingFailure(t *testing.T) {
	accessDenied := &os.PathError{Op: "rename", Path: "new", Err: syscall.Errno(5)}
	legacyCalls := 0
	p, _ := newTestPlanner(
		func(string, string) error { return accessDenied },
		func(string, string) error {
			legacyCalls++
			return nil
		},
	)
	err := p.replace(22631, "old", "new")
	if !errors.Is(err, accessDenied) {
		t.Fatalf("err = %v, want the infoEx access-denied error", err)
	}
	if legacyCalls != 0 {
		t.Fatalf("legacy calls = %d, want 0", legacyCalls)
	}
}

func TestReplacePlannedReportsBothFailures(t *testing.T) {
	infoErr := &os.PathError{Op: "rename", Path: "new", Err: winErrInvalidParameter}
	legacyErr := errors.New("move failed")
	p, _ := newTestPlanner(
		func(string, string) error { return infoErr },
		func(string, string) error { return legacyErr },
	)
	err := p.replace(19045, "old", "new")
	if !errors.Is(err, winErrInvalidParameter) || !errors.Is(err, legacyErr) {
		t.Fatalf("err = %v, want both the infoEx and legacy errors", err)
	}
}

func okRename(string, string) error { return nil }

func boom(name string) func(string, string) error {
	return func(string, string) error {
		return errors.New(name + " must not be called")
	}
}
