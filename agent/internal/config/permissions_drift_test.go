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
// ACLs, which only exist on a Windows host. The root (config dir) target is
// neutered to an empty list so these tests only exercise the logs/data path;
// swapConfigDirDriftSeams below covers the root path in isolation.
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
	origCreate := createProgramDataDirFn
	programDataHardenDirsFn = dirs
	detectProgramDataDriftFn = detect
	reapplyProgramDataDACLFn = reapply
	// Default the create seam to "not available on this host" so a test that
	// does not care about first-run creation never touches the real
	// filesystem; swapCreateSeam overrides it.
	createProgramDataDirFn = func(string) error { return errProgramDataDirCreateUnsupported }
	swapConfigDirDriftSeams(t, func() []string { return nil }, nil, nil)
	t.Cleanup(func() {
		programDataHardenDirsFn = origDirs
		detectProgramDataDriftFn = origDetect
		reapplyProgramDataDACLFn = origReapply
		createProgramDataDirFn = origCreate
	})
}

// swapCreateSeam replaces the hardened-create seam used for a logs/data
// directory that does not exist yet. Call after swapDriftSeams.
func swapCreateSeam(t *testing.T, create func(string) error) {
	t.Helper()
	orig := createProgramDataDirFn
	createProgramDataDirFn = create
	t.Cleanup(func() { createProgramDataDirFn = orig })
}

// swapConfigDirDriftSeams is swapDriftSeams' counterpart for the ProgramData
// ROOT (owner-only) target. detect/reapply may be nil when dirs() is empty
// (the target list is exhausted before either is invoked).
func swapConfigDirDriftSeams(
	t *testing.T,
	dirs func() []string,
	detect func(string) (bool, error),
	reapply func(string) error,
) {
	t.Helper()
	origDirs := configDirHardenFn
	origDetect := detectConfigDirOwnerDriftFn
	origReapply := reapplyConfigDirOwnerFn
	configDirHardenFn = dirs
	if detect != nil {
		detectConfigDirOwnerDriftFn = detect
	}
	if reapply != nil {
		reapplyConfigDirOwnerFn = reapply
	}
	t.Cleanup(func() {
		configDirHardenFn = origDirs
		detectConfigDirOwnerDriftFn = origDetect
		reapplyConfigDirOwnerFn = origReapply
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

func TestEnforceProgramDataTree_MissingDirIsCreatedHardenedThenTrusted(t *testing.T) {
	// A fresh non-MSI install (enroll + service install) starts the agent
	// before ProgramData\Breeze\data exists. The directory must be created
	// with the hardened descriptor during this pass and then verified like
	// any other, so code-loading paths can trust it on the very first run.
	missing := filepath.Join(t.TempDir(), "data")

	var order []string
	swapDriftSeams(t,
		func() []string { return []string{missing} },
		func(p string) (bool, error) { order = append(order, "detect"); return false, nil },
		func(string) error { order = append(order, "reapply"); return nil },
	)
	swapCreateSeam(t, func(p string) error {
		order = append(order, "create")
		return os.Mkdir(p, 0o700)
	})

	EnforceProgramDataTreePermissions()

	if len(order) != 2 || order[0] != "create" || order[1] != "detect" {
		t.Fatalf("missing dir must be created hardened and then verified, got %v", order)
	}
	if !ProgramDataDirTrusted(missing) {
		t.Error("a directory created hardened and verified clean this run must be trusted")
	}
}

func TestEnforceProgramDataTree_CreatedDirStillVerified(t *testing.T) {
	// Trust after creation comes from the drift check, never from the fact
	// that this process created the directory.
	missing := filepath.Join(t.TempDir(), "data")
	swapDriftSeams(t,
		func() []string { return []string{missing} },
		func(string) (bool, error) { return true, nil },
		func(string) error { return errors.New("repair failed") },
	)
	swapCreateSeam(t, func(p string) error { return os.Mkdir(p, 0o700) })

	EnforceProgramDataTreePermissions()

	if ProgramDataDirTrusted(missing) {
		t.Error("a created directory that then fails the drift check and its repair must stay untrusted")
	}
}

func TestEnforceProgramDataTree_CreateRaceFallsBackToCheck(t *testing.T) {
	// Another creator won the race: the existing directory is checked and
	// repaired like any pre-existing one, never trusted blindly.
	missing := filepath.Join(t.TempDir(), "data")
	var reapplied []string
	swapDriftSeams(t,
		func() []string { return []string{missing} },
		func(string) (bool, error) { return true, nil },
		func(p string) error { reapplied = append(reapplied, p); return nil },
	)
	swapCreateSeam(t, func(p string) error {
		if err := os.Mkdir(p, 0o777); err != nil {
			return err
		}
		return os.ErrExist
	})

	EnforceProgramDataTreePermissions()

	if len(reapplied) != 1 {
		t.Fatalf("a directory someone else created must go through the drift repair, got reapplied=%v", reapplied)
	}
	if !ProgramDataDirTrusted(missing) {
		t.Error("a raced directory that was repaired must be trusted")
	}
}

func TestEnforceProgramDataTree_CreateFailureLeavesUntrusted(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "data")
	detectCalled := false
	swapDriftSeams(t,
		func() []string { return []string{missing} },
		func(string) (bool, error) { detectCalled = true; return false, nil },
		func(string) error { return nil },
	)
	swapCreateSeam(t, func(string) error { return errors.New("access denied") })

	EnforceProgramDataTreePermissions()

	if detectCalled {
		t.Error("a directory that could not be created must not be checked")
	}
	if ProgramDataDirTrusted(missing) {
		t.Error("a directory that could not be created must stay untrusted")
	}
}

func TestEnforceProgramDataTree_SkipsMissingDirWhereCreateUnsupported(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "does-not-exist")

	detectCalled := false
	swapDriftSeams(t,
		func() []string { return []string{missing} },
		func(string) (bool, error) { detectCalled = true; return false, nil },
		func(string) error { return nil },
	)

	EnforceProgramDataTreePermissions()

	if detectCalled {
		t.Error("missing dir must be skipped before the ACL check when it cannot be created hardened here")
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Errorf("no directory may be created where hardened creation is unsupported, stat err=%v", err)
	}
	if ProgramDataDirTrusted(missing) {
		t.Error("a skipped directory must stay untrusted")
	}
}

func TestEnforceProgramDataTree_RootNotCreatedWhenMissing(t *testing.T) {
	missingRoot := filepath.Join(t.TempDir(), "Breeze")
	swapDriftSeams(t, func() []string { return nil }, nil, nil)
	createCalled := false
	swapCreateSeam(t, func(string) error { createCalled = true; return nil })
	swapConfigDirDriftSeams(t,
		func() []string { return []string{missingRoot} },
		func(string) (bool, error) { return false, nil },
		func(string) error { return nil },
	)

	EnforceProgramDataTreePermissions()

	if createCalled {
		t.Error("the ProgramData root has its own descriptor and must not be created by the logs/data path")
	}
}

func TestEnforceProgramDataTree_RootCheckedBeforeChildren(t *testing.T) {
	// logs/data may be created inside the root during this pass, so the
	// root's owner must be repaired first.
	root := t.TempDir()
	data := filepath.Join(root, "data")
	var order []string
	swapDriftSeams(t,
		func() []string { return []string{data} },
		func(string) (bool, error) { order = append(order, "child"); return false, nil },
		func(string) error { return nil },
	)
	swapCreateSeam(t, func(p string) error { return os.Mkdir(p, 0o700) })
	swapConfigDirDriftSeams(t,
		func() []string { return []string{root} },
		func(string) (bool, error) { order = append(order, "root"); return false, nil },
		func(string) error { return nil },
	)

	EnforceProgramDataTreePermissions()

	if len(order) != 2 || order[0] != "root" || order[1] != "child" {
		t.Errorf("root owner check must run before the logs/data checks, got %v", order)
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

func TestEnforceProgramDataTree_RepairsRootOwnerDrift(t *testing.T) {
	root := t.TempDir()
	swapDriftSeams(t, func() []string { return nil }, nil, nil)

	var detected, reapplied []string
	swapConfigDirDriftSeams(t,
		func() []string { return []string{root} },
		func(p string) (bool, error) { detected = append(detected, p); return true, nil },
		func(p string) error { reapplied = append(reapplied, p); return nil },
	)

	EnforceProgramDataTreePermissions()

	if len(detected) != 1 || detected[0] != root {
		t.Errorf("expected the root owner check to run on %s, got %v", root, detected)
	}
	if len(reapplied) != 1 || reapplied[0] != root {
		t.Errorf("a drifted root owner must be repaired, got reapplied=%v", reapplied)
	}
}

func TestEnforceProgramDataTree_RootDoesNotUseStrictACLCheck(t *testing.T) {
	// The root intentionally grants BUILTIN\Users read (for the Helper), so
	// it must never be run through the strict logs/data detector/reapplier —
	// doing so would strip that access the next time this self-heal runs.
	root := t.TempDir()

	strictCalled := false
	swapDriftSeams(t,
		func() []string { return nil },
		func(string) (bool, error) { strictCalled = true; return true, nil },
		func(string) error { return nil },
	)
	swapConfigDirDriftSeams(t,
		func() []string { return []string{root} },
		func(string) (bool, error) { return false, nil },
		func(string) error { return nil },
	)

	EnforceProgramDataTreePermissions()

	if strictCalled {
		t.Error("the root must not be checked with the strict logs/data ACL detector")
	}
}

func TestProgramDataDirTrusted_DefaultsFalseUntilChecked(t *testing.T) {
	never := filepath.Join(t.TempDir(), "never-checked")
	if ProgramDataDirTrusted(never) {
		t.Error("a directory EnforceProgramDataTreePermissions has never evaluated must read as untrusted (fail closed)")
	}
}

func TestProgramDataDirTrusted_TrueWhenCleanOrRepaired(t *testing.T) {
	dir := t.TempDir()
	clean := filepath.Join(dir, "clean")
	repaired := filepath.Join(dir, "repaired")
	for _, d := range []string{clean, repaired} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}
	swapDriftSeams(t,
		func() []string { return []string{clean, repaired} },
		func(p string) (bool, error) { return p == repaired, nil },
		func(string) error { return nil },
	)

	EnforceProgramDataTreePermissions()

	if !ProgramDataDirTrusted(clean) {
		t.Error("a directory found clean must be trusted")
	}
	if !ProgramDataDirTrusted(repaired) {
		t.Error("a directory whose drift was successfully repaired must be trusted")
	}
}

func TestProgramDataDirTrusted_FalseWhenRepairFails(t *testing.T) {
	dir := t.TempDir()
	broken := filepath.Join(dir, "broken")
	if err := os.Mkdir(broken, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	swapDriftSeams(t,
		func() []string { return []string{broken} },
		func(string) (bool, error) { return true, nil },
		func(string) error { return errors.New("repair failed") },
	)

	EnforceProgramDataTreePermissions()

	if ProgramDataDirTrusted(broken) {
		t.Error("a directory whose repair failed must remain untrusted — code-loading paths must fail closed, not assume the repair worked")
	}
}

func TestProgramDataDirTrusted_FalseWhenDetectErrors(t *testing.T) {
	dir := t.TempDir()
	unreadable := filepath.Join(dir, "unreadable")
	if err := os.Mkdir(unreadable, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	swapDriftSeams(t,
		func() []string { return []string{unreadable} },
		func(string) (bool, error) { return false, errors.New("acl read failed") },
		func(string) error { return nil },
	)

	EnforceProgramDataTreePermissions()

	if ProgramDataDirTrusted(unreadable) {
		t.Error("a directory whose drift check errored must remain untrusted")
	}
}
