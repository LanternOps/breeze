//go:build windows

package collectors

import (
	"context"
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

	"github.com/shirou/gopsutil/v3/host"
)

// psTimeout is the maximum duration for any single PowerShell invocation.
const psTimeout = 30 * time.Second

// shellMetacharRegex matches characters that could be used for shell injection.
var shellMetacharRegex = regexp.MustCompile(`[;&|` + "`" + `$(){}[\]<>!~'"\\` + "\n\r" + `]`)

// Collect gathers boot performance metrics on Windows.
// It returns partial data when some sub-collections fail.
func (c *BootPerformanceCollector) Collect() (*BootPerformanceMetrics, error) {
	metrics := &BootPerformanceMetrics{}

	// 1. Collect boot timing from Event Log (Event ID 100, Diagnostics-Performance)
	if err := collectBootTiming(metrics); err != nil {
		slog.Warn("failed to collect boot timing from event log, falling back to gopsutil", "error", err)
		collectBootTimingFallback(metrics)
	}

	// 2. Collect startup items from multiple sources
	var startupItems []StartupItem

	// Registry Run keys (HKLM + HKCU)
	if items, err := collectRegistryRunKeys(); err != nil {
		slog.Warn("failed to collect registry Run keys", "error", err)
	} else {
		startupItems = append(startupItems, items...)
	}

	// Startup folder items
	if items, err := collectStartupFolderItems(); err != nil {
		slog.Warn("failed to collect startup folder items", "error", err)
	} else {
		startupItems = append(startupItems, items...)
	}

	// Auto-start services
	if items, err := collectAutoStartServices(); err != nil {
		slog.Warn("failed to collect auto-start services", "error", err)
	} else {
		startupItems = append(startupItems, items...)
	}

	// 3. Collect process performance impact for items started within 60s of boot
	enrichStartupItemPerformance(startupItems, metrics.BootTimestamp)

	metrics.StartupItems = startupItems
	metrics.StartupItemCount = len(startupItems)

	return metrics, nil
}

// ---- Boot Timing Collection ----

// bootDiagEvent represents the parsed fields from Event ID 100
// (Microsoft-Windows-Diagnostics-Performance/Operational).
type bootDiagEvent struct {
	BootTime         string `json:"BootTime"`
	MainPathBootTime string `json:"MainPathBootTime"`
	BootPostBootTime string `json:"BootPostBootTime"`
}

// collectBootTiming queries the Diagnostics-Performance event log for boot durations.
func collectBootTiming(m *BootPerformanceMetrics) error {
	// Event ID 100 contains boot performance data in XML.
	// We extract BootTime, MainPathBootTime, BootPostBootTime (all in milliseconds).
	psScript := `
$event = Get-WinEvent -FilterHashtable @{
    LogName='Microsoft-Windows-Diagnostics-Performance/Operational';
    Id=100
} -MaxEvents 1 -ErrorAction Stop
$xml = [xml]$event.ToXml()
$ns = New-Object Xml.XmlNamespaceManager($xml.NameTable)
$ns.AddNamespace('e','http://schemas.microsoft.com/win/2004/08/events/event')
$data = $xml.SelectNodes('//e:EventData/e:Data', $ns)
$obj = @{}
foreach ($d in $data) { $obj[$d.Name] = $d.'#text' }
@{
    BootTime         = $obj['BootTime']
    MainPathBootTime = $obj['MainPathBootTime']
    BootPostBootTime = $obj['BootPostBootTime']
} | ConvertTo-Json -Compress
`
	ctx, cancel := context.WithTimeout(context.Background(), psTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", psScript)
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("powershell boot diag query failed: %w", err)
	}

	trimmed := strings.TrimSpace(string(output))
	if trimmed == "" {
		return fmt.Errorf("empty output from boot diagnostics query")
	}

	var diag bootDiagEvent
	if err := json.Unmarshal([]byte(trimmed), &diag); err != nil {
		return fmt.Errorf("failed to parse boot diagnostics JSON: %w", err)
	}

	// Values are in milliseconds
	mainPathMs, err := strconv.ParseFloat(diag.MainPathBootTime, 64)
	if err != nil {
		slog.Warn("failed to parse MainPathBootTime", "value", diag.MainPathBootTime, "error", err)
	}
	postBootMs, err := strconv.ParseFloat(diag.BootPostBootTime, 64)
	if err != nil {
		slog.Warn("failed to parse BootPostBootTime", "value", diag.BootPostBootTime, "error", err)
	}
	bootTimeMs, err := strconv.ParseFloat(diag.BootTime, 64)
	if err != nil {
		slog.Warn("failed to parse BootTime", "value", diag.BootTime, "error", err)
	}

	// MainPathBootTime = BIOS + OS loader time
	// BootPostBootTime = time from login screen to desktop ready
	// BootTime = total boot time (may differ from sum)
	m.OsLoaderSeconds = mainPathMs / 1000.0
	m.DesktopReadySeconds = postBootMs / 1000.0

	// Use BootTime as total if available, otherwise sum components
	if bootTimeMs > 0 {
		m.TotalBootSeconds = bootTimeMs / 1000.0
	} else {
		m.TotalBootSeconds = m.OsLoaderSeconds + m.DesktopReadySeconds
	}

	// Estimate BIOS time as a fraction (UEFI firmware time is separate from OS boot)
	// Windows doesn't directly expose BIOS time in this event, so we leave it at 0
	// unless we can derive it from the total minus the others.
	if m.TotalBootSeconds > (m.OsLoaderSeconds + m.DesktopReadySeconds) {
		m.BiosSeconds = m.TotalBootSeconds - m.OsLoaderSeconds - m.DesktopReadySeconds
	}

	// Determine boot timestamp from gopsutil for consistency
	if bootEpoch, err := host.BootTime(); err == nil {
		m.BootTimestamp = time.Unix(int64(bootEpoch), 0)
	}

	return nil
}

// collectBootTimingFallback uses gopsutil to get the boot timestamp.
// Boot phase timing breakdowns are unavailable via this fallback.
func collectBootTimingFallback(m *BootPerformanceMetrics) {
	bootEpoch, err := host.BootTime()
	if err != nil {
		slog.Warn("gopsutil boot time fallback also failed", "error", err)
		return
	}
	m.BootTimestamp = time.Unix(int64(bootEpoch), 0)
	// We cannot determine BIOS/loader/desktop splits from gopsutil alone
}

// ---- Startup Item Collection ----

// registryRunItem represents a startup entry from a registry Run key.
type registryRunItem struct {
	Name  string `json:"Name"`
	Value string `json:"Value"`
	Hive  string `json:"Hive"`
}

// collectRegistryRunKeys enumerates HKLM and HKCU Run keys.
func collectRegistryRunKeys() ([]StartupItem, error) {
	psScript := `
$items = @()
$paths = @(
    @{ Hive='HKLM'; Path='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' },
    @{ Hive='HKCU'; Path='HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' }
)
foreach ($p in $paths) {
    $props = Get-ItemProperty -Path $p.Path -ErrorAction SilentlyContinue
    if ($props) {
        $props.PSObject.Properties | Where-Object {
            $_.Name -notlike 'PS*' -and $_.Name -ne '(default)'
        } | ForEach-Object {
            $items += @{
                Name  = $_.Name
                Value = [string]$_.Value
                Hive  = $p.Hive
            }
        }
    }
}
$items | ConvertTo-Json -Compress -Depth 2
`
	ctx, cancel := context.WithTimeout(context.Background(), psTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", psScript)
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("registry run key query failed: %w", err)
	}

	trimmed := strings.TrimSpace(string(output))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}

	var regItems []registryRunItem
	if err := json.Unmarshal([]byte(trimmed), &regItems); err != nil {
		// PowerShell returns a bare object (not array) for a single result
		var single registryRunItem
		if err2 := json.Unmarshal([]byte(trimmed), &single); err2 != nil {
			return nil, fmt.Errorf("failed to parse registry run JSON: %w", err)
		}
		regItems = []registryRunItem{single}
	}

	var items []StartupItem
	for _, r := range regItems {
		items = append(items, StartupItem{
			Name:    r.Name,
			Type:    "run_key",
			Path:    r.Value,
			Enabled: true, // If it's in the Run key, it's enabled
		})
	}

	return items, nil
}

// collectStartupFolderItems enumerates the user's Startup folder.
func collectStartupFolderItems() ([]StartupItem, error) {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return nil, fmt.Errorf("APPDATA environment variable not set")
	}

	startupDir := filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
	entries, err := os.ReadDir(startupDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to read startup folder: %w", err)
	}

	var items []StartupItem
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		fullPath := filepath.Join(startupDir, name)

		// Items with .disabled extension are treated as disabled
		enabled := true
		if strings.HasSuffix(strings.ToLower(name), ".disabled") {
			enabled = false
			name = strings.TrimSuffix(name, filepath.Ext(name)) // strip .disabled
		}

		items = append(items, StartupItem{
			Name:    strings.TrimSuffix(name, filepath.Ext(name)),
			Type:    "startup_folder",
			Path:    fullPath,
			Enabled: enabled,
		})
	}

	return items, nil
}

// autoStartService represents a Windows service with automatic start type.
type autoStartService struct {
	Name        string `json:"Name"`
	DisplayName string `json:"DisplayName"`
	Status      string `json:"Status"`
	PathName    string `json:"PathName"`
}

// collectAutoStartServices queries services set to start automatically.
func collectAutoStartServices() ([]StartupItem, error) {
	psScript := `
Get-CimInstance -ClassName Win32_Service -Filter "StartMode='Auto'" -ErrorAction SilentlyContinue |
    Select-Object Name, DisplayName, @{N='Status';E={$_.State}}, PathName |
    ConvertTo-Json -Compress -Depth 2
`
	ctx, cancel := context.WithTimeout(context.Background(), psTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", psScript)
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("auto-start service query failed: %w", err)
	}

	trimmed := strings.TrimSpace(string(output))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}

	var services []autoStartService
	if err := json.Unmarshal([]byte(trimmed), &services); err != nil {
		// PowerShell single-object case
		var single autoStartService
		if err2 := json.Unmarshal([]byte(trimmed), &single); err2 != nil {
			return nil, fmt.Errorf("failed to parse services JSON: %w", err)
		}
		services = []autoStartService{single}
	}

	var items []StartupItem
	for _, svc := range services {
		items = append(items, StartupItem{
			Name:    svc.DisplayName,
			Type:    "service",
			Path:    svc.PathName,
			Enabled: strings.EqualFold(svc.Status, "Running"),
		})
	}

	return items, nil
}

// ---- Performance Impact Enrichment ----

// processPerf represents CPU and I/O data for a process started near boot.
type processPerf struct {
	Name        string  `json:"Name"`
	CPUMs       float64 `json:"CPUMs"`
	DiskIOBytes uint64  `json:"DiskIOBytes"`
}

// enrichStartupItemPerformance collects CPU time and disk I/O for processes started
// within 60 seconds of boot and matches them to startup items.
func enrichStartupItemPerformance(items []StartupItem, bootTime time.Time) {
	if bootTime.IsZero() || len(items) == 0 {
		return
	}

	// Get processes that started within the first 60 seconds after boot
	bootStr := bootTime.Format(time.RFC3339)
	psScript := fmt.Sprintf(`
$boot = [DateTime]::Parse('%s')
$cutoff = $boot.AddSeconds(60)
Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.StartTime -ne $null -and $_.StartTime -ge $boot -and $_.StartTime -le $cutoff
} | ForEach-Object {
    @{
        Name        = $_.ProcessName
        CPUMs       = [math]::Round($_.TotalProcessorTime.TotalMilliseconds, 0)
        DiskIOBytes = 0
    }
} | ConvertTo-Json -Compress -Depth 2
`, bootStr)

	ctx, cancel := context.WithTimeout(context.Background(), psTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", psScript)
	output, err := cmd.Output()
	if err != nil {
		slog.Warn("failed to collect process performance data", "error", err)
		return
	}

	trimmed := strings.TrimSpace(string(output))
	if trimmed == "" || trimmed == "null" {
		return
	}

	var procs []processPerf
	if err := json.Unmarshal([]byte(trimmed), &procs); err != nil {
		var single processPerf
		if err2 := json.Unmarshal([]byte(trimmed), &single); err2 != nil {
			slog.Warn("failed to parse process performance JSON", "error", err)
			return
		}
		procs = []processPerf{single}
	}

	// Build a lookup map by lowercase process name
	procMap := make(map[string]processPerf, len(procs))
	for _, p := range procs {
		procMap[strings.ToLower(p.Name)] = p
	}

	// Match startup items to process performance data
	for i := range items {
		// Try to match by extracting the executable name from the path
		exeName := extractExeName(items[i].Path)
		if exeName == "" {
			continue
		}

		if p, ok := procMap[strings.ToLower(exeName)]; ok {
			items[i].CpuTimeMs = int64(p.CPUMs)
			items[i].DiskIoBytes = p.DiskIOBytes
			items[i].ImpactScore = CalculateImpactScore(items[i].CpuTimeMs, items[i].DiskIoBytes)
		}
	}
}

// extractExeName extracts the process name (without extension) from a path.
func extractExeName(path string) string {
	if path == "" {
		return ""
	}
	// Handle quoted paths: "C:\Program Files\app.exe" -args
	p := path
	if strings.HasPrefix(p, `"`) {
		end := strings.Index(p[1:], `"`)
		if end > 0 {
			p = p[1 : end+1]
		}
	} else {
		// Take first space-delimited token for unquoted paths
		if idx := strings.Index(p, " "); idx > 0 {
			p = p[:idx]
		}
	}

	base := filepath.Base(p)
	ext := filepath.Ext(base)
	if ext != "" {
		return strings.TrimSuffix(base, ext)
	}
	return base
}

// ---- Manage Startup Items ----

// ManageStartupItem enables or disables a startup item on Windows.
// Supported types: "service", "run_key", "startup_folder".
// action must be "enable" or "disable".
func ManageStartupItem(name, itemType, path, action string) error {
	// Validate action
	if action != "enable" && action != "disable" {
		return fmt.Errorf("invalid action %q: must be 'enable' or 'disable'", action)
	}

	// Validate inputs against shell metacharacters
	if shellMetacharRegex.MatchString(name) {
		return fmt.Errorf("invalid characters in startup item name")
	}
	if shellMetacharRegex.MatchString(path) {
		return fmt.Errorf("invalid characters in startup item path")
	}

	switch itemType {
	case "service":
		return manageService(name, action)
	case "run_key":
		return manageRunKey(name, path, action)
	case "startup_folder":
		return manageStartupFolder(path, action)
	default:
		return fmt.Errorf("unsupported startup item type: %q", itemType)
	}
}

// manageService enables or disables a Windows service using sc.exe.
func manageService(name, action string) error {
	var startType string
	if action == "disable" {
		startType = "disabled"
	} else {
		startType = "auto"
	}

	ctx, cancel := context.WithTimeout(context.Background(), psTimeout)
	defer cancel()

	// sc.exe requires the format "start= <type>" (space between = and value).
	// Go's exec.Command joins "start=" and the start type with a space automatically.
	cmd := exec.CommandContext(ctx, "sc.exe", "config", name, "start=", startType)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("sc.exe config failed: %s: %w", strings.TrimSpace(string(output)), err)
	}

	return nil
}

// manageRunKey adds or removes a registry Run key entry.
func manageRunKey(name, path, action string) error {
	ctx, cancel := context.WithTimeout(context.Background(), psTimeout)
	defer cancel()

	if action == "disable" {
		// Delete the registry value from HKCU Run key
		cmd := exec.CommandContext(ctx, "reg.exe", "delete",
			`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`,
			"/v", name, "/f")
		output, err := cmd.CombinedOutput()
		if err != nil {
			// Also try HKLM
			cmd2 := exec.CommandContext(ctx, "reg.exe", "delete",
				`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`,
				"/v", name, "/f")
			output2, err2 := cmd2.CombinedOutput()
			if err2 != nil {
				return fmt.Errorf("reg.exe delete failed (HKCU: %s, HKLM: %s): %w",
					strings.TrimSpace(string(output)),
					strings.TrimSpace(string(output2)),
					err2)
			}
		}
	} else {
		// Add the registry value to HKCU Run key
		cmd := exec.CommandContext(ctx, "reg.exe", "add",
			`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`,
			"/v", name, "/t", "REG_SZ", "/d", path, "/f")
		output, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("reg.exe add failed: %s: %w", strings.TrimSpace(string(output)), err)
		}
	}

	return nil
}

// manageStartupFolder disables a startup folder item by renaming with .disabled
// extension, or re-enables by removing the .disabled extension.
func manageStartupFolder(path, action string) error {
	if action == "disable" {
		// Rename file to file.disabled
		disabledPath := path + ".disabled"
		if _, err := os.Stat(path); os.IsNotExist(err) {
			return fmt.Errorf("startup folder item not found: %s", path)
		}
		if err := os.Rename(path, disabledPath); err != nil {
			return fmt.Errorf("failed to disable startup folder item: %w", err)
		}
	} else {
		// Remove .disabled extension
		if !strings.HasSuffix(path, ".disabled") {
			// The item might already be enabled, or caller passed the original path
			enabledPath := path
			disabledPath := path + ".disabled"
			if _, err := os.Stat(disabledPath); err == nil {
				// The .disabled version exists, rename it back
				if err := os.Rename(disabledPath, enabledPath); err != nil {
					return fmt.Errorf("failed to enable startup folder item: %w", err)
				}
				return nil
			}
			// Already enabled or not found
			return nil
		}
		enabledPath := strings.TrimSuffix(path, ".disabled")
		if err := os.Rename(path, enabledPath); err != nil {
			return fmt.Errorf("failed to enable startup folder item: %w", err)
		}
	}

	return nil
}
