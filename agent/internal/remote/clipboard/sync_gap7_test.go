package clipboard

import (
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// gap7Provider is a minimal Provider that records whether the host clipboard
// was ever polled (GetContent) so the GAP7 test can prove Watch() never starts
// its poll loop when host->viewer is disabled.
type gap7Provider struct {
	getCalls atomic.Int64
	setCalls atomic.Int64
}

func (p *gap7Provider) GetContent() (Content, error) {
	p.getCalls.Add(1)
	return Content{Type: ContentTypeText, Text: "secret"}, nil
}

func (p *gap7Provider) SetContent(c Content) error {
	p.setCalls.Add(1)
	return nil
}

// recordingSender satisfies dcSender and counts egress sends.
type recordingSender struct{ sends atomic.Int64 }

func (s *recordingSender) SendText(string) error {
	s.sends.Add(1)
	return nil
}

// TestWatchSkipsWhenHostToViewerDisabled (GAP7): with host->viewer off, Watch
// must NOT start the poll goroutine, so the host clipboard is never read.
func TestWatchSkipsWhenHostToViewerDisabled(t *testing.T) {
	p := &gap7Provider{}
	c := newClipboardSyncWithSender(&recordingSender{}, p, Policy{HostToViewer: false, ViewerToHost: true})
	c.pollInterval = time.Millisecond
	c.Watch()
	time.Sleep(20 * time.Millisecond) // would allow many polls if the loop ran
	if got := p.getCalls.Load(); got != 0 {
		t.Fatalf("host clipboard polled %d times despite host->viewer disabled (GAP7)", got)
	}
}

// TestWatchPollsWhenHostToViewerEnabled is the positive control: with the
// direction enabled, the poll loop runs and reads the host clipboard.
func TestWatchPollsWhenHostToViewerEnabled(t *testing.T) {
	p := &gap7Provider{}
	c := newClipboardSyncWithSender(&recordingSender{}, p, Policy{HostToViewer: true, ViewerToHost: false})
	c.pollInterval = time.Millisecond
	c.Watch()
	defer c.Stop()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if p.getCalls.Load() > 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("poll loop never read the host clipboard with host->viewer enabled")
}

// TestReceiveBlockedByPolicy: a viewer->host paste must be dropped (no
// SetContent) when viewerToHost is disabled, returning nil.
func TestReceiveBlockedByPolicy(t *testing.T) {
	p := &gap7Provider{}
	c := newClipboardSyncWithSender(&recordingSender{}, p, Policy{HostToViewer: true, ViewerToHost: false})
	msg := webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"text","text":"x"}`)}
	if err := c.Receive(msg); err != nil {
		t.Fatalf("blocked Receive should return nil, got %v", err)
	}
	if got := p.setCalls.Load(); got != 0 {
		t.Fatalf("host clipboard written %d times despite viewer->host disabled", got)
	}
}
