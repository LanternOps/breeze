package tools

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// A link count that cannot be read is reported as a scan error, not counted
// as a skipped link.
func TestScanSensitiveDataReportsUnreadableLinkCount(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("AKIA1234567890ABCDEF\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	orig := sensitiveLinkCount
	sensitiveLinkCount = func(*os.File, os.FileInfo) (uint32, error) { return 0, errors.New("link count unavailable") }
	t.Cleanup(func() { sensitiveLinkCount = orig })

	result := ScanSensitiveData(map[string]any{
		"scope":            map[string]any{"includePaths": []any{root}, "excludePaths": []any{}, "fileTypes": []any{".txt"}, "workers": 1},
		"detectionClasses": []any{"credential"},
	})
	response := decodeSensitiveScanResult(t, result)
	if response.Summary.LinksSkipped != 0 || len(response.Summary.Errors) != 1 || len(response.Findings) != 0 {
		t.Fatalf("summary=%+v findings=%d, want one error and no skipped link", response.Summary, len(response.Findings))
	}
}
