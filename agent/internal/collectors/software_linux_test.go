//go:build linux

package collectors

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestSanitizeLinuxSoftwareItemTruncatesFields(t *testing.T) {
	longValue := strings.Repeat("linux", 2000)
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

func TestLinuxCollectObservationAccountsForApplicableSources(t *testing.T) {
	originalLookPath, originalOutput := softwareLookPath, softwareCommandOutput
	t.Cleanup(func() { softwareLookPath, softwareCommandOutput = originalLookPath, originalOutput })
	softwareLookPath = func(name string) (string, error) { return "/usr/bin/" + name, nil }
	softwareCommandOutput = func(_ time.Duration, name string, _ ...string) ([]byte, error) {
		if name == "rpm" {
			return nil, errors.New("rpm failed with private detail")
		}
		return []byte("shared\t1\tVendor\t1\ndpkg-only\t2\tVendor\t1\n"), nil
	}

	got, err := NewSoftwareCollectorWithVersion("4.2.0").CollectObservation()
	if err != nil || got.Completeness != SoftwareInventoryPartial || got.ItemCount != 2 {
		t.Fatalf("observation=%#v err=%v", got, err)
	}
	if fmt.Sprint(got.ExpectedSources) != fmt.Sprint([]string{SoftwareSourceLinuxDpkg, SoftwareSourceLinuxRPM}) || got.FailedSources[0].Code != SoftwareFailureCommandFailed {
		t.Fatalf("source evidence=%#v", got)
	}
}

func TestLinuxCollectObservationNoPackageManagerIsFailedEvidence(t *testing.T) {
	original := softwareLookPath
	t.Cleanup(func() { softwareLookPath = original })
	softwareLookPath = func(string) (string, error) { return "", errors.New("not found") }
	got, err := NewSoftwareCollector().CollectObservation()
	if err != nil || got.Completeness != SoftwareInventoryFailed || len(got.FailedSources) != 2 {
		t.Fatalf("observation=%#v err=%v", got, err)
	}
	for _, failure := range got.FailedSources {
		if failure.Code != SoftwareFailureSourceUnavailable {
			t.Fatalf("failure=%#v", failure)
		}
	}
}

func TestLinuxCollectObservationCompleteForEveryApplicableSource(t *testing.T) {
	originalLookPath, originalOutput := softwareLookPath, softwareCommandOutput
	t.Cleanup(func() { softwareLookPath, softwareCommandOutput = originalLookPath, originalOutput })
	softwareLookPath = func(name string) (string, error) {
		if name == "dpkg-query" {
			return "/usr/bin/dpkg-query", nil
		}
		return "", errors.New("not installed")
	}
	softwareCommandOutput = func(_ time.Duration, _ string, _ ...string) ([]byte, error) {
		return []byte("breeze\t1\tLantern\t1\n"), nil
	}
	got, err := NewSoftwareCollector().CollectObservation()
	if err != nil || got.Completeness != SoftwareInventoryComplete || len(got.ExpectedSources) != 1 || got.ExpectedSources[0] != SoftwareSourceLinuxDpkg {
		t.Fatalf("observation=%#v err=%v", got, err)
	}
}

func TestLinuxCollectObservationMarksFiveThousandItemsTruncated(t *testing.T) {
	originalLookPath, originalOutput := softwareLookPath, softwareCommandOutput
	t.Cleanup(func() { softwareLookPath, softwareCommandOutput = originalLookPath, originalOutput })
	softwareLookPath = func(name string) (string, error) {
		if name == "dpkg-query" {
			return "/usr/bin/dpkg-query", nil
		}
		return "", errors.New("not installed")
	}
	var output strings.Builder
	for i := 0; i < collectorResultLimit; i++ {
		fmt.Fprintf(&output, "app-%d\t1\tVendor\t1\n", i)
	}
	softwareCommandOutput = func(_ time.Duration, _ string, _ ...string) ([]byte, error) {
		return []byte(output.String()), nil
	}
	got, err := NewSoftwareCollector().CollectObservation()
	if err != nil || got.ItemCount != collectorResultLimit || !got.Truncated || got.Completeness != SoftwareInventoryPartial {
		t.Fatalf("count=%d truncated=%t completeness=%s err=%v", got.ItemCount, got.Truncated, got.Completeness, err)
	}
}
