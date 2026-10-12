//go:build windows

package systemrestore

import (
	"errors"
	"fmt"
	"time"

	"github.com/go-ole/go-ole"
	"github.com/yusufpapurcu/wmi"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// This package must stay a leaf above backup/vss: patching imports it today
// and remote/tools will in W07, so importing internal/privilege (which imports
// remote/tools) or anything above it would be an import cycle on Windows.

// win32SystemRestore mirrors the root\default:SystemRestore WMI class. Field
// names must match the WMI property names exactly — the wmi package binds by
// name. WMI declares SequenceNumber as uint32; the wmi package widens it.
type win32SystemRestore struct {
	SequenceNumber int64
	Description    string
	CreationTime   string // CIM DATETIME, e.g. 20260902180311.000000-000
}

const (
	srConfigKey = `SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore`
	srPolicyKey = `SOFTWARE\Policies\Microsoft\Windows NT\SystemRestore`

	// defaultFrequencyMinutes is Microsoft's documented default for
	// SystemRestorePointCreationFrequency when the value is absent.
	defaultFrequencyMinutes int64 = 1440
)

func newEnvironment() environment {
	return environment{
		probe:            probeEntryPoint,
		enabled:          systemRestoreEnabled,
		elevated:         tokenElevated,
		listPoints:       listRestorePoints,
		frequencyMinutes: readCreationFrequency,
		now:              time.Now,
	}
}

// probeEntryPoint checks for srclient.dll!SRSetRestorePointW. Loading a
// System32 DLL by name has no side effects beyond mapping it.
func probeEntryPoint() error {
	if err := srSetRestorePoint.Find(); err != nil {
		return fmt.Errorf("%w: %v", ErrUnsupported, err)
	}
	return nil
}

// tokenElevated reports whether the agent's process token is elevated. The
// agent service runs as LocalSystem, whose token always is; this catches a
// non-elevated interactive run, which SRSetRestorePointW would reject.
func tokenElevated() bool {
	return windows.GetCurrentProcessToken().IsElevated()
}

func listRestorePoints() ([]restorePointRow, error) {
	var rows []win32SystemRestore
	q := "SELECT SequenceNumber, Description, CreationTime FROM SystemRestore"
	if err := wmi.QueryNamespace(q, &rows, `root\default`); err != nil {
		if isProviderAbsent(oleErrorCodes(err), err.Error()) {
			return nil, fmt.Errorf("%w: SystemRestore WMI class unavailable: %v", ErrUnsupported, err)
		}
		return nil, fmt.Errorf("SystemRestore WMI query failed: %w", err)
	}
	out := make([]restorePointRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, restorePointRow{
			SequenceNumber: r.SequenceNumber,
			Description:    r.Description,
			CreationTime:   parseWMIDateTime(r.CreationTime),
		})
	}
	return out, nil
}

// oleErrorCodes pulls the HRESULT and, for DISP_E_EXCEPTION, the EXCEPINFO
// scode off a go-ole error. WMI reports "invalid class" through the scode.
func oleErrorCodes(err error) []uint32 {
	var oleErr *ole.OleError
	if !errors.As(err, &oleErr) {
		return nil
	}
	codes := []uint32{uint32(oleErr.Code())}
	if info, ok := oleErr.SubError().(ole.EXCEPINFO); ok {
		codes = append(codes, info.SCODE())
	}
	return codes
}

func readCreationFrequency() (int64, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, srConfigKey, registry.QUERY_VALUE)
	if err != nil {
		return defaultFrequencyMinutes, nil // absent key = Windows default
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("SystemRestorePointCreationFrequency")
	if err != nil {
		return defaultFrequencyMinutes, nil
	}
	return int64(v), nil
}

// systemRestoreEnabled reports whether System Restore is switched off
// machine-wide, by Group Policy or by the DisableSR configuration value.
// Protection turned off for just the system drive does not show here; the
// native call reports it as nStatus=ERROR_SERVICE_DISABLED, which classify
// maps to StatusSkippedDisabled.
//
// Breeze NEVER turns System Restore on (#4609 Open Decision 5): enabling it
// allocates shadow storage on the system volume, which can evict existing
// shadow copies and collide with the Breeze backup agent's own snapshots.
func systemRestoreEnabled() (bool, error) {
	for _, path := range []string{srPolicyKey, srConfigKey} {
		if disabledAt(path) {
			return false, nil
		}
	}
	return true, nil
}

func disabledAt(path string) bool {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("DisableSR")
	return err == nil && v == 1
}
