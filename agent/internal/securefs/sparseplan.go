package securefs

import (
	"bytes"
	"errors"
	"fmt"
	"io"
)

// sparseChunk is the granularity at which a sparse restore recreates holes
// (#6446). 64 KiB is the NTFS sparse allocation unit at the default 4 KiB
// cluster size (one compression unit of 16 clusters): FSCTL_SET_ZERO_DATA can
// only release whole units, so a finer scan would find zero runs it cannot
// free. Chunks are aligned to file offset 0, which keeps every planned hole
// unit-aligned.
const sparseChunk = 64 << 10

// holeRange is the half-open byte range [Offset, Offset+Length) of a file.
type holeRange struct {
	Offset int64
	Length int64
}

// planSparseCopy reads src in chunk-sized blocks aligned to offset 0 and plans
// the destination's hole map from the content itself: a block that is entirely
// zero is recorded as a hole (merged with an immediately preceding hole) and is
// NOT written; any other block is written whole to dst at its own offset. dst
// may be nil to plan without writing (the post-publish caller, which only
// needs the ranges).
//
// It returns the logical size read. A trailing hole is never written, so a
// caller writing into a fresh file must extend it to that size afterwards.
// Unwritten ranges below the size read back as zero on every filesystem, so
// the bytes are right whether or not the holes are later released; releasing
// them is what makes the restore take no more disk than the source did.
//
// The map is content-derived, not captured: an allocated run of zeroes on the
// source also comes back as a hole. The bytes are identical and the restored
// file can only use less space, never more.
//
// Only io.EOF ends the stream cleanly. io.ReadFull is deliberately not used:
// it maps a short final read to io.ErrUnexpectedEOF, which a truncated
// compressed stream also returns, and treating that as a clean end would
// publish a silently shortened file.
func planSparseCopy(dst io.WriterAt, src io.Reader, chunk int) (int64, []holeRange, error) {
	if chunk <= 0 {
		return 0, nil, fmt.Errorf("sparse chunk size %d must be positive", chunk)
	}
	buf := make([]byte, chunk)
	zero := make([]byte, chunk)
	var (
		off   int64
		holes []holeRange
	)
	for {
		n, readErr := fillBlock(src, buf)
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return off, holes, readErr
		}
		if n > 0 {
			block := buf[:n]
			if bytes.Equal(block, zero[:n]) {
				if k := len(holes); k > 0 && holes[k-1].Offset+holes[k-1].Length == off {
					holes[k-1].Length += int64(n)
				} else {
					holes = append(holes, holeRange{Offset: off, Length: int64(n)})
				}
			} else if dst != nil {
				written, err := dst.WriteAt(block, off)
				if err != nil {
					return off, holes, err
				}
				if written != n {
					return off, holes, io.ErrShortWrite
				}
			}
			off += int64(n)
		}
		if readErr != nil {
			return off, holes, nil
		}
	}
}

// fillBlock reads until buf is full or src returns an error, returning that
// error unchanged (io.EOF included) alongside whatever was read.
func fillBlock(src io.Reader, buf []byte) (int, error) {
	n := 0
	for n < len(buf) {
		m, err := src.Read(buf[n:])
		n += m
		if err != nil {
			return n, err
		}
	}
	return n, nil
}
