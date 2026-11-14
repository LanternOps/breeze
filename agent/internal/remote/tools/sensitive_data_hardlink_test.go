package tools

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// hardLinkPair writes content to <elsewhere>/original.txt and links it into a
// fresh scan folder as linked.txt, so the two names share one file.
func hardLinkPair(t *testing.T, content []byte) (original, linked, scanRoot string) {
	t.Helper()
	original = filepath.Join(t.TempDir(), "original.txt")
	if err := os.WriteFile(original, content, 0o600); err != nil {
		t.Fatal(err)
	}
	scanRoot = t.TempDir()
	linked = filepath.Join(scanRoot, "linked.txt")
	if err := os.Link(original, linked); err != nil {
		t.Skipf("hard links not available here: %v", err)
	}
	return original, linked, scanRoot
}

// A file that also has a name outside the scanned folder belongs to whoever
// owns that other location, so the sensitive-data scan skips it, as it skips
// symbolic links.
func TestScanSensitiveDataSkipsFilesWithOtherHardLinks(t *testing.T) {
	_, _, root := hardLinkPair(t, []byte("AKIA1234567890ABCDEF\n"))
	if err := os.WriteFile(filepath.Join(root, "plain.txt"), []byte("nothing to see\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	result := ScanSensitiveData(map[string]any{
		"scope": map[string]any{
			"includePaths": []any{root},
			"excludePaths": []any{},
			"fileTypes":    []any{".txt"},
			"workers":      1,
		},
		"detectionClasses": []any{"credential"},
	})
	response := decodeSensitiveScanResult(t, result)
	if len(response.Findings) != 0 {
		t.Fatalf("a multiply-linked file was read: findings=%+v", response.Findings)
	}
	if response.Summary.FilesScanned != 1 {
		t.Fatalf("filesScanned = %d, want 1 (only plain.txt)", response.Summary.FilesScanned)
	}
	if response.Summary.LinksSkipped != 1 {
		t.Fatalf("linksSkipped = %d, want 1", response.Summary.LinksSkipped)
	}
}

// Overwriting a multiply-linked file would also change the content seen
// through its other names, so secure delete refuses it and leaves it intact.
func TestSecureDeleteRefusesFileWithOtherHardLinks(t *testing.T) {
	content := []byte("keep me\n")
	original, linked, _ := hardLinkPair(t, content)

	result := SecureDeleteFile(map[string]any{"path": linked})
	if result.Status != "failed" {
		t.Fatalf("expected a refusal, got %s", result.Status)
	}
	got, err := os.ReadFile(original)
	if err != nil || !bytes.Equal(got, content) {
		t.Fatalf("the other name's content changed: %q (err=%v)", got, err)
	}
	if _, err := os.Stat(linked); err != nil {
		t.Fatalf("the refused file was removed: %v", err)
	}
}

func TestEncryptFileRefusesFileWithOtherHardLinks(t *testing.T) {
	t.Setenv("SENSITIVE_DATA_KEYRING_JSON", "")
	t.Setenv("SENSITIVE_DATA_ENCRYPTION_KEY_B64", fixedKeyBase64('K'))
	content := []byte("keep me\n")
	original, linked, _ := hardLinkPair(t, content)

	result := EncryptFile(map[string]any{"path": linked})
	if result.Status != "failed" {
		t.Fatalf("expected a refusal, got %s", result.Status)
	}
	got, err := os.ReadFile(original)
	if err != nil || !bytes.Equal(got, content) {
		t.Fatalf("the other name's content changed: %q (err=%v)", got, err)
	}
	if _, err := os.Stat(linked + ".breeze.enc"); !os.IsNotExist(err) {
		t.Fatalf("an encrypted copy was written (stat err=%v)", err)
	}
}

func TestSecureDeleteStillRemovesSingleLinkFile(t *testing.T) {
	target := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(target, []byte("remove me\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := SecureDeleteFile(map[string]any{"path": target})
	if result.Status != "completed" {
		t.Fatalf("status=%s error=%q", result.Status, result.Error)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("file not removed (stat err=%v)", err)
	}
}
