package terminal

import (
	"bytes"
	"io"
	"testing"
	"unicode/utf8"
)

func TestSplitUTF8Boundary(t *testing.T) {
	euro := []byte("€")           // 3 bytes: E2 82 AC
	emoji := []byte("\U0001F600") // 4 bytes: F0 9F 98 80
	eacute := []byte("é")         // 2 bytes: C3 A9

	tests := []struct {
		name     string
		in       []byte
		wantEmit []byte
		wantHold []byte
	}{
		{"empty", []byte{}, []byte{}, nil},
		{"ascii", []byte("hello"), []byte("hello"), nil},
		{"complete 2-byte at end", []byte("café"), []byte("café"), nil},
		{"complete 3-byte at end", append([]byte("a"), euro...), append([]byte("a"), euro...), nil},
		{"complete 4-byte at end", emoji, emoji, nil},
		{"truncated 2-byte (1 of 2)", []byte{'x', eacute[0]}, []byte{'x'}, []byte{eacute[0]}},
		{"truncated 3-byte (1 of 3)", []byte{'x', euro[0]}, []byte{'x'}, []byte{euro[0]}},
		{"truncated 3-byte (2 of 3)", []byte{'x', euro[0], euro[1]}, []byte{'x'}, []byte{euro[0], euro[1]}},
		{"truncated 4-byte (3 of 4)", append([]byte("x"), emoji[:3]...), []byte("x"), emoji[:3]},
		{"lone continuation byte", []byte{'x', 0xA9}, []byte{'x', 0xA9}, nil}, // not a truncated lead; emit as-is
		{"invalid 0xFF at end", []byte{'x', 0xFF}, []byte{'x', 0xFF}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			emit, hold := splitUTF8Boundary(tt.in)
			if !bytes.Equal(emit, tt.wantEmit) {
				t.Errorf("emit = %v, want %v", emit, tt.wantEmit)
			}
			if !bytes.Equal(hold, tt.wantHold) {
				t.Errorf("hold = %v, want %v", hold, tt.wantHold)
			}
		})
	}
}

type chunkReader struct {
	chunks [][]byte
	i      int
}

func (c *chunkReader) Read(p []byte) (int, error) {
	if c.i >= len(c.chunks) {
		return 0, io.EOF
	}
	n := copy(p, c.chunks[c.i])
	c.i++
	return n, nil
}

func TestStreamUTF8ReassemblesSplitRune(t *testing.T) {
	euro := []byte("€") // E2 82 AC
	// "abc€def" with the euro split across two reads: "abc"+E2 82 | AC+"def".
	chunks := [][]byte{
		append([]byte("abc"), euro[0], euro[1]),
		append([]byte{euro[2]}, []byte("def")...),
	}
	var emits [][]byte
	var all bytes.Buffer
	err := streamUTF8(&chunkReader{chunks: chunks}, func(b []byte) {
		cp := append([]byte(nil), b...)
		emits = append(emits, cp)
		all.Write(cp)
	}, nil)
	if err != io.EOF {
		t.Fatalf("err = %v, want io.EOF", err)
	}
	// Every forwarded chunk must be valid UTF-8 (the split rune is never halved).
	for i, e := range emits {
		if !utf8.Valid(e) {
			t.Errorf("emit[%d] = %v is not valid UTF-8", i, e)
		}
	}
	if got := all.String(); got != "abc€def" {
		t.Errorf("reassembled = %q, want %q", got, "abc€def")
	}
}

func TestStreamUTF8FlushesTruncatedTailOnEOF(t *testing.T) {
	euro := []byte("€")
	// Stream ends with a genuinely truncated rune ("abc" + E2 82, then EOF).
	chunks := [][]byte{append([]byte("abc"), euro[0], euro[1])}
	var all bytes.Buffer
	err := streamUTF8(&chunkReader{chunks: chunks}, func(b []byte) { all.Write(b) }, nil)
	if err != io.EOF {
		t.Fatalf("err = %v, want io.EOF", err)
	}
	// The trailing partial bytes must be flushed, not dropped, so no data loss.
	want := append([]byte("abc"), euro[0], euro[1])
	if !bytes.Equal(all.Bytes(), want) {
		t.Errorf("flushed output = %v, want %v", all.Bytes(), want)
	}
}

func TestStreamUTF8FirstCallback(t *testing.T) {
	calls := 0
	firstN := 0
	chunks := [][]byte{[]byte("hi"), []byte("there")}
	_ = streamUTF8(&chunkReader{chunks: chunks}, func(b []byte) {}, func(n int) {
		calls++
		firstN = n
	})
	if calls != 1 {
		t.Errorf("onFirst called %d times, want 1", calls)
	}
	if firstN != 2 {
		t.Errorf("onFirst n = %d, want 2", firstN)
	}
}
