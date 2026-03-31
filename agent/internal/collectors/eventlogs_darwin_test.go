//go:build darwin

package collectors

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseCrashReportRejectsOversizedFile(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "huge.ips")
	data := make([]byte, collectorFileReadLimit+1)
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatalf("write crash report: %v", err)
	}

	if _, err := parseCrashReport(path); err == nil {
		t.Fatal("expected oversized crash report to be rejected")
	}
}
