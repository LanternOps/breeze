package desktop

import (
	"regexp"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/clipboard"
	"github.com/pion/webrtc/v4"
)

type noopClipboardProvider struct{}

func (noopClipboardProvider) GetContent() (clipboard.Content, error) { return clipboard.Content{}, nil }
func (noopClipboardProvider) SetContent(clipboard.Content) error     { return nil }

func TestDoCleanupReportsClipboardSummaryOnce(t *testing.T) {
	cs := clipboard.NewClipboardSync(nil, noopClipboardProvider{}, clipboard.Policy{HostToViewer: true, ViewerToHost: false})
	// A viewer→host paste the policy blocked: counted, never applied.
	_ = cs.Receive(webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"text","text":"x"}`)})

	var got []ipc.ClipboardSummary
	s := &Session{
		id:            "s1",
		inputHandler:  &stubInputHandler{},
		clipboardSync: cs,
		onClipboardSummary: func(sessionID string, summary ipc.ClipboardSummary) {
			if sessionID != "s1" {
				t.Errorf("sessionID = %q", sessionID)
			}
			got = append(got, summary)
		},
	}

	s.doCleanup()
	s.doCleanup()

	if len(got) != 1 {
		t.Fatalf("summary reported %d times, want exactly once", len(got))
	}
	if got[0].Blocked != 1 {
		t.Fatalf("blocked = %d, want 1", got[0].Blocked)
	}
}

func TestDoCleanupSkipsEmptyClipboardSummary(t *testing.T) {
	called := false
	s := &Session{
		id:                 "s1",
		inputHandler:       &stubInputHandler{},
		clipboardSync:      clipboard.NewClipboardSync(nil, noopClipboardProvider{}, clipboard.Policy{HostToViewer: true, ViewerToHost: true}),
		onClipboardSummary: func(string, ipc.ClipboardSummary) { called = true },
	}
	s.doCleanup()
	if called {
		t.Fatal("a session with no clipboard activity must not produce an audit summary")
	}
}

func TestClipboardSummaryForIPCCopiesCounters(t *testing.T) {
	in := clipboard.Summary{
		Transfers: []clipboard.TransferCount{{Direction: "host_to_viewer", Type: "image", Count: 2, Bytes: 900}},
		Blocked:   3,
	}
	out := clipboardSummaryForIPC(in)
	if out.Blocked != 3 || len(out.Transfers) != 1 || out.Transfers[0] != (ipc.ClipboardTransferCount{Direction: "host_to_viewer", Type: "image", Count: 2, Bytes: 900}) {
		t.Fatalf("out = %+v", out)
	}
}

func TestClipboardSummaryNamesItsSegment(t *testing.T) {
	// One server session can span several agent Sessions (WebRTC reconnect,
	// Retry, session switch), each reporting at its own teardown. The API
	// records one row per segment, so every report carries its own id.
	a := clipboardSummaryForIPC(clipboard.Summary{Blocked: 1})
	b := clipboardSummaryForIPC(clipboard.Summary{Blocked: 1})
	hex32 := regexp.MustCompile(`^[0-9a-f]{32}$`)
	if !hex32.MatchString(a.SegmentID) || !hex32.MatchString(b.SegmentID) {
		t.Fatalf("segment ids %q, %q are not 32 hex chars", a.SegmentID, b.SegmentID)
	}
	if a.SegmentID == b.SegmentID {
		t.Fatal("two segments share an id; the API would drop the second as a duplicate")
	}
}
