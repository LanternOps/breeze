package smbios

import "testing"

// enclosure builds a type 3 structure whose chassis type byte (offset 0x05)
// is code. DSP0134 §7.4: bit 7 is the chassis-lock flag, bits 6:0 the type.
func (b *tableBuilder) enclosure(handle uint16, code byte) *tableBuilder {
	body := make([]byte, 0x09-4)
	body[0x05-4] = code
	return b.raw(3, handle, body)
}

func TestParseChassisType(t *testing.T) {
	tests := []struct {
		name  string
		table []byte
		want  string
	}{
		{"laptop among other structures", new(tableBuilder).bios().system("Acme", "Book").enclosure(3, 10).end().bytes(), "10"},
		{"lock flag is not part of the type", new(tableBuilder).enclosure(3, 0x80|17).end().bytes(), "17"},
		{"first enclosure wins", new(tableBuilder).enclosure(3, 3).enclosure(4, 23).end().bytes(), "3"},
		{"no enclosure", new(tableBuilder).bios().end().bytes(), ""},
		{"code zero is not a chassis type", new(tableBuilder).enclosure(3, 0).end().bytes(), ""},
		{"lock flag alone is not a chassis type", new(tableBuilder).enclosure(3, 0x80).end().bytes(), ""},
		{"enclosure too short to carry the field", new(tableBuilder).raw(3, 3, []byte{1}).end().bytes(), ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseChassisType(tt.table)
			if err != nil {
				t.Fatalf("ParseChassisType: %v", err)
			}
			if got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestParseChassisTypeMalformedTable(t *testing.T) {
	if got, err := ParseChassisType([]byte{3, 0xFF, 0, 0}); err == nil {
		t.Fatalf("want an error for a length past the end, got %q", got)
	}
}
