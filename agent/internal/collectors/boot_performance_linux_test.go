//go:build linux

package collectors

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseSystemdTime(t *testing.T) {
	t.Parallel()

	if got := parseSystemdTime("1.500s"); got != 1.5 {
		t.Fatalf("parseSystemdTime seconds = %v", got)
	}
	if got := parseSystemdTime("250ms"); got != 0.25 {
		t.Fatalf("parseSystemdTime millis = %v", got)
	}
	if got := parseSystemdTime("1,250s"); got != 1.25 {
		t.Fatalf("parseSystemdTime comma seconds = %v", got)
	}
}

func TestParseCronFileSkipsOversizedFile(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "cron")
	data := []byte(strings.Repeat("x", collectorFileReadLimit+1))
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatalf("write cron file: %v", err)
	}

	metrics := &BootPerformanceMetrics{}
	parseCronFile(path, metrics)
	if len(metrics.StartupItems) != 0 {
		t.Fatalf("expected oversized cron file to be skipped, got %+v", metrics.StartupItems)
	}
}
