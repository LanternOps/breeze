package securefs

import (
	"bytes"
	"errors"
	"io"
	"reflect"
	"testing"
	"testing/iotest"
)

// memWriterAt records every WriteAt so a test can prove a planned hole was
// never written, not merely that the reassembled bytes come out right.
type memWriterAt struct {
	buf    []byte
	writes []holeRange
}

func (m *memWriterAt) WriteAt(p []byte, off int64) (int, error) {
	if end := off + int64(len(p)); end > int64(len(m.buf)) {
		m.buf = append(m.buf, make([]byte, end-int64(len(m.buf)))...)
	}
	copy(m.buf[off:], p)
	m.writes = append(m.writes, holeRange{Offset: off, Length: int64(len(p))})
	return len(p), nil
}

func pattern(n int, b byte) []byte { return bytes.Repeat([]byte{b}, n) }

func concat(parts ...[]byte) []byte { return bytes.Join(parts, nil) }

// TestPlanSparseCopy is the cross-platform half of #6446: the range planning
// the Windows restore uses to recreate a sparse file's holes. Every chunk that
// is entirely zero becomes a hole (adjacent ones merged) and is never written;
// every other chunk is written whole at its own offset; the reported size is
// the full logical size so the caller can extend over a trailing hole.
func TestPlanSparseCopy(t *testing.T) {
	const chunk = 8
	cases := []struct {
		name  string
		input []byte
		holes []holeRange
	}{
		{name: "empty", input: nil, holes: nil},
		{name: "no zero chunk", input: pattern(20, 'a'), holes: nil},
		{name: "all zero exact chunks", input: pattern(24, 0), holes: []holeRange{{0, 24}}},
		{name: "all zero shorter than a chunk", input: pattern(5, 0), holes: []holeRange{{0, 5}}},
		{
			name:  "leading hole merged across chunks",
			input: concat(pattern(16, 0), pattern(8, 'x')),
			holes: []holeRange{{0, 16}},
		},
		{
			name:  "interior hole between data",
			input: concat(pattern(8, 'x'), pattern(24, 0), pattern(8, 'y')),
			holes: []holeRange{{8, 24}},
		},
		{
			name:  "trailing partial zero chunk is a hole",
			input: concat(pattern(8, 'x'), pattern(8, 0), pattern(3, 0)),
			holes: []holeRange{{8, 11}},
		},
		{
			name: "a zero run not covering a whole chunk stays data",
			// 4 data bytes then 12 zeroes: chunk 0 is mixed (kept), chunk 1 is
			// all zero (hole). The zeroes inside chunk 0 are written.
			input: concat(pattern(4, 'x'), pattern(12, 0)),
			holes: []holeRange{{8, 8}},
		},
		{
			name:  "single nonzero byte at the end of a zero chunk keeps it",
			input: concat(pattern(7, 0), []byte{1}, pattern(8, 0)),
			holes: []holeRange{{8, 8}},
		},
		{
			name:  "two separate holes",
			input: concat(pattern(8, 0), pattern(8, 'x'), pattern(16, 0), pattern(2, 'y')),
			holes: []holeRange{{0, 8}, {16, 16}},
		},
	}
	readers := map[string]func([]byte) io.Reader{
		"whole":    func(b []byte) io.Reader { return bytes.NewReader(b) },
		"one byte": func(b []byte) io.Reader { return iotest.OneByteReader(bytes.NewReader(b)) },
		"half":     func(b []byte) io.Reader { return iotest.HalfReader(bytes.NewReader(b)) },
	}
	for _, tc := range cases {
		for rname, mk := range readers {
			t.Run(tc.name+"/"+rname, func(t *testing.T) {
				dst := &memWriterAt{}
				size, holes, err := planSparseCopy(dst, mk(tc.input), chunk)
				if err != nil {
					t.Fatalf("planSparseCopy: %v", err)
				}
				if size != int64(len(tc.input)) {
					t.Fatalf("size = %d, want %d", size, len(tc.input))
				}
				if !reflect.DeepEqual(holes, tc.holes) {
					t.Fatalf("holes = %v, want %v", holes, tc.holes)
				}
				// Reassemble as the filesystem would: unwritten bytes below
				// the logical size read back as zero.
				got := make([]byte, size)
				copy(got, dst.buf)
				if !bytes.Equal(got, tc.input) {
					t.Fatalf("reassembled content differs from the source")
				}
				for _, w := range dst.writes {
					if w.Offset%chunk != 0 {
						t.Errorf("write at %d is not chunk-aligned", w.Offset)
					}
					for _, h := range holes {
						if w.Offset < h.Offset+h.Length && h.Offset < w.Offset+w.Length {
							t.Errorf("write %v overlaps planned hole %v", w, h)
						}
					}
				}
			})
		}
	}
}

// TestPlanSparseCopyScanOnly covers the post-publish (BMR) caller, which has
// no destination to write: a nil dst plans the same holes and writes nothing.
func TestPlanSparseCopyScanOnly(t *testing.T) {
	input := concat(pattern(8, 'x'), pattern(16, 0), pattern(3, 'y'))
	size, holes, err := planSparseCopy(nil, bytes.NewReader(input), 8)
	if err != nil {
		t.Fatalf("planSparseCopy: %v", err)
	}
	if size != int64(len(input)) || !reflect.DeepEqual(holes, []holeRange{{8, 16}}) {
		t.Fatalf("size=%d holes=%v, want 27 [{8 16}]", size, holes)
	}
}

// TestPlanSparseCopyDefaultChunk pins the production granularity: 64 KiB is
// the NTFS sparse allocation unit (16 clusters at the default 4 KiB cluster),
// so a smaller zero run cannot be released anyway.
func TestPlanSparseCopyDefaultChunk(t *testing.T) {
	if sparseChunk != 64<<10 {
		t.Fatalf("sparseChunk = %d, want 64 KiB", sparseChunk)
	}
	input := concat(pattern(sparseChunk, 'x'), pattern(3*sparseChunk, 0), pattern(10, 'y'))
	dst := &memWriterAt{}
	size, holes, err := planSparseCopy(dst, bytes.NewReader(input), sparseChunk)
	if err != nil {
		t.Fatalf("planSparseCopy: %v", err)
	}
	want := []holeRange{{sparseChunk, 3 * sparseChunk}}
	if size != int64(len(input)) || !reflect.DeepEqual(holes, want) {
		t.Fatalf("size=%d holes=%v, want %d %v", size, holes, len(input), want)
	}
}

type failingWriterAt struct{ err error }

func (f failingWriterAt) WriteAt([]byte, int64) (int, error) { return 0, f.err }

type shortWriterAt struct{}

func (shortWriterAt) WriteAt(p []byte, _ int64) (int, error) { return len(p) - 1, nil }

// TestPlanSparseCopyPropagatesErrors: a read or write failure must fail the
// copy — a restore that silently drops a chunk would publish corrupt data that
// reads back as zeroes.
func TestPlanSparseCopyPropagatesErrors(t *testing.T) {
	boom := errors.New("boom")
	if _, _, err := planSparseCopy(&memWriterAt{}, iotest.ErrReader(boom), 8); !errors.Is(err, boom) {
		t.Fatalf("read error = %v, want %v", err, boom)
	}
	// A truncated compressed stream reports io.ErrUnexpectedEOF after some
	// data. That is a failure, not a clean end: treating it as EOF (as an
	// io.ReadFull-based loop would) publishes a silently shortened file.
	truncated := io.MultiReader(bytes.NewReader(pattern(5, 'x')), iotest.ErrReader(io.ErrUnexpectedEOF))
	if _, _, err := planSparseCopy(&memWriterAt{}, truncated, 8); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("truncated stream error = %v, want io.ErrUnexpectedEOF", err)
	}
	if _, _, err := planSparseCopy(failingWriterAt{err: boom}, bytes.NewReader(pattern(8, 'x')), 8); !errors.Is(err, boom) {
		t.Fatalf("write error = %v, want %v", err, boom)
	}
	if _, _, err := planSparseCopy(shortWriterAt{}, bytes.NewReader(pattern(8, 'x')), 8); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("short write error = %v, want io.ErrShortWrite", err)
	}
	if _, _, err := planSparseCopy(&memWriterAt{}, bytes.NewReader(nil), 0); err == nil {
		t.Fatalf("chunk 0 accepted, want an error")
	}
}
