package tools

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/wire"
)

// Every device file operation acts on an absolute local path. Network shares,
// device namespaces and relative spellings are refused before anything is
// opened, whichever command carried the path.
func TestPathContainmentRefusesNonLocalPathForms(t *testing.T) {
	for _, p := range []string{
		``,
		`\\fileserver\share\report.txt`,
		`//fileserver/share/report.txt`,
		`\/fileserver\share\report.txt`,
		`/\fileserver/share/report.txt`,
		`\\?\C:\Windows\win.ini`,
		`\\.\C:\Windows\win.ini`,
		`//?/C:/Windows/win.ini`,
		`\\?\UNC\fileserver\share\report.txt`,
		`\\fileserver\C$\Windows\win.ini`,
		`\??\UNC\fileserver\share\report.txt`,
		`/??/C:/Windows/win.ini`,
		`C:Windows\win.ini`,
		`C:`,
		`relative/report.txt`,
		`report.txt`,
		"/tmp/a\x00b",
	} {
		err := EnforcePathContainment("read", p)
		if err == nil {
			t.Errorf("%q: expected a refusal", p)
			continue
		}
		if code := errorCodeOf(err); code != wire.ErrCodeInvalidArgument {
			t.Errorf("%q: error code = %q, want %q (%v)", p, code, wire.ErrCodeInvalidArgument, err)
		}
	}
}

func TestPathContainmentAcceptsAbsoluteLocalPaths(t *testing.T) {
	for _, p := range []string{
		filepath.Join(t.TempDir(), "report.txt"),
		`/var/log/report.txt`,
		`C:\Logs\report.txt`,
		`D:/Logs/report.txt`,
		`\Logs\report.txt`,
	} {
		if err := EnforcePathContainment("read", p); err != nil {
			t.Errorf("%q: unexpected refusal: %v", p, err)
		}
	}
}

func TestReadFileRefusesNetworkSharePath(t *testing.T) {
	result := ReadFile(map[string]any{"path": `\\fileserver\share\report.txt`})
	if result.Status != "failed" || result.ErrorCode != wire.ErrCodeInvalidArgument {
		t.Fatalf("status=%s code=%q error=%q, want a path-form refusal", result.Status, result.ErrorCode, result.Error)
	}
}

func TestMakeDirectoryRefusesRelativePath(t *testing.T) {
	cwd := t.TempDir()
	t.Chdir(cwd)

	result := MakeDirectory(map[string]any{"path": "new-folder"})
	if result.Status != "failed" || result.ErrorCode != wire.ErrCodeInvalidArgument {
		t.Fatalf("status=%s code=%q error=%q, want a path-form refusal", result.Status, result.ErrorCode, result.Error)
	}
	if _, err := os.Stat(filepath.Join(cwd, "new-folder")); !os.IsNotExist(err) {
		t.Fatalf("a folder was created in the agent's working directory (stat err=%v)", err)
	}
}

func TestMakeDirectoryRefusesProtectedLocation(t *testing.T) {
	cfg := t.TempDir()
	orig := agentConfigDirFunc
	agentConfigDirFunc = func() string { return cfg }
	t.Cleanup(func() { agentConfigDirFunc = orig })

	target := filepath.Join(cfg, "new-folder")
	result := MakeDirectory(map[string]any{"path": target})
	if result.Status != "failed" || result.ErrorCode != wire.ErrCodeSensitivePathDenied {
		t.Fatalf("status=%s code=%q error=%q, want a protected-path refusal", result.Status, result.ErrorCode, result.Error)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("a folder was created in the agent configuration directory (stat err=%v)", err)
	}
}

func TestMakeDirectoryCreatesAbsoluteLocalPath(t *testing.T) {
	target := filepath.Join(t.TempDir(), "a", "b")
	result := MakeDirectory(map[string]any{"path": target})
	if result.Status != "completed" {
		t.Fatalf("status=%s error=%q", result.Status, result.Error)
	}
	if info, err := os.Stat(target); err != nil || !info.IsDir() {
		t.Fatalf("folder not created: %v", err)
	}
}
