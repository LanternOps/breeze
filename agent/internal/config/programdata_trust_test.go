package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	testUserSID      = "S-1-5-21-1111111111-2222222222-3333333333-1001"
	testUsersSID     = "S-1-5-32-545"
	testCreatorOwner = "S-1-3-0"

	// Rights used by the fake ACEs below.
	testFullControl  uint32 = 0x001F01FF
	testReadExecute  uint32 = 0x001200A9
	testWriteData    uint32 = 0x00000002
	testWriteDAC     uint32 = 0x00040000
	testGenericWrite uint32 = 0x40000000
)

func hardenedDirSecurity() programDataPathSecurity {
	return programDataPathSecurity{
		Exists:      true,
		OwnerSID:    sidLocalSystem,
		DACLPresent: true,
		ACEs: []programDataACE{
			{Type: aceTypeAccessAllowed, Mask: testFullControl, SID: sidLocalSystem},
			{Type: aceTypeAccessAllowed, Mask: testFullControl, SID: sidAdministrators},
		},
	}
}

// swapPathSecurityReader installs a fake security reader keyed by path and
// records the order in which paths were read.
func swapPathSecurityReader(t *testing.T, byPath map[string]programDataPathSecurity, errs map[string]error) *[]string {
	t.Helper()
	var reads []string
	orig := readProgramDataPathSecurityFn
	readProgramDataPathSecurityFn = func(p string) (programDataPathSecurity, error) {
		reads = append(reads, p)
		if err, ok := errs[p]; ok {
			return programDataPathSecurity{}, err
		}
		sec, ok := byPath[p]
		if !ok {
			return programDataPathSecurity{Exists: false}, nil
		}
		return sec, nil
	}
	t.Cleanup(func() { readProgramDataPathSecurityFn = orig })
	return &reads
}

func TestVerifyProgramDataChain(t *testing.T) {
	root := filepath.Join(string(filepath.Separator)+"pd", "Breeze")
	data := filepath.Join(root, "data")
	dll := filepath.Join(data, "codec.dll")

	rootSec := func() programDataPathSecurity {
		s := hardenedDirSecurity()
		// The root intentionally grants BUILTIN\Users read+traverse.
		s.ACEs = append(s.ACEs, programDataACE{Type: aceTypeAccessAllowed, Mask: testReadExecute, SID: testUsersSID})
		return s
	}

	cases := []struct {
		name    string
		mutate  func(m map[string]programDataPathSecurity)
		errs    map[string]error
		path    string
		wantErr string
	}{
		{name: "clean chain", path: dll},
		{name: "directory only", path: data},
		{name: "root itself", path: root},
		{
			name: "TrustedInstaller owner is trusted",
			path: dll,
			mutate: func(m map[string]programDataPathSecurity) {
				s := m[dll]
				s.OwnerSID = sidTrustedInstaller
				m[dll] = s
			},
		},
		{
			name: "data directory is a link",
			path: dll,
			mutate: func(m map[string]programDataPathSecurity) {
				m[data] = programDataPathSecurity{Exists: true, Reparse: true, NameSurrogate: true}
			},
			wantErr: "link",
		},
		{
			name: "root is a link",
			path: data,
			mutate: func(m map[string]programDataPathSecurity) {
				m[root] = programDataPathSecurity{Exists: true, Reparse: true, NameSurrogate: true}
			},
			wantErr: "link",
		},
		{
			name: "file is a reparse point of another kind",
			path: dll,
			mutate: func(m map[string]programDataPathSecurity) {
				s := m[dll]
				s.Reparse = true
				m[dll] = s
			},
			wantErr: "reparse point",
		},
		{
			name: "root owned by a standard user",
			path: dll,
			mutate: func(m map[string]programDataPathSecurity) {
				s := m[root]
				s.OwnerSID = testUserSID
				m[root] = s
			},
			wantErr: "owner",
		},
		{
			name: "file owned by a standard user",
			path: dll,
			mutate: func(m map[string]programDataPathSecurity) {
				s := m[dll]
				s.OwnerSID = testUserSID
				m[dll] = s
			},
			wantErr: "owner",
		},
		{
			name: "data grants a user write",
			path: dll,
			mutate: func(m map[string]programDataPathSecurity) {
				s := m[data]
				s.ACEs = append(s.ACEs, programDataACE{Type: aceTypeAccessAllowed, Mask: testWriteData, SID: testUserSID})
				m[data] = s
			},
			wantErr: testUserSID,
		},
		{
			name: "file grants Users generic write",
			path: dll,
			mutate: func(m map[string]programDataPathSecurity) {
				s := m[dll]
				s.ACEs = append(s.ACEs, programDataACE{Type: aceTypeAccessAllowed, Mask: testGenericWrite, SID: testUsersSID})
				m[dll] = s
			},
			wantErr: testUsersSID,
		},
		{
			name: "data grants a user permission changes",
			path: dll,
			mutate: func(m map[string]programDataPathSecurity) {
				s := m[data]
				s.ACEs = append(s.ACEs, programDataACE{Type: aceTypeAccessAllowed, Mask: testWriteDAC, SID: testUserSID})
				m[data] = s
			},
			wantErr: testUserSID,
		},
		{
			name: "read-only grant to a user is fine",
			path: dll,
			mutate: func(m map[string]programDataPathSecurity) {
				s := m[data]
				s.ACEs = append(s.ACEs, programDataACE{Type: aceTypeAccessAllowed, Mask: testReadExecute, SID: testUserSID})
				m[data] = s
			},
		},
		{
			name: "inherit-only grant does not apply to the object",
			path: dll,
			mutate: func(m map[string]programDataPathSecurity) {
				s := m[data]
				s.ACEs = append(s.ACEs, programDataACE{Type: aceTypeAccessAllowed, Flags: aceFlagInheritOnly, Mask: testFullControl, SID: testCreatorOwner})
				m[data] = s
			},
		},
		{
			name: "deny entries are ignored",
			path: dll,
			mutate: func(m map[string]programDataPathSecurity) {
				s := m[data]
				s.ACEs = append(s.ACEs, programDataACE{Type: aceTypeAccessDenied, Mask: testFullControl, SID: testUserSID})
				m[data] = s
			},
		},
		{
			name: "unrecognised allow entry type is refused",
			path: dll,
			mutate: func(m map[string]programDataPathSecurity) {
				s := m[data]
				s.ACEs = append(s.ACEs, programDataACE{Type: 0x09, Mask: testFullControl})
				m[data] = s
			},
			wantErr: "entry type",
		},
		{
			name: "no DACL grants everyone everything",
			path: dll,
			mutate: func(m map[string]programDataPathSecurity) {
				s := m[data]
				s.DACLPresent = false
				s.ACEs = nil
				m[data] = s
			},
			wantErr: "no DACL",
		},
		{
			name: "missing file",
			path: dll,
			mutate: func(m map[string]programDataPathSecurity) {
				delete(m, dll)
			},
			wantErr: "does not exist",
		},
		{
			name:    "read failure",
			path:    dll,
			errs:    map[string]error{data: errors.New("access is denied")},
			wantErr: "access is denied",
		},
		{
			name:    "path outside the root",
			path:    filepath.Join(string(filepath.Separator)+"elsewhere", "codec.dll"),
			wantErr: "not under",
		},
		{
			name:    "sibling with a shared name prefix is outside the root",
			path:    root + "Evil" + string(filepath.Separator) + "codec.dll",
			wantErr: "not under",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := map[string]programDataPathSecurity{
				root: rootSec(),
				data: hardenedDirSecurity(),
				dll:  hardenedDirSecurity(),
			}
			if tc.mutate != nil {
				tc.mutate(m)
			}
			swapPathSecurityReader(t, m, tc.errs)
			err := verifyProgramDataChain(root, tc.path)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("expected the path to verify, got %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected a refusal containing %q, got nil", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("expected a refusal containing %q, got %v", tc.wantErr, err)
			}
		})
	}
}

func TestVerifyProgramDataChain_ChecksEveryComponentFromTheRoot(t *testing.T) {
	root := filepath.Join(string(filepath.Separator)+"pd", "Breeze")
	data := filepath.Join(root, "data")
	dll := filepath.Join(data, "codec.dll")
	reads := swapPathSecurityReader(t, map[string]programDataPathSecurity{
		root: hardenedDirSecurity(),
		data: hardenedDirSecurity(),
		dll:  hardenedDirSecurity(),
	}, nil)

	if err := verifyProgramDataChain(root, dll); err != nil {
		t.Fatalf("verify: %v", err)
	}
	want := []string{root, data, dll}
	if len(*reads) != len(want) {
		t.Fatalf("expected reads %v, got %v", want, *reads)
	}
	for i := range want {
		if (*reads)[i] != want[i] {
			t.Fatalf("expected reads %v, got %v", want, *reads)
		}
	}
}

func TestVerifyProgramDataChain_MissingComponentIsNotExist(t *testing.T) {
	root := filepath.Join(string(filepath.Separator)+"pd", "Breeze")
	dll := filepath.Join(root, "data", "codec.dll")
	swapPathSecurityReader(t, map[string]programDataPathSecurity{
		root:                        hardenedDirSecurity(),
		filepath.Join(root, "data"): hardenedDirSecurity(),
	}, nil)
	err := verifyProgramDataChain(root, dll)
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a missing component must report os.ErrNotExist so callers can tell it from a refusal, got %v", err)
	}
}

// --- service-side pass: links at managed paths -------------------------------

// swapLinkSeams installs fakes for the link check/removal seams and the
// nested-content reset used after a drift repair.
func swapLinkSeams(t *testing.T, isLink func(string) (bool, error), remove func(string) error, reset func(string, bool) ([]string, error)) {
	t.Helper()
	origIs, origRemove, origReset := programDataPathIsLinkFn, removeProgramDataLinkFn, resetProgramDataTreeFn
	programDataPathIsLinkFn = isLink
	removeProgramDataLinkFn = remove
	if reset == nil {
		reset = func(string, bool) ([]string, error) { return nil, nil }
	}
	resetProgramDataTreeFn = reset
	t.Cleanup(func() {
		programDataPathIsLinkFn, removeProgramDataLinkFn, resetProgramDataTreeFn = origIs, origRemove, origReset
	})
}

func TestEnforceProgramDataTree_ReplacesLinkedDataDirWithRealDir(t *testing.T) {
	base := t.TempDir()
	data := filepath.Join(base, "data")
	// Stand-in for the link: a path that exists until the link is removed.
	if err := os.Mkdir(data, 0o700); err != nil {
		t.Fatal(err)
	}
	linked := true
	var order []string
	swapDriftSeams(t,
		func() []string { return []string{data} },
		func(string) (bool, error) { order = append(order, "detect"); return false, nil },
		func(string) error { return nil },
	)
	swapCreateSeam(t, func(p string) error { order = append(order, "create"); return os.Mkdir(p, 0o700) })
	swapLinkSeams(t,
		func(string) (bool, error) { return linked, nil },
		func(p string) error {
			order = append(order, "remove")
			linked = false
			return os.Remove(p)
		},
		nil,
	)

	res, err := EnforceProgramDataTreePermissions()
	if err != nil {
		t.Fatalf("a link that was removed and replaced must not fail the pass: %v", err)
	}
	if strings.Join(order, ",") != "remove,create,detect" {
		t.Fatalf("expected remove -> create -> detect, got %v", order)
	}
	if !ProgramDataDirTrusted(data) {
		t.Error("the recreated, verified directory must be trusted")
	}
	if !res.LinkReplaced(data) {
		t.Error("the result must report the replaced link so the caller can reopen files it opened through it")
	}
}

func TestEnforceProgramDataTree_LinkThatCannotBeRemovedStaysUntrustedAndFails(t *testing.T) {
	data := filepath.Join(t.TempDir(), "data")
	var called []string
	swapDriftSeams(t,
		func() []string { return []string{data} },
		func(string) (bool, error) { called = append(called, "detect"); return false, nil },
		func(string) error { called = append(called, "reapply"); return nil },
	)
	swapCreateSeam(t, func(string) error { called = append(called, "create"); return nil })
	swapLinkSeams(t,
		func(string) (bool, error) { return true, nil },
		func(string) error { return errors.New("sharing violation") },
		nil,
	)

	_, err := EnforceProgramDataTreePermissions()
	if err == nil {
		t.Fatal("a managed directory left as a link must fail the pass so nothing writes through it")
	}
	if !strings.Contains(err.Error(), data) {
		t.Errorf("the error must name the directory, got %v", err)
	}
	if len(called) != 0 {
		t.Errorf("nothing may be created, checked or repaired through a link that is still there, got %v", called)
	}
	if ProgramDataDirTrusted(data) {
		t.Error("a directory that is still a link must stay untrusted")
	}
}

func TestEnforceProgramDataTree_LinkCheckErrorFailsClosed(t *testing.T) {
	data := filepath.Join(t.TempDir(), "data")
	if err := os.Mkdir(data, 0o700); err != nil {
		t.Fatal(err)
	}
	swapDriftSeams(t,
		func() []string { return []string{data} },
		func(string) (bool, error) { return false, nil },
		func(string) error { return nil },
	)
	swapLinkSeams(t,
		func(string) (bool, error) { return false, errors.New("attributes unavailable") },
		func(string) error { t.Error("must not remove when the check failed"); return nil },
		nil,
	)

	if _, err := EnforceProgramDataTreePermissions(); err == nil {
		t.Fatal("a directory whose link state cannot be read must fail the pass")
	}
	if ProgramDataDirTrusted(data) {
		t.Error("a directory whose link state cannot be read must stay untrusted")
	}
}

func TestEnforceProgramDataTree_LinkReappearingAfterCreateFails(t *testing.T) {
	data := filepath.Join(t.TempDir(), "data")
	checks := 0
	swapDriftSeams(t,
		func() []string { return []string{data} },
		func(string) (bool, error) {
			t.Error("must not check a path that turned into a link")
			return false, nil
		},
		func(string) error { return nil },
	)
	swapCreateSeam(t, func(p string) error { return os.Mkdir(p, 0o700) })
	swapLinkSeams(t,
		func(string) (bool, error) {
			checks++
			// Not a link at first, a link again right before the ACL check.
			return checks > 1, nil
		},
		func(string) error { return errors.New("still in use") },
		nil,
	)

	if _, err := EnforceProgramDataTreePermissions(); err == nil {
		t.Fatal("a link that appears at a managed path during the pass must fail it")
	}
	if ProgramDataDirTrusted(data) {
		t.Error("must stay untrusted")
	}
}

func TestEnforceProgramDataTree_RootLinkIsNotRemovedButFails(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Breeze")
	swapDriftSeams(t, func() []string { return nil }, nil, nil)
	swapConfigDirDriftSeams(t,
		func() []string { return []string{root} },
		func(string) (bool, error) { t.Error("must not check the owner through a link"); return false, nil },
		func(string) error { return nil },
	)
	removed := false
	swapLinkSeams(t,
		func(string) (bool, error) { return true, nil },
		func(string) error { removed = true; return nil },
		nil,
	)

	_, err := EnforceProgramDataTreePermissions()
	if err == nil {
		t.Fatal("a linked ProgramData root must fail the pass")
	}
	if removed {
		t.Error("the root holds the agent configuration and must not be removed by this pass")
	}
}

func TestEnforceProgramDataTree_SweepsContentFullyOnlyAfterDriftRepair(t *testing.T) {
	base := t.TempDir()
	data := filepath.Join(base, "data")
	clean := filepath.Join(base, "logs")
	for _, d := range []string{data, clean} {
		if err := os.Mkdir(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	swept := map[string]bool{}
	swapDriftSeams(t,
		func() []string { return []string{clean, data} },
		func(p string) (bool, error) { return p == data, nil },
		func(string) error { return nil },
	)
	swapLinkSeams(t,
		func(string) (bool, error) { return false, nil },
		func(string) error { return nil },
		func(p string, full bool) ([]string, error) { swept[p] = full; return nil, nil },
	)

	if _, err := EnforceProgramDataTreePermissions(); err != nil {
		t.Fatalf("pass: %v", err)
	}
	full, ok := swept[data]
	if !ok || !full {
		t.Errorf("a directory whose drift was repaired may hold content created while it was open, so it needs a full sweep, got %v", swept)
	}
	full, ok = swept[clean]
	if !ok || full {
		t.Errorf("a clean directory still gets the cheap sweep of its direct entries (content planted before it was hardened), got %v", swept)
	}
	if !ProgramDataDirTrusted(data) || !ProgramDataDirTrusted(clean) {
		t.Error("both directories must be trusted after a clean sweep")
	}
}

func TestEnforceProgramDataTree_RootContentIsNotSwept(t *testing.T) {
	root := t.TempDir()
	swapDriftSeams(t, func() []string { return nil }, nil, nil)
	swapConfigDirDriftSeams(t,
		func() []string { return []string{root} },
		func(string) (bool, error) { return true, nil },
		func(string) error { return nil },
	)
	swapLinkSeams(t,
		func(string) (bool, error) { return false, nil },
		func(string) error { return nil },
		func(p string, _ bool) ([]string, error) {
			t.Errorf("the root holds agent.yaml, which is intentionally readable; its content must not be swept: %s", p)
			return nil, nil
		},
	)
	if _, err := EnforceProgramDataTreePermissions(); err != nil {
		t.Fatalf("pass: %v", err)
	}
}

func TestEnforceProgramDataTree_NestedLinkThatCannotBeRemovedFails(t *testing.T) {
	data := filepath.Join(t.TempDir(), "data")
	if err := os.Mkdir(data, 0o700); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(data, "pam")
	swapDriftSeams(t,
		func() []string { return []string{data} },
		func(string) (bool, error) { return true, nil },
		func(string) error { return nil },
	)
	swapLinkSeams(t,
		func(string) (bool, error) { return false, nil },
		func(string) error { return nil },
		func(string, bool) ([]string, error) { return []string{nested}, nil },
	)

	_, err := EnforceProgramDataTreePermissions()
	if err == nil || !strings.Contains(err.Error(), nested) {
		t.Fatalf("a nested link that could not be removed must fail the pass and be named, got %v", err)
	}
	if ProgramDataDirTrusted(data) {
		t.Error("a directory that still contains a link must stay untrusted")
	}
}

func TestEnforceProgramDataTree_NestedResetErrorLeavesUntrustedWithoutFailing(t *testing.T) {
	data := filepath.Join(t.TempDir(), "data")
	if err := os.Mkdir(data, 0o700); err != nil {
		t.Fatal(err)
	}
	swapDriftSeams(t,
		func() []string { return []string{data} },
		func(string) (bool, error) { return true, nil },
		func(string) error { return nil },
	)
	swapLinkSeams(t,
		func(string) (bool, error) { return false, nil },
		func(string) error { return nil },
		func(string, bool) ([]string, error) { return nil, errors.New("set owner failed") },
	)

	if _, err := EnforceProgramDataTreePermissions(); err != nil {
		t.Fatalf("an owner/ACL reset failure on nested content keeps the existing untrusted-but-running behaviour, got %v", err)
	}
	if ProgramDataDirTrusted(data) {
		t.Error("a directory whose nested content could not be reset must stay untrusted")
	}
}
