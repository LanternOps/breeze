//go:build linux

package collectors

import (
	"strings"
	"testing"
)

func TestSanitizeLinuxSoftwareItemTruncatesFields(t *testing.T) {
	longValue := strings.Repeat("linux", collectorStringLimit+32)
	item := sanitizeLinuxSoftwareItem(SoftwareItem{
		Name:            longValue,
		Version:         longValue,
		Vendor:          longValue,
		InstallDate:     longValue,
		InstallLocation: longValue,
		UninstallString: longValue,
	})

	if !strings.Contains(item.Name, "[truncated]") {
		t.Fatalf("expected truncated name, got %q", item.Name)
	}
	if !strings.Contains(item.Vendor, "[truncated]") {
		t.Fatalf("expected truncated vendor, got %q", item.Vendor)
	}
}
