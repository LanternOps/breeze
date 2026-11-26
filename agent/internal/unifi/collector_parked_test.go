package unifi

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/parked"
)

// #8318 D-1a: while the device is parked the loop makes no request at all —
// not the config fetch, not an upload — however often its timer or a wake
// fires, and it fetches as soon as the device is assigned.
func TestCollectorLoopSuspendedWhileParked(t *testing.T) {
	api := newCollectorAPI(t)
	api.assigned.Store(true) // the active cadence: the loop would fetch every 5 ms
	st := parked.New()
	st.ObserveBeat(true)
	waker := NewWaker()
	deps := api.deps(fastSchedule(), waker)
	deps.Parked = st
	startLoop(t, deps)

	for i := 0; i < 5; i++ {
		waker.Wake()
		time.Sleep(10 * time.Millisecond)
	}
	if got, posts := api.gets.Load(), api.posts.Load(); got != 0 || posts != 0 {
		t.Fatalf("requests while parked: %d fetches, %d uploads; want none", got, posts)
	}

	st.ObserveBeat(false)
	waitFor(t, "fetch on assignment", func() bool { return api.gets.Load() >= 1 })
	waitFor(t, "upload after assignment", func() bool { return api.posts.Load() >= 1 })
	waitFor(t, "active cadence after assignment", func() bool { return api.gets.Load() >= 3 })
}

// Parked mid-run: an active loop stops at its next timer.
func TestCollectorLoopStopsWhenParkedMidRun(t *testing.T) {
	api := newCollectorAPI(t)
	api.assigned.Store(true)
	st := parked.New()
	deps := api.deps(fastSchedule(), NewWaker())
	deps.Parked = st
	startLoop(t, deps)

	waitFor(t, "fetches before parking", func() bool { return api.gets.Load() >= 2 })
	st.NoteRefusal()
	time.Sleep(20 * time.Millisecond) // let an in-flight round finish
	before := api.gets.Load()
	time.Sleep(60 * time.Millisecond) // 12 active intervals
	if got := api.gets.Load(); got != before {
		t.Fatalf("fetches while parked: %d -> %d, want none", before, got)
	}
}
