package gatewayproof

import (
	"bytes"
	"errors"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/bpf"
)

func TestIfreqName(t *testing.T) {
	ifr, err := ifreqName("en0")
	if err != nil {
		t.Fatal(err)
	}
	if len(ifr) != 32 || !bytes.Equal(ifr[:4], []byte{0x65, 0x6e, 0x30, 0x00}) || !bytes.Equal(ifr[4:], make([]byte, 28)) {
		t.Fatalf("ifreqName(en0) = % x", ifr)
	}
	if ifr, err := ifreqName(strings.Repeat("a", 15)); err != nil || ifr[15] != 0 || ifr[14] != 'a' {
		t.Fatalf("15-byte name: % x, %v", ifr, err)
	}
	for _, bad := range []string{"", strings.Repeat("a", 16), "en\x000"} {
		if _, err := ifreqName(bad); err == nil {
			t.Errorf("ifreqName(%q) accepted", bad)
		}
	}
}

func TestARPReplyFilter(t *testing.T) {
	vm, err := bpf.NewVM(arpReplyFilter())
	if err != nil {
		t.Fatal(err)
	}
	good := reply(gwMAC, gw, ourMAC, src)
	if n, err := vm.Run(good); err != nil || n != len(good) {
		t.Fatalf("good reply: accepted %d of %d bytes, %v", n, len(good), err)
	}
	ipv4 := withEtherType(good, 0x0800)
	for name, frame := range map[string][]byte{
		"request from encodeRequest": encodeRequest(ourMAC, src, gw),
		"IPv4 frame":                 ipv4,
		"802.1Q-tagged reply":        vlanTagged(good),
	} {
		if n, err := vm.Run(frame); err != nil || n != 0 {
			t.Errorf("%s: accepted %d bytes, %v", name, n, err)
		}
	}
}

func TestBPFConn_ReadFrame(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a Windows pipe takes no read deadline")
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	c := newBPFConn(r, 4096)
	defer func() { _ = c.Close() }()
	if !c.pollable {
		t.Fatal("a pipe read end should take a read deadline")
	}
	buf, first, second := twoRecords()
	if _, err := w.Write(buf); err != nil {
		t.Fatal(err)
	}
	// The frameConn contract: a frame already queued is returned even when the
	// deadline has passed (the pre-request drain relies on it).
	past := time.Unix(0, 0)
	got, err := c.ReadFrame(past)
	if err != nil || !bytes.Equal(got, first) {
		t.Fatalf("first ReadFrame = %x, %v", got, err)
	}
	got, err = c.ReadFrame(past)
	if err != nil || !bytes.Equal(got, second) {
		t.Fatalf("second ReadFrame = %x, %v", got, err)
	}
	if _, err := c.ReadFrame(past); !errors.Is(err, errReadTimeout) {
		t.Fatalf("third ReadFrame err = %v, want errReadTimeout", err)
	}
	start := time.Now()
	if _, err := c.ReadFrame(start.Add(50 * time.Millisecond)); !errors.Is(err, errReadTimeout) {
		t.Fatalf("waiting ReadFrame err = %v, want errReadTimeout", err)
	}
	if d := time.Since(start); d < 45*time.Millisecond {
		t.Fatalf("waiting ReadFrame returned after %v, before its deadline", d)
	}
}

func TestBPFConn_FramesDoNotAliasReadBuffer(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a Windows pipe takes no read deadline")
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	c := newBPFConn(r, 4096)
	defer func() { _ = c.Close() }()
	buf, first, _ := twoRecords()
	if _, err := w.Write(buf); err != nil {
		t.Fatal(err)
	}
	got, err := c.ReadFrame(time.Now().Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	// Refill the read buffer with different bytes; the returned frame must not change.
	if _, err := w.Write(bytes.Repeat([]byte{0x55}, len(buf))); err != nil {
		t.Fatal(err)
	}
	_, _ = c.ReadFrame(time.Now().Add(time.Second)) // second record from the first buffer
	_, _ = c.ReadFrame(time.Now().Add(100 * time.Millisecond))
	if !bytes.Equal(got, first) {
		t.Fatalf("returned frame changed after later reads: %x", got)
	}
}

// When Go's poller does not accept the descriptor, bpfConn reads in blocking
// slices (BIOCSRTIMEOUT on a real device). A slice that captured nothing reads
// 0 bytes, which os.File reports as io.EOF; that must be a timeout slice, not a
// closed device. A regular file is never in the poller, so it drives this path.
func TestBPFConn_NonPollableReadTimeoutSlices(t *testing.T) {
	empty, err := os.CreateTemp(t.TempDir(), "bpf-empty")
	if err != nil {
		t.Fatal(err)
	}
	c := newBPFConn(empty, 4096)
	defer func() { _ = c.Close() }()
	if c.pollable {
		t.Skip("a regular file took a read deadline on this OS")
	}
	start := time.Now()
	if _, err := c.ReadFrame(start.Add(30 * time.Millisecond)); !errors.Is(err, errReadTimeout) {
		t.Fatalf("quiet ReadFrame err = %v, want errReadTimeout", err)
	}
	if d := time.Since(start); d < 25*time.Millisecond {
		t.Fatalf("quiet ReadFrame returned after %v, before its deadline", d)
	}
	if _, err := c.ReadFrame(time.Unix(0, 0)); !errors.Is(err, errReadTimeout) {
		t.Fatalf("past-deadline ReadFrame err = %v, want errReadTimeout", err)
	}

	buf, first, second := twoRecords()
	full, err := os.CreateTemp(t.TempDir(), "bpf-full")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := full.Write(buf); err != nil {
		t.Fatal(err)
	}
	if _, err := full.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	c2 := newBPFConn(full, 4096)
	defer func() { _ = c2.Close() }()
	for i, want := range [][]byte{first, second} {
		got, err := c2.ReadFrame(time.Unix(0, 0)) // queued data is returned even past the deadline
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("ReadFrame %d = %x, %v", i, got, err)
		}
	}
	if _, err := c2.ReadFrame(time.Now().Add(10 * time.Millisecond)); !errors.Is(err, errReadTimeout) {
		t.Fatalf("drained ReadFrame err = %v, want errReadTimeout", err)
	}
}
