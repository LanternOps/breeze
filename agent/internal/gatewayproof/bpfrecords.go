package gatewayproof

import (
	"encoding/binary"
	"fmt"
)

// darwin struct bpf_hdr: bh_tstamp (8), bh_caplen uint32 at 8, bh_datalen
// uint32 at 12, bh_hdrlen uint16 at 16; 18 bytes before the kernel pads it
// (unix.SizeofBpfHdr is 20).
const (
	bpfHdrCaplenOff = 8
	bpfHdrHdrlenOff = 16
	bpfHdrMinLen    = 18
	bpfAlignment    = 4 // BPF_ALIGNMENT on darwin
)

// bpfRecords splits one darwin BPF read buffer into its captured frames. Each
// record is Hdrlen bytes of header followed by Caplen bytes, and the next
// record starts at align4(Hdrlen + Caplen). A record that runs past the buffer
// is an error. The frames alias buf.
func bpfRecords(buf []byte) ([][]byte, error) {
	var frames [][]byte
	for off := 0; off < len(buf); {
		if len(buf)-off < bpfHdrMinLen {
			return nil, fmt.Errorf("bpf record header at %d truncated", off)
		}
		caplen := int(binary.NativeEndian.Uint32(buf[off+bpfHdrCaplenOff:]))
		hdrlen := int(binary.NativeEndian.Uint16(buf[off+bpfHdrHdrlenOff:]))
		if hdrlen < bpfHdrMinLen {
			return nil, fmt.Errorf("bpf record at %d: header length %d", off, hdrlen)
		}
		end := off + hdrlen + caplen
		if caplen < 0 || end > len(buf) || end < off {
			return nil, fmt.Errorf("bpf record at %d runs past the buffer", off)
		}
		frames = append(frames, buf[off+hdrlen:end])
		off += (hdrlen + caplen + bpfAlignment - 1) &^ (bpfAlignment - 1)
	}
	return frames, nil
}
