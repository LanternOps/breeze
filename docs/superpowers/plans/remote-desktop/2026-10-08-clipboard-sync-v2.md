---
tracking_issue: LanternOps/breeze#8236
---

# Clipboard Sync v2 — W4a Agent Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clipboard content of any size the policy allows — large text and real images — crosses
the WebRTC clipboard channel in both directions. The viewer can see the policy for each direction.
Connecting no longer pushes the end user's existing clipboard. The agent counts every transfer, so
W4c can audit it.

**Architecture:** This adds a chunking transport *under* the existing clipboard messages, inside
`agent/internal/remote/clipboard`:
- **Chunking:** a payload whose serialized JSON exceeds one frame is split into
  `{type:"chunk", id, seq, total, data}` frames. Each frame is at most 48 KiB serialized.
- **Reassembly:** the receiver rebuilds the original message and hands it to the existing apply
  path, unchanged.
- **Hello:** chunking is used only toward a viewer that has said `{type:"hello", chunked:true}`.
  Old viewers keep getting single messages.
- **Status:** the agent announces `{type:"status", …}` when the channel opens.
- **Watch baseline:** `Watch` records the clipboard's starting hash instead of sending it.

**Tech Stack:** Go agent, pion/webrtc v4.2.22 DataChannel (`SendText`, `BufferedAmount`).

**Spec:** `docs/superpowers/specs/remote-desktop/2026-10-07-viewer-input-clipboard-convenience-design.md`
§5, gotchas C2, C4, C8 (counters only) and C10. The spec merges with #8244.

**Scope:** W4a (this plan) is the agent only and is compatible with every existing viewer. Later
plans:
- **W4b** (viewer): sends `hello`, encodes and decodes chunks, writes and reads images, shows a
  status chip, adds "Copy remote clipboard" and "Send clipboard", treats paste as a transaction, and
  wires VNC clipboard. It needs the W1 viewer code (#8244) merged first.
- **W4c** (audit): delivers `Summary()` to the API as one `remote_session.clipboard_summary`
  `audit_logs` row.

## Global Constraints

- Ships to customer machines. Full rigor: TDD, `go test -race`, `bash scripts/check-windows-vet.sh`,
  and Linux and darwin vet before the PR.
- Content caps are unchanged (`MaxTextBytes` 1 MiB, `MaxRTFBytes` 2 MiB, `MaxImageBytes` 8 MiB).
  The cap on a single non-chunked message is unchanged (`maxClipboardMessageBytes` 2 MiB).
- Frame cap: every message the agent sends on the clipboard channel is ≤ `chunkFrameMaxBytes`
  (48 KiB), unless the peer never sent `hello`. That leaves room under pion's 65,535-byte fallback.
- Per-direction policy gates (`Policy.HostToViewer` / `ViewerToHost`) are enforced before any
  content is assembled or applied. `hello` is control, not content, and is accepted under any
  policy.
- Never log clipboard content. Counts, types, and byte sizes only.
- Old viewers must keep working:
  - they never send `hello`, so they never receive chunks;
  - they ignore `status`, because their handler only acts on `ack` and `text`.

## Review Focus

1. **A viewer opens a chunked transfer and never finishes it.** Memory stays bounded to one
   transfer of at most `maxAssembledBytes`, and the next transfer replaces it. Covered in Task 1
   (`TestAssemblerNewTransferReplacesPartial`, `TestAssemblerRejectsOversizedTotal`).
2. **Chunk frames arriving while viewer→host is disabled by policy.** Nothing is assembled or
   applied, and the attempt is counted as blocked once per transfer, not once per frame. Covered in
   Task 2.
3. **The host clipboard holds an image larger than one frame while the viewer is an old,
   non-hello viewer.** The send is attempted as a single message and its failure is logged. It must
   not panic, and must not leave `lastSentHash` set. A hash cached for a failed send would make the
   next poll skip the image. Covered in Task 2 (`TestSendDoesNotCacheHashOnFailure`).
4. **`Watch` starting while the provider errors**, for example the clipboard is locked by another
   app. The baseline is left unset, and the first successful poll is then treated as a baseline,
   not sent. Covered in Task 3.
5. **Slow viewer with a full SCTP buffer during a large send.** The sender waits on
   `BufferedAmount` with a bounded deadline and returns an error. It must not spin or block
   forever. Covered in Task 2 (`TestSendChunkedGivesUpWhenBufferNeverDrains`).

---

### Task 1: Chunk frames and the assembler

**Files:**
- Create: `agent/internal/remote/clipboard/chunk.go`
- Create: `agent/internal/remote/clipboard/chunk_test.go`

**Interfaces:**
- Produces:
  - `type chunkFrame struct{ Type, ID string; Seq, Total int; Data string }` (JSON `type,id,seq,total,data`);
  - `func encodeChunks(id string, inner []byte) ([][]byte, error)`;
  - `func newTransferID() string`;
  - `type chunkAssembler`, with `func (a *chunkAssembler) add(f chunkFrame) ([]byte, bool, error)`
    and a `now func() time.Time` field;
  - the constants `chunkPieceBytes`, `chunkFrameMaxBytes`, `maxAssembledBytes` and
    `chunkTransferTimeout`.

- [ ] **Step 1: Write the failing test**

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/remote/clipboard/ -run 'TestChunk|TestEncodeChunks|TestAssembler|TestNewTransferID' -race`
Expected: FAIL to compile, `undefined: encodeChunks`.

- [ ] **Step 3: Write minimal implementation**

`agent/internal/remote/clipboard/chunk.go`:

```go
package clipboard

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Chunking is a transport under the ordinary clipboard messages. A message
// whose JSON is larger than one frame is split into pieces, each sent as
//
//	{"type":"chunk","id":"<transfer>","seq":n,"total":N,"data":"<base64 piece>"}
//
// The receiver concatenates the pieces and handles the result exactly as if it
// had arrived whole. pion's outbound limit is the viewer's advertised
// a=max-message-size (65,535 bytes when unset), so a 2 MiB image never fitted
// in one message (spec gotcha C2).
const (
	// chunkPieceBytes raw bytes become ~43.7 KiB of base64 plus the envelope.
	chunkPieceBytes = 32 * 1024
	// chunkFrameMaxBytes is the most any frame may serialize to.
	chunkFrameMaxBytes = 48 * 1024
	// maxAssembledBytes bounds a reassembled message: an 8 MiB image as
	// base64 is ~10.7 MiB, plus JSON.
	maxAssembledBytes = 12 * 1024 * 1024
	// chunkTransferTimeout drops a transfer the sender abandoned.
	chunkTransferTimeout = 30 * time.Second
)

type chunkFrame struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	Seq   int    `json:"seq"`
	Total int    `json:"total"`
	Data  string `json:"data"`
}

func newTransferID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// encodeChunks splits inner into serialized frames for transfer id.
func encodeChunks(id string, inner []byte) ([][]byte, error) {
	if len(inner) > maxAssembledBytes {
		return nil, fmt.Errorf("clipboard message exceeds maximum %d bytes", maxAssembledBytes)
	}
	total := (len(inner) + chunkPieceBytes - 1) / chunkPieceBytes
	if total == 0 {
		total = 1
	}
	frames := make([][]byte, 0, total)
	for seq := 0; seq < total; seq++ {
		start := seq * chunkPieceBytes
		end := start + chunkPieceBytes
		if end > len(inner) {
			end = len(inner)
		}
		raw, err := json.Marshal(chunkFrame{
			Type: "chunk", ID: id, Seq: seq, Total: total,
			Data: base64.StdEncoding.EncodeToString(inner[start:end]),
		})
		if err != nil {
			return nil, err
		}
		frames = append(frames, raw)
	}
	return frames, nil
}

// chunkAssembler rebuilds one transfer at a time. A frame with seq 0 starts a
// new transfer and discards any partial one, so an abandoned transfer costs at
// most one buffer. Frames on the clipboard channel are ordered and reliable,
// so anything out of sequence is an error, not a reordering to repair.
type chunkAssembler struct {
	now     func() time.Time
	id      string
	next    int
	total   int
	buf     []byte
	started time.Time
}

func (a *chunkAssembler) clock() time.Time {
	if a.now != nil {
		return a.now()
	}
	return time.Now()
}

func (a *chunkAssembler) reset() {
	a.id, a.next, a.total, a.buf = "", 0, 0, nil
}

// add consumes f. It returns the reassembled message and true when f was the
// last piece.
func (a *chunkAssembler) add(f chunkFrame) ([]byte, bool, error) {
	if f.ID == "" || f.Total < 1 || f.Total > maxAssembledBytes/chunkPieceBytes+1 || f.Seq < 0 || f.Seq >= f.Total {
		a.reset()
		return nil, false, errors.New("invalid clipboard chunk header")
	}
	if f.Seq == 0 {
		a.reset()
		a.id, a.total, a.started = f.ID, f.Total, a.clock()
	} else if f.ID != a.id {
		a.reset()
		return nil, false, errors.New("clipboard chunk for an unknown transfer")
	}
	if a.clock().Sub(a.started) > chunkTransferTimeout {
		a.reset()
		return nil, false, errors.New("clipboard transfer timed out")
	}
	if f.Seq != a.next || f.Total != a.total {
		a.reset()
		return nil, false, errors.New("clipboard chunk out of sequence")
	}
	piece, err := base64.StdEncoding.DecodeString(f.Data)
	if err != nil {
		a.reset()
		return nil, false, fmt.Errorf("clipboard chunk data: %w", err)
	}
	if len(piece) > chunkPieceBytes || len(a.buf)+len(piece) > maxAssembledBytes {
		a.reset()
		return nil, false, errors.New("clipboard chunk exceeds size limits")
	}
	a.buf = append(a.buf, piece...)
	a.next++
	if a.next < a.total {
		return nil, false, nil
	}
	out := a.buf
	a.reset()
	return out, true, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test ./internal/remote/clipboard/ -race -v -run 'TestChunk|TestEncodeChunks|TestAssembler|TestNewTransferID'`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/clipboard/chunk.go agent/internal/remote/clipboard/chunk_test.go
git commit -m "feat(agent): chunk framing for the clipboard channel (#8240)"
```

---

### Task 2: `ClipboardSync` speaks hello / status / chunk and counts transfers

**Files:**
- Modify: `agent/internal/remote/clipboard/sync.go`
- Create: `agent/internal/remote/clipboard/sync_chunked_test.go`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `(*ClipboardSync).SendStatus() error`;
  - `(*ClipboardSync).Summary() Summary`;
  - `type Summary struct{ Transfers []TransferCount; Blocked int }`;
  - `type TransferCount struct{ Direction, Type string; Count, Bytes int }`;
  - inbound `{"type":"hello","chunked":bool}` handling;
  - inbound and outbound chunk frames;
  - the ack gains an optional `"id"`.

- [ ] **Step 1: Write the failing test**

`agent/internal/remote/clipboard/sync_chunked_test.go`:

```go
package clipboard

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func textMsg(s string) webrtc.DataChannelMessage {
	return webrtc.DataChannelMessage{IsString: true, Data: []byte(s)}
}

// reassemble feeds every chunk frame in sent through a fresh assembler and
// returns the decoded inner payload of the last completed transfer.
func reassemble(t *testing.T, sent []string) clipboardPayload {
	t.Helper()
	var a chunkAssembler
	var inner []byte
	for _, s := range sent {
		if len(s) > chunkFrameMaxBytes {
			t.Fatalf("sent a %d-byte frame (cap %d)", len(s), chunkFrameMaxBytes)
		}
		var f chunkFrame
		if err := json.Unmarshal([]byte(s), &f); err != nil || f.Type != "chunk" {
			continue
		}
		out, done, err := a.add(f)
		if err != nil {
			t.Fatal(err)
		}
		if done {
			inner = out
		}
	}
	var p clipboardPayload
	if err := json.Unmarshal(inner, &p); err != nil {
		t.Fatalf("inner payload: %v", err)
	}
	return p
}

func TestSendChunksLargeTextToHelloPeer(t *testing.T) {
	sender := &mockSender{}
	c := newClipboardSyncWithSender(sender, &stubProvider{}, Policy{HostToViewer: true, ViewerToHost: true})
	if err := c.Receive(textMsg(`{"type":"hello","chunked":true}`)); err != nil {
		t.Fatal(err)
	}

	big := strings.Repeat("a", 300*1024)
	if err := c.Send(Content{Type: ContentTypeText, Text: big}); err != nil {
		t.Fatal(err)
	}
	if len(sender.sent) < 2 {
		t.Fatalf("expected chunked frames, got %d message(s)", len(sender.sent))
	}
	if got := reassemble(t, sender.sent); got.Text != big {
		t.Fatalf("reassembled text length %d, want %d", len(got.Text), len(big))
	}
}

func TestSendStaysSingleMessageForLegacyPeer(t *testing.T) {
	sender := &mockSender{}
	c := newClipboardSyncWithSender(sender, &stubProvider{}, Policy{HostToViewer: true, ViewerToHost: true})
	if err := c.Send(Content{Type: ContentTypeText, Text: strings.Repeat("a", 300*1024)}); err != nil {
		t.Fatal(err)
	}
	if len(sender.sent) != 1 || strings.Contains(sender.sent[0], `"type":"chunk"`) {
		t.Fatalf("a viewer that never said hello must get one ordinary message, got %d", len(sender.sent))
	}
}

type failSender struct{}

func (failSender) SendText(string) error { return errors.New("too large") }

func TestSendDoesNotCacheHashOnFailure(t *testing.T) {
	c := newClipboardSyncWithSender(failSender{}, &stubProvider{}, Policy{HostToViewer: true, ViewerToHost: true})
	content := Content{Type: ContentTypeText, Text: "x"}
	if err := c.Send(content); err == nil {
		t.Fatal("expected the send error")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastSentHash == fingerprint(content) {
		t.Fatal("a failed send must not be remembered as sent")
	}
}

type stuckBufferSender struct{ mockSender }

func (s *stuckBufferSender) BufferedAmount() uint64 { return 1 << 40 }

func TestSendChunkedGivesUpWhenBufferNeverDrains(t *testing.T) {
	sender := &stuckBufferSender{}
	c := newClipboardSyncWithSender(sender, &stubProvider{}, Policy{HostToViewer: true, ViewerToHost: true})
	c.bufferWaitTimeout = 50 * time.Millisecond
	_ = c.Receive(textMsg(`{"type":"hello","chunked":true}`))

	start := time.Now()
	err := c.Send(Content{Type: ContentTypeText, Text: strings.Repeat("a", 200*1024)})
	if err == nil {
		t.Fatal("expected an error when the channel buffer never drains")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("send did not give up promptly")
	}
}

func TestReceiveReassemblesChunkedWriteAndAcksWithID(t *testing.T) {
	sender := &mockSender{}
	provider := &stubProvider{}
	c := newClipboardSyncWithSender(sender, provider, Policy{HostToViewer: true, ViewerToHost: true})

	big := strings.Repeat("b", 200*1024)
	inner, _ := json.Marshal(clipboardPayload{Type: ContentTypeText, Text: big})
	frames, err := encodeChunks("xfer1", inner)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range frames {
		if err := c.Receive(textMsg(string(f))); err != nil {
			t.Fatal(err)
		}
	}
	if provider.content.Text != big || provider.sets != 1 {
		t.Fatalf("provider sets=%d len=%d", provider.sets, len(provider.content.Text))
	}
	var ack struct{ Type, Hash, ID string }
	if err := json.Unmarshal([]byte(sender.sent[len(sender.sent)-1]), &ack); err != nil || ack.Type != "ack" || ack.ID != "xfer1" || ack.Hash == "" {
		t.Fatalf("ack = %+v (err %v)", ack, err)
	}
}

func TestReceiveChunksBlockedByPolicyAreNotAssembled(t *testing.T) {
	provider := &stubProvider{}
	c := newClipboardSyncWithSender(&mockSender{}, provider, Policy{HostToViewer: true, ViewerToHost: false})

	inner, _ := json.Marshal(clipboardPayload{Type: ContentTypeText, Text: strings.Repeat("c", 100*1024)})
	frames, _ := encodeChunks("xfer2", inner)
	for _, f := range frames {
		_ = c.Receive(textMsg(string(f)))
	}
	if provider.sets != 0 {
		t.Fatal("blocked direction wrote the host clipboard")
	}
	if got := c.Summary().Blocked; got != 1 {
		t.Fatalf("blocked = %d, want 1 (once per transfer, not per frame)", got)
	}
}

func TestHelloAcceptedEvenWhenViewerToHostBlocked(t *testing.T) {
	sender := &mockSender{}
	c := newClipboardSyncWithSender(sender, &stubProvider{}, Policy{HostToViewer: true, ViewerToHost: false})
	_ = c.Receive(textMsg(`{"type":"hello","chunked":true}`))
	if err := c.Send(Content{Type: ContentTypeText, Text: strings.Repeat("a", 100*1024)}); err != nil {
		t.Fatal(err)
	}
	if len(sender.sent) < 2 {
		t.Fatal("hello under a viewer→host block must still enable chunked host→viewer sends")
	}
	if c.Summary().Blocked != 0 {
		t.Fatal("hello is control, not a blocked transfer")
	}
}

func TestSendStatusDescribesPolicy(t *testing.T) {
	sender := &mockSender{}
	c := newClipboardSyncWithSender(sender, &stubProvider{}, Policy{HostToViewer: false, ViewerToHost: true})
	if err := c.SendStatus(); err != nil {
		t.Fatal(err)
	}
	var st map[string]any
	if err := json.Unmarshal([]byte(sender.sent[0]), &st); err != nil {
		t.Fatal(err)
	}
	if st["type"] != "status" || st["hostToViewer"] != false || st["viewerToHost"] != true ||
		st["chunked"] != true || st["suppressesBaseline"] != true {
		t.Fatalf("status = %v", st)
	}
	if st["maxTextBytes"] != float64(MaxTextBytes) || st["maxImageBytes"] != float64(MaxImageBytes) {
		t.Fatalf("status caps = %v", st)
	}
}

func TestSummaryCountsBothDirections(t *testing.T) {
	sender := &mockSender{}
	c := newClipboardSyncWithSender(sender, &stubProvider{}, Policy{HostToViewer: true, ViewerToHost: true})
	_ = c.Send(Content{Type: ContentTypeText, Text: "hello"})
	_ = c.Send(Content{Type: ContentTypeImage, Image: []byte{1, 2, 3}, ImageFormat: "png"})
	_ = c.Receive(textMsg(`{"type":"text","text":"abc"}`))

	got := map[string]TransferCount{}
	for _, tc := range c.Summary().Transfers {
		got[tc.Direction+"/"+tc.Type] = tc
	}
	if tc := got["host_to_viewer/text"]; tc.Count != 1 || tc.Bytes != 5 {
		t.Fatalf("host_to_viewer/text = %+v", tc)
	}
	if tc := got["host_to_viewer/image"]; tc.Count != 1 || tc.Bytes != 3 {
		t.Fatalf("host_to_viewer/image = %+v", tc)
	}
	if tc := got["viewer_to_host/text"]; tc.Count != 1 || tc.Bytes != 3 {
		t.Fatalf("viewer_to_host/text = %+v", tc)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/remote/clipboard/ -race -run 'TestSend|TestReceive|TestHello|TestSummary'`
Expected: FAIL to compile, `c.SendStatus undefined`, `c.Summary undefined`, and
`c.bufferWaitTimeout undefined`.

- [ ] **Step 3: Write minimal implementation**

In `sync.go`:

(a) Add fields to `ClipboardSync`, and initialize `bufferWaitTimeout: chunkTransferTimeout` in
both constructors:

```go
	peerChunked       atomic.Bool   // the viewer said hello with chunked:true
	bufferWaitTimeout time.Duration // how long a chunked send waits for the SCTP buffer
	rx                chunkAssembler
	rxBlockedID       string // transfer already counted as blocked (count once per transfer)

	statsMu sync.Mutex
	stats   map[string]*TransferCount // key "direction/type"
	blocked int
```

Add `"sync/atomic"` to the imports.

(b) Types and helpers:

```go
// Summary is what crossed the clipboard channel during a session, for audit.
// Never any content.
type Summary struct {
	Transfers []TransferCount `json:"transfers"`
	Blocked   int             `json:"blocked"`
}

type TransferCount struct {
	Direction string `json:"direction"` // host_to_viewer | viewer_to_host
	Type      string `json:"type"`
	Count     int    `json:"count"`
	Bytes     int    `json:"bytes"`
}

func contentBytes(c Content) int { return len(c.Text) + len(c.RTF) + len(c.Image) }

func (c *ClipboardSync) count(direction string, content Content) {
	c.statsMu.Lock()
	defer c.statsMu.Unlock()
	if c.stats == nil {
		c.stats = map[string]*TransferCount{}
	}
	key := direction + "/" + string(content.Type)
	tc, ok := c.stats[key]
	if !ok {
		tc = &TransferCount{Direction: direction, Type: string(content.Type)}
		c.stats[key] = tc
	}
	tc.Count++
	tc.Bytes += contentBytes(content)
}

func (c *ClipboardSync) countBlocked() {
	c.statsMu.Lock()
	c.blocked++
	c.statsMu.Unlock()
}

// Summary returns the transfer counters, sorted by direction then type.
func (c *ClipboardSync) Summary() Summary {
	c.statsMu.Lock()
	defer c.statsMu.Unlock()
	out := Summary{Blocked: c.blocked}
	for _, tc := range c.stats {
		out.Transfers = append(out.Transfers, *tc)
	}
	sort.Slice(out.Transfers, func(i, j int) bool {
		if out.Transfers[i].Direction != out.Transfers[j].Direction {
			return out.Transfers[i].Direction < out.Transfers[j].Direction
		}
		return out.Transfers[i].Type < out.Transfers[j].Type
	})
	return out
}

// SendStatus tells the viewer what this channel allows, so it can show
// "disabled by policy" instead of guessing from silence (spec gotcha C4).
// Viewers that predate it ignore an unknown message type.
func (c *ClipboardSync) SendStatus() error {
	if c.sender == nil {
		return errClipboardSyncUnconfigured
	}
	raw, err := json.Marshal(map[string]any{
		"type":               "status",
		"hostToViewer":       c.policy.HostToViewer,
		"viewerToHost":       c.policy.ViewerToHost,
		"chunked":            true,
		"suppressesBaseline": true,
		"maxTextBytes":       MaxTextBytes,
		"maxImageBytes":      MaxImageBytes,
	})
	if err != nil {
		return err
	}
	return c.sender.SendText(string(raw))
}
```

Add `"sort"` to the imports.

(c) Rewrite `Send`:
- marshal the payload exactly as today;
- send it as one message when `!c.peerChunked.Load() || len(encoded) <= chunkFrameMaxBytes`,
  otherwise call `c.sendChunked(encoded)`;
- only after a successful send: keep the existing `slog.Info`, call `c.count("host_to_viewer", content)`,
  and set `lastSentHash`.

```go
type bufferedSender interface {
	BufferedAmount() uint64
}

// chunkBufferHighWater pauses a chunked send while this much is queued, so a
// slow viewer does not make the agent buffer a whole image in SCTP.
const chunkBufferHighWater = 1 << 20

func (c *ClipboardSync) sendChunked(inner []byte) error {
	frames, err := encodeChunks(newTransferID(), inner)
	if err != nil {
		return err
	}
	bs, _ := c.sender.(bufferedSender)
	for _, f := range frames {
		if bs != nil {
			deadline := time.Now().Add(c.bufferWaitTimeout)
			for bs.BufferedAmount() > chunkBufferHighWater {
				if time.Now().After(deadline) {
					return errors.New("clipboard channel buffer did not drain")
				}
				time.Sleep(10 * time.Millisecond)
			}
		}
		if err := c.sender.SendText(string(f)); err != nil {
			return err
		}
	}
	return nil
}
```

(d) Rewrite `Receive`. The order of checks matters:

```go
func (c *ClipboardSync) Receive(msg webrtc.DataChannelMessage) error {
	if c.provider == nil {
		return errClipboardSyncUnconfigured
	}
	if !msg.IsString {
		return errors.New("clipboard payload must be text")
	}
	if len(msg.Data) > maxClipboardMessageBytes {
		return fmt.Errorf("clipboard payload exceeds maximum %d bytes", maxClipboardMessageBytes)
	}
	var head struct {
		Type    string `json:"type"`
		Chunked bool   `json:"chunked"`
	}
	if err := json.Unmarshal(msg.Data, &head); err != nil {
		return err
	}

	// hello is the viewer describing itself, not clipboard content: accepted
	// whatever the viewer→host policy says.
	if head.Type == "hello" {
		c.peerChunked.Store(head.Chunked)
		return nil
	}

	if head.Type == "chunk" {
		var f chunkFrame
		if err := json.Unmarshal(msg.Data, &f); err != nil {
			return err
		}
		if !c.policy.ViewerToHost {
			if f.ID != c.rxBlockedID {
				c.rxBlockedID = f.ID
				c.blockedTransfer(len(msg.Data))
			}
			return nil
		}
		inner, done, err := c.rx.add(f)
		if err != nil || !done {
			return err
		}
		return c.applyInbound(inner, f.ID)
	}

	if !c.policy.ViewerToHost {
		c.blockedTransfer(len(msg.Data))
		return nil
	}
	return c.applyInbound(msg.Data, "")
}

func (c *ClipboardSync) blockedTransfer(bytes int) {
	// A denied paste is security-relevant: audit it rather than dropping
	// silently (finding #7). TODO(#1012): central audit_logs (W4c).
	slog.Info("clipboard transfer blocked by policy", "direction", "viewer_to_host", "bytes", bytes)
	c.countBlocked()
}
```

`applyInbound(raw []byte, transferID string) error` is the existing body of `Receive` from
`json.Unmarshal` into `clipboardPayload` through the ack, with these changes:
- it unmarshals `raw` instead of calling `decodeClipboardPayload(msg)`;
- it calls `c.count("viewer_to_host", content)` after the `slog.Info`;
- the ack struct gains ``ID string `json:"id,omitempty"` `` populated with `transferID`.

Delete `decodeClipboardPayload` if it has no remaining callers (`grep -rn decodeClipboardPayload agent/`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test ./internal/remote/clipboard/ -race -count=5`
Expected: PASS (new and all existing tests, including `sync_gap7_test.go` and `gate_test.go`).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/clipboard/
git commit -m "feat(agent): chunked clipboard transfers, status announcement and transfer counters (#8240)"
```

---

### Task 3: `Watch` never pushes the clipboard the session started with

**Files:**
- Modify: `agent/internal/remote/clipboard/sync.go` (`Watch`)
- Create: `agent/internal/remote/clipboard/sync_baseline_test.go`

- [ ] **Step 1: Write the failing test**

```go
package clipboard

import (
	"sync"
	"testing"
	"time"
)

// seqProvider returns the queued contents in order, then repeats the last;
// errs makes the first n GetContent calls fail.
type seqProvider struct {
	mu    sync.Mutex
	items []Content
	errs  int
}

func (p *seqProvider) GetContent() (Content, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.errs > 0 {
		p.errs--
		return Content{}, errClipboardSyncUnconfigured
	}
	c := p.items[0]
	if len(p.items) > 1 {
		p.items = p.items[1:]
	}
	return c, nil
}
func (p *seqProvider) SetContent(Content) error { return nil }

type lockedSender struct {
	mu   sync.Mutex
	sent []string
}

func (s *lockedSender) SendText(v string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sent = append(s.sent, v)
	return nil
}
func (s *lockedSender) n() int { s.mu.Lock(); defer s.mu.Unlock(); return len(s.sent) }

func watchFor(t *testing.T, p Provider, d time.Duration) *lockedSender {
	t.Helper()
	sender := &lockedSender{}
	c := newClipboardSyncWithSender(sender, p, Policy{HostToViewer: true, ViewerToHost: true})
	c.pollInterval = 5 * time.Millisecond
	c.Watch()
	time.Sleep(d)
	c.Stop()
	return sender
}

func TestWatchDoesNotSendStartingClipboard(t *testing.T) {
	p := &seqProvider{items: []Content{{Type: ContentTypeText, Text: "end user's password"}}}
	if n := watchFor(t, p, 60*time.Millisecond).n(); n != 0 {
		t.Fatalf("sent %d message(s); the clipboard at session start must not be pushed", n)
	}
}

func TestWatchSendsLaterChange(t *testing.T) {
	p := &seqProvider{items: []Content{
		{Type: ContentTypeText, Text: "before"},
		{Type: ContentTypeText, Text: "before"},
		{Type: ContentTypeText, Text: "copied during session"},
	}}
	if n := watchFor(t, p, 80*time.Millisecond).n(); n != 1 {
		t.Fatalf("sent %d message(s), want exactly the change", n)
	}
}

func TestWatchBaselineSurvivesInitialProviderError(t *testing.T) {
	// The clipboard is locked by another app when the session starts; the first
	// successful read is still the starting clipboard, not a copy.
	p := &seqProvider{errs: 2, items: []Content{{Type: ContentTypeText, Text: "pre-existing"}}}
	if n := watchFor(t, p, 80*time.Millisecond).n(); n != 0 {
		t.Fatalf("sent %d message(s); the first readable clipboard is the baseline", n)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/remote/clipboard/ -race -run TestWatch`
Expected: FAIL. `TestWatchDoesNotSendStartingClipboard` sends 1 message, and
`TestWatchBaselineSurvivesInitialProviderError` sends 1.

- [ ] **Step 3: Write minimal implementation**

In `Watch`'s goroutine, add `baselined := false` before the loop. In the ticker branch, directly
after `lastErrMsg = ""` and `hash := fingerprint(content)`:

```go
				// The first readable clipboard is what the end user had before the
				// session. Remember it instead of sending it: pushing it would
				// overwrite the technician's clipboard just for connecting, with
				// whatever the end user last copied (spec gotcha C10).
				if !baselined {
					baselined = true
					c.mu.Lock()
					if c.lastSentHash == ([32]byte{}) {
						c.lastSentHash = hash
					}
					c.mu.Unlock()
					continue
				}
```

The `lastSentHash` zero check keeps a viewer→host write that landed before the first poll: it
already set the hash.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test ./internal/remote/clipboard/ -race -count=5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/clipboard/
git commit -m "fix(agent): don't push the end user's existing clipboard when a session starts (#8240)"
```

---

### Task 4: Announce status when the clipboard channel opens

**Files:**
- Modify: `agent/internal/remote/desktop/session_webrtc.go` (clipboard channel block, around `:398-420`)
- Test: `agent/internal/remote/desktop/session_clipboard_open_test.go`

**Interfaces:**
- Consumes: `(*clipboard.ClipboardSync).SendStatus()`, `.Watch()`.
- Produces: `func onClipboardChannelOpen(cs clipboardOpener, hostToViewer bool)`, with
  `type clipboardOpener interface{ SendStatus() error; Watch() }`.

- [ ] **Step 1: Write the failing test**

```go
package desktop

import "testing"

type fakeClipboardOpener struct{ status, watch int }

func (f *fakeClipboardOpener) SendStatus() error { f.status++; return nil }
func (f *fakeClipboardOpener) Watch()            { f.watch++ }

func TestClipboardOpenAnnouncesStatusAndWatchesOnlyWhenAllowed(t *testing.T) {
	allowed := &fakeClipboardOpener{}
	onClipboardChannelOpen(allowed, true)
	if allowed.status != 1 || allowed.watch != 1 {
		t.Fatalf("host→viewer allowed: status=%d watch=%d", allowed.status, allowed.watch)
	}

	blocked := &fakeClipboardOpener{}
	onClipboardChannelOpen(blocked, false)
	if blocked.status != 1 || blocked.watch != 0 {
		t.Fatalf("host→viewer blocked: status=%d watch=%d (status must still be sent)", blocked.status, blocked.watch)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/remote/desktop/ -run TestClipboardOpen -race`
Expected: FAIL to compile, `undefined: onClipboardChannelOpen`.

- [ ] **Step 3: Write minimal implementation**

Add to `session_webrtc.go` (or a new `session_clipboard.go`):

```go
type clipboardOpener interface {
	SendStatus() error
	Watch()
}

// onClipboardChannelOpen tells the viewer what the channel allows, under any
// policy, then starts streaming the host clipboard if that direction is
// allowed (Watch is itself a no-op otherwise; the check keeps intent visible).
func onClipboardChannelOpen(cs clipboardOpener, hostToViewer bool) {
	if err := cs.SendStatus(); err != nil {
		slog.Debug("Failed to send clipboard status", "error", err.Error())
	}
	if hostToViewer {
		cs.Watch()
	}
}
```

Replace the existing block:

```go
			if policy.ClipboardHostToViewer {
				clipboardDC.OnOpen(func() {
					session.clipboardSync.Watch()
				})
			}
```

with:

```go
			hostToViewer := policy.ClipboardHostToViewer
			clipboardDC.OnOpen(func() {
				onClipboardChannelOpen(session.clipboardSync, hostToViewer)
			})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test ./internal/remote/... -race`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/desktop/
git commit -m "feat(agent): announce clipboard policy and capabilities when the channel opens (#8240)"
```

---

### Task 5: Verify

- [ ] `cd agent && go test -race ./internal/remote/... ./internal/heartbeat/...` → PASS.
- [ ] `bash scripts/check-windows-vet.sh` → clean, matches baseline.
- [ ] `cd agent && GOOS=linux CGO_ENABLED=0 go vet ./internal/remote/... && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go vet ./internal/remote/...` → clean.

**Lab gate (owed before merge):**
- An old viewer against the new agent: text copy and paste both ways still work, and connecting does
  not overwrite the technician's clipboard.
- Agent→viewer chunked transfers are only exercisable once W4b ships `hello`. Record that on the PR.

## W4b / W4c outline (separate plans)

**W4b (viewer, after #8244 merges):**
- Send `{"type":"hello","chunked":true}` on clipboard channel open, then read `status`.
- Encode and decode chunks (TypeScript port of `chunk.go`, with the same constants), using
  `bufferedAmount` backpressure.
- Images: `clipboard-manager:allow-read-image` / `allow-write-image`. Remote→local writes PNG bytes;
  local→remote reads the local image, encodes it as PNG, and sends `{type:"image", image, image_format:"png"}`.
- Status chip: per-direction state, "Disabled by policy", and the last transfer size.
- "Copy remote clipboard" (applies the buffered item a background window skipped) and "Send
  clipboard to remote".
- Paste as a transaction: cancel the keystroke on a failed send, an ack timeout, or a channel close,
  when `status` was received (agent known to ack).
- Disable W1's baseline skip when `status.suppressesBaseline`.
- VNC: noVNC `clipboard` event → local; Ctrl+V → `clipboardPasteFrom`.

**W4c (audit):** the session already reports its end to the API as a `command_result`
`desk-disconnect-<id>` with `result:{sessionId, event:"peer_disconnected", stopReason?}`
(`heartbeat.go:1808-1840`). It travels through the helper as IPC `desktop_peer_disconnected` with
`DesktopPeerDisconnectedNotice` (`ipc/message.go:505`). W4c makes these changes:
- **Agent hook:** `OnSessionStopped` gains the session's `clipboard.Summary` (4 fire sites:
  `session_webrtc.go:610,622`, `revocation_lease.go:379`, `ws_lease.go:72`). Emission is guarded
  with a per-session `sync.Once`, because Failed and Closed can both fire.
- **IPC notice:** `DesktopPeerDisconnectedNotice.Clipboard *clipboard.Summary`
  (`json:"clipboard,omitempty"`), populated at `userhelper/client.go:191`.
- **Heartbeat:** `desktopDisconnectResultPayload` adds a bounded `clipboard` key. It is threaded
  through `heartbeat.go:1264` and `:1623`, `handlers_support_viewing.go:88` and
  `handlers_desktop_stream.go:119`.
- **API schema:** `desktopCommandResultSchema` (`agentWs.ts:4401`) is `.strict()`, so it must add
  `clipboard: z.object({transfers: z.array(...).max(8), blocked: z.number().int().nonnegative()}).strict().optional()`.
  Without it, a new agent's report is rejected as malformed.
- **API audit row:** in the `peer_disconnected` branch, outside the `result.ok` gate, call
  `logSessionAudit('session_clipboard_summary', deviceId, row.orgId, {sessionId, clipboard, sessionOwnerId, deviceId, reportedBy:'authenticated_agent'}, undefined, 'agent')`.
  Write it only when there are nonzero counts, and dedupe on `resourceId` and the action.
- **Ordering:** the API schema change must ship **before or with** the agent change.
