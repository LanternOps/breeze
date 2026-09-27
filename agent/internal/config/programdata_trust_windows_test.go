//go:build windows

package config

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// hardenedTestRoot creates a directory with the same descriptor the agent
// creates missing logs/data dirs with, so the verifier has a trusted root.
func hardenedTestRoot(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "Breeze")
	if err := createProgramDataDir(root); err != nil {
		t.Fatalf("create hardened root: %v", err)
	}
	return root
}

func mklinkJunction(t *testing.T, link, target string) {
	t.Helper()
	out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	if err != nil {
		t.Fatalf("mklink /J %s %s: %v: %s", link, target, err, out)
	}
}

func TestProgramDataLinkDetectRemoveLeavesTargetUntouched(t *testing.T) {
	root := hardenedTestRoot(t)
	target := filepath.Join(t.TempDir(), "elsewhere")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(target, "keep.txt")
	if err := os.WriteFile(marker, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "data")
	mklinkJunction(t, link, target)

	isLink, err := programDataPathIsLink(link)
	if err != nil || !isLink {
		t.Fatalf("a junction must be reported as a link, got %v %v", isLink, err)
	}
	if err := verifyProgramDataChain(root, link); err == nil || !strings.Contains(err.Error(), "link") {
		t.Fatalf("the verifier must refuse a junction component, got %v", err)
	}
	if err := removeProgramDataLink(link); err != nil {
		t.Fatalf("remove link: %v", err)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("the link must be gone, lstat err=%v", err)
	}
	if b, err := os.ReadFile(marker); err != nil || string(b) != "keep" {
		t.Fatalf("the link target and its content must be untouched, got %q %v", b, err)
	}
}

func TestRemoveProgramDataLinkRefusesARealDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "real")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := removeProgramDataLink(dir); err == nil {
		t.Fatal("a real directory must never be removed as a link")
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("the real directory must still exist: %v", err)
	}
}

func TestVerifyProgramDataPathAcceptsHardenedChainAndRefusesUserWritableFile(t *testing.T) {
	root := hardenedTestRoot(t)
	data := filepath.Join(root, "data")
	if err := createProgramDataDir(data); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(data, "codec.dll")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := verifyProgramDataChain(root, file); err != nil {
		t.Fatalf("a file created inside a hardened chain must verify, got %v", err)
	}
	// Grant BUILTIN\Users write on the file itself.
	if err := applyWindowsDACL(file, `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FW;;;BU)`); err != nil {
		t.Fatal(err)
	}
	if err := verifyProgramDataChain(root, file); err == nil {
		t.Fatal("a file that BUILTIN\\Users can write must not verify")
	}
}

func TestResetProgramDataTreeRemovesNestedLinksAndResetsForeignEntries(t *testing.T) {
	root := hardenedTestRoot(t)
	data := filepath.Join(root, "data")
	if err := createProgramDataDir(data); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "elsewhere")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(target, "keep.txt")
	if err := os.WriteFile(marker, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	nestedLink := filepath.Join(data, "pam")
	mklinkJunction(t, nestedLink, target)

	// A subdirectory that BUILTIN\Users could change, holding a file they
	// could change: the direct-entry sweep must reset the directory and
	// then everything below it.
	sub := filepath.Join(data, "scripts")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := applyWindowsDACL(sub, `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;BU)`); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(sub, "state.json")
	if err := os.WriteFile(foreign, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := applyWindowsDACL(foreign, `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;BU)`); err != nil {
		t.Fatal(err)
	}

	stuck, err := resetProgramDataTreeContents(data, false)
	if err != nil || len(stuck) != 0 {
		t.Fatalf("reset: stuck=%v err=%v", stuck, err)
	}
	if _, err := os.Lstat(nestedLink); !os.IsNotExist(err) {
		t.Fatalf("the nested link must be removed, lstat err=%v", err)
	}
	if b, err := os.ReadFile(marker); err != nil || string(b) != "keep" {
		t.Fatalf("the nested link target must be untouched, got %q %v", b, err)
	}
	if err := verifyProgramDataChain(root, sub); err != nil {
		t.Fatalf("a direct entry open to BUILTIN\\Users must be reset, got %v", err)
	}
	if err := verifyProgramDataChain(root, foreign); err != nil {
		t.Fatalf("a nested entry open to BUILTIN\\Users must be reset to a trusted owner and inherited-only permissions, got %v", err)
	}
	sd, err := windows.GetNamedSecurityInfo(foreign, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	control, _, err := sd.Control()
	if err != nil {
		t.Fatal(err)
	}
	if control&windows.SE_DACL_PROTECTED != 0 {
		t.Error("a reset entry must inherit from its hardened parent")
	}
}

func TestEnforceProgramDataTreeReplacesJunctionedDataDir(t *testing.T) {
	root := hardenedTestRoot(t)
	target := filepath.Join(t.TempDir(), "elsewhere")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(root, "data")
	mklinkJunction(t, data, target)

	origDirs := programDataHardenDirsFn
	origRoot := configDirHardenFn
	programDataHardenDirsFn = func() []string { return []string{data} }
	configDirHardenFn = func() []string { return nil }
	t.Cleanup(func() { programDataHardenDirsFn = origDirs; configDirHardenFn = origRoot })

	res, err := EnforceProgramDataTreePermissions()
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	if !res.LinkReplaced(data) {
		t.Error("expected the junction to be reported as replaced")
	}
	isLink, err := programDataPathIsLink(data)
	if err != nil || isLink {
		t.Fatalf("data must now be a real directory, isLink=%v err=%v", isLink, err)
	}
	if !ProgramDataDirTrusted(data) {
		t.Error("the recreated directory must be trusted")
	}
	if err := verifyProgramDataChain(root, data); err != nil {
		t.Errorf("the recreated directory must verify: %v", err)
	}
	if entries, err := os.ReadDir(target); err != nil || len(entries) != 0 {
		t.Errorf("nothing may be written into the former link target, got %v %v", entries, err)
	}
}
