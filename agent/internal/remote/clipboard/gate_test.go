package clipboard

import (
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// Finding #7: the agent is the enforcement point for clipboard sync because the
// viewer is untrusted. These tests prove each direction is gated by policy.

type gateProvider struct {
	mu       sync.Mutex
	content  Content
	setCalls int
	gets     int
}

func (p *gateProvider) GetContent() (Content, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.gets++
	return p.content, nil
}

func (p *gateProvider) getCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.gets
}

// waitForBaseline returns once the watcher has read the starting clipboard,
// so a copy made after it is a change rather than the baseline.
func waitForBaseline(t *testing.T, p *gateProvider) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for p.getCount() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("watcher never polled the clipboard")
		}
		time.Sleep(time.Millisecond)
	}
}

func (p *gateProvider) SetContent(c Content) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.setCalls++
	p.content = c
	return nil
}

// copyOnHost simulates the end user copying something new mid-session. The
// watcher deliberately never sends the clipboard it started with, so a gate
// test has to change it after Watch starts or "0 sends" would prove nothing.
func (p *gateProvider) copyOnHost(text string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.content = Content{Type: ContentTypeText, Text: text}
}

func (p *gateProvider) setCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.setCalls
}

type gateSender struct {
	mu   sync.Mutex
	sent int
}

func (s *gateSender) SendText(string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sent++
	return nil
}

func (s *gateSender) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sent
}

// host→viewer OFF: the watcher must never read/forward the host clipboard, so
// nothing the end user copies leaks to the operator.
func TestClipboardWatchGate_HostToViewerDisabled(t *testing.T) {
	snd := &gateSender{}
	prov := &gateProvider{content: Content{Type: ContentTypeText, Text: "secret-on-host"}}
	c := &ClipboardSync{
		sender:       snd,
		provider:     prov,
		pollInterval: 5 * time.Millisecond,
		stop:         make(chan struct{}),
		policy:       Policy{HostToViewer: false, ViewerToHost: true},
	}
	c.Watch()
	defer c.Stop()

	time.Sleep(20 * time.Millisecond)
	prov.copyOnHost("copied-during-session")
	time.Sleep(50 * time.Millisecond)
	if got := snd.count(); got != 0 {
		t.Fatalf("host→viewer disabled: expected 0 sends, got %d (silent clipboard exfiltration)", got)
	}
}

// host→viewer ON: the host clipboard is streamed to the viewer (positive control).
func TestClipboardWatchGate_HostToViewerEnabled(t *testing.T) {
	snd := &gateSender{}
	prov := &gateProvider{content: Content{Type: ContentTypeText, Text: "secret-on-host"}}
	c := &ClipboardSync{
		sender:       snd,
		provider:     prov,
		pollInterval: 5 * time.Millisecond,
		stop:         make(chan struct{}),
		policy:       Policy{HostToViewer: true, ViewerToHost: true},
	}
	c.Watch()
	defer c.Stop()

	waitForBaseline(t, prov)
	prov.copyOnHost("copied-during-session")
	deadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) && snd.count() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if snd.count() == 0 {
		t.Fatal("host→viewer enabled: expected the host clipboard to be streamed, got 0 sends")
	}
}

// viewer→host OFF: an inbound clipboard write must be dropped, leaving the host
// clipboard untouched.
func TestClipboardReceiveGate_ViewerToHostDisabled(t *testing.T) {
	prov := &gateProvider{}
	c := &ClipboardSync{
		sender:       &gateSender{},
		provider:     prov,
		pollInterval: defaultPollInterval,
		stop:         make(chan struct{}),
		policy:       Policy{HostToViewer: true, ViewerToHost: false},
	}
	msg := webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"text","text":"paste-into-host"}`)}
	if err := c.Receive(msg); err != nil {
		t.Fatalf("Receive returned error: %v", err)
	}
	if got := prov.setCount(); got != 0 {
		t.Fatalf("viewer→host disabled: expected host clipboard untouched, got %d SetContent calls", got)
	}
}

// viewer→host ON: an inbound clipboard write is applied to the host (positive control).
func TestClipboardReceiveGate_ViewerToHostEnabled(t *testing.T) {
	prov := &gateProvider{}
	c := &ClipboardSync{
		sender:       &gateSender{},
		provider:     prov,
		pollInterval: defaultPollInterval,
		stop:         make(chan struct{}),
		policy:       Policy{HostToViewer: true, ViewerToHost: true},
	}
	msg := webrtc.DataChannelMessage{IsString: true, Data: []byte(`{"type":"text","text":"paste-into-host"}`)}
	if err := c.Receive(msg); err != nil {
		t.Fatalf("Receive returned error: %v", err)
	}
	if got := prov.setCount(); got != 1 {
		t.Fatalf("viewer→host enabled: expected 1 SetContent call, got %d", got)
	}
}
