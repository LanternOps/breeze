package securefs

import (
	"errors"
	"io/fs"
	"testing"
	"time"
)

// An absence that lasts past the recheck window is only excused when the
// caller can show the lookups contradicted a publish that COMPLETED inside the
// absence (#6176), and even then only if the destination reappears within
// absenceCeiling. Anything else stays persistent.
func TestWatchForAbsenceExcusing(t *testing.T) {
	miss := fs.ErrNotExist
	const recheck = 100 * time.Millisecond
	dense := func(n int) []timedStep { return repeatStep(timedStep{stall: time.Millisecond, err: miss}, n) }
	persistentThenHeals := append(append([]timedStep{{err: miss}}, dense(150)...), timedStep{err: nil}, timedStep{err: nil})
	persistentForever := append([]timedStep{{err: miss}}, dense(5000)...)
	tests := []struct {
		name           string
		script         []timedStep
		excuse         bool
		wantExcused    int
		wantPersistent bool
	}{
		{name: "an excused absence that heals is not persistent", script: persistentThenHeals, excuse: true, wantExcused: 1},
		{name: "an absence the excuse declines is persistent", script: persistentThenHeals, excuse: false, wantPersistent: true},
		{name: "an excused absence that never heals is persistent", script: persistentForever, excuse: true, wantPersistent: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clock := &fakeAbsenceClock{t: time.Unix(1_800_000_000, 0)}
			start := clock.t
			stop := make(chan struct{})
			var gotFirst, gotLast time.Time
			excuse := func(first, last time.Time) (string, bool) {
				gotFirst, gotLast = first, last
				return "contradicted by a completed publish", tc.excuse
			}
			report := watchForAbsenceExcusing(timedProbe(clock, tc.script, stop), stop, recheck, clock.clock(), excuse)
			if len(report.excused) != tc.wantExcused {
				t.Fatalf("excused = %v, want %d", report.excused, tc.wantExcused)
			}
			if gotPersistent := report.persistent != nil; gotPersistent != tc.wantPersistent {
				t.Fatalf("persistent = %v, want %v", report.persistent, tc.wantPersistent)
			}
			if tc.wantPersistent && !errors.Is(report.persistent, fs.ErrNotExist) {
				t.Fatalf("persistent error must be the not-exist answer, got %v", report.persistent)
			}
			if report.transient != 0 {
				t.Fatalf("transient = %d, want 0", report.transient)
			}
			// The excuse is asked about the span the watcher actually saw
			// missing: from when the first missing probe was issued (the start
			// of the fake clock) to when the last missing probe was issued,
			// which is at least the recheck window later.
			if !gotFirst.Equal(start) {
				t.Fatalf("excuse got firstMiss %v, want %v", gotFirst, start)
			}
			if gotLast.Sub(gotFirst) < recheck {
				t.Fatalf("excuse got lastMiss only %v after firstMiss, want >= %v", gotLast.Sub(gotFirst), recheck)
			}
		})
	}
}

// publishesCompletedWithin is the evidence the Windows concurrency test uses to
// excuse an absence: a successful publish that RETURNED strictly between the
// first and last missing probe means a lookup issued after that rename's own
// post-condition held still missed.
func TestPublishesCompletedWithin(t *testing.T) {
	t0 := time.Unix(1_800_000_000, 0)
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }
	log := []publishRecord{
		{start: at(0), end: at(5)},                                      // ended before the absence began
		{start: at(8), end: at(20)},                                     // ended inside
		{start: at(30), end: at(40), err: errors.New("publish failed")}, // failed: proves nothing
		{start: at(90), end: at(130)},                                   // still running at lastMiss
	}
	tests := []struct {
		name        string
		first, last time.Time
		want        int
	}{
		{name: "publish returning inside the absence counts", first: at(10), last: at(110), want: 1},
		{name: "publish returning before the first miss does not", first: at(21), last: at(110), want: 0},
		{name: "publish returning after the last miss does not", first: at(10), last: at(19), want: 0},
		{name: "failed publishes never count", first: at(25), last: at(60), want: 0},
		{name: "boundaries are exclusive", first: at(20), last: at(130), want: 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := publishesCompletedWithin(log, tc.first, tc.last); got != tc.want {
				t.Fatalf("publishesCompletedWithin = %d, want %d", got, tc.want)
			}
		})
	}
}

// renamesSpanning is the evidence for the in-flight excuse (#8491): a rename
// SYSCALL that was entered before the first missing probe and had not returned
// when the last one was issued. A gap opened outside every rename syscall (a
// delete or rename-away before the rename, however long) never satisfies it.
func TestRenamesSpanning(t *testing.T) {
	t0 := time.Unix(1_800_000_000, 0)
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }
	log := []renameCall{
		{start: at(0), end: at(5), done: true, class: 65},                 // 0: returned before the absence
		{start: at(8), end: at(150), done: true, class: 65},               // 1: spans [10,110]
		{start: at(9), class: 10},                                         // 2: still running when asked
		{start: at(12), end: at(200), done: true, class: 65},              // 3: entered after the first miss
		{start: at(1), end: at(60), done: true, class: 65},                // 4: returned inside the absence
		{start: at(2), end: at(300), done: true, class: 65, failed: true}, // 5: failed: proves nothing
	}
	tests := []struct {
		name        string
		first, last time.Time
		want        []int // indexes into log
	}{
		{name: "renames entered before and still running after the absence count", first: at(10), last: at(110), want: []int{1, 2}},
		{name: "a rename entered at or after the first miss does not", first: at(9), last: at(110), want: []int{1}},
		{name: "a rename that returned before the last miss does not", first: at(10), last: at(151), want: []int{2}},
		{name: "no rename in flight at the first miss excuses nothing", first: at(0), last: at(110), want: nil},
		{name: "boundaries are exclusive", first: at(9), last: at(150), want: nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := renamesSpanning(log, tc.first, tc.last)
			if len(got) != len(tc.want) {
				t.Fatalf("renamesSpanning = %+v, want indexes %v", got, tc.want)
			}
			for i, idx := range tc.want {
				if got[i] != log[idx] {
					t.Fatalf("renamesSpanning[%d] = %+v, want %+v", i, got[i], log[idx])
				}
			}
		})
	}
}
