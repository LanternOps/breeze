package gatewayproof

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// bpfRecord appends one darwin BPF record (header of hdrlen bytes with Caplen at
// offset 8 and Hdrlen at offset 16, native endian), then pads to 4 bytes.
func bpfRecord(buf []byte, hdrlen int, frame []byte) []byte {
	hdr := make([]byte, hdrlen)
	binary.NativeEndian.PutUint32(hdr[8:12], uint32(len(frame)))
	binary.NativeEndian.PutUint32(hdr[12:16], uint32(len(frame)))
	binary.NativeEndian.PutUint16(hdr[16:18], uint16(hdrlen))
	buf = append(buf, hdr...)
	buf = append(buf, frame...)
	for len(buf)%4 != 0 {
		buf = append(buf, 0xaa) // padding that must never be read as data
	}
	return buf
}

// twoRecords is Task 2's fixture: hdrlen 20, caplen 42 then 60.
func twoRecords() (buf, first, second []byte) {
	first = reply(gwMAC, gw, ourMAC, src)[:42]
	second = reply(gwMAC, gw, ourMAC, src)
	buf = bpfRecord(nil, 20, first)
	buf = bpfRecord(buf, 20, second)
	return buf, first, second
}

func TestBPFRecords(t *testing.T) {
	buf, first, second := twoRecords()
	got, err := bpfRecords(buf)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || !bytes.Equal(got[0], first) || !bytes.Equal(got[1], second) {
		t.Fatalf("got %d records %x", len(got), got)
	}
	// The last record has no trailing padding in a real read buffer.
	tail := bpfRecord(bpfRecord(nil, 20, second), 20, first)
	tail = tail[:len(tail)-2] // 20+42 = 62: drop the two padding bytes
	if got, err := bpfRecords(tail); err != nil || len(got) != 2 || !bytes.Equal(got[1], first) {
		t.Fatalf("unpadded tail: %d %v", len(got), err)
	}
	if got, err := bpfRecords(nil); err != nil || len(got) != 0 {
		t.Fatalf("empty buffer: %v %v", got, err)
	}
	smallHdr := bpfRecord(nil, 20, first)
	binary.NativeEndian.PutUint16(smallHdr[16:18], 4)
	for name, bad := range map[string][]byte{
		"second record truncated": buf[:len(buf)-10],
		"header truncated":        buf[:64+10],
		"hdrlen below header":     smallHdr,
	} {
		if _, err := bpfRecords(bad); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}
