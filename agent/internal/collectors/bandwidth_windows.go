//go:build windows

package collectors

import (
	"fmt"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// windowsLinkSpeeds reads link speeds in-process from the IP Helper interface
// table. Before #9267 this spawned `powershell Get-NetAdapter` (plus a
// conhost.exe) once per adapter whenever an interface's cached speed expired —
// about four PowerShell processes every five minutes on a typical laptop.
// Now one GetIfTable2Ex call serves every adapter in a metrics cycle, and
// MetricsCollector.getCachedLinkSpeed still caches each result for
// speedCacheTTL on top of that.
var windowsLinkSpeeds = &linkSpeedSource{
	read: readIfTable2LinkSpeeds,
	ttl:  linkSpeedTableTTL,
	now:  time.Now,
}

// getLinkSpeed returns the link speed in bits/sec for the named interface on
// Windows. ifaceName is the interface alias (gopsutil uses net.Interfaces,
// whose Name is the adapter's friendly name, i.e. MIB_IF_ROW2.Alias); the
// adapter description is accepted as a fallback. Returns 0 if unavailable.
func getLinkSpeed(ifaceName string) uint64 {
	return windowsLinkSpeeds.speed(ifaceName)
}

// readIfTable2LinkSpeeds snapshots MIB_IF_TABLE2 via GetIfTable2Ex.
// MibIfTableNormal is used rather than MibIfTableNormalWithoutStatistics
// because the latter does not guarantee the link-speed members are populated.
func readIfTable2LinkSpeeds() ([]ifLinkSpeedRow, error) {
	var table *windows.MibIfTable2
	if err := windows.GetIfTable2Ex(windows.MibIfTableNormal, &table); err != nil {
		return nil, fmt.Errorf("GetIfTable2Ex: %w", err)
	}
	if table == nil {
		return nil, nil
	}
	defer windows.FreeMibTable(unsafe.Pointer(table))

	entries := unsafe.Slice(&table.Table[0], table.NumEntries)
	rows := make([]ifLinkSpeedRow, 0, len(entries))
	for i := range entries {
		e := &entries[i]
		rows = append(rows, ifLinkSpeedRow{
			Alias:             windows.UTF16ToString(e.Alias[:]),
			Description:       windows.UTF16ToString(e.Description[:]),
			ReceiveLinkSpeed:  e.ReceiveLinkSpeed,
			TransmitLinkSpeed: e.TransmitLinkSpeed,
		})
	}
	return rows, nil
}
