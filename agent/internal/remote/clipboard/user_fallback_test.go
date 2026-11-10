package clipboard

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeLocal is the system helper's own clipboard read: what SYSTEM can see.
type fakeLocal struct {
	mu      sync.Mutex
	content Content
	err     error
	gets    int
	set     []Content
}

func (f *fakeLocal) GetContent() (Content, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gets++
	return f.content, f.err
}

func (f *fakeLocal) SetContent(c Content) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.set = append(f.set, c)
	return nil
}

func (f *fakeLocal) answer(c Content, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.content, f.err = c, err
}

// fakeUserProxy stands in for the user helper behind the service relay.
type fakeUserProxy struct {
	mu      sync.Mutex
	content Content
	err     error
	reads   int
}

func (f *fakeUserProxy) read() (Content, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads++
	return f.content, f.err
}

func (f *fakeUserProxy) answer(c Content, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.content, f.err = c, err
}

func (f *fakeUserProxy) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reads
}

// fakeSeq is the window station's clipboard sequence number.
type fakeSeq struct {
	mu sync.Mutex
	n  uint64
	ok bool
}

func (s *fakeSeq) read() (uint64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.n, s.ok
}

func (s *fakeSeq) bump() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.n++
}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

var pngBytes = []byte("\x89PNG\r\n\x1a\nfake-image")

func newFallbackForTest() (*userClipboardFallback, *fakeLocal, *fakeUserProxy, *fakeSeq, *fakeClock) {
	local := &fakeLocal{err: ErrNoSupportedFormat}
	user := &fakeUserProxy{}
	seq := &fakeSeq{n: 7, ok: true}
	clock := &fakeClock{now: time.Unix(1_700_000_000, 0)}
	p := newUserClipboardFallback(local, user.read, seq.read, clock.Now)
	return p, local, user, seq, clock
}

// The #8393 case: SYSTEM sees no format it can read, the user helper reads the
// PNG, and the image is what the session gets.
func TestUserFallbackReadsImageSystemCannotSee(t *testing.T) {
	p, _, user, _, _ := newFallbackForTest()
	user.answer(Content{Type: ContentTypeImage, Image: pngBytes, ImageFormat: "png"}, nil)

	got, err := p.GetContent()
	if err != nil {
		t.Fatalf("GetContent: %v", err)
	}
	if got.Type != ContentTypeImage || got.ImageFormat != "png" || !bytes.Equal(got.Image, pngBytes) {
		t.Fatalf("got %+v, want the user helper's PNG", got)
	}
}

// What SYSTEM reads today (text) keeps coming from SYSTEM: no IPC round trip.
func TestUserFallbackKeepsLocalReadWhenSystemCanRead(t *testing.T) {
	p, local, user, _, _ := newFallbackForTest()
	local.answer(Content{Type: ContentTypeText, Text: "hello"}, nil)
	user.answer(Content{Type: ContentTypeImage, Image: pngBytes, ImageFormat: "png"}, nil)

	got, err := p.GetContent()
	if err != nil || got.Type != ContentTypeText || got.Text != "hello" {
		t.Fatalf("got %+v, %v; want the local text", got, err)
	}
	if user.count() != 0 {
		t.Fatalf("user helper asked %d time(s) for a clipboard SYSTEM can read", user.count())
	}
}

// A clipboard SYSTEM failed to open is unknown, not empty: asking the user
// helper would not make it known, and the watcher must see the failure.
func TestUserFallbackPassesThroughLocalOpenFailure(t *testing.T) {
	p, local, user, _, _ := newFallbackForTest()
	openErr := errors.New("OpenClipboard: Access is denied.")
	local.answer(Content{}, openErr)

	if _, err := p.GetContent(); !errors.Is(err, openErr) {
		t.Fatalf("err = %v, want the local open failure", err)
	}
	if user.count() != 0 {
		t.Fatalf("user helper asked %d time(s) after a local open failure", user.count())
	}
}

// A format SYSTEM sees listed but fails to read is what the user helper is
// for too. The error is the real noContentError output, as the Windows
// provider returns it.
func TestUserFallbackReadsFormatSystemFailsToRead(t *testing.T) {
	p, local, user, _, _ := newFallbackForTest()
	local.answer(Content{}, noContentError(errors.New("GetClipboardData: Invalid clipboard format")))
	user.answer(Content{Type: ContentTypeImage, Image: pngBytes, ImageFormat: "png"}, nil)

	got, err := p.GetContent()
	if err != nil || !bytes.Equal(got.Image, pngBytes) {
		t.Fatalf("got %+v, %v; want the user helper's PNG", got, err)
	}
}

// When the user helper cannot settle it either, SYSTEM's read failure stands:
// the clipboard stays unknown rather than becoming "empty".
func TestUserFallbackKeepsSystemReadFailureWhenUserCannotHelp(t *testing.T) {
	for name, userErr := range map[string]error{
		"no user helper":    ErrUserClipboardUnavailable,
		"user sees nothing": ErrNoSupportedFormat,
		"user read failed":  errors.New("timed out"),
	} {
		t.Run(name, func(t *testing.T) {
			p, local, user, _, _ := newFallbackForTest()
			local.answer(Content{}, noContentError(errors.New("GetClipboardData failed")))
			user.answer(Content{}, userErr)

			_, err := p.GetContent()
			if err == nil || errors.Is(err, ErrNoSupportedFormat) {
				t.Fatalf("err = %v, want a read failure that is not ErrNoSupportedFormat", err)
			}
		})
	}
}

// noContentError keeps its message and stays out of ErrNoSupportedFormat,
// while marking itself as a listed-but-unreadable format.
func TestNoContentErrorMarksUnreadableFormat(t *testing.T) {
	cause := errors.New("GetClipboardData failed")
	err := noContentError(cause)
	if !errors.Is(err, ErrFormatUnreadable) || !errors.Is(err, cause) || errors.Is(err, ErrNoSupportedFormat) {
		t.Fatalf("errors.Is: unreadable=%v cause=%v noFormat=%v", errors.Is(err, ErrFormatUnreadable), errors.Is(err, cause), errors.Is(err, ErrNoSupportedFormat))
	}
	if err.Error() != "clipboard: read failed: GetClipboardData failed" {
		t.Fatalf("message = %q", err.Error())
	}
}

// The watcher polls every 500 ms. An image that stays on the clipboard must
// cross the IPC relay once per clipboard change, not once per poll.
func TestUserFallbackAsksOncePerClipboardChange(t *testing.T) {
	p, _, user, seq, _ := newFallbackForTest()
	user.answer(Content{Type: ContentTypeImage, Image: pngBytes, ImageFormat: "png"}, nil)

	for i := 0; i < 5; i++ {
		got, err := p.GetContent()
		if err != nil || !bytes.Equal(got.Image, pngBytes) {
			t.Fatalf("poll %d: got %+v, %v", i, got, err)
		}
	}
	if user.count() != 1 {
		t.Fatalf("user helper asked %d times for one clipboard state, want 1", user.count())
	}

	other := []byte("\x89PNG\r\n\x1a\nsecond-image")
	user.answer(Content{Type: ContentTypeImage, Image: other, ImageFormat: "png"}, nil)
	seq.bump()
	got, err := p.GetContent()
	if err != nil || !bytes.Equal(got.Image, other) {
		t.Fatalf("after a change: got %+v, %v; want the new image", got, err)
	}
	if user.count() != 2 {
		t.Fatalf("user helper asked %d times after one change, want 2", user.count())
	}
}

// The user helper seeing nothing readable either is a settled answer for that
// clipboard state: the watcher gets ErrNoSupportedFormat, so it can baseline.
func TestUserFallbackSettlesOnUserNoSupportedFormat(t *testing.T) {
	p, _, user, _, clock := newFallbackForTest()
	user.answer(Content{}, ErrNoSupportedFormat)

	for i := 0; i < 3; i++ {
		if _, err := p.GetContent(); !errors.Is(err, ErrNoSupportedFormat) {
			t.Fatalf("poll %d: err = %v, want ErrNoSupportedFormat", i, err)
		}
		clock.advance(time.Minute)
	}
	if user.count() != 1 {
		t.Fatalf("user helper asked %d times for one settled state, want 1", user.count())
	}
}

// No user helper in the session (login screen, user helper not running): what
// SYSTEM saw stands, exactly as before this change. It is asked again later,
// because a user helper can connect without the clipboard changing.
func TestUserFallbackWithoutUserHelperKeepsSystemAnswer(t *testing.T) {
	p, _, user, _, clock := newFallbackForTest()
	user.answer(Content{}, ErrUserClipboardUnavailable)

	if _, err := p.GetContent(); !errors.Is(err, ErrNoSupportedFormat) {
		t.Fatalf("err = %v, want SYSTEM's ErrNoSupportedFormat", err)
	}
	if _, err := p.GetContent(); !errors.Is(err, ErrNoSupportedFormat) {
		t.Fatalf("second poll err = %v", err)
	}
	if user.count() != 1 {
		t.Fatalf("asked %d times inside the retry interval, want 1", user.count())
	}

	clock.advance(fallbackRetryMin)
	user.answer(Content{Type: ContentTypeImage, Image: pngBytes, ImageFormat: "png"}, nil)
	got, err := p.GetContent()
	if err != nil || !bytes.Equal(got.Image, pngBytes) {
		t.Fatalf("after the retry interval: got %+v, %v; want the image", got, err)
	}
	if user.count() != 2 {
		t.Fatalf("asked %d times, want 2", user.count())
	}
}

// A relay that fails (timeout, user helper could not open the clipboard)
// leaves the clipboard unknown: the error must not read as "empty", or the
// watcher would baseline on it and later push the end user's pre-session copy.
func TestUserFallbackRelayFailureIsNotEmpty(t *testing.T) {
	p, _, user, _, clock := newFallbackForTest()
	user.answer(Content{}, errors.New("timed out waiting for the service"))

	_, err := p.GetContent()
	if err == nil || errors.Is(err, ErrNoSupportedFormat) {
		t.Fatalf("err = %v, want a read failure that is not ErrNoSupportedFormat", err)
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("err = %v, want the relay failure named", err)
	}

	// Retried after a backoff, without waiting for the clipboard to change.
	if _, err := p.GetContent(); err == nil {
		t.Fatal("second poll inside the backoff succeeded")
	}
	if user.count() != 1 {
		t.Fatalf("asked %d times inside the backoff, want 1", user.count())
	}
	clock.advance(fallbackRetryMin)
	user.answer(Content{Type: ContentTypeImage, Image: pngBytes, ImageFormat: "png"}, nil)
	if got, err := p.GetContent(); err != nil || !bytes.Equal(got.Image, pngBytes) {
		t.Fatalf("after the backoff: got %+v, %v", got, err)
	}
}

// An agent whose service predates the relay drops the request, so every ask
// times out. Consecutive failures back off further, so that state cannot keep
// the watcher blocked on a relay that will never answer.
func TestUserFallbackBacksOffOnRepeatedFailures(t *testing.T) {
	p, _, user, _, clock := newFallbackForTest()
	user.answer(Content{}, errors.New("timed out"))

	wait := fallbackRetryMin
	for i := 0; i < 8; i++ {
		_, _ = p.GetContent()
		clock.advance(wait / 2)
		_, _ = p.GetContent() // inside the backoff: no ask
		clock.advance(wait - wait/2)
		if wait < fallbackRetryMax {
			wait *= 2
			if wait > fallbackRetryMax {
				wait = fallbackRetryMax
			}
		}
	}
	if user.count() != 8 {
		t.Fatalf("asked %d times over 8 doubling backoffs, want 8", user.count())
	}
	if p.retryDelayLocked() != fallbackRetryMax {
		t.Fatalf("backoff = %v, want it capped at %v", p.retryDelayLocked(), fallbackRetryMax)
	}
}

// A clipboard change is always worth one ask, even mid-backoff.
func TestUserFallbackAsksAgainOnChangeDuringBackoff(t *testing.T) {
	p, _, user, seq, _ := newFallbackForTest()
	user.answer(Content{}, errors.New("timed out"))
	_, _ = p.GetContent()

	user.answer(Content{Type: ContentTypeImage, Image: pngBytes, ImageFormat: "png"}, nil)
	seq.bump()
	if got, err := p.GetContent(); err != nil || !bytes.Equal(got.Image, pngBytes) {
		t.Fatalf("got %+v, %v; want the image after the change", got, err)
	}
}

// Without a sequence number nothing tells a change from no change, so the
// relay is asked at most once per retry interval, whatever it answered.
func TestUserFallbackWithoutSequenceNumberRateLimits(t *testing.T) {
	p, _, user, seq, clock := newFallbackForTest()
	seq.ok = false
	user.answer(Content{Type: ContentTypeImage, Image: pngBytes, ImageFormat: "png"}, nil)

	for i := 0; i < 4; i++ {
		if got, err := p.GetContent(); err != nil || !bytes.Equal(got.Image, pngBytes) {
			t.Fatalf("poll %d: got %+v, %v", i, got, err)
		}
	}
	if user.count() != 1 {
		t.Fatalf("asked %d times inside one interval, want 1", user.count())
	}
	clock.advance(fallbackRetryMin)
	_, _ = p.GetContent()
	if user.count() != 2 {
		t.Fatalf("asked %d times after the interval, want 2", user.count())
	}
}

// The size caps hold on the relayed path too.
func TestUserFallbackRejectsOversizedImage(t *testing.T) {
	p, _, user, _, _ := newFallbackForTest()
	user.answer(Content{Type: ContentTypeImage, Image: make([]byte, MaxImageBytes+1), ImageFormat: "png"}, nil)

	_, err := p.GetContent()
	if err == nil || errors.Is(err, ErrNoSupportedFormat) {
		t.Fatalf("err = %v, want an oversize rejection", err)
	}
}

// Writes from the viewer stay on SYSTEM's clipboard, as before: a PNG written
// as SYSTEM reads back as the user.
func TestUserFallbackWritesLocally(t *testing.T) {
	p, local, user, _, _ := newFallbackForTest()
	in := Content{Type: ContentTypeImage, Image: pngBytes, ImageFormat: "png"}
	if err := p.SetContent(in); err != nil {
		t.Fatalf("SetContent: %v", err)
	}
	if len(local.set) != 1 || !bytes.Equal(local.set[0].Image, pngBytes) {
		t.Fatalf("local writes = %+v", local.set)
	}
	if user.count() != 0 {
		t.Fatal("a write asked the user helper to read")
	}
}

// The fallback exposes the window station's change count, so a watcher that
// detects changes by count keeps doing so in system-helper sessions.
func TestUserFallbackChangeCount(t *testing.T) {
	p, _, _, seq, _ := newFallbackForTest()
	if n, ok := p.ChangeCount(); !ok || n != 7 {
		t.Fatalf("ChangeCount = %d, %v; want 7, true", n, ok)
	}
	seq.bump()
	if n, _ := p.ChangeCount(); n != 8 {
		t.Fatalf("ChangeCount after a change = %d, want 8", n)
	}
}

// End to end through the watcher: SYSTEM never sees the PNG, the user helper
// does, and the viewer receives it as an image transfer after the baseline.
func TestWatchSendsImageReadThroughUserHelper(t *testing.T) {
	local := &fakeLocal{err: ErrNoSupportedFormat}
	user := &fakeUserProxy{err: ErrNoSupportedFormat} // empty at session start
	seq := &fakeSeq{n: 1, ok: true}
	p := newUserClipboardFallback(local, user.read, seq.read, time.Now)

	sender := &lockedSender{}
	c := newClipboardSyncWithSender(sender, p, Policy{HostToViewer: true, ViewerToHost: true})
	c.pollInterval = 5 * time.Millisecond
	c.Watch()
	defer c.Stop()

	// Let the watcher baseline on the empty clipboard.
	deadline := time.Now().Add(2 * time.Second)
	for user.count() < 1 {
		if time.Now().After(deadline) {
			t.Fatal("watcher never asked the user helper")
		}
		time.Sleep(time.Millisecond)
	}

	user.answer(Content{Type: ContentTypeImage, Image: pngBytes, ImageFormat: "png"}, nil)
	seq.bump()

	for sender.n() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the image never reached the viewer")
		}
		time.Sleep(time.Millisecond)
	}
	sender.mu.Lock()
	raw := sender.sent[0]
	sender.mu.Unlock()
	var got clipboardPayload
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatalf("payload: %v", err)
	}
	img, _ := base64.StdEncoding.DecodeString(got.Image)
	if got.Type != ContentTypeImage || got.ImageFormat != "png" || !bytes.Equal(img, pngBytes) {
		t.Fatalf("sent %+v, want the PNG", got)
	}
}

// With host→viewer off the watcher never polls, so the relay is never asked:
// the policy gate is unchanged by routing reads through the user helper.
func TestWatchWithHostToViewerOffNeverAsksUserHelper(t *testing.T) {
	local := &fakeLocal{err: ErrNoSupportedFormat}
	user := &fakeUserProxy{}
	seq := &fakeSeq{n: 1, ok: true}
	p := newUserClipboardFallback(local, user.read, seq.read, time.Now)

	c := newClipboardSyncWithSender(&lockedSender{}, p, Policy{HostToViewer: false, ViewerToHost: true})
	c.pollInterval = time.Millisecond
	c.Watch()
	time.Sleep(30 * time.Millisecond)
	c.Stop()
	if user.count() != 0 || local.gets != 0 {
		t.Fatalf("policy off, but user helper asked %d and local read %d time(s)", user.count(), local.gets)
	}
}
