package wayland

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"io"
)

const (
	// msgFrame is a JPEG payload. msgError is a fatal text error.
	// Both are length-prefixed so a systemd-run status line on the same
	// pipe can be skipped until the first marker.
	msgFrame   uint32 = 0xB712E001
	msgError   uint32 = 0xB712E002
	maxPayload        = 12 << 20
)

func writeMsg(w *bufio.Writer, kind uint32, payload []byte) error {
	var hdr [8]byte
	binary.BigEndian.PutUint32(hdr[0:4], kind)
	binary.BigEndian.PutUint32(hdr[4:8], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if _, err := w.Write(payload); err != nil {
		return err
	}
	return w.Flush()
}

// streamReader pulls framed messages out of a byte stream that may begin
// with unrelated text.
type streamReader struct {
	r   *bufio.Reader
	buf []byte
}

func newStreamReader(r io.Reader) *streamReader {
	return &streamReader{r: bufio.NewReaderSize(r, 256<<10)}
}

func (s *streamReader) Next() (uint32, []byte, error) {
	for {
		i := indexMagic(s.buf)
		if i < 0 || len(s.buf) < i+8 {
			if i >= 0 {
				s.buf = append([]byte(nil), s.buf[i:]...)
			} else if len(s.buf) > 3 {
				s.buf = append([]byte(nil), s.buf[len(s.buf)-3:]...)
			}
			if err := s.fill(); err != nil {
				return 0, nil, err
			}
			continue
		}
		n := binary.BigEndian.Uint32(s.buf[i+4 : i+8])
		if n > maxPayload {
			s.buf = append([]byte(nil), s.buf[i+1:]...)
			continue
		}
		total := i + 8 + int(n)
		if len(s.buf) < total {
			s.buf = append([]byte(nil), s.buf[i:]...)
			if err := s.fill(); err != nil {
				return 0, nil, err
			}
			continue
		}
		kind := binary.BigEndian.Uint32(s.buf[i : i+4])
		payload := append([]byte(nil), s.buf[i+8:total]...)
		s.buf = append([]byte(nil), s.buf[total:]...)
		return kind, payload, nil
	}
}

func indexMagic(b []byte) int {
	for i := 0; i+4 <= len(b); i++ {
		k := binary.BigEndian.Uint32(b[i : i+4])
		if k == msgFrame || k == msgError {
			return i
		}
	}
	return -1
}

func (s *streamReader) fill() error {
	tmp := make([]byte, 64<<10)
	n, err := s.r.Read(tmp)
	if n > 0 {
		s.buf = append(s.buf, tmp[:n]...)
	}
	if n > 0 && err == nil {
		return nil
	}
	if n > 0 && err == io.EOF {
		return nil
	}
	if err != nil {
		return err
	}
	return io.ErrNoProgress
}

// takeJPEG returns the next complete JPEG (SOI through EOI) in buf.
// JPEG entropy escapes 0xFF as 0xFF00, so 0xFFD9 is only the end marker.
func takeJPEG(buf []byte) (frame, rest []byte, ok bool) {
	start := bytes.Index(buf, []byte{0xFF, 0xD8})
	if start < 0 {
		if len(buf) > 1 {
			return nil, buf[len(buf)-1:], false
		}
		return nil, buf, false
	}
	rel := bytes.Index(buf[start+2:], []byte{0xFF, 0xD9})
	if rel < 0 {
		if start > 0 {
			buf = buf[start:]
		}
		if len(buf) > maxPayload {
			return nil, buf[len(buf)-1:], false
		}
		return nil, buf, false
	}
	end := start + 2 + rel + 2
	return append([]byte(nil), buf[start:end]...), buf[end:], true
}
