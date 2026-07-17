package x11

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func writeField(buf *bytes.Buffer, b []byte) {
	_ = binary.Write(buf, binary.BigEndian, uint16(len(b)))
	buf.Write(b)
}

func entry(family uint16, addr, display, name string, data []byte) []byte {
	var buf bytes.Buffer
	_ = binary.Write(&buf, binary.BigEndian, family)
	writeField(&buf, []byte(addr))
	writeField(&buf, []byte(display))
	writeField(&buf, []byte(name))
	writeField(&buf, data)
	return buf.Bytes()
}

func TestFindMitMagicCookie(t *testing.T) {
	cookie := bytes.Repeat([]byte{0xAB}, 16)
	other := bytes.Repeat([]byte{0xCD}, 16)

	local := entry(256, "ubuntu", "10", "MIT-MAGIC-COOKIE-1", cookie) // FamilyLocal
	wrongDisplay := entry(256, "ubuntu", "11", "MIT-MAGIC-COOKIE-1", other)
	wild := entry(65535, "", "10", "MIT-MAGIC-COOKIE-1", cookie)    // FamilyWild
	xdm := entry(256, "ubuntu", "10", "XDM-AUTHORIZATION-1", other) // wrong scheme

	cases := []struct {
		name          string
		blob          []byte
		display, host string
		want          []byte
		wantErr       bool
	}{
		{"exact local+display match", append(append([]byte{}, wrongDisplay...), local...), "10", "ubuntu", cookie, false},
		{"wild family matches", wild, "10", "someotherhost", cookie, false},
		{"stale hostname falls back to display match", entry(256, "oldhost", "10", "MIT-MAGIC-COOKIE-1", cookie), "10", "newhost", cookie, false},
		{"no matching display", wrongDisplay, "10", "ubuntu", nil, true},
		{"only XDM scheme present", xdm, "10", "ubuntu", nil, true},
		{"empty blob", nil, "10", "ubuntu", nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := FindMitMagicCookie(tc.blob, tc.display, tc.host)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got cookie %x", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !bytes.Equal(got, tc.want) {
				t.Fatalf("cookie = %x, want %x", got, tc.want)
			}
		})
	}
}
