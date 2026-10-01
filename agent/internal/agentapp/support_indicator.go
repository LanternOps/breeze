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
// re-checked this often even if no change was signalled, so a stop path that
// does not poke (none is known) still hides it within a second.
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
	show   func(label string, startedAtMs int64)
	hide   func()
	say    func(string)
	now    func() time.Time
	kick   chan struct{} // capacity 1: a pending "look again"

	// Owned by the goroutine calling reconcile/run.
	shown     bool
	label     string
	startedMs int64
}

func newSupportIndicator(hb *heartbeat.Heartbeat) *supportIndicator {
	return &supportIndicator{
		active: hb.SupportDesktopActive,
		viewer: hb.SupportViewer,
		show: func(label string, startedAtMs int64) {
			userhelper.ShowSessionBanner(supportIndicatorSessionID, label, startedAtMs)
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

func supportViewerName(viewer string) string {
	if viewer == "" {
		return "A technician"
	}
	return viewer
}

// reconcile makes the indicator match the current facts.
func (i *supportIndicator) reconcile() {
	if !i.active() {
		if i.shown {
			i.hide()
			i.shown = false
			i.label = ""
			i.say("\nYour technician is no longer viewing your screen.")
		}
		return
	}
	name := supportViewerName(i.viewer())
	label := name + " is viewing your screen"
	if !i.shown {
		i.startedMs = i.now().UnixMilli()
		i.show(label, i.startedMs)
		i.shown = true
		i.label = label
		i.say("\n" + label + ".\nTo stop sharing, close this window or press Ctrl+C.")
		return
	}
	if label != i.label {
		// Relabel in place, keeping the session clock.
		i.show(label, i.startedMs)
		i.label = label
	}
}

// run reconciles on every poke and every poll tick until ctx ends, then hides
// the indicator if it is up.
func (i *supportIndicator) run(ctx context.Context, poll time.Duration) {
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	i.reconcile()
	for {
		select {
		case <-ctx.Done():
			if i.shown {
				i.hide()
				i.shown = false
			}
			return
		case <-i.kick:
			i.reconcile()
		case <-ticker.C:
			i.reconcile()
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
		defer func() {
			if r := recover(); r != nil {
				log.Error("panic in Quick Support viewing indicator", "panic", fmt.Sprint(r))
			}
		}()
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
