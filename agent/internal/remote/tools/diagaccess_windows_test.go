//go:build windows

package tools

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// Windows containment for grant-mode reads. These run in the CI "Windows
// diagnostic-access containment" step, which asserts PASS counts so a junction
// that silently stops being created cannot turn the checks into no-ops.

func mklinkJunction(t *testing.T, link, target string) {
	t.Helper()
	out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	if err != nil {
		t.Fatalf("mklink /J failed: %v: %s", err, out)
	}
}

func TestDiagWindowsJunctionEscapesRefused(t *testing.T) {
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	root, outside := diagTree(t)
	logs := filepath.Join(root, "Logs")

	// A junction inside the approved tree pointing outside it.
	mklinkJunction(t, filepath.Join(logs, "escape"), outside)
	if got := diagCode(s.run(s.build(t, "read", filepath.Join(logs, "escape", "secret.txt"), rec(root), nil, nil, nil), "read", env)); got != DiagErrLinkRefused {
		t.Fatalf("junction escape: %s", got)
	}
	if got := diagCode(s.run(s.build(t, "list", filepath.Join(logs, "escape"), rec(root), nil, nil, nil), "list", env)); got != DiagErrLinkRefused {
		t.Fatalf("junction list escape: %s", got)
	}

	// The approved root replaced by a junction after approval.
	moved := root + "-moved"
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	mklinkJunction(t, root, outside)
	if got := diagCode(s.run(s.build(t, "read", filepath.Join(root, "secret.txt"), rec(root), nil, nil, nil), "read", env)); got != DiagErrLinkRefused {
		t.Fatalf("root swapped for a junction: %s", got)
	}
}

func TestDiagWindowsCaseInsensitiveContainment(t *testing.T) {
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	root, _ := diagTree(t)
	// Approved in one case, requested in another: same object on NTFS.
	upper := strings.ToUpper(filepath.Join(root, "Logs", "app.log"))
	if got := diagCode(s.run(s.build(t, "read", upper, rec(strings.ToLower(root)), nil, nil, nil), "read", env)); got != "OK" {
		t.Fatalf("case-folded in-scope read refused: %s", got)
	}
	// A case-folded prefix sibling is still out of scope.
	sibling := root + "Evil"
	if err := os.MkdirAll(sibling, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sibling, "x.log"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := diagCode(s.run(s.build(t, "read", filepath.Join(sibling, "x.log"), rec(strings.ToUpper(root)), nil, nil, nil), "read", env)); got != DiagErrOutOfScope {
		t.Fatalf("prefix sibling: %s", got)
	}
}

func TestDiagWindowsAlternatePathFormsRefused(t *testing.T) {
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	root, _ := diagTree(t)
	file := filepath.Join(root, "Logs", "app.log")
	for _, p := range []string{
		file + ":hidden",         // NTFS alternate data stream
		file + "::$DATA",         // default stream spelled out
		`\\?\` + file,            // Win32 namespace prefix
		`\\.\` + file,            // device namespace
		`\\localhost\C$\Windows`, // UNC / admin share
		file + ".",               // trailing dot (Win32 strips it)
		file + " ",               // trailing space
		filepath.Join(root, "Logs") + `\..\..\..\outside\secret.txt`,
	} {
		if got := diagCode(s.run(s.build(t, "read", p, rec(root), nil, nil, nil), "read", env)); got != DiagErrPathForm {
			t.Fatalf("%q: got %s, want %s", p, got, DiagErrPathForm)
		}
	}
}

// 8.3 short names are an alternate spelling of the same object; grant mode
// requires the final path to equal the requested path, so a short-name
// spelling is refused rather than resolved. Skips where the volume has 8.3
// generation disabled; the CI step enables it first and requires a PASS.
func TestDiagWindowsShortNameRefused(t *testing.T) {
	s := newDiagSigner(t)
	env := s.env("dev-1", "org-1")
	root, _ := diagTree(t)
	long := filepath.Join(root, "Logs", "a-rather-long-file-name.log")
	if err := os.WriteFile(long, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	p16, _ := windows.UTF16PtrFromString(long)
	buf := make([]uint16, 1024)
	n, err := windows.GetShortPathName(p16, &buf[0], uint32(len(buf)))
	short := windows.UTF16ToString(buf[:n])
	if err != nil || n == 0 || strings.EqualFold(short, long) {
		t.Skip("8.3 short names are not generated on this volume")
	}
	if got := diagCode(s.run(s.build(t, "read", short, rec(root), nil, nil, nil), "read", env)); got != DiagErrLinkRefused && got != DiagErrOutOfScope {
		t.Fatalf("short name %q served: %s", short, got)
	}
}
