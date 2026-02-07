package security

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// ErrNotSupported is returned when platform-specific operations are unavailable.
var ErrNotSupported = errors.New("operation not supported on this platform")

// AVProduct represents an antivirus product detected on the endpoint.
type AVProduct struct {
	DisplayName          string `json:"displayName"`
	Provider             string `json:"provider"`
	ProductState         int    `json:"productState"`
	ProductStateHex      string `json:"productStateHex"`
	Registered           bool   `json:"registered"`
	RealTimeProtection   bool   `json:"realTimeProtection"`
	DefinitionsUpToDate  bool   `json:"definitionsUpToDate"`
	PathToSignedProduct  string `json:"pathToSignedProductExe,omitempty"`
	PathToSignedReporter string `json:"pathToSignedReportingExe,omitempty"`
	Timestamp            string `json:"timestamp,omitempty"`
	InstanceGUID         string `json:"instanceGuid,omitempty"`
}

// SecurityStatus is the agent payload for endpoint security posture.
type SecurityStatus struct {
	DeviceID                       string      `json:"deviceId"`
	DeviceName                     string      `json:"deviceName"`
	OrgID                          string      `json:"orgId"`
	OS                             string      `json:"os"`
	Provider                       string      `json:"provider"`
	ProviderVersion                string      `json:"providerVersion,omitempty"`
	DefinitionsVersion             string      `json:"definitionsVersion,omitempty"`
	DefinitionsUpdatedAt           string      `json:"definitionsDate,omitempty"`
	LastScanAt                     string      `json:"lastScan,omitempty"`
	LastScanType                   string      `json:"lastScanType,omitempty"`
	RealTimeProtection             bool        `json:"realTimeProtection"`
	ThreatCount                    int         `json:"threatCount"`
	FirewallEnabled                bool        `json:"firewallEnabled"`
	EncryptionStatus               string      `json:"encryptionStatus"`
	WindowsSecurityCenterAvailable bool        `json:"windowsSecurityCenterAvailable,omitempty"`
	AVProducts                     []AVProduct `json:"avProducts,omitempty"`
}

// DefenderStatus captures Microsoft Defender health details.
type DefenderStatus struct {
	Enabled              bool
	RealTimeProtection   bool
	DefinitionsVersion   string
	DefinitionsUpdatedAt string
	LastQuickScan        string
	LastFullScan         string
}

func normalizeOS(goos string) string {
	switch goos {
	case "darwin":
		return "macos"
	case "windows":
		return "windows"
	case "linux":
		return "linux"
	default:
		return goos
	}
}

func defaultDataDir() string {
	switch runtime.GOOS {
	case "windows":
		programData := os.Getenv("ProgramData")
		if programData == "" {
			return filepath.Join("C:", "ProgramData", "Breeze")
		}
		return filepath.Join(programData, "Breeze")
	case "darwin":
		return "/Library/Application Support/Breeze"
	default:
		return "/var/lib/breeze"
	}
}

func providerFromName(name string) string {
	lower := strings.ToLower(strings.TrimSpace(name))
	switch {
	case strings.Contains(lower, "defender"):
		return "windows_defender"
	case strings.Contains(lower, "bitdefender"):
		return "bitdefender"
	case strings.Contains(lower, "sophos"):
		return "sophos"
	case strings.Contains(lower, "sentinel"):
		return "sentinelone"
	case strings.Contains(lower, "crowdstrike"):
		return "crowdstrike"
	case strings.Contains(lower, "malwarebytes"):
		return "malwarebytes"
	case strings.Contains(lower, "eset"):
		return "eset"
	case strings.Contains(lower, "kaspersky"):
		return "kaspersky"
	default:
		return "other"
	}
}

func latestScanTime(defenderStatus DefenderStatus) string {
	if defenderStatus.LastFullScan != "" {
		return defenderStatus.LastFullScan
	}
	return defenderStatus.LastQuickScan
}

func encryptionString(enabled bool, detectErr error) string {
	if detectErr != nil {
		return "unknown"
	}
	if enabled {
		return "encrypted"
	}
	return "unencrypted"
}

// CollectStatus gathers AV/firewall/encryption posture for this endpoint.
func CollectStatus(cfg *config.Config) (SecurityStatus, error) {
	var status SecurityStatus
	var errs []error

	if cfg == nil {
		cfg = config.Default()
	}

	hostname, hostErr := os.Hostname()
	if hostErr != nil {
		errs = append(errs, hostErr)
	}

	status.DeviceID = cfg.AgentID
	status.OrgID = cfg.OrgID
	status.DeviceName = hostname
	status.OS = normalizeOS(runtime.GOOS)
	status.Provider = "other"
	status.EncryptionStatus = "unknown"

	// Windows Security Center AV products (workstations) first.
	if runtime.GOOS == "windows" {
		products, wscErr := GetWindowsSecurityCenterProducts()
		if wscErr != nil {
			if !errors.Is(wscErr, ErrNotSupported) {
				errs = append(errs, wscErr)
			}
		} else {
			status.WindowsSecurityCenterAvailable = true
			status.AVProducts = products
			if len(products) > 0 {
				primary := products[0]
				for _, candidate := range products {
					if candidate.RealTimeProtection {
						primary = candidate
						break
					}
				}
				status.Provider = primary.Provider
				status.RealTimeProtection = primary.RealTimeProtection
				status.DefinitionsUpdatedAt = primary.Timestamp
			}
		}
	}

	// Defender fallback (Windows Server and environments where WSC data is unavailable).
	defenderStatus, defErr := GetDefenderStatus()
	if defErr != nil {
		if !errors.Is(defErr, ErrNotSupported) {
			errs = append(errs, defErr)
		}
	} else {
		if status.Provider == "other" {
			status.Provider = "windows_defender"
		}
		if defenderStatus.RealTimeProtection {
			status.RealTimeProtection = true
		}
		if status.DefinitionsVersion == "" {
			status.DefinitionsVersion = defenderStatus.DefinitionsVersion
		}
		if status.DefinitionsUpdatedAt == "" {
			status.DefinitionsUpdatedAt = defenderStatus.DefinitionsUpdatedAt
		}
		status.LastScanAt = latestScanTime(defenderStatus)
		if defenderStatus.LastFullScan != "" {
			status.LastScanType = "full"
		} else if defenderStatus.LastQuickScan != "" {
			status.LastScanType = "quick"
		}
	}

	firewallEnabled, fwErr := GetFirewallStatus()
	if fwErr != nil {
		errs = append(errs, fwErr)
	}
	status.FirewallEnabled = firewallEnabled

	encryptionEnabled, encErr := getEncryptionStatus()
	if encErr != nil {
		errs = append(errs, encErr)
	}
	status.EncryptionStatus = encryptionString(encryptionEnabled, encErr)

	return status, errors.Join(errs...)
}

// GetFirewallStatus returns whether a firewall is enabled on the host.
func GetFirewallStatus() (bool, error) {
	switch runtime.GOOS {
	case "windows":
		return getFirewallStatusWindows()
	case "darwin":
		return getFirewallStatusDarwin()
	default:
		return getFirewallStatusLinux()
	}
}

func getFirewallStatusWindows() (bool, error) {
	output, err := runCommand(8*time.Second, "powershell", "-NoProfile", "-NonInteractive", "-Command", "Get-NetFirewallProfile | Select-Object -ExpandProperty Enabled")
	if err != nil {
		return false, err
	}

	for _, line := range strings.Split(output, "\n") {
		if strings.EqualFold(strings.TrimSpace(line), "True") {
			return true, nil
		}
	}

	return false, nil
}

func getFirewallStatusDarwin() (bool, error) {
	output, err := runCommand(5*time.Second, "/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate")
	if err == nil {
		lower := strings.ToLower(output)
		if strings.Contains(lower, "enabled") {
			return true, nil
		}
		if strings.Contains(lower, "disabled") {
			return false, nil
		}
	}

	output, err = runCommand(5*time.Second, "defaults", "read", "/Library/Preferences/com.apple.alf", "globalstate")
	if err != nil {
		return false, err
	}

	state := strings.TrimSpace(output)
	switch state {
	case "1", "2":
		return true, nil
	case "0":
		return false, nil
	default:
		return false, fmt.Errorf("unexpected firewall state: %s", state)
	}
}

func getFirewallStatusLinux() (bool, error) {
	if hasCommand("ufw") {
		output, err := runCommand(5*time.Second, "ufw", "status")
		if err == nil {
			if strings.Contains(output, "Status: active") {
				return true, nil
			}
			if strings.Contains(output, "Status: inactive") {
				return false, nil
			}
		}
	}

	if hasCommand("firewall-cmd") {
		output, err := runCommand(5*time.Second, "firewall-cmd", "--state")
		if err == nil {
			state := strings.TrimSpace(output)
			if state == "running" {
				return true, nil
			}
			if state == "not running" {
				return false, nil
			}
		}
	}

	if hasCommand("systemctl") {
		output, err := runCommand(5*time.Second, "systemctl", "is-active", "firewalld")
		if err == nil {
			state := strings.TrimSpace(output)
			if state == "active" {
				return true, nil
			}
			if state == "inactive" || state == "failed" {
				return false, nil
			}
		}
	}

	return false, fmt.Errorf("unable to determine firewall status")
}

func getEncryptionStatus() (bool, error) {
	switch runtime.GOOS {
	case "windows":
		return getEncryptionStatusWindows()
	case "darwin":
		return getEncryptionStatusDarwin()
	default:
		return getEncryptionStatusLinux()
	}
}

func getEncryptionStatusWindows() (bool, error) {
	output, err := runCommand(8*time.Second, "powershell", "-NoProfile", "-NonInteractive", "-Command", "Get-BitLockerVolume -MountPoint $env:SystemDrive | Select-Object -ExpandProperty ProtectionStatus")
	if err != nil {
		return false, err
	}

	state := strings.TrimSpace(output)
	switch state {
	case "1":
		return true, nil
	case "0":
		return false, nil
	default:
		return false, fmt.Errorf("unexpected BitLocker status: %s", state)
	}
}

func getEncryptionStatusDarwin() (bool, error) {
	output, err := runCommand(5*time.Second, "fdesetup", "status")
	if err != nil {
		return false, err
	}

	lower := strings.ToLower(output)
	if strings.Contains(lower, "filevault is on") {
		return true, nil
	}
	if strings.Contains(lower, "filevault is off") {
		return false, nil
	}
	return false, fmt.Errorf("unexpected FileVault status: %s", strings.TrimSpace(output))
}

func getEncryptionStatusLinux() (bool, error) {
	if !hasCommand("lsblk") {
		return false, fmt.Errorf("lsblk not found")
	}

	output, err := runCommand(5*time.Second, "lsblk", "-o", "TYPE,MOUNTPOINT", "-nr")
	if err != nil {
		return false, err
	}

	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if fields[0] == "crypt" && fields[1] == "/" {
			return true, nil
		}
	}

	return false, nil
}

func hasCommand(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func runCommand(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	output, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return "", fmt.Errorf("command timed out: %s", name)
	}
	if err != nil {
		return "", fmt.Errorf("command failed: %s: %w", name, err)
	}
	return strings.TrimSpace(string(output)), nil
}
