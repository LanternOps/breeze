//go:build darwin

package collectors

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestParseSoftwareUpdateOutputCapsAndTruncates(t *testing.T) {
	c := NewPatchCollector()
	longName := strings.Repeat("x", collectorStringLimit+32)

	var output strings.Builder
	for i := 0; i < collectorResultLimit+5; i++ {
		fmt.Fprintf(&output, "* Label: %s-%d\n", longName, i)
		fmt.Fprintf(&output, "    Title: %s-%d, Version: 14.%d, Size: %s, Recommended: YES, Action: restart\n", longName, i, i, longName)
	}

	patches := c.parseSoftwareUpdateOutput([]byte(output.String()))
	if len(patches) != collectorResultLimit {
		t.Fatalf("expected %d patches, got %d", collectorResultLimit, len(patches))
	}
	if !strings.Contains(patches[0].Name, "[truncated]") {
		t.Fatalf("expected truncated patch name, got %q", patches[0].Name)
	}
	if !strings.Contains(patches[0].Description, "[truncated]") {
		t.Fatalf("expected truncated patch description, got %q", patches[0].Description)
	}
}

func TestParseBrewOutdatedOutputCapsAndTruncates(t *testing.T) {
	c := NewPatchCollector()
	longName := strings.Repeat("brew", collectorStringLimit+16)

	var output strings.Builder
	for i := 0; i < collectorResultLimit+5; i++ {
		fmt.Fprintf(&output, "%s%d (%s) < %s\n", longName, i, longName, longName)
	}

	patches := c.parseBrewOutdatedOutput([]byte(output.String()))
	if len(patches) != collectorResultLimit {
		t.Fatalf("expected %d brew patches, got %d", collectorResultLimit, len(patches))
	}
	if !strings.Contains(patches[0].Name, "[truncated]") {
		t.Fatalf("expected truncated brew patch name, got %q", patches[0].Name)
	}
}

func TestParseInstallHistoryCapsAndTruncates(t *testing.T) {
	c := NewPatchCollector()
	longName := strings.Repeat("install", collectorStringLimit+24)

	type item struct {
		Name        string `json:"_name"`
		Version     string `json:"install_version"`
		Source      string `json:"package_source"`
		InstallDate string `json:"install_date"`
	}
	payload := struct {
		Items []item `json:"SPInstallHistoryDataType"`
	}{}

	for i := 0; i < collectorResultLimit+5; i++ {
		payload.Items = append(payload.Items, item{
			Name:        fmt.Sprintf("%s-%d", longName, i),
			Version:     longName,
			Source:      "package_source_apple",
			InstallDate: time.Now().UTC().Format(time.RFC3339),
		})
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("failed to encode install history payload: %v", err)
	}

	patches := c.parseInstallHistory(encoded, 24*time.Hour)
	if len(patches) != collectorResultLimit {
		t.Fatalf("expected %d installed patches, got %d", collectorResultLimit, len(patches))
	}
	if !strings.Contains(patches[0].Name, "[truncated]") {
		t.Fatalf("expected truncated installed patch name, got %q", patches[0].Name)
	}
}
