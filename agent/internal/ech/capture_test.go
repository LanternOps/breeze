package ech

import (
	"bytes"
	"context"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// pipePair returns a captureConn over one end of a net.Pipe and the peer end.
func pipePair(t *testing.T) (*captureConn, net.Conn) {
	t.Helper()
	a, b := net.Pipe()
	t.Cleanup(func() { _ = a.Close(); _ = b.Close() })
	return newCaptureConn(a), b
}

func TestCaptureConn_TLSFirstByteStopsCapture(t *testing.T) {
	cc, peer := pipePair(t)
	chunks := [][]byte{{0x16, 0x03, 0x03}, {0x00, 0x10, 'H', 'T', 'T', 'P'}, bytes.Repeat([]byte{0x01}, 16)}
	go func() {
		for _, c := range chunks {
			_, _ = peer.Write(c)
		}
		_ = peer.Close()
	}()
	got, err := io.ReadAll(cc)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if want := bytes.Join(chunks, nil); !bytes.Equal(got, want) {
		t.Fatalf("reader got %x, want %x", got, want)
	}
	if c := cc.Captured(); len(c) != 0 {
		t.Fatalf("Captured() = %q, want empty for a TLS first byte", c)
	}
}

func TestCaptureConn_PlaintextCappedAt4096(t *testing.T) {
	cc, peer := pipePair(t)
	payload := append([]byte("HTTP/1.1 302 Found\r\n"), bytes.Repeat([]byte("x"), 10*1024)...)
	go func() {
		_, _ = peer.Write(payload)
		_ = peer.Close()
	}()
	got, err := io.ReadAll(cc)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("reader got %d bytes, want all %d", len(got), len(payload))
	}
	if n := len(cc.Captured()); n != captureLimit {
		t.Fatalf("len(Captured()) = %d, want %d", n, captureLimit)
	}
	if !bytes.Equal(cc.Captured(), payload[:captureLimit]) {
		t.Fatal("captured bytes are not the first captureLimit bytes read")
	}
}

func TestCaptureConn_CapturedIsACopy(t *testing.T) {
	cc, peer := pipePair(t)
	go func() { _, _ = peer.Write([]byte("HTTP/1.1 200 OK\r\n")) }()
	buf := make([]byte, 64)
	if _, err := cc.Read(buf); err != nil {
		t.Fatal(err)
	}
	c := cc.Captured()
	c[0] = 'X'
	if cc.Captured()[0] != 'H' {
		t.Fatal("Captured() returned the internal buffer, want a copy")
	}
}

func TestCaptureConn_DrainStopsAtHeaderEnd(t *testing.T) {
	cc, peer := pipePair(t)
	// The TLS layer consumed only the first chunk.
	go func() {
		_, _ = peer.Write([]byte("HTTP/1.1 302 Found\r\n"))
		_, _ = peer.Write([]byte("Location: https://warn.filter-a.example/\r\n\r\n"))
		// Never closes: drain must stop on the header end, not on EOF.
	}()
	buf := make([]byte, 5)
	if _, err := io.ReadFull(cc, buf); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	cc.drainHeaders(context.Background(), 2*time.Second)
	if el := time.Since(start); el > time.Second {
		t.Fatalf("drain took %v, want it to return on the header end", el)
	}
	if !strings.HasSuffix(string(cc.Captured()), "\r\n\r\n") {
		t.Fatalf("captured %q, want the full header block", cc.Captured())
	}
}

func TestCaptureConn_DrainBoundedByMaxAndContext(t *testing.T) {
	cc, peer := pipePair(t)
	go func() { _, _ = peer.Write([]byte("HTTP/1.1 302")) }()
	buf := make([]byte, 5)
	if _, err := io.ReadFull(cc, buf); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	cc.drainHeaders(context.Background(), 150*time.Millisecond)
	if el := time.Since(start); el > time.Second {
		t.Fatalf("drain with max 150ms took %v", el)
	}

	cc2, peer2 := pipePair(t)
	go func() { _, _ = peer2.Write([]byte("HTTP/1.1 302")) }()
	if _, err := io.ReadFull(cc2, buf); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start = time.Now()
	cc2.drainHeaders(ctx, 5*time.Second)
	if el := time.Since(start); el > time.Second {
		t.Fatalf("drain under a 100ms ctx deadline took %v", el)
	}
}
