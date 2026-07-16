//go:build windows

package systemstate

import (
	"encoding/csv"
	"errors"
	"io"
	"log/slog"
	"os/exec"
	"strconv"
	"strings"
)

// CollectHardwareProfile captures hardware info via CIM/WMI. It uses PowerShell
// Get-CimInstance rather than wmic.exe: wmic is deprecated and, on Windows
// Server 2022 / Windows 11 (build 20348+), no longer installed by default, so
// the old wmic path silently returned zero cores / zero memory (see the
// system_image backup E2E — hardware_profile came back all-zero on Server 2022).
func (c *WindowsCollector) CollectHardwareProfile() (*HardwareProfile, error) {
	hw := &HardwareProfile{}

	// CPU
	if out, err := cimCSV("Win32_Processor", "", "Name", "NumberOfCores"); err == nil {
		if row := firstCSVRow(out); row != nil {
			hw.CPUModel = csvField(row, "Name")
			hw.CPUCores, _ = strconv.Atoi(csvField(row, "NumberOfCores"))
		}
	}

	// Memory
	if out, err := cimCSV("Win32_ComputerSystem", "", "TotalPhysicalMemory"); err == nil {
		if row := firstCSVRow(out); row != nil {
			bytes, _ := strconv.ParseInt(csvField(row, "TotalPhysicalMemory"), 10, 64)
			hw.TotalMemoryMB = bytes / (1024 * 1024)
		}
	}

	// Disks
	if out, err := cimCSV("Win32_DiskDrive", "", "Name", "Size", "Model"); err == nil {
		for _, row := range allCSVRows(out) {
			sz, _ := strconv.ParseInt(csvField(row, "Size"), 10, 64)
			hw.Disks = append(hw.Disks, DiskInfo{
				Name:      csvField(row, "Name"),
				SizeBytes: sz,
				Model:     csvField(row, "Model"),
			})
		}
	}

	// Partitions (logical disks)
	if out, err := cimCSV("Win32_LogicalDisk", "", "Name", "FileSystem", "Size", "FreeSpace", "VolumeName"); err == nil {
		for _, row := range allCSVRows(out) {
			sz, _ := strconv.ParseInt(csvField(row, "Size"), 10, 64)
			free, _ := strconv.ParseInt(csvField(row, "FreeSpace"), 10, 64)
			part := PartitionInfo{
				Name:       csvField(row, "Name"),
				MountPoint: csvField(row, "Name"),
				FSType:     csvField(row, "FileSystem"),
				SizeBytes:  sz,
				UsedBytes:  sz - free,
				Label:      csvField(row, "VolumeName"),
			}
			attached := false
			for i := range hw.Disks {
				if strings.HasPrefix(part.Name, hw.Disks[i].Name) {
					hw.Disks[i].Partitions = append(hw.Disks[i].Partitions, part)
					attached = true
					break
				}
			}
			if !attached {
				hw.Disks = append(hw.Disks, DiskInfo{
					Name:       part.Name,
					SizeBytes:  sz,
					Partitions: []PartitionInfo{part},
				})
			}
		}
	}

	// NICs (connected: NetConnectionStatus=2)
	if out, err := cimCSV("Win32_NetworkAdapter", "NetConnectionStatus=2", "Name", "MACAddress"); err == nil {
		for _, row := range allCSVRows(out) {
			hw.NetworkAdapters = append(hw.NetworkAdapters, NICInfo{
				Name:       csvField(row, "Name"),
				MACAddress: csvField(row, "MACAddress"),
			})
		}
	}

	// BIOS
	if out, err := cimCSV("Win32_BIOS", "", "SMBIOSBIOSVersion"); err == nil {
		if row := firstCSVRow(out); row != nil {
			hw.BIOSVersion = csvField(row, "SMBIOSBIOSVersion")
		}
	}

	// UEFI detection
	if out, err := exec.Command("bcdedit").Output(); err == nil {
		hw.IsUEFI = strings.Contains(string(out), `\EFI\`)
	}

	// Motherboard
	if out, err := cimCSV("Win32_BaseBoard", "", "Manufacturer", "Product"); err == nil {
		if row := firstCSVRow(out); row != nil {
			hw.Motherboard = csvField(row, "Manufacturer") + " " + csvField(row, "Product")
		}
	}

	return hw, nil
}

// ---------------------------------------------------------------------------
// CIM (Get-CimInstance) CSV helpers
// ---------------------------------------------------------------------------

// cimCSV queries a CIM/WMI class via PowerShell and returns CSV (header row =
// the requested property names, matching csvField lookups). filter is an
// optional WQL filter (e.g. "NetConnectionStatus=2"); pass "" for none.
//
// SAFETY: className, filter, and props are ALL interpolated raw into the
// PowerShell -Command script. Every current caller passes code-defined string
// literals, so there is no injection surface. This invariant MUST hold — never
// pass a caller/agent/server-controlled value here. A dynamic -Filter in
// particular would allow PowerShell/WQL injection into a script that runs with
// the agent's (typically SYSTEM) privileges; parameterize or strictly validate
// before introducing any non-literal argument.
func cimCSV(className, filter string, props ...string) ([]byte, error) {
	script := "Get-CimInstance -ClassName " + className
	if filter != "" {
		script += " -Filter '" + filter + "'"
	}
	script += " | Select-Object " + strings.Join(props, ",") + " | ConvertTo-Csv -NoTypeInformation"
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	out, err := cmd.Output()
	if err != nil {
		// Don't let CIM failures vanish silently: an unlogged failure here is
		// exactly how the wmic path shipped all-zero hardware profiles. Include
		// PowerShell's stderr (blocked execution policy, Constrained Language
		// Mode, missing binary, etc.) so the zeros are diagnosable.
		var stderr string
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			stderr = strings.TrimSpace(string(exitErr.Stderr))
		}
		slog.Warn("systemstate: CIM query failed", "class", className, "error", err.Error(), "stderr", stderr)
	}
	return out, err
}

func firstCSVRow(data []byte) map[string]string {
	rows := allCSVRows(data)
	if len(rows) == 0 {
		return nil
	}
	return rows[0]
}

// allCSVRows parses ConvertTo-Csv output into a slice of header->value maps.
func allCSVRows(data []byte) []map[string]string {
	r := csv.NewReader(strings.NewReader(string(data)))
	r.LazyQuotes = true
	r.TrimLeadingSpace = true

	var header []string
	var rows []map[string]string
	for {
		record, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			continue
		}
		if len(record) == 0 || (len(record) == 1 && strings.TrimSpace(record[0]) == "") {
			continue
		}
		if header == nil {
			header = record
			continue
		}
		row := make(map[string]string, len(header))
		for i, h := range header {
			if i < len(record) {
				row[h] = strings.TrimSpace(record[i])
			}
		}
		rows = append(rows, row)
	}
	return rows
}

func csvField(row map[string]string, key string) string {
	if row == nil {
		return ""
	}
	return row[key]
}
