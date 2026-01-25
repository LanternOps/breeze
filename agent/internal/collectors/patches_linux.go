//go:build linux

package collectors

import (
	"bufio"
	"bytes"
	"os/exec"
	"regexp"
	"strings"
)

// Collect retrieves available patches/updates on Linux
func (c *PatchCollector) Collect() ([]PatchInfo, error) {
	var patches []PatchInfo

	// Try apt (Debian/Ubuntu)
	if aptPatches, err := c.collectAptUpdates(); err == nil && len(aptPatches) > 0 {
		patches = append(patches, aptPatches...)
		return patches, nil
	}

	// Try yum/dnf (RHEL/CentOS/Fedora)
	if yumPatches, err := c.collectYumUpdates(); err == nil && len(yumPatches) > 0 {
		patches = append(patches, yumPatches...)
		return patches, nil
	}

	return patches, nil
}

// collectAptUpdates checks for updates on Debian/Ubuntu systems
func (c *PatchCollector) collectAptUpdates() ([]PatchInfo, error) {
	// Check if apt is available
	_, err := exec.LookPath("apt")
	if err != nil {
		return nil, err
	}

	// Run apt list --upgradable
	cmd := exec.Command("apt", "list", "--upgradable")
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	return c.parseAptOutput(output), nil
}

// parseAptOutput parses the output of apt list --upgradable
// Format: "package/source version arch [upgradable from: old_version]"
func (c *PatchCollector) parseAptOutput(output []byte) []PatchInfo {
	var patches []PatchInfo

	scanner := bufio.NewScanner(bytes.NewReader(output))
	// Skip header line "Listing..."
	scanner.Scan()

	// Pattern: "package/source version arch [upgradable from: old_version]"
	pattern := regexp.MustCompile(`^(\S+)/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s+([^\]]+)\]`)

	for scanner.Scan() {
		line := scanner.Text()
		if matches := pattern.FindStringSubmatch(line); len(matches) == 4 {
			name := matches[1]
			category := "application"

			// Categorize based on package name
			if strings.Contains(name, "linux-") || strings.Contains(name, "kernel") {
				category = "system"
			} else if strings.Contains(name, "security") || strings.Contains(name, "openssl") || strings.Contains(name, "libssl") {
				category = "security"
			}

			patches = append(patches, PatchInfo{
				Name:       name,
				Version:    matches[2],
				CurrentVer: matches[3],
				Category:   category,
				Source:     "apt",
			})
		}
	}

	return patches
}

// collectYumUpdates checks for updates on RHEL/CentOS/Fedora systems
func (c *PatchCollector) collectYumUpdates() ([]PatchInfo, error) {
	// Try dnf first, then yum
	pkgManager := "dnf"
	if _, err := exec.LookPath("dnf"); err != nil {
		if _, err := exec.LookPath("yum"); err != nil {
			return nil, err
		}
		pkgManager = "yum"
	}

	// Run check-update
	cmd := exec.Command(pkgManager, "check-update", "-q")
	output, _ := cmd.Output() // Exit code 100 means updates available

	return c.parseYumOutput(output, pkgManager), nil
}

// parseYumOutput parses the output of yum/dnf check-update
// Format: "package.arch    version    repository"
func (c *PatchCollector) parseYumOutput(output []byte, source string) []PatchInfo {
	var patches []PatchInfo

	scanner := bufio.NewScanner(bytes.NewReader(output))
	pattern := regexp.MustCompile(`^(\S+?)\.(\S+)\s+(\S+)\s+(\S+)`)

	for scanner.Scan() {
		line := scanner.Text()
		if matches := pattern.FindStringSubmatch(line); len(matches) == 5 {
			name := matches[1]
			category := "application"

			if strings.Contains(name, "kernel") {
				category = "system"
			} else if strings.Contains(name, "security") || strings.Contains(name, "openssl") {
				category = "security"
			}

			patches = append(patches, PatchInfo{
				Name:     name,
				Version:  matches[3],
				Category: category,
				Source:   source,
			})
		}
	}

	return patches
}
