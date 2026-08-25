package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestIsRecursiveDeleteBoundary_POSIX pins the behaviour of the ORIGINAL guard
// (strings.Split(strings.TrimPrefix(p, "/"), "/") with len <= 1) so the #3932
// Windows fix is provably a no-op for POSIX paths. Every case here returns the
// same verdict the old code returned, except the "unresolved parent" case at
// the bottom, which is called out explicitly as a tightening.
func TestIsRecursiveDeleteBoundary_POSIX(t *testing.T) {
	tests := []struct {
		name string
		path string
		deny bool
	}{
		{name: "filesystem root", path: "/", deny: true},
		{name: "top-level directory", path: "/home", deny: true},
		{name: "top-level directory var", path: "/var", deny: true},
		{name: "nested two components", path: "/home/user", deny: false},
		{name: "deeply nested", path: "/home/user/projects/breeze/dist", deny: false},
		{name: "relative single component", path: "foo", deny: true},
		{name: "relative nested", path: "foo/bar", deny: false},
		{name: "current directory", path: ".", deny: true},
		{name: "empty", path: "", deny: true},

		// A backslash is a legal character in a POSIX file name. "/data\evil" is
		// ONE top-level directory, refused before this change and refused after:
		// normalising backslashes on POSIX would over-count depth and let it
		// through.
		{name: "backslash in posix filename stays one component", path: `/data\evil`, deny: true},
		{name: "backslash filename nested", path: `/data\evil/sub`, deny: false},

		// A colon is a legal POSIX filename character, so the Windows
		// colon-fails-closed rule must not leak across.
		{name: "colon in posix filename", path: "/home/user/back:up", deny: false},
		{name: "colon in posix top-level directory", path: "/back:up", deny: true},

		// A Windows-shaped path handed to a POSIX agent is one strange relative
		// file name, and stays refused.
		{name: "windows path on posix host", path: `C:\ProgramData\SOTIKS\BreezePilot`, deny: true},

		// Tightening (not a fix for #3932): a leading ".." makes real depth
		// depend on the agent's working directory, so it is refused rather than
		// guessed. The old rule allowed "../etc".
		{name: "unresolved parent", path: "../etc", deny: true},
		{name: "unresolved parent deep", path: "../../etc/ssl", deny: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isRecursiveDeleteBoundaryFor(tt.path, false); got != tt.deny {
				t.Errorf("isRecursiveDeleteBoundaryFor(%q, posix) = %v, want %v", tt.path, got, tt.deny)
			}
		})
	}
}

// TestIsRecursiveDeleteBoundary_Windows is the #3932 regression suite. It runs
// the Windows path grammar explicitly rather than via runtime.GOOS so CI (Linux)
// and dev machines (macOS) actually execute it — a GOOS-gated test would have
// silently skipped everywhere the agent is built.
func TestIsRecursiveDeleteBoundary_Windows(t *testing.T) {
	tests := []struct {
		name string
		path string
		deny bool
	}{
		// The reported failure: every one of these was denied before the fix
		// because filepath.Clean returns backslashes on Windows and the guard
		// split on "/" only.
		{name: "issue 3932 reporter path", path: `C:\ProgramData\SOTIKS\BreezePilot\delete-test.txt`, deny: false},
		{name: "nested backslash two components", path: `C:\Temp\build`, deny: false},
		{name: "nested forward slash", path: `C:/Temp/build`, deny: false},
		{name: "mixed separators", path: `C:\Temp/build\out`, deny: false},
		{name: "rooted on current drive nested", path: `\Windows\System32`, deny: false},

		// Volume roots and volume-adjacent paths stay refused.
		{name: "drive root backslash", path: `C:\`, deny: true},
		{name: "drive root forward slash", path: `C:/`, deny: true},
		{name: "bare drive specifier", path: `C:`, deny: true},
		{name: "lowercase drive root", path: `d:\`, deny: true},
		{name: "top-level windows directory", path: `C:\Windows`, deny: true},
		{name: "top-level users directory", path: `C:\Users`, deny: true},
		{name: "top-level programdata", path: `C:\ProgramData`, deny: true},
		{name: "top-level trailing separator", path: `C:\Temp\`, deny: true},
		{name: "bare separator", path: `\`, deny: true},
		{name: "rooted single component", path: `\Windows`, deny: true},
		{name: "rooted two-character first component", path: `\Go\src\pkg`, deny: false},

		// A colon past the volume specifier is neither legal in a component nor a
		// separator, so counting it as one would inflate depth: "C::\Windows"
		// must not read as depth 2.
		{name: "doubled drive colon", path: `C::\Windows`, deny: true},
		{name: "doubled drive colon nested", path: `C::\Temp\build`, deny: true},
		{name: "alternate data stream", path: `C:\Temp\build:stream`, deny: true},
		{name: "colon in relative path", path: `foo:bar\baz`, deny: true},

		// Drive-relative paths resolve against the drive's working directory,
		// which is at minimum the volume root, so depth is a lower bound.
		{name: "drive relative single component", path: `C:foo`, deny: true},
		{name: "drive relative nested", path: `C:foo\bar`, deny: false},

		// UNC: the host + share pair IS the volume, so it contributes no depth.
		{name: "unc share root", path: `\\server\share`, deny: true},
		{name: "unc share root trailing separator", path: `\\server\share\`, deny: true},
		{name: "unc host only", path: `\\server`, deny: true},
		{name: "unc one level below share", path: `\\server\share\sub`, deny: true},
		{name: "unc two levels below share", path: `\\server\share\sub\data`, deny: false},
		{name: "unc forward slash form", path: `//server/share/sub`, deny: true},
		{name: "unc forward slash nested", path: `//server/share/sub/data`, deny: false},

		// Extended-length prefix over an ordinary drive keeps ordinary depth.
		{name: "extended drive root", path: `\\?\C:\`, deny: true},
		{name: "extended top-level directory", path: `\\?\C:\Windows`, deny: true},
		{name: "extended nested", path: `\\?\C:\Temp\build`, deny: false},
		{name: "device drive nested", path: `\\.\C:\Temp\build`, deny: false},
		{name: "nt object manager drive top level", path: `\??\C:\Windows`, deny: true},
		{name: "nt object manager drive nested", path: `\??\C:\Temp\build`, deny: false},

		// Extended-length UNC.
		{name: "extended unc share root", path: `\\?\UNC\server\share`, deny: true},
		{name: "extended unc one level below share", path: `\\?\UNC\server\share\sub`, deny: true},
		{name: "extended unc two levels below share", path: `\\?\UNC\server\share\sub\data`, deny: false},
		{name: "extended unc lowercase marker", path: `\\?\unc\server\share\sub\data`, deny: false},

		// Unrecognised device namespaces fail closed: their components are
		// object-manager nodes, not filesystem depth, so counting them would make
		// a volume-root-adjacent target look arbitrarily deep.
		{name: "globalroot device path", path: `\\?\GLOBALROOT\Device\HarddiskVolume1\Windows`, deny: true},
		{name: "volume guid path", path: `\\?\Volume{b75e2c83-0000-0000-0000-602f00000000}\Windows`, deny: true},
		{name: "raw device path", path: `\\.\PhysicalDrive0`, deny: true},
		{name: "bare extended prefix", path: `\\?\`, deny: true},

		// Unresolved parents are refused rather than guessed: `..\Windows`
		// counts as two components but can resolve to a volume-root child.
		{name: "unresolved parent", path: `..\Windows`, deny: true},
		{name: "unresolved parent drive relative", path: `C:..\Windows`, deny: true},

		{name: "empty", path: "", deny: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isRecursiveDeleteBoundaryFor(tt.path, true); got != tt.deny {
				t.Errorf("isRecursiveDeleteBoundaryFor(%q, windows) = %v, want %v", tt.path, got, tt.deny)
			}
		})
	}
}

// TestIsRecursiveDeleteBoundary_UsesHostGrammar proves the exported wrapper is
// wired to the running platform, so the table above is not testing a function
// nothing calls.
func TestIsRecursiveDeleteBoundary_UsesHostGrammar(t *testing.T) {
	const nested = "/breeze/nested/path"
	if isRecursiveDeleteBoundary(nested) != isRecursiveDeleteBoundaryFor(nested, filepath.Separator == '\\') {
		t.Fatalf("isRecursiveDeleteBoundary(%q) does not match the host path grammar", nested)
	}
}

// TestDeleteFile_RecursiveNestedDirectoryAllowed exercises the guard through
// DeleteFile itself: before #3932 the boundary check ran on a raw slash split,
// and this is the call site that must keep letting a genuinely nested recursive
// delete through.
func TestDeleteFile_RecursiveNestedDirectoryAllowed(t *testing.T) {
	tempDir := t.TempDir()

	target := filepath.Join(tempDir, "project", "build")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatalf("failed to create nested directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(target, "artifact.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("failed to write artifact: %v", err)
	}

	result := DeleteFile(map[string]any{"path": target, "recursive": true, "permanent": true})
	if result.Status != "completed" {
		t.Fatalf("recursive delete of a nested directory was denied (status %s): %s", result.Status, result.Error)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("expected %s to be removed, stat err = %v", target, err)
	}
}

// TestDeleteFile_RecursiveTopLevelStillDenied proves the guard still fires at
// the call site. The path is deliberately one that does not exist, so a
// regression here removes nothing — it would fall through to the "path does not
// exist" branch instead.
func TestDeleteFile_RecursiveTopLevelStillDenied(t *testing.T) {
	result := DeleteFile(map[string]any{
		"path":      "/breeze-3932-guard-probe-does-not-exist",
		"recursive": true,
		"permanent": true,
	})
	if result.Status == "completed" {
		t.Fatal("recursive delete of a top-level path was allowed")
	}
	if !strings.Contains(result.Error, "recursive delete denied on top-level path") {
		t.Fatalf("expected the top-level guard to fire, got: %s", result.Error)
	}
}
