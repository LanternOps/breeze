package tools

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/breeze-rmm/agent/internal/wire"
)

// protectedConfigFixture points the agent configuration directory at dir,
// holding secrets.yaml, for the duration of the test.
func protectedConfigFixture(t *testing.T, dir string) (secrets string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	secrets = filepath.Join(dir, "secrets.yaml")
	if err := os.WriteFile(secrets, []byte("auth_token: test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	orig := agentConfigDirFunc
	agentConfigDirFunc = func() string { return dir }
	t.Cleanup(func() { agentConfigDirFunc = orig })
	return secrets
}

// Case-insensitive volumes fold some letters together (U+017F names the same
// folder as "s"). Another spelling of a protected folder is still that folder.
func TestPathContainmentRefusesAnotherSpellingOfProtectedFolder(t *testing.T) {
	base := t.TempDir()
	protectedConfigFixture(t, filepath.Join(base, "Breeze-secrets"))
	alias := filepath.Join(base, "Breeze-ſecrets")
	if _, err := os.Stat(alias); err != nil {
		t.Skip("this volume does not fold the alternative spelling")
	}
	if err := EnforcePathContainment("read", alias); err == nil {
		t.Fatal("another spelling of the protected folder was accepted")
	}
	if !treeEntrySensitivity(alias)(filepath.Join(alias, "secrets.yaml")) {
		t.Fatal("an entry below another spelling of the protected folder was not recognised")
	}
}

func TestReadFileRefusesOtherNameOfProtectedFile(t *testing.T) {
	secrets := protectedConfigFixture(t, filepath.Join(t.TempDir(), "agentcfg"))
	link := filepath.Join(t.TempDir(), "notes.txt")
	if err := os.Link(secrets, link); err != nil {
		t.Skipf("hard links not available here: %v", err)
	}
	result := ReadFile(map[string]any{"path": link})
	if result.Status != "failed" || result.ErrorCode != wire.ErrCodeSensitivePathDenied {
		t.Fatalf("status=%s code=%q error=%q, want a protected-path refusal", result.Status, result.ErrorCode, result.Error)
	}
}

func TestCopyFileRefusesOtherNameOfProtectedFile(t *testing.T) {
	secrets := protectedConfigFixture(t, filepath.Join(t.TempDir(), "agentcfg"))
	dir := t.TempDir()
	link := filepath.Join(dir, "notes.txt")
	if err := os.Link(secrets, link); err != nil {
		t.Skipf("hard links not available here: %v", err)
	}
	dst := filepath.Join(dir, "copy.txt")
	result := CopyFile(map[string]any{"sourcePath": link, "destPath": dst})
	if result.Status != "failed" {
		t.Fatalf("status=%s error=%q, want a refusal", result.Status, result.Error)
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Fatalf("a copy was written (stat err=%v)", err)
	}
}

// Hard links are common for ordinary files (Windows system binaries, package
// managers); only other names of protected files are refused.
func TestReadFileReadsOrdinaryHardLinkedFile(t *testing.T) {
	protectedConfigFixture(t, filepath.Join(t.TempDir(), "agentcfg"))
	dir := t.TempDir()
	orig := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(orig, []byte("hello\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "b.txt")
	if err := os.Link(orig, link); err != nil {
		t.Skipf("hard links not available here: %v", err)
	}
	if result := ReadFile(map[string]any{"path": link}); result.Status != "completed" {
		t.Fatalf("status=%s error=%q", result.Status, result.Error)
	}
}

// Encrypt checks the file it actually opened, not only the path it was given.
func TestEncryptFileChecksTheFileItOpened(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs a privilege Windows CI does not grant")
	}
	t.Setenv("SENSITIVE_DATA_KEYRING_JSON", "")
	t.Setenv("SENSITIVE_DATA_ENCRYPTION_KEY_B64", fixedKeyBase64('K'))
	secrets := protectedConfigFixture(t, filepath.Join(t.TempDir(), "agentcfg"))
	source := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(source, []byte("note\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	swapped := false
	testHookAfterPathCheck = func(p string) {
		if p != source || swapped {
			return
		}
		swapped = true
		_ = os.Remove(source)
		if err := os.Symlink(secrets, source); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(func() { testHookAfterPathCheck = nil })

	result := EncryptFile(map[string]any{"path": source})
	if !swapped {
		t.Fatal("encrypt did not pause between its path check and opening the file")
	}
	if result.Status != "failed" {
		t.Fatalf("status=%s, want a refusal", result.Status)
	}
	if got, err := os.ReadFile(secrets); err != nil || string(got) != "auth_token: test\n" {
		t.Fatalf("the protected file changed: %q (err=%v)", got, err)
	}
}

func TestScanSensitiveDataRefusesAnotherSpellingOfProtectedFolder(t *testing.T) {
	base := t.TempDir()
	secrets := protectedConfigFixture(t, filepath.Join(base, "Breeze-secrets"))
	if err := os.WriteFile(secrets+".txt", []byte("AKIA1234567890ABCDEF\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(base, "Breeze-ſecrets")
	if _, err := os.Stat(alias); err != nil {
		t.Skip("this volume does not fold the alternative spelling")
	}
	result := ScanSensitiveData(map[string]any{
		"scope":            map[string]any{"includePaths": []any{alias}, "excludePaths": []any{}, "fileTypes": []any{".txt"}, "workers": 1},
		"detectionClasses": []any{"credential"},
	})
	if result.Status == "completed" {
		response := decodeSensitiveScanResult(t, result)
		if len(response.Findings) != 0 || response.Summary.FilesScanned != 0 {
			t.Fatalf("the protected folder was scanned through another spelling: %+v", response.Summary)
		}
	}
}
