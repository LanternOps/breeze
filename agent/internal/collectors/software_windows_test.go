//go:build windows

package collectors

import (
	"errors"
	"fmt"
	"testing"

	"golang.org/x/sys/windows/registry"
)

func TestWindowsCollectObservationSourceEvidenceAndGlobalCap(t *testing.T) {
	original := softwareRegistryCollect
	t.Cleanup(func() { softwareRegistryCollect = original })

	softwareRegistryCollect = func(root registry.Key, path string) ([]SoftwareItem, error) {
		switch {
		case root == registry.LOCAL_MACHINE && path == softwareRegistryPaths[0].path:
			items := make([]SoftwareItem, collectorResultLimit+1)
			for i := range items {
				items[i] = SoftwareItem{Name: fmt.Sprintf("app-%d", i)}
			}
			return items, nil
		case root == registry.LOCAL_MACHINE:
			return nil, registry.ErrNotExist // optional and therefore not applicable
		default:
			return nil, errors.New("access denied")
		}
	}

	got, err := NewSoftwareCollectorWithVersion("8.1.0").CollectObservation()
	if err != nil {
		t.Fatal(err)
	}
	if got.Completeness != SoftwareInventoryPartial || !got.Truncated || got.ItemCount != collectorResultLimit {
		t.Fatalf("observation=%#v", got)
	}
	if len(got.ExpectedSources) != 2 || got.ExpectedSources[0] != SoftwareSourceWindowsHKLM64 || got.ExpectedSources[1] != SoftwareSourceWindowsHKCU {
		t.Fatalf("expected sources=%v", got.ExpectedSources)
	}
	if len(got.FailedSources) != 1 || got.FailedSources[0].Code != SoftwareFailureRegistryReadFailed {
		t.Fatalf("failed sources=%v", got.FailedSources)
	}
}

func TestWindowsCollectObservationAllApplicableSourcesFailed(t *testing.T) {
	original := softwareRegistryCollect
	t.Cleanup(func() { softwareRegistryCollect = original })
	softwareRegistryCollect = func(_ registry.Key, _ string) ([]SoftwareItem, error) {
		return nil, errors.New("read failed")
	}

	got, err := NewSoftwareCollector().CollectObservation()
	if err != nil || got.Completeness != SoftwareInventoryFailed || len(got.FailedSources) != 3 {
		t.Fatalf("observation=%#v err=%v", got, err)
	}
}

func TestWindowsCollectObservationCompleteWhenApplicableSourcesSucceed(t *testing.T) {
	original := softwareRegistryCollect
	t.Cleanup(func() { softwareRegistryCollect = original })
	softwareRegistryCollect = func(root registry.Key, path string) ([]SoftwareItem, error) {
		if root == registry.LOCAL_MACHINE && path == softwareRegistryPaths[0].path {
			return []SoftwareItem{{Name: "Breeze", Version: "1"}}, nil
		}
		return nil, registry.ErrNotExist
	}

	got, err := NewSoftwareCollector().CollectObservation()
	if err != nil || got.Completeness != SoftwareInventoryComplete || len(got.SucceededSources) != 1 || got.SucceededSources[0] != SoftwareSourceWindowsHKLM64 {
		t.Fatalf("observation=%#v err=%v", got, err)
	}
}
