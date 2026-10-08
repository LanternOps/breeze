package clipboard

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func roundTrip(t *testing.T, inner []byte) []byte {
	t.Helper()
	frames, err := encodeChunks("t1", inner)
	if err != nil {
		t.Fatalf("encodeChunks: %v", err)
	}
	var a chunkAssembler
	for i, raw := range frames {
		if len(raw) > chunkFrameMaxBytes {
			t.Fatalf("frame %d is %d bytes, cap %d", i, len(raw), chunkFrameMaxBytes)
		}
		var f chunkFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatal(err)
		}
		out, done, err := a.add(f)
		if err != nil {
			t.Fatalf("add frame %d: %v", i, err)
		}
		if done != (i == len(frames)-1) {
			t.Fatalf("frame %d: done=%v", i, done)
		}
		if done {
			return out
		}
	}
	t.Fatal("never completed")
	return nil
}

func TestChunkRoundTripSizes(t *testing.T) {
	for _, n := range []int{1, chunkPieceBytes - 1, chunkPieceBytes, chunkPieceBytes + 1, 5 * 1024 * 1024} {
		inner := bytes.Repeat([]byte("x"), n)
		if got := roundTrip(t, inner); !bytes.Equal(got, inner) {
			t.Fatalf("n=%d: round trip mismatch (len %d)", n, len(got))
		}
	}
}

func TestEncodeChunksRejectsOversizedInner(t *testing.T) {
	if _, err := encodeChunks("t1", make([]byte, maxAssembledBytes+1)); err == nil {
		t.Fatal("expected an error for an inner message over maxAssembledBytes")
	}
}

func TestAssemblerRejectsOutOfOrder(t *testing.T) {
	var a chunkAssembler
	if _, _, err := a.add(chunkFrame{Type: "chunk", ID: "a", Seq: 0, Total: 3, Data: "eA=="}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := a.add(chunkFrame{Type: "chunk", ID: "a", Seq: 2, Total: 3, Data: "eA=="}); err == nil {
		t.Fatal("expected out-of-order frame to be rejected")
	}
}

func TestAssemblerRejectsUnknownTransfer(t *testing.T) {
	var a chunkAssembler
	if _, _, err := a.add(chunkFrame{Type: "chunk", ID: "a", Seq: 1, Total: 3, Data: "eA=="}); err == nil {
		t.Fatal("expected a non-initial frame without a started transfer to be rejected")
	}
}

func TestAssemblerRejectsOversizedTotal(t *testing.T) {
	var a chunkAssembler
	tooMany := maxAssembledBytes/chunkPieceBytes + 2
	if _, _, err := a.add(chunkFrame{Type: "chunk", ID: "a", Seq: 0, Total: tooMany, Data: "eA=="}); err == nil {
		t.Fatal("expected an impossible total to be rejected up front")
	}
}

func TestAssemblerRejectsOversizedPiece(t *testing.T) {
	var a chunkAssembler
	big := strings.Repeat("A", (chunkPieceBytes/3+2)*4) // decodes to > chunkPieceBytes
	if _, _, err := a.add(chunkFrame{Type: "chunk", ID: "a", Seq: 0, Total: 2, Data: big}); err == nil {
		t.Fatal("expected a piece larger than chunkPieceBytes to be rejected")
	}
}

func TestAssemblerNewTransferReplacesPartial(t *testing.T) {
	var a chunkAssembler
	_, _, _ = a.add(chunkFrame{Type: "chunk", ID: "old", Seq: 0, Total: 5, Data: "eA=="})
	out, done, err := a.add(chunkFrame{Type: "chunk", ID: "new", Seq: 0, Total: 1, Data: "eQ=="})
	if err != nil || !done || string(out) != "y" {
		t.Fatalf("out=%q done=%v err=%v", out, done, err)
	}
	if _, _, err := a.add(chunkFrame{Type: "chunk", ID: "old", Seq: 1, Total: 5, Data: "eA=="}); err == nil {
		t.Fatal("the replaced transfer must not continue")
	}
}

func TestAssemblerTimesOut(t *testing.T) {
	now := time.Unix(1000, 0)
	a := chunkAssembler{now: func() time.Time { return now }}
	_, _, _ = a.add(chunkFrame{Type: "chunk", ID: "a", Seq: 0, Total: 2, Data: "eA=="})
	now = now.Add(chunkTransferTimeout + time.Second)
	if _, _, err := a.add(chunkFrame{Type: "chunk", ID: "a", Seq: 1, Total: 2, Data: "eA=="}); err == nil {
		t.Fatal("expected a stale transfer to be rejected")
	}
}

func TestNewTransferIDIsUnique(t *testing.T) {
	if newTransferID() == newTransferID() {
		t.Fatal("transfer ids collided")
	}
}
