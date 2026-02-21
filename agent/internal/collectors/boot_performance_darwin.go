//go:build darwin

package collectors

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// sysctlBoottimeRegex matches the sec= field from sysctl kern.boottime output.
// Example: { sec = 1705000000, usec = 123456 } Mon Jan 15 10:00:00 2024
var sysctlBoottimeRegex = regexp.MustCompile(`sec\s*=\s*(\d+)`)

// shellMetacharRegex matches shell metacharacters for input validation.
var shellMetacharRegex = regexp.MustCompile(`[;&|$` + "`" + `\\!<>(){}'"*?~#\n\r]`)

// Collect gathers boot performance metrics on macOS.
// It retrieves boot timestamp, estimates boot-to-desktop timing, enumerates
// startup items (LaunchAgents, LaunchDaemons, Login Items), and estimates
// per-process performance impact from early-boot processes.
func (c *BootPerformanceCollector) Collect() (*BootPerformanceMetrics, error) {
	metrics := &BootPerformanceMetrics{
		StartupItems: []StartupItem{},
	}

	// --- Boot timestamp from sysctl ---
	bootTime, err := getBootTimestamp()
	if err != nil {
		return nil, fmt.Errorf("failed to get boot timestamp: %w", err)
	}
	metrics.BootTimestamp = bootTime

	// macOS does not expose BIOS/loader phase timings directly.
	// We treat time-to-loginwindow as the boot duration proxy when available,
	// otherwise fall back to uptime as a coarse estimate.
	uptimeSeconds := time.Since(bootTime).Seconds()
	desktopReady := getDesktopReadyTime(bootTime)
	applyDarwinBootTiming(metrics, desktopReady, uptimeSeconds)

	// --- Enumerate startup items ---
	var items []StartupItem

	// LaunchDaemons (system-level)
	items = append(items, enumerateLaunchItems("/Library/LaunchDaemons", "launch_daemon")...)

	// LaunchAgents (system-level)
	items = append(items, enumerateLaunchItems("/Library/LaunchAgents", "launch_agent")...)

	// LaunchAgents (user-level)
	home := os.Getenv("HOME")
	if home != "" {
		userAgentsDir := filepath.Join(home, "Library", "LaunchAgents")
		items = append(items, enumerateLaunchItems(userAgentsDir, "launch_agent")...)
	}

	// Login Items via osascript
	loginItems := getLoginItems()
	items = append(items, loginItems...)

	// --- Estimate performance impact for early-boot processes ---
	earlyProcs := getEarlyBootProcesses(bootTime)
	enrichItemsWithPerformance(items, earlyProcs)

	metrics.StartupItems = items
	metrics.StartupItemCount = len(items)

	return metrics, nil
}

func applyDarwinBootTiming(metrics *BootPerformanceMetrics, desktopReady, uptimeSeconds float64) {
	metrics.BiosSeconds = 0
	metrics.OsLoaderSeconds = 0

	if desktopReady > 0 {
		metrics.DesktopReadySeconds = desktopReady
		metrics.TotalBootSeconds = desktopReady
		return
	}

	// If log-based desktop-ready timing is unavailable, avoid reporting a zero-second
	// boot by falling back to uptime as a coarse estimate.
	metrics.DesktopReadySeconds = 0
	if uptimeSeconds > 0 {
		metrics.TotalBootSeconds = uptimeSeconds
		return
	}
	metrics.TotalBootSeconds = 0
}

// getBootTimestamp retrieves the system boot time from sysctl kern.boottime.
func getBootTimestamp() (time.Time, error) {
	out, err := exec.Command("sysctl", "-n", "kern.boottime").Output()
	if err != nil {
		return time.Time{}, fmt.Errorf("sysctl kern.boottime failed: %w", err)
	}

	output := strings.TrimSpace(string(out))
	matches := sysctlBoottimeRegex.FindStringSubmatch(output)
	if len(matches) < 2 {
		return time.Time{}, fmt.Errorf("could not parse boot time from sysctl output: %s", output)
	}

	sec, err := strconv.ParseInt(matches[1], 10, 64)
	if err != nil {
		return time.Time{}, fmt.Errorf("could not parse seconds value %q: %w", matches[1], err)
	}

	return time.Unix(sec, 0), nil
}

// getDesktopReadyTime attempts to determine the time between boot and loginwindow
// appearing by querying the unified log. Returns seconds, or 0 if unavailable.
func getDesktopReadyTime(bootTime time.Time) float64 {
	// Query for loginwindow events during the last boot.
	// The "loginwindow" process posting its first event is a reasonable proxy
	// for the desktop becoming ready.
	out, err := exec.Command("log", "show",
		"--predicate", `eventMessage contains "loginwindow"`,
		"--last", "boot",
		"--style", "compact",
	).Output()
	if err != nil {
		slog.Warn("failed to query unified log for desktop-ready time", "error", err)
		return 0
	}

	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := scanner.Text()
		// Compact log format: "2024-01-15 10:00:05.123 ... loginwindow ..."
		// We need at least 23 chars for a timestamp with fractional seconds.
		if len(line) < 23 {
			continue
		}

		// Try parsing the timestamp from the start of the line.
		tsStr := line[:23]
		ts, err := time.Parse("2006-01-02 15:04:05.000", tsStr)
		if err != nil {
			// Try without fractional seconds.
			if len(line) >= 19 {
				ts, err = time.Parse("2006-01-02 15:04:05", line[:19])
			}
			if err != nil {
				continue
			}
		}

		// The first loginwindow event after boot gives us the desktop-ready time.
		delta := ts.Sub(bootTime).Seconds()
		if delta > 0 && delta < 600 { // Sanity check: under 10 minutes
			return delta
		}
	}

	return 0
}

// plistJSON represents the relevant fields from a launchd plist file
// after conversion to JSON via plutil.
type plistJSON struct {
	Label            string   `json:"Label"`
	ProgramArguments []string `json:"ProgramArguments"`
	Program          string   `json:"Program"`
	Disabled         bool     `json:"Disabled"`
	RunAtLoad        bool     `json:"RunAtLoad"`
}

// enumerateLaunchItems reads all .plist files from the given directory and
// returns them as StartupItem entries.
func enumerateLaunchItems(dir, itemType string) []StartupItem {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if !os.IsNotExist(err) {
			slog.Warn("failed to read launch items directory", "dir", dir, "error", err)
		}
		return nil
	}

	var items []StartupItem
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".plist") {
			continue
		}

		fullPath := filepath.Join(dir, name)
		item := parseLaunchPlist(fullPath, itemType)
		items = append(items, item)
	}

	return items
}

// parseLaunchPlist parses a single launchd plist file into a StartupItem.
// Uses plutil to convert the plist to JSON for parsing, avoiding external Go
// dependencies for plist handling.
func parseLaunchPlist(path, itemType string) StartupItem {
	item := StartupItem{
		Name:    filepath.Base(path),
		Type:    itemType,
		Path:    path,
		Enabled: true, // Assume enabled unless Disabled=true in plist
	}

	// Use plutil to convert plist to JSON on stdout.
	out, err := exec.Command("plutil", "-convert", "json", "-o", "-", path).Output()
	if err != nil {
		return item
	}

	var p plistJSON
	if err := json.Unmarshal(out, &p); err != nil {
		return item
	}

	if p.Label != "" {
		item.Name = p.Label
	}

	// Resolve the executable path from plist.
	if p.Program != "" {
		item.Path = p.Program
	} else if len(p.ProgramArguments) > 0 {
		item.Path = p.ProgramArguments[0]
	}

	item.Enabled = !p.Disabled

	return item
}

// getLoginItems retrieves login items configured through System Preferences
// via osascript/System Events.
func getLoginItems() []StartupItem {
	out, err := exec.Command("osascript", "-e",
		`tell application "System Events" to get the name of every login item`,
	).Output()
	if err != nil {
		slog.Warn("failed to enumerate login items via osascript", "error", err)
		return nil
	}

	output := strings.TrimSpace(string(out))
	if output == "" {
		return nil
	}

	// Output is comma-separated: "item1, item2, item3"
	names := strings.Split(output, ", ")
	var items []StartupItem
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		items = append(items, StartupItem{
			Name:    name,
			Type:    "login_item",
			Path:    "", // Path not readily available from this AppleScript call.
			Enabled: true,
		})
	}

	return items
}

// processInfo holds parsed data from ps for an early-boot process.
type processInfo struct {
	comm      string
	cpuTimeMs int64
	elapsed   time.Duration
}

// getEarlyBootProcesses finds processes that started within 60 seconds of boot
// and returns their CPU time and command name.
func getEarlyBootProcesses(bootTime time.Time) []processInfo {
	// ps -eo etime,cputime,comm
	// etime format: [[DD-]HH:]MM:SS
	// cputime format: [[DD-]HH:]MM:SS
	out, err := exec.Command("ps", "-eo", "etime,cputime,comm").Output()
	if err != nil {
		slog.Warn("failed to enumerate early boot processes; startup item impact scores will be unavailable", "error", err)
		return nil
	}

	var procs []processInfo
	scanner := bufio.NewScanner(strings.NewReader(string(out)))

	// Skip header line
	if scanner.Scan() {
		// discard header
	}

	now := time.Now()
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}

		etimeStr := fields[0]
		cputimeStr := fields[1]
		comm := strings.Join(fields[2:], " ")

		elapsed := parsePsTime(etimeStr)
		if elapsed == 0 {
			continue
		}

		// Calculate when this process started.
		processStart := now.Add(-elapsed)

		// Check if the process started within 60 seconds of boot.
		timeSinceBoot := processStart.Sub(bootTime)
		if timeSinceBoot < 0 || timeSinceBoot > 60*time.Second {
			continue
		}

		cpuTime := parsePsTime(cputimeStr)
		cpuMs := cpuTime.Milliseconds()

		procs = append(procs, processInfo{
			comm:      filepath.Base(comm),
			cpuTimeMs: cpuMs,
			elapsed:   elapsed,
		})
	}

	return procs
}

// parsePsTime parses ps time format [[DD-]HH:]MM:SS into a time.Duration.
func parsePsTime(s string) time.Duration {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}

	var days, hours, minutes, seconds int

	// Check for DD- prefix (e.g., "3-04:05:06")
	if idx := strings.Index(s, "-"); idx > 0 {
		d, err := strconv.Atoi(s[:idx])
		if err != nil {
			return 0
		}
		days = d
		s = s[idx+1:]
	}

	parts := strings.Split(s, ":")
	switch len(parts) {
	case 3:
		// HH:MM:SS
		h, err := strconv.Atoi(parts[0])
		if err != nil {
			return 0
		}
		hours = h
		m, err := strconv.Atoi(parts[1])
		if err != nil {
			return 0
		}
		minutes = m
		sec, err := strconv.Atoi(parts[2])
		if err != nil {
			return 0
		}
		seconds = sec
	case 2:
		// MM:SS
		m, err := strconv.Atoi(parts[0])
		if err != nil {
			return 0
		}
		minutes = m
		sec, err := strconv.Atoi(parts[1])
		if err != nil {
			return 0
		}
		seconds = sec
	default:
		return 0
	}

	return time.Duration(days)*24*time.Hour +
		time.Duration(hours)*time.Hour +
		time.Duration(minutes)*time.Minute +
		time.Duration(seconds)*time.Second
}

// enrichItemsWithPerformance matches early-boot processes to startup items and
// fills in CpuTimeMs, DiskIoBytes, and ImpactScore.
func enrichItemsWithPerformance(items []StartupItem, procs []processInfo) {
	for i := range items {
		itemBase := strings.ToLower(filepath.Base(items[i].Path))
		itemName := strings.ToLower(items[i].Name)

		for _, proc := range procs {
			procLower := strings.ToLower(proc.comm)
			if procLower == itemBase || strings.Contains(itemName, procLower) || strings.Contains(procLower, itemName) {
				items[i].CpuTimeMs = proc.cpuTimeMs
				// Disk I/O is not available from ps on macOS (unlike Linux /proc/pid/io).
				// We use a rough heuristic of ~10KB per ms of CPU time. This is an
				// order-of-magnitude estimate only and may over- or under-report actual I/O.
				items[i].DiskIoBytes = uint64(proc.cpuTimeMs) * 10240
				items[i].ImpactScore = CalculateImpactScore(items[i].CpuTimeMs, items[i].DiskIoBytes)
				break
			}
		}
	}
}

// ManageStartupItem enables or disables a startup item on macOS.
// Supported types: "launch_agent", "launch_daemon", "login_item".
// Actions: "enable", "disable".
func ManageStartupItem(name, itemType, path, action string) error {
	// Validate inputs against shell metacharacters.
	if shellMetacharRegex.MatchString(name) {
		return fmt.Errorf("invalid characters in item name: %q", name)
	}
	if shellMetacharRegex.MatchString(path) {
		return fmt.Errorf("invalid characters in path: %q", path)
	}
	if action != "enable" && action != "disable" {
		return fmt.Errorf("unsupported action %q: must be \"enable\" or \"disable\"", action)
	}

	switch itemType {
	case "launch_agent", "launch_daemon":
		return manageLaunchdItem(name, path, action)
	case "login_item":
		return manageLoginItem(name, action)
	default:
		return fmt.Errorf("unsupported item type %q on macOS", itemType)
	}
}

// manageLaunchdItem enables or disables a launchd plist via launchctl.
func manageLaunchdItem(label, path, action string) error {
	if label == "" {
		return fmt.Errorf("label is required for launchd items")
	}
	if path == "" {
		return fmt.Errorf("path is required for launchd items")
	}

	// Verify the plist file exists.
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return fmt.Errorf("plist file not found: %s", path)
	}

	// Determine the domain. System-level items use "system", user-level use
	// "gui/<uid>". We infer from the path.
	domain := "system"
	home := os.Getenv("HOME")
	if home != "" && strings.HasPrefix(path, home) {
		// User-level agent: use gui/<uid> domain.
		uidOut, err := exec.Command("id", "-u").Output()
		if err == nil {
			uid := strings.TrimSpace(string(uidOut))
			domain = "gui/" + uid
		}
	}

	switch action {
	case "disable":
		// Try launchctl bootout to unload/disable the service.
		target := domain + "/" + label
		cmd := exec.Command("launchctl", "bootout", target)
		if out, err := cmd.CombinedOutput(); err != nil {
			slog.Info("launchctl bootout failed, falling back to legacy unload", "label", label, "error", strings.TrimSpace(string(out)))
			cmd2 := exec.Command("launchctl", "unload", "-w", path)
			if out2, err2 := cmd2.CombinedOutput(); err2 != nil {
				return fmt.Errorf("failed to disable %s (bootout: %s; unload: %s)", label, string(out), string(out2))
			}
		}
		return nil

	case "enable":
		// Bootstrap (load) the plist into the domain.
		cmd := exec.Command("launchctl", "bootstrap", domain, path)
		if out, err := cmd.CombinedOutput(); err != nil {
			slog.Info("launchctl bootstrap failed, falling back to legacy load", "label", label, "error", strings.TrimSpace(string(out)))
			cmd2 := exec.Command("launchctl", "load", "-w", path)
			if out2, err2 := cmd2.CombinedOutput(); err2 != nil {
				return fmt.Errorf("failed to enable %s (bootstrap: %s; load: %s)", label, string(out), string(out2))
			}
		}
		return nil

	default:
		return fmt.Errorf("unsupported action: %s", action)
	}
}

// manageLoginItem adds or removes a login item via osascript/System Events.
func manageLoginItem(name, action string) error {
	if name == "" {
		return fmt.Errorf("name is required for login items")
	}

	switch action {
	case "disable":
		script := fmt.Sprintf(
			`tell application "System Events" to delete login item "%s"`,
			name,
		)
		cmd := exec.Command("osascript", "-e", script)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("failed to remove login item %q: %s (%w)", name, string(out), err)
		}
		return nil

	case "enable":
		// To add a login item we need a path. Without one, we cannot proceed.
		// This is a limitation: re-adding a removed login item requires the
		// application path, which is not always known.
		return fmt.Errorf("enabling login items requires specifying the application path; use System Preferences to re-add %q", name)

	default:
		return fmt.Errorf("unsupported action: %s", action)
	}
}
