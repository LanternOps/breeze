package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// swapDriftSeams replaces the ProgramData-drift orchestration seams with the
// supplied fakes and returns a restore func. It lets the cross-platform
// orchestration (detect -> warn -> re-apply) be exercised without real Windows
// ACLs, which only exist on a Windows host.
func swapDriftSeams(
	t *testing.T,
	dirs func() []string,
	detect func(string) (bool, error),
	reapply func(string) error,
) {
	t.Helper()
	origDirs := programDataHardenDirsFn
	origDetect := detectProgramDataDriftFn
	origReapply := reapplyProgramDataDACLFn
	programDataHardenDirsFn = dirs
	detectProgramDataDriftFn = detect
	reapplyProgramDataDACLFn = reapply
	t.Cleanup(func() {
		programDataHardenDirsFn = origDirs
		detectProgramDataDriftFn = origDetect
		reapplyProgramDataDACLFn = origReapply
	})
}

func TestEnforceProgramDataTree_ReappliesOnDrift(t *testing.T) {
	dir := t.TempDir()
	logs := filepath.Join(dir, "logs")
	data := filepath.Join(dir, "data")
	for _, d := range []string{logs, data} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}

	var detected, reapplied []string
	swapDriftSeams(t,
		func() []string { return []string{logs, data} },
		func(p string) (bool, error) { detected = append(detected, p); return true, nil },
		func(p string) error { reapplied = append(reapplied, p); return nil },
	)

	EnforceProgramDataTreePermissions()

	if len(detected) != 2 {
		t.Errorf("expected drift check on both dirs, got %v", detected)
	}
	if len(reapplied) != 2 {
		t.Errorf("drifted dirs must be re-hardened, got reapplied=%v", reapplied)
	}
}

func TestEnforceProgramDataTree_SkipsWhenClean(t *testing.T) {
	dir := t.TempDir()
	logs := filepath.Join(dir, "logs")
	if err := os.Mkdir(logs, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	reapplyCalled := false
	swapDriftSeams(t,
		func() []string { return []string{logs} },
		func(string) (bool, error) { return false, nil },
		func(string) error { reapplyCalled = true; return nil },
	)

	EnforceProgramDataTreePermissions()

	if reapplyCalled {
		t.Error("clean dir must not be re-hardened (would lose the drift signal)")
	}
}

func TestEnforceProgramDataTree_SkipsMissingDir(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "does-not-exist")

	detectCalled := false
	swapDriftSeams(t,
		func() []string { return []string{missing} },
		func(string) (bool, error) { detectCalled = true; return false, nil },
		func(string) error { return nil },
	)

	EnforceProgramDataTreePermissions()

	if detectCalled {
		t.Error("missing dir must be skipped before the ACL check")
	}
}

func TestEnforceProgramDataTree_DetectErrorDoesNotReapply(t *testing.T) {
	dir := t.TempDir()
	logs := filepath.Join(dir, "logs")
	if err := os.Mkdir(logs, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	reapplyCalled := false
	swapDriftSeams(t,
		func() []string { return []string{logs} },
		func(string) (bool, error) { return false, errors.New("acl read failed") },
		func(string) error { reapplyCalled = true; return nil },
	)

	EnforceProgramDataTreePermissions()

	if reapplyCalled {
		t.Error("a drift-check error must not trigger a blind re-harden")
	}
}
