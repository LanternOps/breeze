package clipboard

import (
	"encoding/json"
	"errors"
	"log"
	"time"
)

const defaultPollInterval = 500 * time.Millisecond

var (
	// After an injected copy chord the watcher reads at once, then again
	// every copyChordRetryInterval until the clipboard changes or
	// copyChordBurst has passed. The app copies when it processes the
	// keystroke, which is usually within tens of milliseconds; the regular
	// poll would report it up to defaultPollInterval later, after a quick
	// paste may already have pushed the viewer's older clipboard (#11310
	// row 4).
	// Variables so tests on a loaded host can widen the burst.
	copyChordRetryInterval = 25 * time.Millisecond
	copyChordBurst         = 400 * time.Millisecond
	// Without a change counter every read is a full read (on Linux, an xclip
	// process per format), so the burst reads less often.
	copyChordRetryIntervalNoCounter = 100 * time.Millisecond
)

const (
	// selfWriteEchoWindow: a change whose content is the viewer write just
	// applied is taken as that write, not a new copy, for this long. It covers
	// a change counter that moves again after the write (a clipboard history
	// tool re-rendering it) and a poll that raced the write.
	selfWriteEchoWindow = time.Second
)

// selfWrite is the last viewer write applied to the host clipboard.
type selfWrite struct {
	count   uint64 // ChangeCount right after the write
	counted bool
	hash    [32]byte
	at      time.Time
}

// watchState is the watcher's view of the host clipboard. Watcher goroutine
// only.
type watchState struct {
	baselined  bool
	haveCount  bool
	lastCount  uint64
	lastErrMsg string
}

// take records the change count of a read whose outcome is settled.
func (st *watchState) take(count uint64, counted bool) {
	st.haveCount = counted
	st.lastCount = count
}

func (c *ClipboardSync) Watch() {
	if c.provider == nil {
		return
	}

	// Host→viewer streaming disabled by policy: never poll or forward the host
	// clipboard. This is the silent-exfiltration guard — without it, whatever
	// the end user copies (passwords, MFA codes, secrets) streams to the
	// operator within one defaultPollInterval. Finding #7.
	if !c.policy.HostToViewer {
		return
	}

	interval := c.pollInterval
	if interval <= 0 {
		interval = defaultPollInterval
	}

	ticker := time.NewTicker(interval)
	go func() {
		defer ticker.Stop()
		var st watchState
		// The baseline is taken at once, so a copy chord in the first poll
		// interval is a change after it rather than the baseline itself.
		c.pollOnce(&st)
		var retry <-chan time.Time
		var burstEnd time.Time
		for {
			select {
			case <-ticker.C:
				if c.pollOnce(&st) {
					retry = nil // the change the burst was waiting for
				}
			case <-c.nudge:
				burstEnd = time.Now().Add(copyChordBurst)
				retry = c.burstStep(&st, burstEnd)
			case <-retry:
				retry = c.burstStep(&st, burstEnd)
			case <-c.stop:
				return
			}
		}
	}()
}

// burstStep is one read of a copy chord's burst. It returns when to read
// again, or nil once the change was reported or the burst is over.
func (c *ClipboardSync) burstStep(st *watchState, end time.Time) <-chan time.Time {
	if c.pollOnce(st) || !time.Now().Before(end) {
		return nil
	}
	if _, counts := c.provider.(ChangeCounter); !counts {
		return time.After(copyChordRetryIntervalNoCounter)
	}
	return time.After(copyChordRetryInterval)
}

// CopyChordInjected tells the watcher that a copy chord was just injected on
// the host, so it reads the clipboard now instead of at the next poll. Never
// blocks; a no-op when the watcher is not running.
func (c *ClipboardSync) CopyChordInjected() {
	select {
	case c.nudge <- struct{}{}:
	default:
	}
}

func (c *ClipboardSync) changeCount() (uint64, bool) {
	if cc, ok := c.provider.(ChangeCounter); ok {
		return cc.ChangeCount()
	}
	return 0, false
}

// beginSelfWrite marks a viewer write about to be applied, so a poll that
// reads it before noteSelfWrite records its count still takes it as the
// viewer's write (by hash, within selfWriteEchoWindow).
func (c *ClipboardSync) beginSelfWrite(fp [32]byte) {
	c.mu.Lock()
	c.self = selfWrite{hash: fp, at: time.Now()}
	c.mu.Unlock()
}

// noteSelfWrite records a viewer write just applied to the host clipboard, so
// the watcher does not report it back as a host change.
//
// A host copy that lands between the write and the ChangeCount read here is
// counted as part of the write and not reported. That window is the length of
// one system call.
func (c *ClipboardSync) noteSelfWrite(fp [32]byte) {
	count, counted := c.changeCount()
	c.mu.Lock()
	c.lastSentHash = fp
	c.self = selfWrite{count: count, counted: counted, hash: fp, at: time.Now()}
	c.mu.Unlock()
}

func (c *ClipboardSync) isSelfWriteCount(count uint64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.self.at.IsZero() && c.self.counted && c.self.count == count
}

func (c *ClipboardSync) isEcho(count uint64, hash [32]byte) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.self.at.IsZero() {
		return false
	}
	if c.self.counted && c.self.count == count {
		return true
	}
	return c.self.hash == hash && time.Since(c.self.at) < selfWriteEchoWindow
}

// pollOnce reads the host clipboard once if it may have changed, and reports
// whether it told the viewer about a change (content or notice).
//
// With a change counter, every change is reported (except a copy of the
// viewer's own write within selfWriteEchoWindow of it): a re-copy of
// identical content as content, and content the agent cannot carry (a file, an image
// format it cannot read, more than the size cap) as an "unsupported" notice,
// so the viewer knows the remote clipboard is now newer than its own. Without
// one (Linux, macOS built without cgo), a change is new content by hash, as
// before #11310.
func (c *ClipboardSync) pollOnce(st *watchState) bool {
	count, counted := c.changeCount()
	if counted && st.haveCount && count == st.lastCount {
		return false
	}
	if counted && st.baselined && c.isSelfWriteCount(count) {
		st.take(count, counted)
		return false
	}
	prevCounted := st.baselined && st.haveCount
	// A change that could not be reported is not consumed: restoring the
	// previous count makes the next poll try again.
	prevCount := st.lastCount
	retryLater := func() bool {
		st.lastCount = prevCount
		return false
	}

	content, err := c.provider.GetContent()
	if err != nil {
		// Only log when the error message changes to avoid spam.
		if msg := err.Error(); msg != st.lastErrMsg {
			log.Printf("[clipboard] failed to get content: %v", err)
			st.lastErrMsg = msg
		}
		if !errors.Is(err, ErrNoSupportedFormat) {
			// A failure to open the clipboard says nothing about what it
			// holds: the count is not taken, so the next poll reads again.
			return false
		}
		// Empty (or unreadable formats only) at session start: that is the
		// baseline, so the first copy after it is sent.
		wasBaselined := st.baselined
		st.baselined = true
		st.take(count, counted)
		if !wasBaselined || !counted || !prevCounted {
			return false
		}
		if !c.sendChangeNotice(errors.Is(err, ErrClipboardEmpty)) && c.peerChangeNotices.Load() {
			return retryLater()
		}
		return true
	}
	st.lastErrMsg = ""
	hash := fingerprint(content)

	// The first readable clipboard is what the end user had before the
	// session. Remember it instead of sending it: pushing it would overwrite
	// the technician's clipboard just for connecting, with whatever the end
	// user last copied. A viewer→host write that landed before this poll has
	// already set the hash; keep it.
	if !st.baselined {
		st.baselined = true
		st.take(count, counted)
		c.mu.Lock()
		if c.lastSentHash == ([32]byte{}) {
			c.lastSentHash = hash
		}
		c.mu.Unlock()
		return false
	}
	st.take(count, counted)

	if counted && prevCounted {
		if c.isEcho(count, hash) {
			return false
		}
		if ValidateContent(content) != nil {
			// Too large to carry: the viewer still learns the remote changed.
			if !c.sendChangeNotice(false) && c.peerChangeNotices.Load() {
				return retryLater()
			}
			return true
		}
		if err := c.Send(content); err != nil {
			log.Printf("[clipboard] failed to send content: %v", err)
			return retryLater()
		}
		return true
	}

	c.mu.Lock()
	shouldSend := hash != c.lastSentHash
	c.mu.Unlock()
	if !shouldSend {
		return false
	}
	if err := c.Send(content); err != nil {
		log.Printf("[clipboard] failed to send content: %v", err)
		return false
	}
	return true
}

// sendChangeNotice tells a viewer that asked for it that the host clipboard
// changed to something the agent does not send: content it cannot carry, or
// nothing at all (empty). The next copy of what was last sent is then a change
// again, whatever path detects it.
func (c *ClipboardSync) sendChangeNotice(empty bool) bool {
	c.mu.Lock()
	c.lastSentHash = [32]byte{}
	c.mu.Unlock()
	if c.sender == nil || !c.peerChangeNotices.Load() {
		return false
	}
	body := map[string]any{"type": "unsupported", "seq": c.changeSeq.Add(1)}
	if empty {
		body["empty"] = true
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return false
	}
	if err := c.sender.SendText(string(raw)); err != nil {
		log.Printf("[clipboard] failed to send change notice: %v", err)
		return false
	}
	return true
}
