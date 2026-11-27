package prompthost

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #12808: Assist's IPC connection dropped and came back within a second or
// two under the SAME session key (the key is role-user-pid, and the process
// keeps running). The replay skipped any placement still pointing at that
// key, so an open decision sat invisible through its 10 s grace and then fell
// back to the native dialog, although the renderer it belonged to was back.

// sameKeyDrop presents a restart prompt and a consent on assist-1, drops the
// connection and brings the same key back after gap.
func sameKeyDrop(t *testing.T, gap time.Duration) (hh *harness, restart ipc.PromptShow, deadline time.Time, calls *promptCalls, lost *lostRecorder) {
	t.Helper()
	kinds := []string{"restart.prompt@1", "remote.consent@1"}
	hh = newHarness(t, assistRenderer("assist-1", kinds...), nativeRenderer("user-1", kinds...))
	calls, lost = &promptCalls{outcome: ActionOutcome{Accepted: true}}, &lostRecorder{}
	deadline = t0.Add(time.Hour)
	if err := hh.h.Show(restartPrompt(t, "restart:42", deadline, calls)); err != nil {
		t.Fatal(err)
	}
	restart = showsTo(hh.dir.take(), "assist-1")[0]
	hh.presented("assist-1", restart)
	if err := hh.h.Show(consentPrompt("consent:c1", &promptCalls{}, lost)); err != nil {
		t.Fatal(err)
	}
	for _, s := range showsTo(hh.dir.take(), "assist-1") {
		hh.presented("assist-1", s)
	}

	hh.dir.remove("assist-1")
	hh.h.RendererDisconnected("assist-1")
	hh.tick(gap)
	hh.dir.add(assistRenderer("assist-1", kinds...))
	hh.h.RendererConnected(assistRenderer("assist-1", kinds...))
	return hh, restart, deadline, calls, lost
}

func TestSameKeyReconnectWithinGraceRestoresTheDecisionOnce(t *testing.T) {
	hh, first, deadline, calls, lost := sameKeyDrop(t, 2*time.Second)
	hh.tick(time.Second)
	msgs := hh.dir.take()

	var restart []ipc.PromptShow
	for _, s := range showsTo(msgs, "assist-1") {
		switch s.PromptID {
		case "restart:42":
			restart = append(restart, s)
		case "consent:c1":
			t.Fatal("the consent was re-presented after a reconnect: it is never re-asked (spec §3.7)")
		}
	}
	if len(restart) != 1 {
		t.Fatalf("restart shows on the reconnected renderer = %d, want exactly 1", len(restart))
	}
	re := restart[0]
	if re.Lease.RendererSession != "assist-1" || re.Lease.Epoch <= first.Lease.Epoch {
		t.Fatalf("lease = %+v, want assist-1 with an epoch above %d", re.Lease, first.Lease.Epoch)
	}
	if re.Presentation == ipc.PromptPresentationListOnly || re.Focus != ipc.PromptFocusNoActivate {
		t.Fatalf("restored as presentation=%q focus=%q, want the decision card, non-activating", re.Presentation, re.Focus)
	}
	if re.Timing.DeadlineUnixMs != deadline.UnixMilli() {
		t.Fatalf("deadline moved: %d, want %d", re.Timing.DeadlineUnixMs, deadline.UnixMilli())
	}
	if n := len(closesTo(msgs, "assist-1")); n != 0 {
		// The new session holds no window for the old lease; a fenced close
		// would only be refused as stale.
		t.Fatalf("%d prompt_close sent to the reconnected renderer", n)
	}
	if n := len(showsTo(msgs, "user-1")); n != 0 {
		t.Fatal("a native copy was drawn although Assist came back within the grace")
	}

	// The consent was lost at the disconnect, once, and ends as the domain's
	// no-renderer answer (denied): never re-shown, never a second chance.
	if got := lost.snapshot(); len(got) != 1 || got[0].reason != "renderer_gone" {
		t.Fatalf("consent lost = %+v, want one renderer_gone", got)
	}
	if hh.h.IsOpen("consent:c1") {
		t.Fatal("a lost consent must be withdrawn")
	}

	// A click on the old lease (from before the drop) does not count.
	if r := hh.act("assist-1", first.PromptID, first.Rev, first.Lease, "postpone"); r.Result != ipc.PromptActionRejectedStale {
		t.Fatalf("old-lease action = %q, want rejected_stale", r.Result)
	}
	if _, n, _ := calls.counts(); n != 0 {
		t.Fatalf("an old-lease click reached the domain (%d actions)", n)
	}

	// Presented on the new lease: the grace is gone for good, and nothing is
	// drawn again or elsewhere.
	hh.presented("assist-1", re)
	for range 20 {
		hh.tick(time.Second)
	}
	msgs = hh.dir.take()
	if len(showsTo(msgs, "assist-1")) != 0 || len(showsTo(msgs, "user-1")) != 0 {
		t.Fatalf("drawn again after the restore: %+v", msgs)
	}
	if r := hh.act("assist-1", re.PromptID, re.Rev, re.Lease, "postpone"); r.Result != ipc.PromptActionAccepted {
		t.Fatalf("new-lease action = %q, want accepted", r.Result)
	}
	if _, n, _ := calls.counts(); n != 1 {
		t.Fatalf("domain actions = %d, want 1", n)
	}
}

// A reconnect that arrives after the grace finds the prompt already moved to
// the native helper; the restore does not run twice and the deadline holds.
func TestSameKeyReconnectAfterGraceDoesNotDrawTwice(t *testing.T) {
	hh, _, deadline, _, _ := sameKeyDrop(t, 11*time.Second)
	hh.tick(time.Second)
	msgs := hh.dir.take()
	native := showsTo(msgs, "user-1")
	if len(native) != 1 || len(showsTo(msgs, "assist-1")) != 0 {
		t.Fatalf("after the grace: native shows %d, Assist shows %d; want exactly 1 and 0",
			len(native), len(showsTo(msgs, "assist-1")))
	}
	if native[0].Timing.DeadlineUnixMs != deadline.UnixMilli() {
		t.Fatalf("the fallback moved the deadline: %d, want %d", native[0].Timing.DeadlineUnixMs, deadline.UnixMilli())
	}
}

// Two decisions open on the dropped renderer: the reconnect restores one
// decision surface (the oldest) and lists the other (spec §3.1, replay never
// storms), each once and non-activating.
func TestSameKeyReconnectRestoresOneDecisionSurface(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"), nativeRenderer("user-1", "restart.prompt@1"))
	var first []ipc.PromptShow
	for _, id := range []string{"restart:a", "restart:b"} {
		if err := hh.h.Show(restartPrompt(t, id, t0.Add(time.Hour), &promptCalls{})); err != nil {
			t.Fatal(err)
		}
		hh.tick(time.Second)
	}
	for _, s := range showsTo(hh.dir.take(), "assist-1") {
		hh.presented("assist-1", s)
		first = append(first, s)
	}
	if len(first) != 2 {
		t.Fatalf("setup: %d shows, want 2", len(first))
	}
	hh.dir.remove("assist-1")
	hh.h.RendererDisconnected("assist-1")
	hh.tick(2 * time.Second)
	hh.dir.add(assistRenderer("assist-1", "restart.prompt@1"))
	hh.h.RendererConnected(assistRenderer("assist-1", "restart.prompt@1"))
	hh.tick(time.Second)
	msgs := hh.dir.take()
	re := showsTo(msgs, "assist-1")
	if len(re) != 2 || len(showsTo(msgs, "user-1")) != 0 {
		t.Fatalf("restored %d on Assist, %d native; want 2 and 0", len(re), len(showsTo(msgs, "user-1")))
	}
	cards := 0
	for _, s := range re {
		if s.Focus != ipc.PromptFocusNoActivate {
			t.Fatalf("%s restored with focus %q", s.PromptID, s.Focus)
		}
		if s.Presentation != ipc.PromptPresentationListOnly {
			cards++
			if s.PromptID != "restart:a" {
				t.Fatalf("the restored decision is %s, want the oldest (restart:a)", s.PromptID)
			}
		}
	}
	if cards != 1 {
		t.Fatalf("%d decision cards restored, want exactly 1", cards)
	}
}

// A same-key reconnect that can no longer draw the prompt (it stopped
// advertising the kind) does not take it: the grace stands, and the prompt
// falls back to the native helper once, as before.
func TestSameKeyReconnectThatCannotDrawItKeepsTheGrace(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"), nativeRenderer("user-1", "restart.prompt@1"))
	if err := hh.h.Show(restartPrompt(t, "restart:9", t0.Add(time.Hour), &promptCalls{})); err != nil {
		t.Fatal(err)
	}
	hh.presented("assist-1", showsTo(hh.dir.take(), "assist-1")[0])
	hh.dir.remove("assist-1")
	hh.h.RendererDisconnected("assist-1")
	hh.tick(2 * time.Second)
	hh.dir.add(assistRenderer("assist-1", "notice.info@1"))
	hh.h.RendererConnected(assistRenderer("assist-1", "notice.info@1"))
	hh.tick(time.Second)
	if msgs := hh.dir.take(); len(showsTo(msgs, "assist-1")) != 0 || len(showsTo(msgs, "user-1")) != 0 {
		t.Fatalf("drawn before the grace ran out: %+v", msgs)
	}
	for range 10 {
		hh.tick(time.Second)
	}
	msgs := hh.dir.take()
	if n := len(showsTo(msgs, "user-1")); n != 1 || len(showsTo(msgs, "assist-1")) != 0 {
		t.Fatalf("after the grace: native %d, Assist %d; want 1 and 0 (orphaned or drawn twice)", n, len(showsTo(msgs, "assist-1")))
	}
}

// A renderer that never left (a second connect notice for a live key) is not
// handed a duplicate of the card it already shows.
func TestConnectNoticeForALiveKeyDoesNotDuplicate(t *testing.T) {
	hh := newHarness(t, assistRenderer("assist-1", "restart.prompt@1"))
	if err := hh.h.Show(restartPrompt(t, "restart:7", t0.Add(time.Hour), &promptCalls{})); err != nil {
		t.Fatal(err)
	}
	s := showsTo(hh.dir.take(), "assist-1")[0]
	hh.presented("assist-1", s)
	hh.h.RendererConnected(assistRenderer("assist-1", "restart.prompt@1"))
	hh.tick(time.Second)
	if n := len(showsTo(hh.dir.take(), "assist-1")); n != 0 {
		t.Fatalf("%d duplicate shows to a renderer that never disconnected", n)
	}
}
