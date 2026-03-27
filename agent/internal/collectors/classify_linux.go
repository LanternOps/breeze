//go:build linux

package collectors

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"strings"
	"time"
)

// getChassisType reads SMBIOS chassis type from sysfs on Linux.
func getChassisType() string {
	data, err := os.ReadFile("/sys/class/dmi/id/chassis_type")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// readOsRelease parses /etc/os-release into a key=value map.
func readOsRelease() map[string]string {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return nil
	}
	defer f.Close()

	result := make(map[string]string)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := parts[0]
		val := strings.Trim(parts[1], "\"")
		result[key] = val
	}
	if err := scanner.Err(); err != nil {
		return nil // partial read — fall through to other detection methods
	}
	return result
}

// getSystemdDefaultTarget runs "systemctl get-default" and returns the result
// (e.g. "multi-user.target" or "graphical.target").
func getSystemdDefaultTarget() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "systemctl", "get-default").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// detectLinuxServer checks /etc/os-release and systemd default target to
// determine if this Linux machine is a server. Returns true if server
// indicators are found.
func detectLinuxServer() bool {
	// Method A: Check /etc/os-release for server indicators
	osRelease := readOsRelease()
	if osRelease != nil {
		// VARIANT_ID=server is the most reliable indicator (RHEL, Fedora, Ubuntu Server)
		if strings.EqualFold(osRelease["VARIANT_ID"], "server") {
			return true
		}
		// Some distros put "Server" in the NAME or PRETTY_NAME
		for _, key := range []string{"NAME", "PRETTY_NAME"} {
			if strings.Contains(strings.ToLower(osRelease[key]), "server") {
				return true
			}
		}
	}

	// Method B: Check systemd default target
	// multi-user.target = no GUI = server; graphical.target = desktop
	target := getSystemdDefaultTarget()
	if target == "multi-user.target" {
		return true
	}

	return false
}
