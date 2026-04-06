//go:build darwin

package collectors

import (
	"strings"
	"testing"
)

func TestSanitizeSoftwareItemTruncatesFields(t *testing.T) {
	longValue := strings.Repeat("v", collectorStringLimit+32)
	item := sanitizeSoftwareItem(SoftwareItem{
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
	if !strings.Contains(item.InstallLocation, "[truncated]") {
		t.Fatalf("expected truncated install location, got %q", item.InstallLocation)
	}
}
