package collectors

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	SoftwareInventorySchemaVersion  = 2
	SoftwareCollectorVersionUnknown = "unknown"

	SoftwareSourceLinuxDpkg           = "linux:dpkg-query"
	SoftwareSourceLinuxRPM            = "linux:rpm"
	SoftwareSourceMacOSSystemProfiler = "macos:system-profiler"
	SoftwareSourceWindowsHKLM64       = "windows:registry:hklm64"
	SoftwareSourceWindowsHKLM32       = "windows:registry:hklm32"
	SoftwareSourceWindowsHKCU         = "windows:registry:hkcu"

	SoftwareFailureSourceUnavailable  = "source_unavailable"
	SoftwareFailureCommandFailed      = "command_failed"
	SoftwareFailureDecodeFailed       = "decode_failed"
	SoftwareFailureScanFailed         = "scan_failed"
	SoftwareFailureRegistryReadFailed = "registry_read_failed"
)

type SoftwareInventoryCompleteness string

const (
	SoftwareInventoryComplete SoftwareInventoryCompleteness = "complete"
	SoftwareInventoryPartial  SoftwareInventoryCompleteness = "partial"
	SoftwareInventoryFailed   SoftwareInventoryCompleteness = "failed"
)

// SoftwareItem represents an installed application/package on the system
type SoftwareItem struct {
	Name            string `json:"name"`
	Version         string `json:"version,omitempty"`
	Vendor          string `json:"vendor,omitempty"`
	InstallDate     string `json:"installDate,omitempty"`
	InstallLocation string `json:"installLocation,omitempty"`
	UninstallString string `json:"uninstallString,omitempty"`
}

func truncateSoftwareWireString(value string, limit int) string {
	value = strings.ToValidUTF8(strings.TrimSpace(value), "")
	if len(value) <= limit {
		return value
	}
	const suffix = "... [truncated]"
	cut := limit - len(suffix)
	for cut > 0 && !utf8.ValidString(value[:cut]) {
		cut--
	}
	return strings.TrimSpace(value[:cut]) + suffix
}

func sanitizeSoftwareInventoryItem(item SoftwareItem) SoftwareItem {
	item.Name = truncateSoftwareWireString(item.Name, 500)
	item.Version = truncateSoftwareWireString(item.Version, 100)
	item.Vendor = truncateSoftwareWireString(item.Vendor, 200)
	item.InstallDate = truncateSoftwareWireString(item.InstallDate, 64)
	item.InstallLocation = truncateSoftwareWireString(item.InstallLocation, 4096)
	item.UninstallString = truncateSoftwareWireString(item.UninstallString, 8192)
	return item
}

type SoftwareSourceFailure struct {
	Source string `json:"source"`
	Code   string `json:"code"`
}

type SoftwareInventoryObservationV2 struct {
	SchemaVersion    int                           `json:"schemaVersion"`
	ObservationID    string                        `json:"observationId"`
	CollectorVersion string                        `json:"collectorVersion"`
	ObservedAt       time.Time                     `json:"observedAt"`
	Completeness     SoftwareInventoryCompleteness `json:"completeness"`
	ExpectedSources  []string                      `json:"expectedSources"`
	SucceededSources []string                      `json:"succeededSources"`
	FailedSources    []SoftwareSourceFailure       `json:"failedSources"`
	Truncated        bool                          `json:"truncated"`
	ItemCount        int                           `json:"itemCount"`
	Items            []SoftwareItem                `json:"items"`
}

type SoftwareInventoryIncompleteError struct {
	Completeness SoftwareInventoryCompleteness
	Truncated    bool
}

func (e *SoftwareInventoryIncompleteError) Error() string {
	return fmt.Sprintf("software inventory is incomplete (completeness=%s, truncated=%t)", e.Completeness, e.Truncated)
}

type softwareSourceResult struct {
	Source      string
	Items       []SoftwareItem
	FailureCode string
}

// SoftwareCollector collects installed software information.
type SoftwareCollector struct {
	collectorVersion string
	now              func() time.Time
	newObservationID func() string
	// Test seam used to prove compatibility callers reject incomplete evidence.
	collectObservation func() (SoftwareInventoryObservationV2, error)
}

// NewSoftwareCollector creates a new software collector
func NewSoftwareCollector() *SoftwareCollector {
	return NewSoftwareCollectorWithVersion(SoftwareCollectorVersionUnknown)
}

// NewSoftwareCollectorWithVersion stamps reports with the running agent version.
func NewSoftwareCollectorWithVersion(version string) *SoftwareCollector {
	if version == "" {
		version = SoftwareCollectorVersionUnknown
	}
	return &SoftwareCollector{
		collectorVersion: version,
		now:              time.Now,
		newObservationID: uuid.NewString,
	}
}

func buildSoftwareObservation(version string, sources []softwareSourceResult, now func() time.Time, newID func() string) SoftwareInventoryObservationV2 {
	observation := SoftwareInventoryObservationV2{
		SchemaVersion:    SoftwareInventorySchemaVersion,
		ObservationID:    newID(),
		CollectorVersion: version,
		ExpectedSources:  make([]string, 0, len(sources)),
		SucceededSources: make([]string, 0, len(sources)),
		FailedSources:    make([]SoftwareSourceFailure, 0),
		Items:            make([]SoftwareItem, 0),
	}
	seen := make(map[string]struct{})
	for _, source := range sources {
		observation.ExpectedSources = append(observation.ExpectedSources, source.Source)
		if source.FailureCode != "" {
			observation.FailedSources = append(observation.FailedSources, SoftwareSourceFailure{Source: source.Source, Code: source.FailureCode})
			continue
		}
		observation.SucceededSources = append(observation.SucceededSources, source.Source)
		for _, item := range source.Items {
			key := item.Name + "\x00" + item.Version
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			if len(observation.Items) >= collectorResultLimit {
				observation.Truncated = true
				continue
			}
			observation.Items = append(observation.Items, item)
		}
	}
	if len(observation.Items) >= collectorResultLimit {
		observation.Truncated = true
	}
	observation.ItemCount = len(observation.Items)
	observation.ObservedAt = now().UTC()
	switch {
	case len(observation.SucceededSources) == 0:
		observation.Completeness = SoftwareInventoryFailed
	case len(observation.FailedSources) > 0 || observation.Truncated:
		observation.Completeness = SoftwareInventoryPartial
	default:
		observation.Completeness = SoftwareInventoryComplete
	}
	return observation
}

// Collect keeps the legacy slice/error API. Incomplete evidence is returned for
// diagnostics together with a typed error, so callers can never infer absence.
func (c *SoftwareCollector) Collect() ([]SoftwareItem, error) {
	observation, err := c.CollectObservation()
	if err != nil {
		return nil, err
	}
	if observation.Completeness != SoftwareInventoryComplete || observation.Truncated {
		return observation.Items, &SoftwareInventoryIncompleteError{
			Completeness: observation.Completeness,
			Truncated:    observation.Truncated,
		}
	}
	return observation.Items, nil
}

// CollectObservation is implemented per platform in software_*.go.
