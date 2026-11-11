package clipboard

import (
	"errors"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

var fallbackLog = logging.L("clipboard.userfallback")

// Retry bounds for a user-helper read that gave no settled answer (no user
// helper, timeout, read failure). Consecutive failures double the wait, so an
// agent service that predates the relay, and drops every request, cannot keep
// the watcher blocked on asks that will never be answered.
const (
	fallbackRetryMin = 5 * time.Second
	fallbackRetryMax = time.Minute
)

// userClipboardFallback is the clipboard of a desktop session hosted by the
// Windows system helper (#8393). That helper runs as SYSTEM in the user's
// session: it reads CF_UNICODETEXT, but registered formats the logged-on user
// copied (PNG, JFIF, Rich Text Format) are unreadable to it. In the lab,
// EnumClipboardFormats lists PNG while IsClipboardFormatAvailable says it is
// absent, so SYSTEM's read ends in ErrNoSupportedFormat and a copied image
// never reached the viewer.
//
// Reads go to SYSTEM's own clipboard first, so everything that worked before
// takes the same path. Only when SYSTEM finds no format it can read, or fails
// to read one it sees listed (ErrFormatUnreadable), is the user-role helper
// asked, through the service. A settled answer (content, or nothing readable)
// is kept until the window station's sequence number moves; the watcher polls
// every 500 ms, and an image left on the clipboard must not cross two IPC hops
// on every poll. Other answers, and every answer when the sequence number is
// unavailable, are re-asked on a backoff (fallbackRetryMin..fallbackRetryMax).
// Writes stay on SYSTEM's clipboard; the user reads those back.
type userClipboardFallback struct {
	local    Provider
	readUser func() (Content, error)
	seq      func() (uint64, bool)
	now      func() time.Time

	mu       sync.Mutex
	cached   *fallbackAnswer
	failures int    // consecutive unsettled answers, for the backoff
	lastErr  string // last relay outcome logged, to log changes only
}

// fallbackAnswer is what the user helper said about one clipboard state.
type fallbackAnswer struct {
	seq     uint64
	seqOK   bool
	content Content
	err     error
	settled bool      // valid until the sequence number moves
	retryAt time.Time // otherwise valid until then
}

// NewUserClipboardFallback returns the clipboard provider for a session hosted
// by the Windows system helper. local is SYSTEM's own clipboard, readUser reads
// through the user-role helper, and seq is the clipboard sequence number.
func NewUserClipboardFallback(local Provider, readUser func() (Content, error), seq func() (uint64, bool)) Provider {
	return newUserClipboardFallback(local, readUser, seq, time.Now)
}

func newUserClipboardFallback(local Provider, readUser func() (Content, error), seq func() (uint64, bool), now func() time.Time) *userClipboardFallback {
	return &userClipboardFallback{local: local, readUser: readUser, seq: seq, now: now}
}

func (p *userClipboardFallback) GetContent() (Content, error) {
	// Sampled before any read, so a cached answer is never tagged with a newer
	// state than the one it describes: a change after this shows up as a new
	// number on the next poll.
	seq, seqOK := p.seq()
	content, err := p.local.GetContent()
	if !errors.Is(err, ErrNoSupportedFormat) && !errors.Is(err, ErrFormatUnreadable) {
		// SYSTEM read it, or failed to open the clipboard (which a read through
		// the user helper would not explain). Either way the cached image, if
		// any, describes an older state.
		p.mu.Lock()
		p.cached = nil
		p.mu.Unlock()
		return content, err
	}
	return p.readThroughUser(seq, seqOK, err)
}

func (p *userClipboardFallback) readThroughUser(seq uint64, seqOK bool, localErr error) (Content, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := p.now()
	if a := p.cached; a != nil && a.seqOK == seqOK && (!seqOK || a.seq == seq) {
		if (a.settled && seqOK) || now.Before(a.retryAt) {
			return a.content, a.err
		}
	}

	content, err := p.readUser()
	answer := &fallbackAnswer{seq: seq, seqOK: seqOK}
	switch {
	case err == nil:
		if vErr := ValidateContent(content); vErr != nil {
			answer.err = vErr
		} else {
			answer.content = content
			answer.settled = true
		}
	case errors.Is(err, ErrNoSupportedFormat):
		// Nothing readable as the user either. If SYSTEM saw a format it
		// failed to read, its failure stands: the clipboard stays unknown
		// rather than becoming empty.
		answer.err = err
		if !errors.Is(localErr, ErrNoSupportedFormat) {
			answer.err = localErr
		}
		answer.settled = true
	case errors.Is(err, ErrUserClipboardUnavailable):
		// Nobody else to ask: what SYSTEM saw stands, as before #8393.
		answer.err = localErr
	default:
		// The clipboard is unknown. This must not read as empty, or the watcher
		// would baseline on it and later push what the end user had copied
		// before the session.
		answer.err = err
	}

	if answer.settled {
		p.failures = 0
	} else {
		p.failures++
	}
	answer.retryAt = now.Add(p.retryDelayLocked())
	p.cached = answer
	p.logOutcomeLocked(err)
	return answer.content, answer.err
}

// retryDelayLocked is how long an answer stays valid when the clipboard has
// not changed: fallbackRetryMin, doubled per consecutive unsettled answer, up
// to fallbackRetryMax.
func (p *userClipboardFallback) retryDelayLocked() time.Duration {
	d := fallbackRetryMin
	for i := 1; i < p.failures && d < fallbackRetryMax; i++ {
		d *= 2
	}
	if d > fallbackRetryMax {
		d = fallbackRetryMax
	}
	return d
}

// logOutcomeLocked logs a relay failure when it starts or changes, not on
// every retry. A settled answer is the normal case and stays quiet.
func (p *userClipboardFallback) logOutcomeLocked(err error) {
	msg := ""
	if err != nil && !errors.Is(err, ErrNoSupportedFormat) {
		msg = err.Error()
	}
	if msg == p.lastErr {
		return
	}
	p.lastErr = msg
	switch {
	case msg == "":
		fallbackLog.Info("clipboard read through user helper recovered")
	case errors.Is(err, ErrUserClipboardUnavailable):
		// Expected at the sign-in screen, where no user helper runs.
		fallbackLog.Info("no user helper to read the clipboard through; only what SYSTEM can read reaches the viewer",
			"retryIn", p.retryDelayLocked().String())
	default:
		fallbackLog.Warn("clipboard read through user helper failed; images the user copies may not reach the viewer",
			"error", msg, "retryIn", p.retryDelayLocked().String())
	}
}

func (p *userClipboardFallback) SetContent(content Content) error {
	return p.local.SetContent(content)
}

// ChangeCount is the window station's clipboard sequence number, so a watcher
// that detects changes by count keeps doing so for these sessions.
func (p *userClipboardFallback) ChangeCount() (uint64, bool) {
	return p.seq()
}
