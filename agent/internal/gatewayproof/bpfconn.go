package gatewayproof

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"time"

	"golang.org/x/net/bpf"
)

// This file holds the macOS BPF logic that does not touch a device, untagged
// so its tests run on every OS. prove_darwin.go opens the device and issues
// the ioctls.

// ifreqName returns a 32-byte struct ifreq holding name in ifr_name: the first
// IFNAMSIZ (16) bytes, NUL-terminated, so at most 15 bytes of name.
func ifreqName(name string) ([32]byte, error) {
	var ifr [32]byte
	if name == "" || len(name) > 15 || strings.IndexByte(name, 0) >= 0 {
		return ifr, fmt.Errorf("interface name of %d bytes is not a BSD interface name", len(name))
	}
	copy(ifr[:], name)
	return ifr, nil
}

// arpReplyFilter accepts an untagged Ethernet frame with EtherType 0x0806 and
// ARP op 2, whole, and rejects everything else. decodeReply still checks every
// field; the filter only keeps unrelated traffic out of the read buffer.
func arpReplyFilter() []bpf.Instruction {
	return []bpf.Instruction{
		bpf.LoadAbsolute{Off: 12, Size: 2},                               // EtherType
		bpf.JumpIf{Cond: bpf.JumpEqual, Val: etherTypeARP, SkipFalse: 4}, // not ARP -> reject
		bpf.LoadAbsolute{Off: 20, Size: 2},                               // ARP op
		bpf.JumpIf{Cond: bpf.JumpEqual, Val: arpOpReply, SkipFalse: 2},   // not a reply -> reject
		bpf.LoadExtension{Num: bpf.ExtLen},                               // accept the whole frame
		bpf.RetA{},
		bpf.RetConstant{Val: 0},
	}
}

// bpfConn is a frameConn over a /dev/bpf descriptor. One read returns a buffer
// of records; bpfConn keeps them and returns them one at a time.
//
// It waits with (*os.File).SetReadDeadline when Go's poller accepted the
// descriptor (pollable). Otherwise the device must be in blocking mode with a
// BIOCSRTIMEOUT set (prove_darwin.go does both), and ReadFrame reads in
// read-timeout slices until its deadline.
type bpfConn struct {
	f        *os.File
	buf      []byte // len must equal the device's BIOCGBLEN
	pending  [][]byte
	pollable bool
}

func newBPFConn(f *os.File, bufLen int) *bpfConn {
	// SetReadDeadline fails with os.ErrNoDeadline when the descriptor is not
	// in Go's poller.
	pollable := f.SetReadDeadline(time.Time{}) == nil
	return &bpfConn{f: f, buf: make([]byte, bufLen), pollable: pollable}
}

func (c *bpfConn) WriteFrame(frame []byte) error {
	n, err := c.f.Write(frame)
	if err == nil && n != len(frame) {
		err = io.ErrShortWrite
	}
	return err
}

// ReadFrame honours the frameConn contract.
func (c *bpfConn) ReadFrame(deadline time.Time) ([]byte, error) {
	for {
		if len(c.pending) > 0 {
			f := c.pending[0]
			c.pending = c.pending[1:]
			return f, nil
		}
		n, err := c.read(deadline)
		if err != nil {
			return nil, err
		}
		if n == 0 {
			// A blocking read that hit BIOCSRTIMEOUT with nothing captured.
			if !time.Now().Before(deadline) {
				return nil, errReadTimeout
			}
			continue
		}
		records, err := bpfRecords(c.buf[:n])
		if err != nil {
			return nil, err
		}
		for _, r := range records {
			// Copy: the next read reuses c.buf.
			c.pending = append(c.pending, append([]byte(nil), r...))
		}
	}
}

func (c *bpfConn) read(deadline time.Time) (int, error) {
	if c.pollable {
		// Go's poller refuses to read once the deadline has passed, even
		// with data queued; give a passed deadline a 1 ms window so frames
		// already queued are still returned (the drain depends on it).
		d := deadline
		if min := time.Now().Add(time.Millisecond); d.Before(min) {
			d = min
		}
		if err := c.f.SetReadDeadline(d); err != nil {
			return 0, err
		}
	}
	n, err := c.f.Read(c.buf)
	switch {
	case errors.Is(err, os.ErrDeadlineExceeded):
		return 0, errReadTimeout
	case errors.Is(err, syscall.EINTR), errors.Is(err, syscall.EAGAIN):
		return 0, nil
	case errors.Is(err, io.EOF):
		return 0, fmt.Errorf("bpf device closed: %w", err)
	}
	return n, err
}

func (c *bpfConn) Close() error { return c.f.Close() }
