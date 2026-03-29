//go:build windows

package systemstate

import (
	"encoding/csv"
	"io"
	"os/exec"
	"strconv"
	"strings"
)

// CollectHardwareProfile captures hardware info using WMI queries.
func (c *WindowsCollector) CollectHardwareProfile() (*HardwareProfile, error) {
	hw := &HardwareProfile{}

	// CPU
	if out, err := wmicCSV("cpu", "name", "numberofcores"); err == nil {
		if row := firstCSVRow(out); row != nil {
			hw.CPUModel = csvField(row, "Name")
			hw.CPUCores, _ = strconv.Atoi(csvField(row, "NumberOfCores"))
		}
	}

	// Memory
	if out, err := wmicCSV("computersystem", "totalphysicalmemory"); err == nil {
		if row := firstCSVRow(out); row != nil {
			bytes, _ := strconv.ParseInt(csvField(row, "TotalPhysicalMemory"), 10, 64)
			hw.TotalMemoryMB = bytes / (1024 * 1024)
		}
	}

	// Disks
	if out, err := wmicCSV("diskdrive", "name", "size", "model"); err == nil {
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
	if out, err := wmicCSV("logicaldisk", "name", "filesystem", "size", "freespace", "volumename"); err == nil {
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

	// NICs
	if out, err := wmicCSV("nic where \"netconnectionstatus=2\"", "name", "macaddress"); err == nil {
		for _, row := range allCSVRows(out) {
			hw.NetworkAdapters = append(hw.NetworkAdapters, NICInfo{
				Name:       csvField(row, "Name"),
				MACAddress: csvField(row, "MACAddress"),
			})
		}
	}

	// BIOS
	if out, err := wmicCSV("bios", "smbiosbiosversion"); err == nil {
		if row := firstCSVRow(out); row != nil {
			hw.BIOSVersion = csvField(row, "SMBIOSBIOSVersion")
		}
	}

	// UEFI detection
	if out, err := exec.Command("bcdedit").Output(); err == nil {
		hw.IsUEFI = strings.Contains(string(out), `\EFI\`)
	}

	// Motherboard
	if out, err := wmicCSV("baseboard", "manufacturer", "product"); err == nil {
		if row := firstCSVRow(out); row != nil {
			hw.Motherboard = csvField(row, "Manufacturer") + " " + csvField(row, "Product")
		}
	}

	return hw, nil
}

// ---------------------------------------------------------------------------
// WMIC CSV helpers
// ---------------------------------------------------------------------------

func wmicCSV(alias string, fields ...string) ([]byte, error) {
	parts := strings.Fields(alias)
	cmdArgs := append(parts[1:], "get", strings.Join(fields, ","), "/format:csv")
	cmd := exec.Command("wmic", append([]string{parts[0]}, cmdArgs...)...)
	return cmd.Output()
}

func firstCSVRow(data []byte) map[string]string {
	rows := allCSVRows(data)
	if len(rows) == 0 {
		return nil
	}
	return rows[0]
}

// allCSVRows parses WMIC CSV output into a slice of header->value maps.
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
