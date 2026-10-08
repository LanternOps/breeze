package desktop

import (
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
