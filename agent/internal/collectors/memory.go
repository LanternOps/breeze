package collectors

import (
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"strings"
	"unicode"

	"github.com/breeze-rmm/agent/internal/collectors/smbios"
)

// ErrMemoryUnsupported is returned by CollectMemoryModules on platforms with
// no memory-module source. Callers omit the memory block (the API then keeps
// whatever it stored before).
var ErrMemoryUnsupported = errors.New("memory module inventory not supported on this platform")

// Wire limits, mirrored from the API's validation of the `memory` block. The
// API rejects (never truncates) an over-limit block, so the agent enforces the
// same limits before sending: strings are truncated, structural limits are
// errors that make the agent omit `memory` entirely.
const (
	memoryMaxModules    = smbios.MaxMemoryDevices // 256
	memorySlotKeyMax    = 160
	memoryLocatorMax    = 128
	memoryLabelMax      = 128 // bankLabel, manufacturer, partNumber, serialNumber
	memoryEnumMax       = 32  // memoryType, formFactor
	memoryMaxIntegerVal = math.MaxInt32
)

// MemoryInfo is the optional `memory` block on PUT /agents/:id/hardware.
// A present block is an authoritative snapshot; optional fields are omitted
// (not sent as null) when not reported, which the API stores as NULL.
type MemoryInfo struct {
	SlotsTotal    *int           `json:"slotsTotal,omitempty"`
	MaxCapacityMb *int           `json:"maxCapacityMb,omitempty"`
	Soldered      bool           `json:"soldered"`
	Modules       []MemoryModule `json:"modules"`
}

// MemoryModule is one physical slot, populated or not.
type MemoryModule struct {
	SlotKey            string  `json:"slotKey"`
	Locator            string  `json:"locator"`
	BankLabel          *string `json:"bankLabel,omitempty"`
	Populated          bool    `json:"populated"`
	CapacityMb         *int    `json:"capacityMb,omitempty"`
	MemoryType         *string `json:"memoryType,omitempty"`
	FormFactor         *string `json:"formFactor,omitempty"`
	SpeedMts           *int    `json:"speedMts,omitempty"`
	ConfiguredSpeedMts *int    `json:"configuredSpeedMts,omitempty"`
	Manufacturer       *string `json:"manufacturer,omitempty"`
	PartNumber         *string `json:"partNumber,omitempty"`
	SerialNumber       *string `json:"serialNumber,omitempty"`
}

// CollectMemoryModules returns the per-slot memory inventory. Any error means
// "do not send a memory block" — it never returns an empty module list.
func CollectMemoryModules() (*MemoryInfo, error) {
	info, err := collectPlatformMemory()
	if err != nil {
		return nil, err
	}
	if err := validateMemoryInfo(info); err != nil {
		return nil, err
	}
	return info, nil
}

// memoryInfoFromSMBIOSTable parses a raw SMBIOS structure table (Windows
// RSMB minus its header, Linux /sys/firmware/dmi/tables/DMI).
func memoryInfoFromSMBIOSTable(table []byte) (*MemoryInfo, error) {
	inv, err := smbios.ParseMemory(table)
	if err != nil {
		return nil, err
	}
	return memoryInfoFromInventory(inv)
}

func memoryInfoFromInventory(inv *smbios.MemoryInventory) (*MemoryInfo, error) {
	if inv == nil {
		return nil, errors.New("memory: nil SMBIOS inventory")
	}
	info := &MemoryInfo{
		SlotsTotal:    intPtr(inv.SlotsTotal),
		MaxCapacityMb: boundedInt(inv.MaxCapacityMB),
		Modules:       make([]MemoryModule, 0, len(inv.Devices)),
	}
	for i, d := range inv.Devices {
		m := MemoryModule{
			SlotKey:    fmt.Sprintf("smbios:0x%04x", d.Handle),
			Locator:    memoryLocator(d.Locator, i),
			BankLabel:  normalizeMemoryString(d.BankLocator, memoryLabelMax, false),
			Populated:  d.Populated,
			MemoryType: normalizeMemoryString(d.MemoryType, memoryEnumMax, false),
			FormFactor: normalizeMemoryString(d.FormFactor, memoryEnumMax, false),
		}
		// Module identity only exists for an installed module; empty slots
		// frequently carry fillers ("NO DIMM", "Not Specified") or stale values.
		if d.Populated {
			m.CapacityMb = boundedInt(d.SizeMB)
			m.SpeedMts = boundedInt32(d.SpeedMTs)
			m.ConfiguredSpeedMts = boundedInt32(d.ConfiguredSpeedMTs)
			m.Manufacturer = normalizeMemoryString(d.Manufacturer, memoryLabelMax, true)
			m.PartNumber = normalizeMemoryString(d.PartNumber, memoryLabelMax, true)
			m.SerialNumber = normalizeMemoryString(d.SerialNumber, memoryLabelMax, true)
		}
		info.Modules = append(info.Modules, m)
	}
	if err := validateMemoryInfo(info); err != nil {
		return nil, err
	}
	return info, nil
}

// validateMemoryInfo enforces the wire contract's structural limits. A
// violation is an error (omit the block), never a truncation.
func validateMemoryInfo(info *MemoryInfo) error {
	if info == nil {
		return errors.New("memory: no inventory")
	}
	if len(info.Modules) == 0 {
		return errors.New("memory: no modules")
	}
	if len(info.Modules) > memoryMaxModules {
		return fmt.Errorf("memory: %d modules exceeds limit of %d", len(info.Modules), memoryMaxModules)
	}
	if info.SlotsTotal != nil && (*info.SlotsTotal < 0 || *info.SlotsTotal > memoryMaxModules) {
		return fmt.Errorf("memory: slotsTotal %d outside 0..%d", *info.SlotsTotal, memoryMaxModules)
	}
	seen := make(map[string]struct{}, len(info.Modules))
	for i, m := range info.Modules {
		if m.SlotKey == "" || utf16Len(m.SlotKey) > memorySlotKeyMax {
			return fmt.Errorf("memory: module %d slotKey length out of range", i)
		}
		if _, dup := seen[m.SlotKey]; dup {
			return fmt.Errorf("memory: duplicate slotKey %q", m.SlotKey)
		}
		seen[m.SlotKey] = struct{}{}
		if m.Locator == "" || utf16Len(m.Locator) > memoryLocatorMax {
			return fmt.Errorf("memory: module %d locator length out of range", i)
		}
	}
	return nil
}

// memoryLocator normalises a firmware slot label, substituting "Slot <n>"
// (1-based position) when the firmware gives nothing usable.
func memoryLocator(raw string, index int) string {
	if v := normalizeMemoryString(raw, memoryLocatorMax, false); v != nil {
		return *v
	}
	return fmt.Sprintf("Slot %d", index+1)
}

var (
	memoryPlaceholders = map[string]struct{}{
		"unknown":                {},
		"not specified":          {},
		"none":                   {},
		"to be filled by o.e.m.": {},
		"to be filled by oem":    {},
		"no dimm":                {},
		"empty":                  {},
		"n/a":                    {},
		"not available":          {},
		"default string":         {},
		"undefined":              {},
	}
	// Common AMI/Insyde fillers: "Manufacturer00", "SerNum0", "PartNum1",
	// "AssetTagNum2" and bare forms thereof.
	memoryFillerPattern = regexp.MustCompile(`(?i)^(manufacturer|sernum|partnum|assettagnum)[\s_-]*\d*$`)
)

// normalizeMemoryString cleans a firmware string: strips NULs, control
// characters and invalid UTF-8, trims whitespace, maps placeholders to nil,
// and truncates to max UTF-16 code units (what the API's length check
// counts). identifier enables the all-zero / all-F filter for manufacturer,
// part number and serial fields.
func normalizeMemoryString(raw string, max int, identifier bool) *string {
	v := strings.ToValidUTF8(raw, "")
	v = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\t' {
			return -1
		}
		if r == '\t' {
			return ' '
		}
		return r
	}, v)
	v = strings.TrimSpace(v)
	if v == "" {
		return nil
	}
	lower := strings.ToLower(v)
	if _, ok := memoryPlaceholders[lower]; ok {
		return nil
	}
	if strings.HasPrefix(lower, "sernum") || strings.HasPrefix(lower, "partnum") || memoryFillerPattern.MatchString(v) {
		return nil
	}
	if identifier && isAllZeroOrF(lower) {
		return nil
	}
	v = truncateUTF16(v, max)
	v = strings.TrimSpace(v)
	if v == "" {
		return nil
	}
	return &v
}

// isAllZeroOrF reports whether a (lower-cased) value, ignoring an optional
// 0x prefix and separators, is all '0' or all 'f'.
func isAllZeroOrF(lower string) bool {
	s := strings.TrimPrefix(lower, "0x")
	s = strings.NewReplacer(" ", "", "-", "", ":", "").Replace(s)
	if s == "" {
		return false
	}
	return strings.Trim(s, "0") == "" || strings.Trim(s, "f") == ""
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func truncateUTF16(s string, max int) string {
	n := 0
	for i, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if n+w > max {
			return s[:i]
		}
		n += w
	}
	return s
}

func boundedInt(v *uint64) *int {
	if v == nil || *v > memoryMaxIntegerVal {
		return nil
	}
	out := int(*v)
	return &out
}

func boundedInt32(v *uint32) *int {
	if v == nil || *v > memoryMaxIntegerVal {
		return nil
	}
	out := int(*v)
	return &out
}

// readSMBIOSTableFile reads a raw SMBIOS table from disk with a hard size
// bound (Linux sysfs DMI export).
func readSMBIOSTableFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("memory: open SMBIOS table: %w", err)
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, smbios.MaxTableSize+1))
	if err != nil {
		return nil, fmt.Errorf("memory: read SMBIOS table: %w", err)
	}
	if len(data) == 0 {
		return nil, errors.New("memory: SMBIOS table is empty")
	}
	if len(data) > smbios.MaxTableSize {
		return nil, fmt.Errorf("memory: SMBIOS table exceeds %d bytes", smbios.MaxTableSize)
	}
	return data, nil
}

// rawSMBIOSHeaderLen is the size of the Windows RawSMBIOSData header that
// precedes the table: Used20CallingMethod, SMBIOSMajorVersion,
// SMBIOSMinorVersion, DmiRevision (1 byte each), Length (DWORD).
const rawSMBIOSHeaderLen = 8

// parseRawSMBIOSData validates a GetSystemFirmwareTable('RSMB') buffer and
// returns the structure table (header stripped) and the SMBIOS version.
// returned is the byte count the API reported writing.
func parseRawSMBIOSData(buf []byte, returned uint32) (table []byte, major, minor byte, err error) {
	if uint64(returned) > uint64(len(buf)) {
		return nil, 0, 0, fmt.Errorf("memory: RSMB returned %d bytes for a %d byte buffer", returned, len(buf))
	}
	if returned < rawSMBIOSHeaderLen {
		return nil, 0, 0, fmt.Errorf("memory: RSMB returned %d bytes, shorter than its header", returned)
	}
	length := uint64(uint32(buf[4]) | uint32(buf[5])<<8 | uint32(buf[6])<<16 | uint32(buf[7])<<24)
	if length == 0 {
		return nil, 0, 0, errors.New("memory: RSMB table length is zero")
	}
	if length > smbios.MaxTableSize {
		return nil, 0, 0, fmt.Errorf("memory: RSMB table length %d exceeds %d", length, smbios.MaxTableSize)
	}
	if length > uint64(returned)-rawSMBIOSHeaderLen {
		return nil, 0, 0, fmt.Errorf("memory: RSMB header length %d exceeds returned data %d", length, uint64(returned)-rawSMBIOSHeaderLen)
	}
	return buf[rawSMBIOSHeaderLen : rawSMBIOSHeaderLen+length], buf[1], buf[2], nil
}
