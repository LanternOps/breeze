package wayland

import (
	"bufio"
	"bytes"
	"io"
	"testing"
)

func TestStreamReaderSkipsPreamble(t *testing.T) {
	payload := []byte{0xFF, 0xD8, 0x00, 0x11, 0xFF, 0xD9}
	var full bytes.Buffer
	full.WriteString("Running as unit: run-example.service\n")
	bw := bufio.NewWriter(&full)
	if err := writeMsg(bw, msgFrame, payload); err != nil {
		t.Fatal(err)
	}
	if err := writeMsg(bw, msgError, []byte("user cancelled")); err != nil {
		t.Fatal(err)
	}

	r := newStreamReader(bytes.NewReader(full.Bytes()))
	kind, got, err := r.Next()
	if err != nil {
		t.Fatal(err)
	}
	if kind != msgFrame || !bytes.Equal(got, payload) {
		t.Fatalf("frame kind=%x payload=%x", kind, got)
	}
	kind, got, err = r.Next()
	if err != nil {
		t.Fatal(err)
	}
	if kind != msgError || string(got) != "user cancelled" {
		t.Fatalf("error kind=%x payload=%q", kind, got)
	}
	if _, _, err = r.Next(); err != io.EOF {
		t.Fatalf("want EOF, got %v", err)
	}
}

func TestTakeJPEG(t *testing.T) {
	a := []byte{0xFF, 0xD8, 0x01, 0xFF, 0x00, 0xFF, 0xD9}
	b := []byte{0xFF, 0xD8, 0x02, 0xFF, 0xD9}
	buf := append(append([]byte("junk"), a...), b...)
	frame, rest, ok := takeJPEG(buf)
	if !ok || !bytes.Equal(frame, a) {
		t.Fatalf("frame=%x ok=%v", frame, ok)
	}
	frame, rest, ok = takeJPEG(rest)
	if !ok || !bytes.Equal(frame, b) || len(rest) != 0 {
		t.Fatalf("frame=%x rest=%x ok=%v", frame, rest, ok)
	}
}
