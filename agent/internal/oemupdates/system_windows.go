//go:build windows

package oemupdates

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/host"
	"golang.org/x/sys/windows/registry"
)

type systemInfo struct{}

// BiosVersion reads the SMBIOS BIOS version from the registry, the value the
// hardware collector reports as Win32_BIOS.SMBIOSBIOSVersion, without a spawn.
func (systemInfo) BiosVersion() (string, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\BIOS`, registry.QUERY_VALUE)
	if err != nil {
		return "", fmt.Errorf("open BIOS key: %w", err)
	}
	defer func() { _ = k.Close() }()
	v, _, err := k.GetStringValue("BIOSVersion")
	if err != nil {
		return "", fmt.Errorf("read BIOSVersion: %w", err)
	}
	return strings.TrimSpace(v), nil
}

func (systemInfo) BootTime() (time.Time, error) {
	secs, err := host.BootTime()
	if err != nil {
		return time.Time{}, err
	}
	return time.Unix(int64(secs), 0), nil
}

func exitCodeOf(ps *os.ProcessState) int64 {
	// A Windows exit code is a DWORD; ExitCode reports it as a signed int.
	return int64(uint32(ps.ExitCode()))
}
