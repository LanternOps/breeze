//go:build linux

package collectors

import (
	"strconv"
	"strings"
	"time"
)

// Collect retrieves installed software on Linux using dpkg-query or rpm
func (c *SoftwareCollector) Collect() ([]SoftwareItem, error) {
	// Try dpkg-query first (Debian/Ubuntu)
	software, err := collectFromDpkg()
	if err == nil && len(software) > 0 {
		return software, nil
	}

	// Fall back to rpm (RHEL/CentOS/Fedora)
	software, err = collectFromRpm()
	if err == nil && len(software) > 0 {
		return software, nil
	}

	// If both fail, return empty list with no error
	// (system may not have either package manager)
	return []SoftwareItem{}, nil
}

// collectFromDpkg retrieves packages using dpkg-query (Debian/Ubuntu)
func collectFromDpkg() ([]SoftwareItem, error) {
	output, err := runCollectorOutput(collectorLongCommandTimeout, "dpkg-query", "-W", "-f=${Package}\t${Version}\t${Maintainer}\t${Installed-Size}\n")
	if err != nil {
		return nil, err
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
		if len(software) >= collectorResultLimit {
			break
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, err
	}

	return software, nil
}

// collectFromRpm retrieves packages using rpm (RHEL/CentOS/Fedora)
func collectFromRpm() ([]SoftwareItem, error) {
	output, err := runCollectorOutput(collectorLongCommandTimeout, "rpm", "-qa", "--queryformat", "%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\t%{INSTALLTIME}\n")
	if err != nil {
		return nil, err
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
		if len(software) >= collectorResultLimit {
			break
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, err
	}

	return software, nil
}

func sanitizeLinuxSoftwareItem(item SoftwareItem) SoftwareItem {
	item.Name = truncateCollectorString(item.Name)
	item.Version = truncateCollectorString(item.Version)
	item.Vendor = truncateCollectorString(item.Vendor)
	item.InstallDate = truncateCollectorString(item.InstallDate)
	item.InstallLocation = truncateCollectorString(item.InstallLocation)
	item.UninstallString = truncateCollectorString(item.UninstallString)
	return item
}
