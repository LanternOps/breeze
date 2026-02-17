//go:build linux

package collectors

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/host"
)

// systemdTimeRegex matches systemd-analyze output like "1.234s" or "456ms"
var systemdTimeRegex = regexp.MustCompile(`([\d.]+)(ms|s)`)

// systemdAnalyzeRegex parses the full "Startup finished in ..." line.
// Groups: firmware, loader, kernel, userspace, total
// Some fields may be absent on certain systems (e.g. no firmware/loader on VMs).
var systemdAnalyzeRegex = regexp.MustCompile(
	`Startup finished in\s+` +
		`(?:([\d.]+(?:ms|s))\s+\(firmware\)\s+\+\s+)?` +
		`(?:([\d.]+(?:ms|s))\s+\(loader\)\s+\+\s+)?` +
		`(?:([\d.]+(?:ms|s))\s+\(kernel\)\s+\+\s+)?` +
		`([\d.]+(?:ms|s))\s+\(userspace\)\s+=\s+([\d.]+(?:ms|s))`,
)

// safeServiceNameRegex validates service names to prevent command injection.
var safeServiceNameRegex = regexp.MustCompile(`^[a-zA-Z0-9._@-]+$`)

// parseSystemdTime converts a systemd time string like "1.234s" or "456ms" to seconds.
func parseSystemdTime(s string) float64 {
	matches := systemdTimeRegex.FindStringSubmatch(s)
	if len(matches) < 3 {
		return 0
	}
	val, err := strconv.ParseFloat(matches[1], 64)
	if err != nil {
		return 0
	}
	if matches[2] == "ms" {
		return val / 1000.0
	}
	return val
}

// Collect gathers boot performance metrics on Linux.
// It uses systemd-analyze for boot timing and systemctl/cron/init.d for startup items.
// Falls back gracefully on non-systemd systems.
func (c *BootPerformanceCollector) Collect() (*BootPerformanceMetrics, error) {
	metrics := &BootPerformanceMetrics{
		StartupItems: []StartupItem{},
	}

	// --- Boot timestamp ---
	bootTimeSec, err := host.BootTime()
	if err == nil && bootTimeSec > 0 {
		metrics.BootTimestamp = time.Unix(int64(bootTimeSec), 0)
	} else {
		// Fallback: read /proc/stat btime
		metrics.BootTimestamp = readProcBtime()
	}

	// --- Boot timing via systemd-analyze ---
	collectSystemdTiming(metrics)

	// If systemd-analyze gave us nothing, compute a rough total from uptime
	if metrics.TotalBootSeconds == 0 && !metrics.BootTimestamp.IsZero() {
		// We cannot determine BIOS/loader/userspace breakdown without systemd,
		// so leave those at zero and only set TotalBootSeconds as a rough estimate.
		// This is intentionally left at 0 since we don't have reliable data.
	}

	// --- Startup items ---
	collectSystemdUnits(metrics)
	collectCronReboot(metrics)
	collectInitDScripts(metrics)

	// --- Per-service performance via systemd-analyze blame ---
	blameMap := collectSystemdBlame()

	// Enrich startup items with blame data
	for i := range metrics.StartupItems {
		item := &metrics.StartupItems[i]
		if ms, ok := blameMap[item.Name]; ok {
			item.CpuTimeMs = ms
			item.ImpactScore = CalculateImpactScore(item.CpuTimeMs, item.DiskIoBytes)
		}
	}

	// Try to gather disk I/O from /proc for recently-started processes
	enrichDiskIO(metrics)

	metrics.StartupItemCount = len(metrics.StartupItems)
	return metrics, nil
}

// readProcBtime reads the btime field from /proc/stat as a fallback for boot time.
func readProcBtime() time.Time {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return time.Time{}
	}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "btime ") {
			parts := strings.Fields(line)
			if len(parts) == 2 {
				ts, err := strconv.ParseInt(parts[1], 10, 64)
				if err == nil {
					return time.Unix(ts, 0)
				}
			}
		}
	}
	return time.Time{}
}

// collectSystemdTiming runs systemd-analyze and parses boot phase timings.
func collectSystemdTiming(metrics *BootPerformanceMetrics) {
	cmd := exec.Command("systemd-analyze")
	output, err := cmd.CombinedOutput()
	if err != nil {
		// systemd-analyze not available (non-systemd system), skip gracefully
		return
	}

	line := strings.TrimSpace(string(output))
	// systemd-analyze may output multiple lines; the timing is on the first line
	// that starts with "Startup finished in"
	for _, l := range strings.Split(line, "\n") {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, "Startup finished in") {
			matches := systemdAnalyzeRegex.FindStringSubmatch(l)
			if len(matches) >= 6 {
				if matches[1] != "" {
					metrics.BiosSeconds = parseSystemdTime(matches[1])
				}
				if matches[2] != "" {
					metrics.OsLoaderSeconds = parseSystemdTime(matches[2])
				}
				// matches[3] is kernel time - we don't have a dedicated field,
				// so it contributes to TotalBootSeconds via the total.
				if matches[4] != "" {
					metrics.DesktopReadySeconds = parseSystemdTime(matches[4])
				}
				if matches[5] != "" {
					metrics.TotalBootSeconds = parseSystemdTime(matches[5])
				}
			}
			break
		}
	}
}

// collectSystemdUnits enumerates enabled systemd service units.
func collectSystemdUnits(metrics *BootPerformanceMetrics) {
	cmd := exec.Command("systemctl", "list-unit-files",
		"--state=enabled", "--type=service", "--no-pager", "--no-legend")
	output, err := cmd.Output()
	if err != nil {
		return
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 1 {
			continue
		}

		unitName := fields[0]
		// Remove .service suffix for display
		displayName := strings.TrimSuffix(unitName, ".service")

		metrics.StartupItems = append(metrics.StartupItems, StartupItem{
			Name:    displayName,
			Type:    "systemd",
			Path:    unitName,
			Enabled: true,
		})
	}
}

// collectCronReboot parses crontab files for @reboot entries.
func collectCronReboot(metrics *BootPerformanceMetrics) {
	// Check /etc/crontab
	parseCronFile("/etc/crontab", metrics)

	// Check user crontabs
	crontabDir := "/var/spool/cron/crontabs"
	entries, err := os.ReadDir(crontabDir)
	if err != nil {
		// Also try /var/spool/cron (RHEL/CentOS style)
		crontabDir = "/var/spool/cron"
		entries, err = os.ReadDir(crontabDir)
		if err != nil {
			return
		}
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		parseCronFile(filepath.Join(crontabDir, entry.Name()), metrics)
	}
}

// parseCronFile reads a crontab file and extracts @reboot entries.
func parseCronFile(path string, metrics *BootPerformanceMetrics) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}

	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		enabled := true
		displayLine := line

		// Check for commented-out @reboot lines
		if strings.HasPrefix(line, "#") {
			stripped := strings.TrimSpace(strings.TrimPrefix(line, "#"))
			if strings.HasPrefix(stripped, "@reboot") {
				enabled = false
				displayLine = stripped
			} else {
				continue
			}
		}

		if !strings.HasPrefix(displayLine, "@reboot") {
			continue
		}

		// Extract the command part after @reboot
		command := strings.TrimSpace(strings.TrimPrefix(displayLine, "@reboot"))
		if command == "" {
			continue
		}

		// Use the first word of the command as the name
		cmdParts := strings.Fields(command)
		name := filepath.Base(cmdParts[0])

		metrics.StartupItems = append(metrics.StartupItems, StartupItem{
			Name:    name,
			Type:    "cron",
			Path:    path + ": " + command,
			Enabled: enabled,
		})
	}
}

// collectInitDScripts scans /etc/init.d/ for legacy init scripts.
func collectInitDScripts(metrics *BootPerformanceMetrics) {
	initDir := "/etc/init.d"
	entries, err := os.ReadDir(initDir)
	if err != nil {
		return
	}

	// Build a set of systemd names already collected to avoid duplicates
	systemdNames := make(map[string]bool)
	for _, item := range metrics.StartupItems {
		if item.Type == "systemd" {
			systemdNames[item.Name] = true
		}
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		// Skip common non-service files
		if name == "README" || name == "skeleton" || strings.HasPrefix(name, ".") {
			continue
		}
		// Skip if already collected as a systemd unit
		if systemdNames[name] {
			continue
		}

		scriptPath := filepath.Join(initDir, name)
		info, err := entry.Info()
		if err != nil {
			continue
		}
		// Only include executable files
		if info.Mode()&0111 == 0 {
			continue
		}

		metrics.StartupItems = append(metrics.StartupItems, StartupItem{
			Name:    name,
			Type:    "init_d",
			Path:    scriptPath,
			Enabled: true, // Present in init.d implies enabled on legacy systems
		})
	}
}

// collectSystemdBlame runs systemd-analyze blame and returns a map of service name to milliseconds.
func collectSystemdBlame() map[string]int64 {
	result := make(map[string]int64)

	cmd := exec.Command("systemd-analyze", "blame", "--no-pager")
	output, err := cmd.Output()
	if err != nil {
		return result
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		// Format: "  1.234s service-name.service"
		// or:     "  456ms service-name.service"
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}

		timeStr := fields[0]
		serviceName := strings.TrimSuffix(fields[1], ".service")

		seconds := parseSystemdTime(timeStr)
		ms := int64(seconds * 1000)
		if ms > 0 {
			result[serviceName] = ms
		}
	}

	return result
}

// enrichDiskIO reads /proc/<pid>/io for recently started processes (within 60s of boot)
// and enriches startup items with disk I/O data.
func enrichDiskIO(metrics *BootPerformanceMetrics) {
	if metrics.BootTimestamp.IsZero() {
		return
	}

	bootUnix := metrics.BootTimestamp.Unix()
	cutoff := bootUnix + 60 // 60 seconds after boot

	// Read all processes from /proc
	procEntries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}

	// Build a map of startup item names for matching
	itemIndex := make(map[string]int)
	for i, item := range metrics.StartupItems {
		itemIndex[item.Name] = i
	}

	for _, entry := range procEntries {
		if !entry.IsDir() {
			continue
		}
		pid := entry.Name()
		// Check if it's a numeric PID
		if _, err := strconv.Atoi(pid); err != nil {
			continue
		}

		// Read process start time from /proc/<pid>/stat
		startTime := getProcessStartTime(pid, bootUnix)
		if startTime == 0 || startTime > cutoff {
			continue
		}

		// Read process comm (name)
		commData, err := os.ReadFile(filepath.Join("/proc", pid, "comm"))
		if err != nil {
			continue
		}
		procName := strings.TrimSpace(string(commData))

		// Match against startup items
		idx, ok := itemIndex[procName]
		if !ok {
			continue
		}

		// Read I/O stats
		ioData, err := os.ReadFile(filepath.Join("/proc", pid, "io"))
		if err != nil {
			continue
		}

		var readBytes, writeBytes uint64
		ioScanner := bufio.NewScanner(bytes.NewReader(ioData))
		for ioScanner.Scan() {
			ioLine := ioScanner.Text()
			if strings.HasPrefix(ioLine, "read_bytes:") {
				val := strings.TrimSpace(strings.TrimPrefix(ioLine, "read_bytes:"))
				readBytes, _ = strconv.ParseUint(val, 10, 64)
			} else if strings.HasPrefix(ioLine, "write_bytes:") {
				val := strings.TrimSpace(strings.TrimPrefix(ioLine, "write_bytes:"))
				writeBytes, _ = strconv.ParseUint(val, 10, 64)
			}
		}

		totalIO := readBytes + writeBytes
		if totalIO > 0 {
			metrics.StartupItems[idx].DiskIoBytes = totalIO
			metrics.StartupItems[idx].ImpactScore = CalculateImpactScore(
				metrics.StartupItems[idx].CpuTimeMs,
				totalIO,
			)
		}
	}
}

// getProcessStartTime returns the approximate Unix timestamp when a process started.
// It reads the starttime field from /proc/<pid>/stat and converts using boot time and clock ticks.
func getProcessStartTime(pid string, bootUnix int64) int64 {
	statData, err := os.ReadFile(filepath.Join("/proc", pid, "stat"))
	if err != nil {
		return 0
	}

	// /proc/<pid>/stat format: pid (comm) state ... field22=starttime
	// The comm field can contain spaces and parentheses, so find the last ')'
	statStr := string(statData)
	closeParen := strings.LastIndex(statStr, ")")
	if closeParen < 0 || closeParen+2 >= len(statStr) {
		return 0
	}

	// Fields after (comm) start at index 2 (state is field index 2)
	rest := strings.TrimSpace(statStr[closeParen+2:])
	fields := strings.Fields(rest)
	// starttime is field 22 in /proc/<pid>/stat (0-indexed from after comm: index 19)
	// state=0, ppid=1, pgrp=2, session=3, tty_nr=4, tpgid=5, flags=6,
	// minflt=7, cminflt=8, majflt=9, cmajflt=10, utime=11, stime=12,
	// cutime=13, cstime=14, priority=15, nice=16, num_threads=17,
	// itrealvalue=18, starttime=19
	if len(fields) < 20 {
		return 0
	}

	startTicks, err := strconv.ParseInt(fields[19], 10, 64)
	if err != nil {
		return 0
	}

	// Get clock ticks per second (usually 100 on Linux)
	clkTck := int64(100) // sysconf(_SC_CLK_TCK) default
	cmd := exec.Command("getconf", "CLK_TCK")
	if out, err := cmd.Output(); err == nil {
		if val, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64); err == nil && val > 0 {
			clkTck = val
		}
	}

	return bootUnix + (startTicks / clkTck)
}

// ManageStartupItem enables or disables a startup item on Linux.
// Supported types: "systemd", "cron", "init_d".
// Action must be "enable" or "disable".
func ManageStartupItem(name, itemType, path, action string) error {
	if action != "enable" && action != "disable" {
		return fmt.Errorf("invalid action %q: must be \"enable\" or \"disable\"", action)
	}

	// Validate the service name to prevent command injection
	if !safeServiceNameRegex.MatchString(name) {
		return fmt.Errorf("invalid service name %q: only alphanumeric, dash, underscore, dot, and @ are allowed", name)
	}

	switch itemType {
	case "systemd":
		return manageSystemdService(name, action)
	case "cron":
		return manageCronReboot(path, action)
	case "init_d":
		return manageInitDService(name, action)
	default:
		return fmt.Errorf("unsupported startup item type %q", itemType)
	}
}

// manageSystemdService enables or disables a systemd service unit.
func manageSystemdService(name, action string) error {
	// Ensure .service suffix
	unitName := name
	if !strings.HasSuffix(unitName, ".service") {
		unitName = name + ".service"
	}

	cmd := exec.Command("systemctl", action, unitName)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl %s %s failed: %v: %s", action, unitName, err, strings.TrimSpace(string(output)))
	}
	return nil
}

// manageCronReboot enables or disables a @reboot cron entry by commenting/uncommenting it.
// The path field is expected to be in the format "filepath: command".
func manageCronReboot(path, action string) error {
	// Parse the path to get the file and command
	parts := strings.SplitN(path, ": ", 2)
	if len(parts) != 2 {
		return fmt.Errorf("invalid cron path format %q: expected \"filepath: command\"", path)
	}
	cronFile := parts[0]
	cronCommand := parts[1]

	data, err := os.ReadFile(cronFile)
	if err != nil {
		return fmt.Errorf("failed to read cron file %s: %v", cronFile, err)
	}

	lines := strings.Split(string(data), "\n")
	found := false

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)

		if action == "disable" {
			// Look for active @reboot line with matching command
			if strings.HasPrefix(trimmed, "@reboot") {
				cmd := strings.TrimSpace(strings.TrimPrefix(trimmed, "@reboot"))
				if cmd == cronCommand {
					lines[i] = "#" + line
					found = true
					break
				}
			}
		} else { // enable
			// Look for commented @reboot line with matching command
			if strings.HasPrefix(trimmed, "#") {
				stripped := strings.TrimSpace(strings.TrimPrefix(trimmed, "#"))
				if strings.HasPrefix(stripped, "@reboot") {
					cmd := strings.TrimSpace(strings.TrimPrefix(stripped, "@reboot"))
					if cmd == cronCommand {
						// Remove the leading # (preserve indentation)
						if strings.HasPrefix(line, "#") {
							lines[i] = line[1:]
						}
						found = true
						break
					}
				}
			}
		}
	}

	if !found {
		return fmt.Errorf("@reboot entry for command %q not found in %s", cronCommand, cronFile)
	}

	// Write the modified file back
	err = os.WriteFile(cronFile, []byte(strings.Join(lines, "\n")), 0644)
	if err != nil {
		return fmt.Errorf("failed to write cron file %s: %v", cronFile, err)
	}

	return nil
}

// manageInitDService enables or disables a legacy init.d service.
// Tries update-rc.d first, falls back to systemctl.
func manageInitDService(name, action string) error {
	// Try update-rc.d (Debian/Ubuntu)
	updateRcD, err := exec.LookPath("update-rc.d")
	if err == nil {
		var cmd *exec.Cmd
		if action == "disable" {
			cmd = exec.Command(updateRcD, name, "disable")
		} else {
			cmd = exec.Command(updateRcD, name, "enable")
		}
		output, err := cmd.CombinedOutput()
		if err == nil {
			return nil
		}
		// If update-rc.d fails, fall through to systemctl
		_ = output
	}

	// Fallback: use systemctl
	cmd := exec.Command("systemctl", action, name)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to %s init.d service %s: %v: %s", action, name, err, strings.TrimSpace(string(output)))
	}
	return nil
}
