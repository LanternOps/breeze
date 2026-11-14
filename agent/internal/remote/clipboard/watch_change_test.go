package clipboard

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

// counterProvider is a clipboard with a change counter, like Windows
// (GetClipboardSequenceNumber) and macOS (NSPasteboard changeCount). Every
// change bumps the counter, including a copy of identical content.
type counterProvider struct {
	mu        sync.Mutex
	content   Content
	err       error // returned by GetContent instead of content when set
	count     uint64
	noCounter bool // ChangeCount reports unavailable
	gets      int
}

func (p *counterProvider) ChangeCount() (uint64, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.noCounter {
		return 0, false
	}
	return p.count, true
}

func (p *counterProvider) GetContent() (Content, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.gets++
	if p.err != nil {
		return Content{}, p.err
	}
	return p.content, nil
}

func (p *counterProvider) SetContent(c Content) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.content, p.err = c, nil
	p.count += 2 // Windows: EmptyClipboard and SetClipboardData each bump it
	return nil
}

// copyOnHost is the end user copying text on the remote machine.
func (p *counterProvider) copyOnHost(text string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.content, p.err = Content{Type: ContentTypeText, Text: text}, nil
	p.count++
}

// copyUnreadable is the end user copying something the provider cannot carry
// (a file, an image format it cannot read), or clearing the clipboard.
func (p *counterProvider) copyUnreadable(err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.err = err
	p.count++
}

func (p *counterProvider) polls() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.gets
}

func (s *lockedSender) messages() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]map[string]any, 0, len(s.sent))
	for _, raw := range s.sent {
		var m map[string]any
		if err := json.Unmarshal([]byte(raw), &m); err == nil {
			out = append(out, m)
		}
	}
	return out
}

func (s *lockedSender) ofType(typ string) []map[string]any {
	var out []map[string]any
	for _, m := range s.messages() {
		if m["type"] == typ {
			out = append(out, m)
		}
	}
	return out
}

func waitUntil(t *testing.T, what string, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

// startCounterWatch starts a watcher on p and waits for its baseline poll.
func startCounterWatch(t *testing.T, p *counterProvider, interval time.Duration, changeNotices bool) (*ClipboardSync, *lockedSender) {
	t.Helper()
	sender := &lockedSender{}
	c := newClipboardSyncWithSender(sender, p, Policy{HostToViewer: true, ViewerToHost: true})
	c.pollInterval = interval
	hello := `{"type":"hello","chunked":true}`
	if changeNotices {
		hello = `{"type":"hello","chunked":true,"changeNotices":true}`
	}
	if err := c.Receive(textMsg(hello)); err != nil {
		t.Fatalf("hello: %v", err)
	}
	c.Watch()
	t.Cleanup(c.Stop)
	waitUntil(t, "baseline poll", 3*time.Second, func() bool { return p.polls() >= 1 })
	return c, sender
}

func textsSent(s *lockedSender) []string {
	var out []string
	for _, m := range s.ofType("text") {
		out = append(out, m["text"].(string))
	}
	return out
}

// A remote copy of what the remote held before a viewer write is reported
// (this already held with the hash rule; kept as a guard).
func TestWatchReportsRemoteCopyAfterViewerWrite(t *testing.T) {
	p := &counterProvider{content: Content{Type: ContentTypeText, Text: "baseline"}, count: 1}
	c, sender := startCounterWatch(t, p, 5*time.Millisecond, true)

	p.copyOnHost("X")
	waitUntil(t, "first X", 2*time.Second, func() bool { return len(textsSent(sender)) == 1 })

	if err := c.Receive(textMsg(`{"type":"text","text":"Y"}`)); err != nil {
		t.Fatalf("viewer write: %v", err)
	}
	p.copyOnHost("X")
	waitUntil(t, "second X", 2*time.Second, func() bool { return len(textsSent(sender)) == 2 })
	if got := textsSent(sender); got[0] != "X" || got[1] != "X" {
		t.Fatalf("sent %q, want [X X]", got)
	}
}

// Row 3 of #11310: copy X on the remote, copy Y on the Mac (nothing reaches
// the agent), copy X on the remote again. The second X must be reported even
// though its hash is the one last sent, or the viewer cannot tell that the
// remote is newer and its next paste overwrites X with Y.
func TestWatchReportsRecopyOfIdenticalContent(t *testing.T) {
	p := &counterProvider{content: Content{Type: ContentTypeText, Text: "baseline"}, count: 1}
	_, sender := startCounterWatch(t, p, 5*time.Millisecond, true)
	p.copyOnHost("X")
	waitUntil(t, "first X", 2*time.Second, func() bool { return len(textsSent(sender)) == 1 })
	p.copyOnHost("X")
	waitUntil(t, "second X", 2*time.Second, func() bool { return len(textsSent(sender)) == 2 })
}

// The viewer's own write must not come back to it as a remote change.
func TestWatchDoesNotEchoViewerWrite(t *testing.T) {
	p := &counterProvider{content: Content{Type: ContentTypeText, Text: "baseline"}, count: 1}
	c, sender := startCounterWatch(t, p, 2*time.Millisecond, true)
	if err := c.Receive(textMsg(`{"type":"text","text":"from viewer"}`)); err != nil {
		t.Fatalf("viewer write: %v", err)
	}
	time.Sleep(60 * time.Millisecond)
	if got := textsSent(sender); len(got) != 0 {
		t.Fatalf("echoed the viewer's write back: %q", got)
	}
	if len(sender.ofType("ack")) != 1 {
		t.Fatalf("want one ack, got %d", len(sender.ofType("ack")))
	}
}

// With an unchanged counter the clipboard is not read at all.
func TestWatchSkipsReadWhileCounterUnchanged(t *testing.T) {
	p := &counterProvider{content: Content{Type: ContentTypeText, Text: "baseline"}, count: 7}
	startCounterWatch(t, p, 2*time.Millisecond, true)
	time.Sleep(60 * time.Millisecond)
	if n := p.polls(); n != 1 {
		t.Fatalf("read the clipboard %d times with an unchanged counter, want 1 (the baseline)", n)
	}
}

// Rows 5–6: a file or unreadable image copied on the remote is invisible as
// content, but the viewer must learn the remote clipboard is now newer.
func TestWatchSendsUnsupportedNoticeToCapableViewer(t *testing.T) {
	p := &counterProvider{content: Content{Type: ContentTypeText, Text: "baseline"}, count: 1}
	_, sender := startCounterWatch(t, p, 5*time.Millisecond, true)
	p.copyUnreadable(ErrNoSupportedFormat)
	waitUntil(t, "unsupported notice", 2*time.Second, func() bool { return len(sender.ofType("unsupported")) == 1 })
	n := sender.ofType("unsupported")[0]
	if _, ok := n["seq"].(float64); !ok {
		t.Fatalf("notice has no seq: %v", n)
	}
	if n["empty"] == true {
		t.Fatalf("unsupported content reported as empty: %v", n)
	}
	// Still unreadable, unchanged: one notice only.
	time.Sleep(30 * time.Millisecond)
	if got := len(sender.ofType("unsupported")); got != 1 {
		t.Fatalf("sent %d notices for one change", got)
	}
	// A second unreadable copy is a second change.
	p.copyUnreadable(ErrNoSupportedFormat)
	waitUntil(t, "second notice", 2*time.Second, func() bool { return len(sender.ofType("unsupported")) == 2 })
	a, b := sender.ofType("unsupported")[0]["seq"].(float64), sender.ofType("unsupported")[1]["seq"].(float64)
	if b <= a {
		t.Fatalf("seq did not increase: %v then %v", a, b)
	}
}

func TestWatchSendsEmptyNotice(t *testing.T) {
	p := &counterProvider{content: Content{Type: ContentTypeText, Text: "baseline"}, count: 1}
	_, sender := startCounterWatch(t, p, 5*time.Millisecond, true)
	p.copyUnreadable(ErrClipboardEmpty)
	waitUntil(t, "empty notice", 2*time.Second, func() bool { return len(sender.ofType("unsupported")) == 1 })
	if n := sender.ofType("unsupported")[0]; n["empty"] != true {
		t.Fatalf("empty clipboard not reported as empty: %v", n)
	}
}

// A viewer that predates the notice never gets one.
func TestWatchSendsNoNoticeToLegacyViewer(t *testing.T) {
	p := &counterProvider{content: Content{Type: ContentTypeText, Text: "baseline"}, count: 1}
	_, sender := startCounterWatch(t, p, 2*time.Millisecond, false)
	p.copyUnreadable(ErrNoSupportedFormat)
	time.Sleep(60 * time.Millisecond)
	if n := sender.n(); n != 0 {
		t.Fatalf("sent %d message(s) to a viewer that did not ask for notices", n)
	}
}

// A failure to open the clipboard is not a change: the next poll re-reads.
func TestWatchRetriesAfterReadFailureWithCounter(t *testing.T) {
	p := &counterProvider{content: Content{Type: ContentTypeText, Text: "baseline"}, count: 1}
	_, sender := startCounterWatch(t, p, 5*time.Millisecond, true)
	p.copyUnreadable(errors.New("OpenClipboard: access denied"))
	time.Sleep(30 * time.Millisecond)
	if n := sender.n(); n != 0 {
		t.Fatalf("sent %d message(s) for a failed read", n)
	}
	p.mu.Lock()
	p.err = nil
	p.content = Content{Type: ContentTypeText, Text: "now readable"}
	p.mu.Unlock()
	waitUntil(t, "content after the failure clears", 2*time.Second, func() bool { return len(textsSent(sender)) == 1 })
}

// A provider whose counter is unavailable keeps the hash rule.
func TestWatchFallsBackToHashWithoutCounter(t *testing.T) {
	p := &counterProvider{content: Content{Type: ContentTypeText, Text: "baseline"}, noCounter: true}
	_, sender := startCounterWatch(t, p, 2*time.Millisecond, true)
	p.copyOnHost("X")
	waitUntil(t, "X", 2*time.Second, func() bool { return len(textsSent(sender)) == 1 })
	time.Sleep(30 * time.Millisecond)
	if got := textsSent(sender); len(got) != 1 {
		t.Fatalf("hash fallback re-sent unchanged content: %q", got)
	}
}

// Row 4: after a forwarded copy chord the watcher reads at once and retries
// briefly, instead of waiting for the next poll.
func TestCopyChordReadsPromptly(t *testing.T) {
	// A long poll and a wide burst, so a loaded host cannot make the poll win
	// or the burst expire: only the chord's burst can report the copy in time.
	const interval = 10 * time.Second
	defer func(b time.Duration) { copyChordBurst = b }(copyChordBurst)
	copyChordBurst = 5 * time.Second
	p := &counterProvider{content: Content{Type: ContentTypeText, Text: "baseline"}, count: 1}
	c, sender := startCounterWatch(t, p, interval, true)

	// The app answers Ctrl+C a little after the chord was injected.
	c.CopyChordInjected()
	time.Sleep(40 * time.Millisecond)
	p.copyOnHost("copied")
	waitUntil(t, "copy after the chord, well before the next poll", 4*time.Second, func() bool { return len(textsSent(sender)) == 1 })
}

// CopyChordInjected never blocks, even with host→viewer off (no watcher).
func TestCopyChordInjectedNeverBlocks(t *testing.T) {
	c := newClipboardSyncWithSender(&lockedSender{}, &counterProvider{}, Policy{})
	done := make(chan struct{})
	go func() {
		for i := 0; i < 100; i++ {
			c.CopyChordInjected()
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("CopyChordInjected blocked")
	}
}

func TestSendStatusAdvertisesChangeNotices(t *testing.T) {
	sender := &lockedSender{}
	c := newClipboardSyncWithSender(sender, &counterProvider{}, Policy{HostToViewer: true, ViewerToHost: true})
	if err := c.SendStatus(); err != nil {
		t.Fatal(err)
	}
	if st := sender.ofType("status"); len(st) != 1 || st[0]["changeNotices"] != true {
		t.Fatalf("status does not advertise changeNotices: %v", sender.messages())
	}
}

func TestErrClipboardEmptyIsNoSupportedFormat(t *testing.T) {
	if !errors.Is(ErrClipboardEmpty, ErrNoSupportedFormat) {
		t.Fatal("an empty clipboard must still count as no supported format (baseline rule)")
	}
	if !errors.Is(proxyHelperError(ErrClipboardEmpty.Error()), ErrClipboardEmpty) {
		t.Fatal("ErrClipboardEmpty must survive the helper IPC trip")
	}
}

// flakySender fails its first n sends.
type flakySender struct {
	lockedSender
	fail int
}

func (s *flakySender) SendText(v string) error {
	s.mu.Lock()
	if s.fail > 0 {
		s.fail--
		s.mu.Unlock()
		return errors.New("channel busy")
	}
	s.mu.Unlock()
	return s.lockedSender.SendText(v)
}

// A change whose send failed is retried, not lost with the counter.
func TestWatchRetriesAChangeWhoseSendFailed(t *testing.T) {
	p := &counterProvider{content: Content{Type: ContentTypeText, Text: "baseline"}, count: 1}
	sender := &flakySender{}
	c := newClipboardSyncWithSender(sender, p, Policy{HostToViewer: true, ViewerToHost: true})
	c.pollInterval = 5 * time.Millisecond
	c.Watch()
	t.Cleanup(c.Stop)
	waitUntil(t, "baseline poll", 3*time.Second, func() bool { return p.polls() >= 1 })
	sender.mu.Lock()
	sender.fail = 2
	sender.mu.Unlock()
	p.copyOnHost("X")
	waitUntil(t, "X after the failed sends", 2*time.Second, func() bool { return len(textsSent(&sender.lockedSender)) == 1 })
}

// A clipboard history tool re-rendering the viewer's write moves the counter
// again with the same content: still the viewer's write, not a host copy.
func TestWatchDoesNotEchoAReRenderedViewerWrite(t *testing.T) {
	p := &counterProvider{content: Content{Type: ContentTypeText, Text: "baseline"}, count: 1}
	c, sender := startCounterWatch(t, p, 2*time.Millisecond, true)
	if err := c.Receive(textMsg(`{"type":"text","text":"from viewer"}`)); err != nil {
		t.Fatalf("viewer write: %v", err)
	}
	p.mu.Lock()
	p.count++ // re-rendered, same content
	p.mu.Unlock()
	reads := p.polls()
	waitUntil(t, "the re-render to be read", 2*time.Second, func() bool { return p.polls() > reads })
	time.Sleep(20 * time.Millisecond)
	if got := textsSent(sender); len(got) != 0 {
		t.Fatalf("echoed a re-rendered viewer write: %q", got)
	}
}

// Without a change counter the agent cannot report re-copies or tell an
// empty clipboard from an unsupported one, so it does not offer notices and
// the viewer does not wait for copies.
func TestSendStatusOffersNoChangeNoticesWithoutCounter(t *testing.T) {
	sender := &lockedSender{}
	c := newClipboardSyncWithSender(sender, &seqProvider{items: []Content{{Type: ContentTypeText, Text: "x"}}}, Policy{HostToViewer: true, ViewerToHost: true})
	if err := c.SendStatus(); err != nil {
		t.Fatal(err)
	}
	if st := sender.ofType("status"); len(st) != 1 || st[0]["changeNotices"] != false {
		t.Fatalf("status offers changeNotices without a counter: %v", sender.messages())
	}
}
