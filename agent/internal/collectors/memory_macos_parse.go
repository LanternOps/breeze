package collectors

// Parsing for `system_profiler SPMemoryDataType -json` (macOS). Kept free of
// build tags so the parser is tested on every CI platform; the command itself
// runs only in memory_darwin.go.

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

type spMemoryReport struct {
	SPMemoryDataType []spMemoryEntry `json:"SPMemoryDataType"`
}

// spMemoryEntry covers both shapes:
//   - Intel: {"_name":"memory","_items":[<slot>...],"is_memory_upgradeable":"Yes"}
//   - Apple Silicon: {"dimm_type":"LPDDR5","dimm_manufacturer":"Samsung","SPMemoryDataType":"16 GB"}
type spMemoryEntry struct {
	Name             string         `json:"_name"`
	Items            []spMemorySlot `json:"_items"`
	TotalSize        string         `json:"SPMemoryDataType"`
	DimmType         string         `json:"dimm_type"`
	DimmManufacturer string         `json:"dimm_manufacturer"`
}

type spMemorySlot struct {
	Name         string `json:"_name"`
	Size         string `json:"dimm_size"`
	Type         string `json:"dimm_type"`
	Speed        string `json:"dimm_speed"`
	Status       string `json:"dimm_status"`
	Manufacturer string `json:"dimm_manufacturer"`
	PartNumber   string `json:"dimm_part_number"`
	SerialNumber string `json:"dimm_serial_number"`
}

const macOnPackageSlotKey = "macos:on-package"

func parseSPMemoryJSON(data []byte) (*MemoryInfo, error) {
	var report spMemoryReport
	if err := json.Unmarshal(data, &report); err != nil {
		return nil, fmt.Errorf("memory: parse SPMemoryDataType: %w", err)
	}
	if len(report.SPMemoryDataType) == 0 {
		return nil, errors.New("memory: SPMemoryDataType has no entries")
	}

	var slots []spMemorySlot
	var onPackage *spMemoryEntry
	for i := range report.SPMemoryDataType {
		e := &report.SPMemoryDataType[i]
		switch {
		case len(e.Items) > 0:
			slots = append(slots, e.Items...)
		case strings.TrimSpace(e.TotalSize) != "":
			if onPackage != nil {
				return nil, errors.New("memory: multiple on-package memory entries")
			}
			onPackage = e
		}
	}

	var info *MemoryInfo
	switch {
	case len(slots) > 0 && onPackage != nil:
		return nil, errors.New("memory: SPMemoryDataType mixes slot list and on-package entry")
	case onPackage != nil:
		info = macOnPackageInfo(onPackage)
	case len(slots) > 0:
		if len(slots) > memoryMaxModules {
			return nil, fmt.Errorf("memory: %d slots exceeds limit of %d", len(slots), memoryMaxModules)
		}
		info = &MemoryInfo{SlotsTotal: intPtr(len(slots)), Modules: make([]MemoryModule, 0, len(slots))}
		for i, s := range slots {
			info.Modules = append(info.Modules, macSlotModule(s, i))
		}
	default:
		return nil, errors.New("memory: SPMemoryDataType has no slots and no on-package memory")
	}

	if err := validateMemoryInfo(info); err != nil {
		return nil, err
	}
	return info, nil
}

// macOnPackageInfo builds the Apple Silicon report: unified memory on the SoC
// package, no slot inventory.
func macOnPackageInfo(e *spMemoryEntry) *MemoryInfo {
	return &MemoryInfo{
		Soldered: true,
		Modules: []MemoryModule{{
			SlotKey:      macOnPackageSlotKey,
			Locator:      "On-package",
			Populated:    true,
			CapacityMb:   parseMacSizeMB(e.TotalSize),
			MemoryType:   normalizeMemoryString(e.DimmType, memoryEnumMax, false),
			Manufacturer: normalizeMemoryString(decodeMacMemoryString(e.DimmManufacturer), memoryLabelMax, true),
		}},
	}
}

func macSlotModule(s spMemorySlot, index int) MemoryModule {
	name := normalizeMemoryString(s.Name, memorySlotKeyMax-len("macos:"), false)
	m := MemoryModule{}
	if name != nil {
		m.SlotKey = "macos:" + *name
		// "BANK 0/ChannelA-DIMM0" → bank "BANK 0", locator "ChannelA-DIMM0".
		if bank, loc, ok := strings.Cut(*name, "/"); ok && strings.TrimSpace(bank) != "" && strings.TrimSpace(loc) != "" {
			m.BankLabel = normalizeMemoryString(bank, memoryLabelMax, false)
			m.Locator = memoryLocator(loc, index)
		} else {
			m.Locator = memoryLocator(*name, index)
		}
	} else {
		m.SlotKey = fmt.Sprintf("macos:slot%d", index+1)
		m.Locator = memoryLocator("", index)
	}

	// Empty slots report "empty" for status and every field. A slot is
	// populated when it is not marked empty and either reports a size or an
	// "ok" status.
	status := strings.ToLower(strings.TrimSpace(s.Status))
	size := parseMacSizeMB(s.Size)
	m.Populated = status != "empty" && !strings.EqualFold(strings.TrimSpace(s.Size), "empty") &&
		(size != nil || status == "ok")
	if !m.Populated {
		return m
	}
	m.CapacityMb = size
	m.MemoryType = normalizeMemoryString(s.Type, memoryEnumMax, false)
	m.SpeedMts = parseMacSpeed(s.Speed)
	m.Manufacturer = normalizeMemoryString(decodeMacMemoryString(s.Manufacturer), memoryLabelMax, true)
	m.PartNumber = normalizeMemoryString(decodeMacMemoryString(s.PartNumber), memoryLabelMax, true)
	m.SerialNumber = normalizeMemoryString(s.SerialNumber, memoryLabelMax, true)
	return m
}

var macSizePattern = regexp.MustCompile(`(?i)^\s*(\d+(?:\.\d+)?)\s*(TB|GB|MB)\s*$`)

// parseMacSizeMB converts "8 GB" / "512 MB" / "1 TB" (binary units, as
// system_profiler reports memory) to MiB.
func parseMacSizeMB(s string) *int {
	m := macSizePattern.FindStringSubmatch(s)
	if m == nil {
		return nil
	}
	v, err := strconv.ParseFloat(m[1], 64)
	if err != nil || v <= 0 {
		return nil
	}
	switch strings.ToUpper(m[2]) {
	case "TB":
		v *= 1024 * 1024
	case "GB":
		v *= 1024
	}
	if v < 1 || v > memoryMaxIntegerVal {
		return nil
	}
	out := int(v)
	return &out
}

var macSpeedPattern = regexp.MustCompile(`(?i)^\s*(\d+)\s*(MHz|MT/s)\s*$`)

// parseMacSpeed reads "2667 MHz". macOS labels the DDR data rate as MHz; the
// value is reported unchanged as MT/s (no doubling), matching SMBIOS.
func parseMacSpeed(s string) *int {
	m := macSpeedPattern.FindStringSubmatch(s)
	if m == nil {
		return nil
	}
	v, err := strconv.Atoi(m[1])
	if err != nil || v <= 0 || v > memoryMaxIntegerVal {
		return nil
	}
	return &v
}

// jedecManufacturers maps the JEDEC JEP106 codes Intel Macs report as
// "0xBBMM" (continuation bank + manufacturer byte) for the common DRAM
// vendors. Unknown codes are passed through unchanged.
var jedecManufacturers = map[string]string{
	"0x80AD": "SK Hynix",
	"0x802C": "Micron",
	"0x80CE": "Samsung",
	"0x0198": "Kingston",
	"0x029E": "Corsair",
	"0x04CD": "G.Skill",
	"0x859B": "Crucial",
	"0x0443": "Ramaxel",
	"0x8551": "Qimonda",
	"0x80B0": "Nanya",
}

// decodeMacMemoryString turns Intel-Mac hex encodings into text: known JEDEC
// manufacturer codes to vendor names, and "0x<hex>" part numbers to their
// ASCII form when every decoded byte is printable. Anything else is returned
// as-is.
func decodeMacMemoryString(s string) string {
	t := strings.TrimSpace(s)
	if len(t) < 3 || !strings.EqualFold(t[:2], "0x") {
		return s
	}
	digits := t[2:]
	if name, ok := jedecManufacturers["0x"+strings.ToUpper(digits)]; ok {
		return name
	}
	raw, err := hex.DecodeString(digits)
	if err != nil || len(raw) == 0 {
		return s
	}
	for _, b := range raw {
		if b < 0x20 || b > 0x7E {
			return s
		}
	}
	return string(raw)
}
