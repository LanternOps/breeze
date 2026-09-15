package heartbeat

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/desktopfence"
)

// W05: the fence survives an agent restart and refuses starts it has no
// durable knowledge of until the control plane has echoed the session's
// current generation and phase (sync-on-unknown).

func newDurableFence(t *testing.T, path string) *desktopFence {
	t.Helper()
	f := &desktopFence{}
	f.attachStore(desktopfence.NewStore(path))
	return f
}

func liveSync(gen int64) desktopFenceSyncInput {
	return desktopFenceSyncInput{Generation: gen, HasGeneration: true}
}

// syncTest applies an answer the way the agent does: a waiter is registered
// for the nonce before the renew goes out, so the answer is the one this
// process asked for.
func syncTest(f *desktopFence, sessionID string, in desktopFenceSyncInput) {
	in.Nonce = "test-nonce"
	ch := f.subscribeSync(sessionID, in.Nonce)
	defer f.unsubscribeSync(sessionID, ch)
	f.noteSync(sessionID, in)
}

func TestDesktopFenceUnknownSessionNeedsSync(t *testing.T) {
	var f desktopFence
	d := f.admitStart("s1", desktopStartFenceInput{Generation: 3, HasGeneration: true, CommandID: "c"})
	if d.Admitted || !d.NeedsSync || d.Reason != desktopFenceReasonUnsynced {
		t.Fatalf("a start for a session the fence has never seen must ask for a sync, got %#v", d)
	}
	// Until the sync lands the answer stays the same — the fence never "learns"
	// from a refused start.
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 3, HasGeneration: true, CommandID: "c"}); !d.NeedsSync {
		t.Fatalf("second attempt before sync must still need a sync, got %#v", d)
	}
}

func TestDesktopFenceSyncAdmitsServerGenerationAndRefusesBelow(t *testing.T) {
	var f desktopFence
	syncTest(&f, "s1", liveSync(5))
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 4, HasGeneration: true, CommandID: "stale"}); d.Admitted || d.Reason != desktopFenceReasonSuperseded {
		t.Fatalf("a start below the server's current generation is stale and must be refused, got %#v", d)
	}
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 5, HasGeneration: true, CommandID: "live"}); !d.Admitted {
		t.Fatalf("the start AT the server's current generation is the live intent and must be admitted, got %#v", d)
	}
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 5, HasGeneration: true, CommandID: "other"}); d.Admitted {
		t.Fatal("a different command at the admitted generation must be refused")
	}
}

func TestDesktopFenceSyncTerminalPhaseTombstones(t *testing.T) {
	var f desktopFence
	syncTest(&f, "s1", desktopFenceSyncInput{Generation: 6, HasGeneration: true, Terminal: true})
	for _, gen := range []int64{5, 6, 7} {
		if d := f.admitStart("s1", desktopStartFenceInput{Generation: gen, HasGeneration: true, CommandID: "c"}); d.Admitted || d.Reason != desktopFenceReasonTerminal {
			t.Fatalf("generation %d after a terminal-phase sync must be refused as terminal, got %#v", gen, d)
		}
	}
}

// An old API answers renewals without a generation. That is still the server
// confirming the session is live, so the start is admitted — at W04-level
// (in-memory) protection, exactly what the fleet has before this wave.
func TestDesktopFenceLegacySyncAdmits(t *testing.T) {
	var f desktopFence
	syncTest(&f, "s1", desktopFenceSyncInput{})
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 2, HasGeneration: true, CommandID: "c"}); !d.Admitted {
		t.Fatalf("legacy sync must admit, got %#v", d)
	}
}

func TestDesktopFenceSyncNeverLowersHighWater(t *testing.T) {
	var f desktopFence
	syncTest(&f, "s1", liveSync(3))
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 9, HasGeneration: true, CommandID: "c"}); !d.Admitted {
		t.Fatalf("setup: %#v", d)
	}
	// A late/reordered renewal answer echoing an older generation must not
	// re-open anything below the high-water mark.
	syncTest(&f, "s1", liveSync(3))
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 8, HasGeneration: true, CommandID: "late"}); d.Admitted {
		t.Fatal("sync echoing an older generation must not lower the high-water mark")
	}
}

func TestDesktopFenceRestartReloadsTombstone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fence.json")
	first := newDurableFence(t, path)
	first.noteStop("s1", desktopStopFenceInput{Generation: 4, HasGeneration: true})

	// "Restart": a brand-new fence over the same file, nothing in memory.
	second := newDurableFence(t, path)
	d := second.admitStart("s1", desktopStartFenceInput{Generation: 3, HasGeneration: true, CommandID: "replayed"})
	if d.Admitted || d.Reason != desktopFenceReasonTerminal {
		t.Fatalf("a replayed start after restart must hit the durable tombstone, got %#v", d)
	}
}

// A loaded non-terminal entry is knowledge, not certification: its high-water
// mark holds, but a start above it still needs one in-process sync — the file
// may be valid yet stale (a terminal whose write failed before the restart).
func TestDesktopFenceRestartReloadsHighWaterButRequiresSync(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fence.json")
	first := newDurableFence(t, path)
	syncTest(first, "s1", liveSync(1))
	if d := first.admitStart("s1", desktopStartFenceInput{Generation: 7, HasGeneration: true, CommandID: "c7"}); !d.Admitted {
		t.Fatalf("setup: %#v", d)
	}

	second := newDurableFence(t, path)
	if d := second.admitStart("s1", desktopStartFenceInput{Generation: 7, HasGeneration: true, CommandID: "c7"}); d.Admitted {
		t.Fatal("the same command replayed after restart has no in-flight call to join and must be refused")
	}
	if d := second.admitStart("s1", desktopStartFenceInput{Generation: 8, HasGeneration: true, CommandID: "c8"}); d.Admitted || !d.NeedsSync {
		t.Fatalf("a start above a loaded high-water mark must still sync once per process, got %#v", d)
	}
	syncTest(second, "s1", liveSync(8))
	if d := second.admitStart("s1", desktopStartFenceInput{Generation: 7, HasGeneration: true, CommandID: "x"}); d.Admitted {
		t.Fatal("the loaded high-water mark must still hold after the sync")
	}
	if d := second.admitStart("s1", desktopStartFenceInput{Generation: 8, HasGeneration: true, CommandID: "c8"}); !d.Admitted {
		t.Fatalf("generation 8 must be admitted once synced, got %#v", d)
	}
}

// The Codex-review scenario: a terminal whose persist failed, then a restart
// from the valid-but-stale file, then the delayed start it was meant to fence.
func TestDesktopFenceStaleFileAfterFailedTerminalWriteStillFencesViaSync(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fence.json")
	first := newDurableFence(t, path)
	syncTest(first, "s1", liveSync(1))
	if d := first.admitStart("s1", desktopStartFenceInput{Generation: 1, HasGeneration: true, CommandID: "c1"}); !d.Admitted {
		t.Fatalf("setup: %#v", d)
	}
	first.persist = func(desktopfence.State) error { return errors.New("disk full") }
	first.noteStop("s1", desktopStopFenceInput{Generation: 3, HasGeneration: true}) // not persisted

	second := newDurableFence(t, path) // loads HWM=1, non-terminal
	d := second.admitStart("s1", desktopStartFenceInput{Generation: 2, HasGeneration: true, CommandID: "delayed"})
	if d.Admitted || !d.NeedsSync {
		t.Fatalf("the delayed start must not be admitted on stale disk state alone, got %#v", d)
	}
	// The control plane still knows the session is terminal.
	syncTest(second, "s1", desktopFenceSyncInput{Generation: 3, HasGeneration: true, Terminal: true})
	if d := second.admitStart("s1", desktopStartFenceInput{Generation: 2, HasGeneration: true, CommandID: "delayed"}); d.Admitted || d.Reason != desktopFenceReasonTerminal {
		t.Fatalf("after sync the delayed start must hit the tombstone, got %#v", d)
	}
}

// A stalled answer to an EARLIER sync attempt must not certify a later one.
func TestDesktopFenceStaleNonceAnswerDoesNotCertify(t *testing.T) {
	var f desktopFence
	ch := f.subscribeSync("s1", "nonce-B")
	defer f.unsubscribeSync("s1", ch)
	// Answer to attempt A arrives late: live at 7.
	f.noteSync("s1", desktopFenceSyncInput{Generation: 7, HasGeneration: true, Nonce: "nonce-A"})
	select {
	case <-ch:
		t.Fatal("waiter B must not be woken by A's answer")
	default:
	}
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 7, HasGeneration: true, CommandID: "c"}); d.Admitted || !d.NeedsSync {
		t.Fatalf("a mismatched-nonce answer must not certify the session, got %#v", d)
	}
	// ...but its knowledge is kept: nothing below 7 can ever be admitted.
	f.noteSync("s1", desktopFenceSyncInput{Generation: 7, HasGeneration: true, Nonce: "nonce-B"})
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 6, HasGeneration: true, CommandID: "c"}); d.Admitted {
		t.Fatal("generation below the learned server generation must be refused")
	}
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 7, HasGeneration: true, CommandID: "c"}); !d.Admitted {
		t.Fatalf("matched-nonce answer must certify, got %#v", d)
	}
}

func TestDesktopFenceCorruptStateBlocksUntilSync(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fence.json")
	if err := os.WriteFile(path, []byte("garbage"), 0o600); err != nil {
		t.Fatal(err)
	}
	f := newDurableFence(t, path)
	d := f.admitStart("s1", desktopStartFenceInput{Generation: 2, HasGeneration: true, CommandID: "c"})
	if d.Admitted || !d.NeedsSync {
		t.Fatalf("corrupt state must block starts until a sync, got %#v", d)
	}
	syncTest(f, "s1", liveSync(2))
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 2, HasGeneration: true, CommandID: "c"}); !d.Admitted {
		t.Fatalf("after sync the live start must be admitted, got %#v", d)
	}
	// The store recovered: the bad file is quarantined and a fresh one written.
	if _, err := os.Stat(path + ".corrupt"); err != nil {
		t.Fatalf("corrupt file must be quarantined: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("fresh state file must exist after the first persisted mutation: %v", err)
	}
}

func TestDesktopFencePersistFailureBlocksAdmissionAndKeepsHighWater(t *testing.T) {
	var f desktopFence
	syncTest(&f, "s1", liveSync(1))
	failing := errors.New("disk full")
	f.persist = func(desktopfence.State) error { return failing }

	d := f.admitStart("s1", desktopStartFenceInput{Generation: 5, HasGeneration: true, CommandID: "c5"})
	if d.Admitted || d.Reason != desktopFenceReasonPersistFailed {
		t.Fatalf("a start whose fence record could not be persisted must be refused, got %#v", d)
	}
	// Redelivery of the very same command must not rejoin: nothing was admitted.
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 5, HasGeneration: true, CommandID: "c5"}); d.Admitted {
		t.Fatal("redelivered command must not rejoin after a persist failure")
	}
	// The high-water mark did NOT roll back: anything at or below 5 stays refused
	// even once the disk recovers.
	f.persist = func(desktopfence.State) error { return nil }
	for _, gen := range []int64{4, 5} {
		if d := f.admitStart("s1", desktopStartFenceInput{Generation: gen, HasGeneration: true, CommandID: "x"}); d.Admitted {
			t.Fatalf("generation %d admitted after persist failure; high-water rolled back", gen)
		}
	}
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 6, HasGeneration: true, CommandID: "c6"}); !d.Admitted {
		t.Fatalf("a newer start once persistence recovers must be admitted, got %#v", d)
	}
}

func TestDesktopFenceStopPersistFailureStillTombstonesInMemory(t *testing.T) {
	var f desktopFence
	f.persist = func(desktopfence.State) error { return errors.New("disk full") }
	f.noteStop("s1", desktopStopFenceInput{Generation: 2, HasGeneration: true})
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 3, HasGeneration: true, CommandID: "c"}); d.Admitted {
		t.Fatal("tombstone must hold in memory even when it could not be persisted")
	}
}

func TestDesktopFenceEvictsOldestNonTerminalBeyondCap(t *testing.T) {
	var f desktopFence
	now := time.Unix(1000, 0)
	f.now = func() time.Time { now = now.Add(time.Millisecond); return now }
	for i := 0; i < maxDesktopFenceEntries+10; i++ {
		syncTest(&f, sessionName(i), liveSync(1))
	}
	f.mu.Lock()
	n := len(f.entries)
	_, oldestPresent := f.entries[sessionName(0)]
	_, newestPresent := f.entries[sessionName(maxDesktopFenceEntries+9)]
	f.mu.Unlock()
	if n != maxDesktopFenceEntries {
		t.Fatalf("entries must be capped at %d, got %d", maxDesktopFenceEntries, n)
	}
	if oldestPresent || !newestPresent {
		t.Fatalf("eviction must drop the oldest entries (oldest present=%v newest present=%v)", oldestPresent, newestPresent)
	}
	// An evicted session is simply unknown again — which means sync-on-unknown,
	// not admission.
	if d := f.admitStart(sessionName(0), desktopStartFenceInput{Generation: 1, HasGeneration: true, CommandID: "c"}); d.Admitted || !d.NeedsSync {
		t.Fatalf("evicted session must fall back to sync-on-unknown, got %#v", d)
	}
}

// Tombstones outlive the cap while young: a generationless start (old
// server) bypasses the sync, so only the tombstone itself can refuse it.
// Non-terminal entries are always evicted first.
func TestDesktopFenceKeepsYoungTombstonesPastCap(t *testing.T) {
	var f desktopFence
	now := time.Unix(1_700_000_000, 0)
	f.now = func() time.Time { now = now.Add(time.Millisecond); return now }
	f.noteStop("tomb", desktopStopFenceInput{})
	for i := 0; i < maxDesktopFenceEntries+10; i++ {
		syncTest(&f, sessionName(i), liveSync(1))
	}
	f.mu.Lock()
	n := len(f.entries)
	f.mu.Unlock()
	if n > maxDesktopFenceEntries {
		t.Fatalf("fence must stay at the cap, got %d", n)
	}
	if d := f.admitStart("tomb", desktopStartFenceInput{CommandID: "legacy"}); d.Admitted {
		t.Fatal("a young tombstone must survive eviction and refuse a generationless start")
	}
}

// A tombstone older than the retention window is evictable once the fence is
// over its cap — by then no server anywhere still holds a deliverable start
// for that session.
func TestDesktopFenceEvictsTombstonesPastRetention(t *testing.T) {
	var f desktopFence
	now := time.Unix(1_700_000_000, 0)
	f.now = func() time.Time { now = now.Add(time.Millisecond); return now }
	for i := 0; i < maxDesktopFenceEntries; i++ {
		f.noteStop(sessionName(i), desktopStopFenceInput{})
	}
	now = now.Add(desktopFenceTombstoneRetention + time.Hour)
	f.noteStop("fresh", desktopStopFenceInput{})

	f.mu.Lock()
	n := len(f.entries)
	_, oldestPresent := f.entries[sessionName(0)]
	_, freshPresent := f.entries["fresh"]
	f.mu.Unlock()
	if n != maxDesktopFenceEntries {
		t.Fatalf("fence must stay at the cap, got %d", n)
	}
	if oldestPresent {
		t.Fatal("a tombstone past retention must be evicted when the fence is full")
	}
	if !freshPresent {
		t.Fatal("the newest tombstone must never be the one evicted")
	}
}

func sessionName(i int) string { return "sess-" + itoa(i) }

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

func TestDesktopFenceSyncWaitersAreWoken(t *testing.T) {
	var f desktopFence
	ch := f.subscribeSync("s1", "n")
	defer f.unsubscribeSync("s1", ch)
	go f.noteSync("s1", desktopFenceSyncInput{Generation: 4, HasGeneration: true, Nonce: "n"})
	select {
	case out := <-ch:
		if out != desktopFenceSyncSynced {
			t.Fatalf("waiter woken with %v, want synced", out)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("sync waiter never woken")
	}
}

func TestDesktopFenceSyncUnavailableWakesWaiterWithoutSyncing(t *testing.T) {
	var f desktopFence
	ch := f.subscribeSync("s1", "n")
	defer f.unsubscribeSync("s1", ch)
	go f.noteSyncUnavailable("s1", "n")
	select {
	case out := <-ch:
		if out != desktopFenceSyncUnavailable {
			t.Fatalf("waiter woken with %v, want unavailable", out)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("sync waiter never woken")
	}
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 1, HasGeneration: true, CommandID: "c"}); !d.NeedsSync {
		t.Fatalf("an unavailable answer must not count as a sync, got %#v", d)
	}
}
