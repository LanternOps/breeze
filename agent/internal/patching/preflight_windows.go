//go:build windows

package patching

import (
	"fmt"
	"os"
	"strings"
	"time"
	"unsafe"

	"github.com/shirou/gopsutil/v3/disk"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/breeze-rmm/agent/internal/config"
)

// PreflightOptions configures which pre-flight checks to run before patching.
type PreflightOptions struct {
	CheckServiceHealth bool
	CheckDiskSpace     bool
	MinDiskSpaceGB     float64
	CheckACPower       bool
	CheckMaintWindow   bool
	MaintenanceStart   string   // "HH:MM"
	MaintenanceEnd     string   // "HH:MM"
	MaintenanceDays    []string // ["monday", ...] empty=all
}

// PreflightResult captures the outcome of all pre-flight checks.
type PreflightResult struct {
	OK       bool
	Checks   []PreflightCheck
	Warnings []string
}

// PreflightCheck is one individual check result.
type PreflightCheck struct {
	Name    string
	Passed  bool
	Message string
}

// PreflightOptionsFromConfig builds PreflightOptions from config fields.
func PreflightOptionsFromConfig(cfg *config.Config) PreflightOptions {
	return PreflightOptions{
		CheckServiceHealth: true,
		CheckDiskSpace:     cfg.PatchMinDiskSpaceGB > 0,
		MinDiskSpaceGB:     cfg.PatchMinDiskSpaceGB,
		CheckACPower:       cfg.PatchRequireACPower,
		CheckMaintWindow:   cfg.PatchMaintenanceStart != "" && cfg.PatchMaintenanceEnd != "",
		MaintenanceStart:   cfg.PatchMaintenanceStart,
		MaintenanceEnd:     cfg.PatchMaintenanceEnd,
		MaintenanceDays:    cfg.PatchMaintenanceDays,
	}
}

// RunPreflight runs all enabled pre-flight checks and returns a combined result.
// If any check fails, OK is false and the first failure is returned as the error check.
func RunPreflight(opts PreflightOptions) PreflightResult {
	result := PreflightResult{OK: true}

	if opts.CheckServiceHealth {
		check := checkWUServiceHealth()
		result.Checks = append(result.Checks, check)
		if !check.Passed {
			result.OK = false
		}
	}

	if opts.CheckDiskSpace {
		check := checkDiskSpace(opts.MinDiskSpaceGB)
		result.Checks = append(result.Checks, check)
		if !check.Passed {
			result.OK = false
		}
	}

	if opts.CheckACPower {
		check := checkACPower()
		result.Checks = append(result.Checks, check)
		if !check.Passed {
			result.OK = false
		}
	}

	if opts.CheckMaintWindow {
		check := checkMaintenanceWindow(opts.MaintenanceStart, opts.MaintenanceEnd, opts.MaintenanceDays)
		result.Checks = append(result.Checks, check)
		if !check.Passed {
			result.OK = false
		}
	}

	return result
}

// FirstError returns the first failed check as an ErrPreflightFailed, or nil if all passed.
func (r PreflightResult) FirstError() error {
	for _, check := range r.Checks {
		if !check.Passed {
			return &ErrPreflightFailed{Check: check.Name, Message: check.Message}
		}
	}
	return nil
}

// checkWUServiceHealth ensures the Windows Update service (wuauserv) is running.
// If stopped, it attempts to start it and waits up to 30 seconds.
func checkWUServiceHealth() PreflightCheck {
	check := PreflightCheck{Name: "service_health"}

	m, err := mgr.Connect()
	if err != nil {
		check.Message = fmt.Sprintf("failed to connect to service manager: %v", err)
		return check
	}
	defer m.Disconnect()

	s, err := m.OpenService("wuauserv")
	if err != nil {
		check.Message = fmt.Sprintf("failed to open wuauserv service: %v", err)
		return check
	}
	defer s.Close()

	status, err := s.Query()
	if err != nil {
		check.Message = fmt.Sprintf("failed to query wuauserv status: %v", err)
		return check
	}

	if status.State == svc.Running {
		check.Passed = true
		check.Message = "wuauserv is running"
		return check
	}

	// Attempt to start the service
	if err := s.Start(); err != nil {
		check.Message = fmt.Sprintf("wuauserv is %s and failed to start: %v", svcStateName(status.State), err)
		return check
	}

	// Wait up to 30 seconds for it to reach Running state
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		status, err = s.Query()
		if err != nil {
			check.Message = fmt.Sprintf("failed to query wuauserv after start: %v", err)
			return check
		}
		if status.State == svc.Running {
			check.Passed = true
			check.Message = "wuauserv started successfully"
			return check
		}
		time.Sleep(1 * time.Second)
	}

	check.Message = fmt.Sprintf("wuauserv did not reach running state within 30s (state: %s)", svcStateName(status.State))
	return check
}

func svcStateName(state svc.State) string {
	switch state {
	case svc.Stopped:
		return "Stopped"
	case svc.StartPending:
		return "StartPending"
	case svc.StopPending:
		return "StopPending"
	case svc.Running:
		return "Running"
	case svc.ContinuePending:
		return "ContinuePending"
	case svc.PausePending:
		return "PausePending"
	case svc.Paused:
		return "Paused"
	default:
		return fmt.Sprintf("Unknown(%d)", state)
	}
}

// checkDiskSpace verifies the system drive has at least minGB free space.
func checkDiskSpace(minGB float64) PreflightCheck {
	check := PreflightCheck{Name: "disk_space"}

	systemDrive := os.Getenv("SystemDrive")
	if systemDrive == "" {
		systemDrive = "C:"
	}

	usage, err := disk.Usage(systemDrive + "\\")
	if err != nil {
		check.Message = fmt.Sprintf("failed to check disk space on %s: %v", systemDrive, err)
		return check
	}

	freeGB := float64(usage.Free) / (1024 * 1024 * 1024)
	if freeGB < minGB {
		check.Message = fmt.Sprintf("insufficient disk space: %.1f GB free, minimum %.1f GB required", freeGB, minGB)
		return check
	}

	check.Passed = true
	check.Message = fmt.Sprintf("%.1f GB free on %s", freeGB, systemDrive)
	return check
}

// systemPowerStatus is the SYSTEM_POWER_STATUS struct from Windows API.
type systemPowerStatus struct {
	ACLineStatus        byte
	BatteryFlag         byte
	BatteryLifePercent  byte
	SystemStatusFlag    byte
	BatteryLifeTime     uint32
	BatteryFullLifeTime uint32
}

var (
	kernel32               = windows.NewLazySystemDLL("kernel32.dll")
	procGetSystemPowerStatus = kernel32.NewProc("GetSystemPowerStatus")
)

// checkACPower verifies the machine is on AC power (not battery).
// Desktops (BatteryFlag=128 "no battery") always pass.
func checkACPower() PreflightCheck {
	check := PreflightCheck{Name: "battery"}

	var status systemPowerStatus
	r, _, err := procGetSystemPowerStatus.Call(uintptr(unsafe.Pointer(&status)))
	if r == 0 {
		check.Message = fmt.Sprintf("failed to get power status: %v", err)
		return check
	}

	// BatteryFlag 128 = no system battery (desktop) — always pass
	if status.BatteryFlag == 128 {
		check.Passed = true
		check.Message = "no battery detected (desktop)"
		return check
	}

	// ACLineStatus: 0=offline, 1=online, 255=unknown
	if status.ACLineStatus == 1 {
		check.Passed = true
		check.Message = "AC power connected"
		return check
	}

	check.Message = fmt.Sprintf("running on battery power (battery: %d%%)", status.BatteryLifePercent)
	return check
}

// checkMaintenanceWindow verifies current time falls within the configured maintenance window.
// Handles overnight windows (e.g. 22:00-06:00).
func checkMaintenanceWindow(startStr, endStr string, days []string) PreflightCheck {
	check := PreflightCheck{Name: "maintenance_window"}

	startTime, err := time.Parse("15:04", startStr)
	if err != nil {
		check.Message = fmt.Sprintf("invalid maintenance start time %q: %v", startStr, err)
		return check
	}
	endTime, err := time.Parse("15:04", endStr)
	if err != nil {
		check.Message = fmt.Sprintf("invalid maintenance end time %q: %v", endStr, err)
		return check
	}

	now := time.Now()

	// Check day-of-week if days are specified
	if len(days) > 0 {
		todayName := strings.ToLower(now.Weekday().String())
		dayAllowed := false
		for _, d := range days {
			if strings.ToLower(d) == todayName {
				dayAllowed = true
				break
			}
		}
		if !dayAllowed {
			check.Message = fmt.Sprintf("today (%s) is not in maintenance days", todayName)
			return check
		}
	}

	// Compare time-of-day only (hours and minutes)
	nowMinutes := now.Hour()*60 + now.Minute()
	startMinutes := startTime.Hour()*60 + startTime.Minute()
	endMinutes := endTime.Hour()*60 + endTime.Minute()

	var inWindow bool
	if startMinutes <= endMinutes {
		// Same-day window (e.g. 02:00 - 06:00)
		inWindow = nowMinutes >= startMinutes && nowMinutes < endMinutes
	} else {
		// Overnight window (e.g. 22:00 - 06:00)
		inWindow = nowMinutes >= startMinutes || nowMinutes < endMinutes
	}

	if !inWindow {
		check.Message = fmt.Sprintf("current time %s is outside maintenance window %s-%s", now.Format("15:04"), startStr, endStr)
		return check
	}

	check.Passed = true
	check.Message = fmt.Sprintf("within maintenance window %s-%s", startStr, endStr)
	return check
}

// CreateRestorePoint creates a Windows System Restore point.
// Best-effort: returns error but callers should not block on failure.
func CreateRestorePoint(description string) error {
	var (
		srclientDLL          = windows.NewLazySystemDLL("srclient.dll")
		procSRSetRestorePoint = srclientDLL.NewProc("SRSetRestorePointW")
	)

	if err := procSRSetRestorePoint.Find(); err != nil {
		return fmt.Errorf("SRSetRestorePoint not available: %w", err)
	}

	// RESTOREPOINTINFOW structure
	type restorePointInfo struct {
		EventType         uint32
		RestorePointType  uint32
		SequenceNumber    int64
		Description       [256]uint16
	}

	// STATEMGRSTATUS structure
	type statemgrStatus struct {
		Status         uint32
		SequenceNumber int64
	}

	const (
		beginSystemChange   = 100
		applicationInstall  = 0
	)

	rpi := restorePointInfo{
		EventType:        beginSystemChange,
		RestorePointType: applicationInstall,
	}

	// Convert description to UTF-16, truncate to fit the fixed 256-element array
	descUTF16, err := windows.UTF16FromString(description)
	if err != nil {
		return fmt.Errorf("failed to convert description: %w", err)
	}
	if len(descUTF16) > len(rpi.Description) {
		descUTF16 = descUTF16[:len(rpi.Description)-1]
		descUTF16 = append(descUTF16, 0) // null terminator
	}
	copy(rpi.Description[:], descUTF16)

	var status statemgrStatus
	r, _, callErr := procSRSetRestorePoint.Call(
		uintptr(unsafe.Pointer(&rpi)),
		uintptr(unsafe.Pointer(&status)),
	)
	if r == 0 {
		return fmt.Errorf("SRSetRestorePoint failed: status=%d err=%v", status.Status, callErr)
	}

	return nil
}
