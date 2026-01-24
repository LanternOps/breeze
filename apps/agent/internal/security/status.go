package security

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// SecurityStatus mirrors the API schema for device security status.
type SecurityStatus struct {
	DeviceID             string `json:"deviceId"`
	DeviceName           string `json:"deviceName"`
	OrgID                string `json:"orgId"`
	OS                   string `json:"os"`
	ProviderID           string `json:"providerId"`
	Status               string `json:"status"`
	RiskLevel            string `json:"riskLevel"`
	LastScanAt           string `json:"lastScanAt"`
	ThreatsDetected      int    `json:"threatsDetected"`
	DefinitionsUpdatedAt string `json:"definitionsUpdatedAt"`
	RealTimeProtection   bool   `json:"realTimeProtection"`
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

// ErrNotSupported is returned when Windows-only operations are attempted on other platforms.
var ErrNotSupported = errors.New("this operation is only supported on Windows")

const (
	StatusProtected   = "protected"
	StatusAtRisk      = "at_risk"
	StatusUnprotected = "unprotected"
	StatusOffline     = "offline"
)

const (
	RiskLow      = "low"
	RiskMedium   = "medium"
	RiskHigh     = "high"
	RiskCritical = "critical"
)

const providerDefender = "prov-defender"
const providerUnknown = "prov-unknown"

// CollectStatus gathers the current AV, firewall, and encryption posture.
func CollectStatus() (SecurityStatus, error) {
	var status SecurityStatus
	var errs []error

	cfg, err := config.Load()
	if err != nil {
		errs = append(errs, err)
		cfg = config.DefaultConfig()
	}
	if cfg == nil {
		cfg = config.DefaultConfig()
	}

	hostname, hostErr := os.Hostname()
	if hostErr != nil {
		errs = append(errs, hostErr)
	}

	status.DeviceID = cfg.DeviceID
	status.OrgID = cfg.OrgID
	status.DeviceName = cfg.DeviceName
	if status.DeviceName == "" {
		status.DeviceName = hostname
	}
	status.OS = normalizeOS(runtime.GOOS)
	status.ProviderID = providerUnknown
	status.Status = StatusUnprotected
	status.RiskLevel = RiskHigh

	defenderStatus, err := GetDefenderStatus()
	if err != nil {
		if !errors.Is(err, ErrNotSupported) {
			errs = append(errs, err)
		}
	} else {
		status.ProviderID = providerDefender
		status.RealTimeProtection = defenderStatus.RealTimeProtection
		status.DefinitionsUpdatedAt = defenderStatus.DefinitionsUpdatedAt
		status.LastScanAt = latestScanTime(defenderStatus)
		if defenderStatus.Enabled {
			status.Status = StatusProtected
			status.RiskLevel = RiskLow
		}
	}

	firewallEnabled, err := GetFirewallStatus()
	if err != nil {
		errs = append(errs, err)
	}

	encryptionEnabled, err := getEncryptionStatus()
	if err != nil {
		errs = append(errs, err)
	}

	status = applyPostureRisk(status, firewallEnabled, encryptionEnabled)

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

func applyPostureRisk(status SecurityStatus, firewallEnabled bool, encryptionEnabled bool) SecurityStatus {
	if status.Status == StatusUnprotected {
		if firewallEnabled || encryptionEnabled {
			status.Status = StatusAtRisk
			status.RiskLevel = RiskMedium
		}
		return status
	}

	if status.Status == StatusProtected {
		if !firewallEnabled || !encryptionEnabled || !status.RealTimeProtection {
			status.Status = StatusAtRisk
			if status.RiskLevel == RiskLow {
				status.RiskLevel = RiskMedium
			}
		}
	}

	return status
}

func latestScanTime(defenderStatus DefenderStatus) string {
	if defenderStatus.LastFullScan != "" {
		return defenderStatus.LastFullScan
	}
	return defenderStatus.LastQuickScan
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
