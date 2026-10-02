package agentapp

import (
	"context"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/heartbeat"
	"github.com/breeze-rmm/agent/internal/userhelper"
)

// supportIndicatorSessionID owns the on-screen pill in this process. A Quick
// Support client serves one support session and draws at most one pill.
const supportIndicatorSessionID = "quick-support"

// supportIndicatorPoll is the safety net behind the pokes: the indicator is
// re-checked this often even without a poke. Every WebSocket and WebRTC start
// and stop path pokes it; the poll also retries a pill that failed to appear.
const supportIndicatorPoll = time.Second

// supportIndicator is the Quick Support "a technician is viewing your screen"
// indicator (#7684): an always-on-top pill (the same one the installed
// agent's helper shows in notify mode) plus a line in this console window,
// which is the End control ("close this window or press Ctrl+C").
//
// It draws from facts, not events: active() and viewer() are read on every
// reconcile, and pokes only say "look again". That makes it correct for every
// start and stop path — End, session end, revocation, window close, an
// overtaken start — without tracking any of them, and immune to pokes
// arriving out of order.
type supportIndicator struct {
	active func() bool
	viewer func() string
	show   func(label string, startedAtMs int64) bool // reports whether the pill is up
	hide   func()
	say    func(string)
	now    func() time.Time
	kick   chan struct{} // capacity 1: a pending "look again"

	// Owned by the goroutine calling reconcile/run.
	announced bool   // the console said viewing started, and not yet that it ended
	pillUp    bool   // the pill is on screen
	pillLabel string // what the pill says
	warned    bool   // a failed pill was logged for this viewing
	startedMs int64
}

func newSupportIndicator(hb *heartbeat.Heartbeat) *supportIndicator {
	return &supportIndicator{
		active: hb.SupportDesktopActive,
		viewer: hb.SupportViewer,
		show: func(label string, startedAtMs int64) bool {
			return userhelper.ShowSessionBanner(supportIndicatorSessionID, label, startedAtMs)
		},
		hide: func() { userhelper.HideSessionBanner(supportIndicatorSessionID) },
		say:  func(s string) { fmt.Println(s) },
		now:  time.Now,
		kick: make(chan struct{}, 1),
	}
}

// poke asks the worker to re-check. Never blocks: it is called with the
// stream manager's lock held.
func (i *supportIndicator) poke() {
	select {
	case i.kick <- struct{}{}:
	default: // a re-check is already pending; it will see this change too
	}
}

// supportViewingSuffix ends every indicator label.
const supportViewingSuffix = " is viewing your screen"

func supportViewerName(viewer string) string {
	if viewer == "" {
		return "A technician"
	}
	return viewer
}

// supportViewingLabel is the pill and console text for viewer. The name comes
// from the server: control and bidirectional formatting characters are
// removed, and a long name is shortened (on a character boundary) so the
// sentence always fits the banner's label limit whole.
func supportViewingLabel(viewer string) string {
	name := userhelper.DisplayNameWithin(viewer, userhelper.MaxBannerLabelBytes-len(supportViewingSuffix))
	return supportViewerName(name) + supportViewingSuffix
}

// reconcile makes the indicator match the current facts. The console line
// is announced once per viewing; the pill is retried until it is up (window
// creation can fail or time out), so it is never recorded as shown when it
// is not.
func (i *supportIndicator) reconcile() {
	if !i.active() {
		if i.pillUp {
			i.hide()
			i.pillUp = false
			i.pillLabel = ""
		}
		if i.announced {
			i.announced = false
			i.warned = false
			i.say("\nYour technician is no longer viewing your screen.")
		}
		return
	}
	label := supportViewingLabel(i.viewer())
	if !i.announced {
		i.startedMs = i.now().UnixMilli()
		i.announced = true
		i.say("\n" + label + ".\nTo stop sharing, close this window or press Ctrl+C.")
	}
	if i.pillUp && label == i.pillLabel {
		return
	}
	// Show, retry a failed show, or relabel in place keeping the clock.
	if i.show(label, i.startedMs) {
		i.pillUp = true
		i.pillLabel = label
		return
	}
	if !i.warned {
		i.warned = true
		log.Warn("Quick Support viewing indicator could not be shown; retrying", "label", label)
	}
}

// safeReconcile is one reconcile that cannot take the worker down with it:
// a panic is logged and the next poke or poll tries again.
func (i *supportIndicator) safeReconcile() {
	defer func() {
		if r := recover(); r != nil {
			log.Error("panic in Quick Support viewing indicator; will retry", "panic", fmt.Sprint(r))
		}
	}()
	i.reconcile()
}

// run reconciles on every poke and every poll tick until ctx ends, then hides
// the pill if it is up.
func (i *supportIndicator) run(ctx context.Context, poll time.Duration) {
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	i.safeReconcile()
	for {
		select {
		case <-ctx.Done():
			if i.pillUp {
				i.hide()
				i.pillUp = false
			}
			return
		case <-i.kick:
			i.safeReconcile()
		case <-ticker.C:
			i.safeReconcile()
		}
	}
}

// startSupportIndicator wires the indicator to the heartbeat and runs it.
// The returned stop hides the indicator and waits for the worker to exit.
func startSupportIndicator(hb *heartbeat.Heartbeat) (stop func()) {
	ind := newSupportIndicator(hb)
	hb.SetSupportViewingObserver(ind.poke)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		ind.run(ctx, supportIndicatorPoll)
	}()
	return func() {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			// Never hold up teardown: a window-close gives ~5 s of grace and
			// the pill dies with the process anyway.
			log.Warn("Quick Support viewing indicator did not stop in time")
		}
	}
}
