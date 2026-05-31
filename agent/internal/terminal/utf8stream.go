package terminal

import (
	"io"
	"unicode/utf8"
)

// splitUTF8Boundary splits b at the last complete UTF-8 rune boundary. It
// returns the leading bytes that end on a complete boundary (emit) plus any
// trailing incomplete multibyte sequence (hold, at most utf8.UTFMax-1 bytes)
// that must be prepended to the next read before decoding.
//
// Complete input — including pure ASCII — returns (b, nil). Bytes that are
// invalid UTF-8 but are NOT a truncated trailing sequence (e.g. a stray
// continuation byte or a lone 0xFF) are left in emit: they decode to width-1
// U+FFFD errors regardless of buffering, so holding them would only stall.
//
// Rationale: PTY/pipe output is read in fixed-size chunks, so a multibyte rune
// can straddle a chunk boundary. Forwarding the halves separately makes each
// chunk get UTF-8-decoded independently downstream (e.g. Buffer.toString in the
// API), turning the split rune into U+FFFD. Holding the trailing partial bytes
// until the next read keeps every forwarded chunk on a rune boundary.
func splitUTF8Boundary(b []byte) (emit, hold []byte) {
	if len(b) == 0 {
		return b, nil
	}
	// The last rune starts no earlier than UTFMax-1 bytes from the end. Scan
	// back to the most recent lead byte and decide whether its sequence is
	// complete.
	for i := len(b) - 1; i >= 0 && i >= len(b)-(utf8.UTFMax-1); i-- {
		if utf8.RuneStart(b[i]) {
			if utf8.FullRune(b[i:]) {
				return b, nil // last rune is complete
			}
			return b[:i], b[i:] // last rune is truncated — hold it for the next read
		}
	}
	// No lead byte within the trailing UTFMax-1 bytes (malformed run); nothing
	// sensible to hold, emit as-is.
	return b, nil
}

// streamUTF8 reads from r in 4096-byte chunks and forwards data to onOutput on
// UTF-8 rune boundaries, holding back a trailing incomplete rune across reads
// and flushing any held bytes when the stream ends. It returns the terminating
// read error (io.EOF on a clean close). onFirst, if non-nil, is invoked once
// with the byte count of the first non-empty read (for first-data logging).
func streamUTF8(r io.Reader, onOutput func([]byte), onFirst func(int)) error {
	buf := make([]byte, 4096)
	var pending []byte
	for {
		n, err := r.Read(buf)
		if n > 0 && onOutput != nil {
			if onFirst != nil {
				onFirst(n)
				onFirst = nil
			}
			// Fresh allocation each iteration so the held tail (a subslice of
			// combined) stays valid as `pending` without aliasing buf.
			combined := make([]byte, len(pending)+n)
			copy(combined, pending)
			copy(combined[len(pending):], buf[:n])
			emit, hold := splitUTF8Boundary(combined)
			pending = hold
			if len(emit) > 0 {
				onOutput(emit)
			}
		}
		if err != nil {
			// Flush any trailing bytes (even an incomplete rune) so output at
			// stream end is never silently dropped.
			if len(pending) > 0 && onOutput != nil {
				onOutput(pending)
			}
			return err
		}
	}
}
