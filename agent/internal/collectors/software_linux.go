//go:build linux

package collectors

import (
	"errors"
	"log/slog"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

var softwareCommandOutput = runCollectorOutput
var softwareLookPath = exec.LookPath

type softwareSourceError struct {
	code string
	err  error
}

func (e *softwareSourceError) Error() string { return e.err.Error() }
func (e *softwareSourceError) Unwrap() error { return e.err }

func softwareFailureCode(err error) string {
	var sourceErr *softwareSourceError
	if errors.As(err, &sourceErr) {
		return sourceErr.code
	}
	return SoftwareFailureCommandFailed
}

// CollectObservation retrieves installed software from every applicable Linux package manager.
func (c *SoftwareCollector) CollectObservation() (SoftwareInventoryObservationV2, error) {
	if c.collectObservation != nil {
		return c.collectObservation()
	}
	type candidate struct {
		source  string
		binary  string
		collect func() ([]SoftwareItem, error)
	}
	candidates := []candidate{
		{SoftwareSourceLinuxDpkg, "dpkg-query", collectFromDpkg},
		{SoftwareSourceLinuxRPM, "rpm", collectFromRpm},
	}
	results := make([]softwareSourceResult, 0, len(candidates))
	for _, candidate := range candidates {
		if _, err := softwareLookPath(candidate.binary); err != nil {
			continue
		}
		items, err := candidate.collect()
		result := softwareSourceResult{Source: candidate.source, Items: items}
		if err != nil {
			slog.Warn("software inventory source failed", "source", candidate.source, "error", err.Error())
			result.FailureCode = softwareFailureCode(err)
		}
		results = append(results, result)
	}
	if len(results) == 0 {
		results = []softwareSourceResult{
			{Source: SoftwareSourceLinuxDpkg, FailureCode: SoftwareFailureSourceUnavailable},
			{Source: SoftwareSourceLinuxRPM, FailureCode: SoftwareFailureSourceUnavailable},
		}
	}
	return buildSoftwareObservation(c.collectorVersion, results, c.now, c.newObservationID), nil
}

// collectFromDpkg retrieves packages using dpkg-query (Debian/Ubuntu)
func collectFromDpkg() ([]SoftwareItem, error) {
	output, err := softwareCommandOutput(collectorLongCommandTimeout, "dpkg-query", "-W", "-f=${Package}\t${Version}\t${Maintainer}\t${Installed-Size}\n")
	if err != nil {
		return nil, &softwareSourceError{code: SoftwareFailureCommandFailed, err: err}
	}

	var software []SoftwareItem
	scanner := newCollectorScanner(output)

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		parts := strings.Split(line, "\t")
		if len(parts) < 1 {
			continue
		}

		item := SoftwareItem{
			Name: strings.TrimSpace(parts[0]),
		}

		if len(parts) > 1 {
			item.Version = strings.TrimSpace(parts[1])
		}

		if len(parts) > 2 {
			// Maintainer field often contains email, extract just the name
			maintainer := strings.TrimSpace(parts[2])
			if idx := strings.Index(maintainer, "<"); idx > 0 {
				maintainer = strings.TrimSpace(maintainer[:idx])
			}
			item.Vendor = maintainer
		}

		// Installed-Size is in KB, we don't have a field for this but could add to InstallLocation
		// For now, we skip it as SoftwareItem doesn't have a size field

		// Skip empty names
		if item.Name == "" {
			continue
		}

		software = append(software, sanitizeLinuxSoftwareItem(item))
	}

	if err := scanner.Err(); err != nil {
		return nil, &softwareSourceError{code: SoftwareFailureScanFailed, err: err}
	}

	return software, nil
}

// collectFromRpm retrieves packages using rpm (RHEL/CentOS/Fedora)
func collectFromRpm() ([]SoftwareItem, error) {
	output, err := softwareCommandOutput(collectorLongCommandTimeout, "rpm", "-qa", "--queryformat", "%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\t%{INSTALLTIME}\n")
	if err != nil {
		return nil, &softwareSourceError{code: SoftwareFailureCommandFailed, err: err}
	}

	var software []SoftwareItem
	scanner := newCollectorScanner(output)

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		parts := strings.Split(line, "\t")
		if len(parts) < 1 {
			continue
		}

		item := SoftwareItem{
			Name: strings.TrimSpace(parts[0]),
		}

		if len(parts) > 1 {
			item.Version = strings.TrimSpace(parts[1])
		}

		if len(parts) > 2 {
			vendor := strings.TrimSpace(parts[2])
			// RPM returns "(none)" for unset vendor
			if vendor != "(none)" {
				item.Vendor = vendor
			}
		}

		if len(parts) > 3 {
			// INSTALLTIME is a Unix timestamp
			installTime := strings.TrimSpace(parts[3])
			if installTime != "" && installTime != "(none)" {
				if timestamp, err := strconv.ParseInt(installTime, 10, 64); err == nil {
					item.InstallDate = time.Unix(timestamp, 0).Format("2006-01-02")
				}
			}
		}

		// Skip empty names
		if item.Name == "" {
			continue
		}

		software = append(software, sanitizeLinuxSoftwareItem(item))
	}

	if err := scanner.Err(); err != nil {
		return nil, &softwareSourceError{code: SoftwareFailureScanFailed, err: err}
	}

	return software, nil
}

func sanitizeLinuxSoftwareItem(item SoftwareItem) SoftwareItem {
	return sanitizeSoftwareInventoryItem(item)
}
