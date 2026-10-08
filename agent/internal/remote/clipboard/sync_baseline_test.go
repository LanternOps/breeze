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
	gets  int
}

func (p *seqProvider) polls() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.gets
}

func (p *seqProvider) GetContent() (Content, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.gets++
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

// watchFor runs the watcher until it has polled at least minPolls times (so a
// "nothing sent" result means something), then stops it.
func watchFor(t *testing.T, p *seqProvider, minPolls int) *lockedSender {
	t.Helper()
	sender := &lockedSender{}
	c := newClipboardSyncWithSender(sender, p, Policy{HostToViewer: true, ViewerToHost: true})
	c.pollInterval = 5 * time.Millisecond
	c.Watch()
	deadline := time.Now().Add(2 * time.Second)
	for p.polls() < minPolls {
		if time.Now().After(deadline) {
			t.Fatalf("watcher polled %d time(s), want at least %d", p.polls(), minPolls)
		}
		time.Sleep(time.Millisecond)
	}
	c.Stop()
	return sender
}

func TestWatchDoesNotSendStartingClipboard(t *testing.T) {
	p := &seqProvider{items: []Content{{Type: ContentTypeText, Text: "end user's password"}}}
	if n := watchFor(t, p, 4).n(); n != 0 {
		t.Fatalf("sent %d message(s); the clipboard at session start must not be pushed", n)
	}
}

func TestWatchSendsLaterChange(t *testing.T) {
	p := &seqProvider{items: []Content{
		{Type: ContentTypeText, Text: "before"},
		{Type: ContentTypeText, Text: "before"},
		{Type: ContentTypeText, Text: "copied during session"},
	}}
	if n := watchFor(t, p, 5).n(); n != 1 {
		t.Fatalf("sent %d message(s), want exactly the change", n)
	}
}

func TestWatchBaselineSurvivesInitialProviderError(t *testing.T) {
	// The clipboard is locked by another app when the session starts; the first
	// successful read is still the starting clipboard, not a copy.
	p := &seqProvider{errs: 2, items: []Content{{Type: ContentTypeText, Text: "pre-existing"}}}
	if n := watchFor(t, p, p.errs+3).n(); n != 0 {
		t.Fatalf("sent %d message(s); the first readable clipboard is the baseline", n)
	}
}
