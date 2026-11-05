package smbios

import "strconv"

const (
	typeSystemEnclosure = 3
	// chassisTypeOffset is the Type field of the System Enclosure structure
	// (DSP0134 §7.4). Its top bit is the chassis-lock flag, not part of the type.
	chassisTypeOffset = 0x05
	chassisTypeMask   = 0x7F
)

// ParseChassisType returns the chassis type code of the first System Enclosure
// structure as a decimal string, the same numbering WMI's ChassisTypes and
// Linux's /sys/class/dmi/id/chassis_type report. A table with no enclosure, or
// one that leaves the field unset, returns "". A malformed table is an error.
func ParseChassisType(table []byte) (string, error) {
	structs, err := ParseStructures(table)
	if err != nil {
		return "", err
	}
	for _, s := range structs {
		if s.Type != typeSystemEnclosure {
			continue
		}
		raw, ok := s.byteAt(chassisTypeOffset)
		if !ok || raw&chassisTypeMask == 0 {
			return "", nil
		}
		return strconv.Itoa(int(raw & chassisTypeMask)), nil
	}
	return "", nil
}
