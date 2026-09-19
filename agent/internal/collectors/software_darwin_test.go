//go:build darwin

package collectors

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestSanitizeSoftwareItemTruncatesFields(t *testing.T) {
	longValue := strings.Repeat("v", 9000)
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

func TestDarwinCollectObservationReportsSourceEvidence(t *testing.T) {
	original := softwareCommandOutput
	t.Cleanup(func() { softwareCommandOutput = original })

	t.Run("complete", func(t *testing.T) {
		softwareCommandOutput = func(_ time.Duration, _ string, _ ...string) ([]byte, error) {
			return []byte(`{"SPApplicationsDataType":[{"_name":"Breeze","version":"1"}]}`), nil
		}
		got, err := NewSoftwareCollectorWithVersion("7.0.0").CollectObservation()
		if err != nil || got.Completeness != SoftwareInventoryComplete || len(got.SucceededSources) != 1 || got.SucceededSources[0] != SoftwareSourceMacOSSystemProfiler {
			t.Fatalf("observation=%#v err=%v", got, err)
		}
	})

	t.Run("command failed", func(t *testing.T) {
		softwareCommandOutput = func(_ time.Duration, _ string, _ ...string) ([]byte, error) {
			return nil, errors.New("private raw error")
		}
		got, err := NewSoftwareCollector().CollectObservation()
		if err != nil || got.Completeness != SoftwareInventoryFailed || got.FailedSources[0].Code != SoftwareFailureCommandFailed {
			t.Fatalf("observation=%#v err=%v", got, err)
		}
	})
}

func TestDarwinCollectObservationMarksFiveThousandItemsTruncated(t *testing.T) {
	original := softwareCommandOutput
	t.Cleanup(func() { softwareCommandOutput = original })
	apps := make([]applicationInfo, collectorResultLimit)
	for i := range apps {
		apps[i] = applicationInfo{Name: fmt.Sprintf("app-%d", i)}
	}
	payload, err := json.Marshal(systemProfilerOutput{SPApplicationsDataType: apps})
	if err != nil {
		t.Fatal(err)
	}
	softwareCommandOutput = func(_ time.Duration, _ string, _ ...string) ([]byte, error) { return payload, nil }
	got, err := NewSoftwareCollector().CollectObservation()
	if err != nil || got.ItemCount != collectorResultLimit || !got.Truncated || got.Completeness != SoftwareInventoryPartial {
		t.Fatalf("observation count=%d truncated=%t completeness=%s err=%v", got.ItemCount, got.Truncated, got.Completeness, err)
	}
}
