//go:build windows

package collectors

import (
	"errors"
	"fmt"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/collectors/smbios"
	"golang.org/x/sys/windows"
)

var (
	memoryKernel32                   = windows.NewLazySystemDLL("kernel32.dll")
	procMemoryGetSystemFirmwareTable = memoryKernel32.NewProc("GetSystemFirmwareTable")
)

// firmwareProviderRSMB is the 'RSMB' raw SMBIOS provider signature as the
// DWORD GetSystemFirmwareTable expects ('R'<<24 | 'S'<<16 | 'M'<<8 | 'B').
const firmwareProviderRSMB = 0x52534D42

// collectPlatformMemory reads the raw SMBIOS table with
// GetSystemFirmwareTable('RSMB', 0, …): one call to size the buffer, one to
// fill it. No WMI or PowerShell.
func collectPlatformMemory() (*MemoryInfo, error) {
	buf, n, err := getRSMBTable()
	if err != nil {
		return nil, err
	}
	table, _, _, err := parseRawSMBIOSData(buf, n)
	if err != nil {
		return nil, err
	}
	return memoryInfoFromSMBIOSTable(table)
}

func getRSMBTable() ([]byte, uint32, error) {
	if err := procMemoryGetSystemFirmwareTable.Find(); err != nil {
		return nil, 0, fmt.Errorf("memory: GetSystemFirmwareTable unavailable: %w", err)
	}
	size, _, callErr := procMemoryGetSystemFirmwareTable.Call(firmwareProviderRSMB, 0, 0, 0)
	if size == 0 {
		return nil, 0, fmt.Errorf("memory: GetSystemFirmwareTable size query failed: %w", callErr)
	}
	if size > smbios.MaxTableSize+rawSMBIOSHeaderLen {
		return nil, 0, fmt.Errorf("memory: RSMB table of %d bytes exceeds limit", size)
	}
	buf := make([]byte, size)
	n, _, callErr := procMemoryGetSystemFirmwareTable.Call(
		firmwareProviderRSMB, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if n == 0 {
		return nil, 0, fmt.Errorf("memory: GetSystemFirmwareTable read failed: %w", callErr)
	}
	// A return larger than the buffer means the table grew between calls and
	// the buffer holds nothing usable.
	if n > uintptr(len(buf)) {
		return nil, 0, errors.New("memory: RSMB table size changed between calls")
	}
	return buf, uint32(n), nil
}
