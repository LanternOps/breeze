package smbios

// memoryTypes is DSP0134 §7.18.2 (Memory Device — Type), indexed from 0x01.
// "Unknown" and reserved codes map to "" (not reported).
var memoryTypes = [...]string{
	0x01: "Other",
	0x02: "",
	0x03: "DRAM",
	0x04: "EDRAM",
	0x05: "VRAM",
	0x06: "SRAM",
	0x07: "RAM",
	0x08: "ROM",
	0x09: "Flash",
	0x0A: "EEPROM",
	0x0B: "FEPROM",
	0x0C: "EPROM",
	0x0D: "CDRAM",
	0x0E: "3DRAM",
	0x0F: "SDRAM",
	0x10: "SGRAM",
	0x11: "RDRAM",
	0x12: "DDR",
	0x13: "DDR2",
	0x14: "DDR2 FB-DIMM",
	0x15: "", // reserved
	0x16: "", // reserved
	0x17: "", // reserved
	0x18: "DDR3",
	0x19: "FBD2",
	0x1A: "DDR4",
	0x1B: "LPDDR",
	0x1C: "LPDDR2",
	0x1D: "LPDDR3",
	0x1E: "LPDDR4",
	0x1F: "Logical non-volatile device",
	0x20: "HBM",
	0x21: "HBM2",
	0x22: "DDR5",
	0x23: "LPDDR5",
	0x24: "HBM3",
}

// formFactors is DSP0134 §7.18.1 (Memory Device — Form Factor).
var formFactors = [...]string{
	0x01: "Other",
	0x02: "",
	0x03: "SIMM",
	0x04: "SIP",
	0x05: "Chip",
	0x06: "DIP",
	0x07: "ZIP",
	0x08: "Proprietary Card",
	0x09: "DIMM",
	0x0A: "TSOP",
	0x0B: "Row of chips",
	0x0C: "RIMM",
	0x0D: "SODIMM",
	0x0E: "SRIMM",
	0x0F: "FB-DIMM",
	0x10: "Die",
	0x11: "CAMM",
}

// MemoryTypeName decodes a type 17 Memory Type byte; "" means unknown,
// reserved, or out of range.
func MemoryTypeName(code byte) string {
	if int(code) < len(memoryTypes) {
		return memoryTypes[code]
	}
	return ""
}

// FormFactorName decodes a type 17 Form Factor byte; "" means unknown or out
// of range.
func FormFactorName(code byte) string {
	if int(code) < len(formFactors) {
		return formFactors[code]
	}
	return ""
}
