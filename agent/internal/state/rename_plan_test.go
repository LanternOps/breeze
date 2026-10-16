package state

import (
	"errors"
	"os"
	"syscall"
	"testing"
)

func TestRenameReplacePlannedSkipsInfoExOnWindows10_1507(t *testing.T) {
	infoExCalls, legacyCalls := 0, 0
	err := renameReplacePlanned(10240, "old", "new",
		func(string, string) error {
			infoExCalls++
			return nil
		},
		func(string, string) error {
			legacyCalls++
			return nil
		},
	)
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if infoExCalls != 0 || legacyCalls != 1 {
		t.Fatalf("infoEx calls = %d, legacy calls = %d, want 0 and 1", infoExCalls, legacyCalls)
	}
}

func TestRenameReplacePlannedBoundary(t *testing.T) {
	// 14392 is the last build before Windows 10 1607. 14393 is 1607.
	for _, build := range []uint32{10240, 10586, 14392} {
		if err := renameReplacePlanned(build, "a", "b", boom("infoEx"), okRename); err != nil {
			t.Fatalf("build %d: %v", build, err)
		}
	}
	infoExCalled := false
	err := renameReplacePlanned(14393, "a", "b", func(string, string) error {
		infoExCalled = true
		return nil
	}, boom("legacy"))
	if err != nil || !infoExCalled {
		t.Fatalf("build 14393 err=%v infoExCalled=%v", err, infoExCalled)
	}
}

func TestRenameReplacePlannedFallsBackWhenInfoExIsUnsupported(t *testing.T) {
	infoErr := &os.PathError{Op: "rename", Path: `C:\ProgramData\Breeze\agent.state`, Err: winErrInvalidParameter}
	legacyCalls := 0
	err := renameReplacePlanned(19045, "old", "new",
		func(string, string) error { return infoErr },
		func(string, string) error {
			legacyCalls++
			return nil
		},
	)
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if legacyCalls != 1 {
		t.Fatalf("legacy calls = %d, want 1", legacyCalls)
	}
}

func TestRenameReplacePlannedDoesNotHideSharingFailure(t *testing.T) {
	accessDenied := &os.PathError{Op: "rename", Path: "new", Err: syscall.Errno(5)}
	legacyCalls := 0
	err := renameReplacePlanned(22631, "old", "new",
		func(string, string) error { return accessDenied },
		func(string, string) error {
			legacyCalls++
			return nil
		},
	)
	if !errors.Is(err, accessDenied) {
		t.Fatalf("err = %v, want the infoEx access-denied error", err)
	}
	if legacyCalls != 0 {
		t.Fatalf("legacy calls = %d, want 0", legacyCalls)
	}
}

func TestRenameReplacePlannedReportsBothFailures(t *testing.T) {
	infoErr := &os.PathError{Op: "rename", Path: "new", Err: winErrInvalidParameter}
	legacyErr := errors.New("move failed")
	err := renameReplacePlanned(19045, "old", "new",
		func(string, string) error { return infoErr },
		func(string, string) error { return legacyErr },
	)
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
