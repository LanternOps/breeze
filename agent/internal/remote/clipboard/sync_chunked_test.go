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
