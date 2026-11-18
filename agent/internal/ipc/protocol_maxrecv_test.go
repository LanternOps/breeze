package ipc

import (
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// sizedFrame builds a valid pre-auth frame whose JSON body is about n bytes.
func sizedFrame(t *testing.T, id string, seq uint64, n int) []byte {
	t.Helper()
	payload, err := json.Marshal(strings.Repeat("x", n))
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	env := &Envelope{ID: id, Type: TypePing, Seq: seq, Payload: payload}
	env.HMAC = (&Conn{}).computeHMAC(env)
	data, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	frame := make([]byte, 4+len(data))
	binary.BigEndian.PutUint32(frame, uint32(len(data)))
	copy(frame[4:], data)
	return frame
}

func lengthHeader(n uint32) []byte {
	h := make([]byte, 4)
	binary.BigEndian.PutUint32(h, n)
	return h
}

func TestConnSetMaxRecvSize_RejectsBeforeAlloc(t *testing.T) {
	readerRaw, writerRaw := createSocketPair(t)
	defer func() { _ = readerRaw.Close() }()
	defer func() { _ = writerRaw.Close() }()
	reader := NewConn(readerRaw)
	reader.SetMaxRecvSize(256 << 10)

	mustWrite(t, writerRaw, lengthHeader(16<<20))
	_ = reader.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, err := reader.Recv()
	if err == nil || !strings.Contains(err.Error(), "message too large") {
		t.Fatalf("Recv err = %v, want message too large", err)
	}
	if reader.rbody != nil {
		t.Fatalf("Recv allocated %d bytes for a frame over the cap", len(reader.rbody))
	}
	// The stream has lost sync: every later Recv reports the same failure.
	if _, err2 := reader.Recv(); err2 == nil || err2.Error() != err.Error() {
		t.Fatalf("second Recv err = %v, want the sticky %v", err2, err)
	}
}

func TestConnSetMaxRecvSize_AcceptsUpToCap(t *testing.T) {
	readerRaw, writerRaw := createSocketPair(t)
	defer func() { _ = readerRaw.Close() }()
	defer func() { _ = writerRaw.Close() }()
	reader := NewConn(readerRaw)
	frame := sizedFrame(t, "at-cap", 1, 8<<10)
	reader.SetMaxRecvSize(uint32(len(frame) - 4))

	go func() { _, _ = writerRaw.Write(frame) }()
	_ = reader.SetReadDeadline(time.Now().Add(2 * time.Second))
	env, err := reader.Recv()
	if err != nil {
		t.Fatalf("frame exactly at the cap rejected: %v", err)
	}
	if env.ID != "at-cap" {
		t.Fatalf("id = %q", env.ID)
	}
	if got := reader.LastRecvFrameSize(); got != len(frame)-4 {
		t.Fatalf("LastRecvFrameSize = %d, want %d", got, len(frame)-4)
	}
}

func TestConnSetMaxRecvSize_ZeroMeansDefault(t *testing.T) {
	readerRaw, writerRaw := createSocketPair(t)
	defer func() { _ = readerRaw.Close() }()
	defer func() { _ = writerRaw.Close() }()
	reader := NewConn(readerRaw)
	reader.SetMaxRecvSize(64 << 10)
	reader.SetMaxRecvSize(0)
	if got := reader.maxRecvSize(); got != MaxMessageSize {
		t.Fatalf("cap after SetMaxRecvSize(0) = %d, want MaxMessageSize", got)
	}
	reader.SetMaxRecvSize(MaxMessageSize * 2)
	if got := reader.maxRecvSize(); got != MaxMessageSize {
		t.Fatalf("cap above MaxMessageSize = %d, want clamp to MaxMessageSize", got)
	}

	reader.SetMaxRecvSize(0)
	frame := sizedFrame(t, "big", 1, 300<<10)
	go func() { _, _ = writerRaw.Write(frame) }()
	_ = reader.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := reader.Recv(); err != nil {
		t.Fatalf("300 KiB frame rejected under the default cap: %v", err)
	}
}

// A peer that starts a frame and then trickles it is cut off at the frame
// deadline, however steadily it keeps sending.
func TestConnFrameDeadline_TrickledFrameFails(t *testing.T) {
	readerRaw, writerRaw := createSocketPair(t)
	defer func() { _ = readerRaw.Close() }()
	defer func() { _ = writerRaw.Close() }()
	reader := NewConn(readerRaw)
	const deadline = 300 * time.Millisecond
	reader.SetFrameDeadline(deadline)

	frame := rawFrame(t, "slow", 1)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for i := range len(frame) {
			select {
			case <-stop:
				return
			case <-time.After(40 * time.Millisecond):
			}
			if _, err := writerRaw.Write(frame[i : i+1]); err != nil {
				return
			}
		}
	}()

	start := time.Now()
	_, err := reader.Recv()
	elapsed := time.Since(start)
	if err == nil || !strings.Contains(err.Error(), "frame deadline") {
		t.Fatalf("Recv err = %v, want a frame deadline error", err)
	}
	if elapsed > deadline+2*time.Second {
		t.Fatalf("Recv took %v, want about the %v frame deadline", elapsed, deadline)
	}
	if _, err2 := reader.Recv(); err2 == nil || !strings.Contains(err2.Error(), "frame deadline") {
		t.Fatalf("second Recv err = %v, want the sticky frame deadline error", err2)
	}
}

// Waiting for a frame to begin is not bounded by the frame deadline: an idle
// but healthy peer is the keepalive's business.
func TestConnFrameDeadline_IdleBeforeFrameAllowed(t *testing.T) {
	readerRaw, writerRaw := createSocketPair(t)
	defer func() { _ = readerRaw.Close() }()
	defer func() { _ = writerRaw.Close() }()
	reader := NewConn(readerRaw)
	reader.SetFrameDeadline(150 * time.Millisecond)

	first := rawFrame(t, "first", 1)
	second := rawFrame(t, "second", 2)
	go func() {
		time.Sleep(400 * time.Millisecond)
		_, _ = writerRaw.Write(first)
		time.Sleep(400 * time.Millisecond)
		_, _ = writerRaw.Write(second)
	}()
	for _, want := range []string{"first", "second"} {
		env, err := reader.Recv()
		if err != nil {
			t.Fatalf("Recv %s after an idle gap: %v", want, err)
		}
		if env.ID != want {
			t.Fatalf("id = %q, want %q", env.ID, want)
		}
	}
}
