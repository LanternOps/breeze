//go:build linux

package collectors

import (
	"fmt"
	"strings"
	"testing"
)

func TestParseAptOutputCapsAndTruncates(t *testing.T) {
	c := NewPatchCollector()
	longName := strings.Repeat("pkg", collectorStringLimit+24)

	var output strings.Builder
	output.WriteString("Listing...\n")
	for i := 0; i < collectorResultLimit+5; i++ {
		fmt.Fprintf(&output, "%s%d/stable 1.%d amd64 [upgradable from: %s]\n", longName, i, i, longName)
	}

	patches := c.parseAptOutput([]byte(output.String()))
	if len(patches) != collectorResultLimit {
		t.Fatalf("expected %d apt patches, got %d", collectorResultLimit, len(patches))
	}
	if !strings.Contains(patches[0].Name, "[truncated]") {
		t.Fatalf("expected truncated apt patch name, got %q", patches[0].Name)
	}
}

func TestParseYumOutputCapsAndTruncates(t *testing.T) {
	c := NewPatchCollector()
	longName := strings.Repeat("kernel", collectorStringLimit+24)

	var output strings.Builder
	for i := 0; i < collectorResultLimit+5; i++ {
		fmt.Fprintf(&output, "%s%d.x86_64 1.%d repo\n", longName, i, i)
	}

	patches := c.parseYumOutput([]byte(output.String()), "yum")
	if len(patches) != collectorResultLimit {
		t.Fatalf("expected %d yum patches, got %d", collectorResultLimit, len(patches))
	}
	if !strings.Contains(patches[0].Name, "[truncated]") {
		t.Fatalf("expected truncated yum patch name, got %q", patches[0].Name)
	}
}
