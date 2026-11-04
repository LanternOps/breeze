package collectors

import (
	"log/slog"

	"github.com/breeze-rmm/agent/internal/collectors/smbios"
)

// chassisTypeFromSMBIOS reads the chassis type from a raw SMBIOS table. Any
// failure is an unknown chassis: classification falls through to its other
// signals, so this is not worth more than a debug line.
func chassisTypeFromSMBIOS(readTable func() ([]byte, error)) string {
	table, err := readTable()
	if err != nil {
		slog.Debug("chassis type unavailable: cannot read SMBIOS table", "error", err.Error())
		return ""
	}
	chassisType, err := smbios.ParseChassisType(table)
	if err != nil {
		slog.Debug("chassis type unavailable: cannot parse SMBIOS table", "error", err.Error())
		return ""
	}
	return chassisType
}
