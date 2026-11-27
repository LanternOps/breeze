package prompthost

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #12808 review: the broker removes a session from its maps, releases its
// lock, and only then tells the host the renderer left. Nothing orders that
// notice against a new connection under the same key (Assist's key is
// role-user-pid), so "joined" for the new connection can reach the host
// before "left" for the old one. The late notice must not undo the restore
// or take down a prompt shown on the new connection.
func TestLateLeftForTheOldConnectionDoesNotUndoTheSameKeyRestore(t *testing.T) {
	kinds := []string{"restart.prompt@1", "remote.consent@1"}
	conn := func(n uint64) RendererSession {
		r := assistRenderer("assist-1", kinds...)
		r.Conn = n
		return r
	}
	for _, leftBeforeTick := range []bool{true, false} {
		name := "left after the replay tick"
		if leftBeforeTick {
			name = "left before the replay tick"
		}
		t.Run(name, func(t *testing.T) {
			hh := newHarness(t, conn(1), nativeRenderer("user-1", kinds...))
			hh.h.RendererConnected(conn(1))
			hh.tick(time.Second)
			hh.dir.take()
			deadline := t0.Add(time.Hour)
			if err := hh.h.Show(restartPrompt(t, "restart:42", deadline, &promptCalls{outcome: ActionOutcome{Accepted: true}})); err != nil {
				t.Fatal(err)
			}
			first := showsTo(hh.dir.take(), "assist-1")[0]
			hh.presented("assist-1", first)
			oldLost := &lostRecorder{}
			if err := hh.h.Show(consentPrompt("consent:old", &promptCalls{}, oldLost)); err != nil {
				t.Fatal(err)
			}
			for _, s := range showsTo(hh.dir.take(), "assist-1") {
				hh.presented("assist-1", s)
			}

			// Connection 1 is gone from the broker's maps; connection 2 of the
			// same key registers and is announced first.
			hh.dir.remove("assist-1")
			hh.tick(2 * time.Second)
			hh.dir.add(conn(2))
			hh.h.RendererConnected(conn(2))
			if leftBeforeTick {
				hh.h.rendererLeft("assist-1", 1)
			}
			hh.tick(time.Second)
			msgs := hh.dir.take()
			var restored []ipc.PromptShow
			for _, s := range showsTo(msgs, "assist-1") {
				if s.PromptID == "restart:42" {
					restored = append(restored, s)
				}
			}
			if len(restored) != 1 {
				t.Fatalf("restart shows on connection 2 = %d, want exactly 1", len(restored))
			}
			re := restored[0]
			if re.Lease.Epoch <= first.Lease.Epoch || re.Timing.DeadlineUnixMs != deadline.UnixMilli() {
				t.Fatalf("restored with lease %+v deadline %d; want an epoch above %d and the original deadline",
					re.Lease, re.Timing.DeadlineUnixMs, first.Lease.Epoch)
			}
			hh.presented("assist-1", re)

			// A consent shown on connection 2.
			newLost := &lostRecorder{}
			if err := hh.h.Show(consentPrompt("consent:new", &promptCalls{}, newLost)); err != nil {
				t.Fatal(err)
			}
			for _, s := range showsTo(hh.dir.take(), "assist-1") {
				hh.presented("assist-1", s)
			}
			if !leftBeforeTick {
				hh.h.rendererLeft("assist-1", 1)
			}

			for range 20 {
				hh.tick(time.Second)
			}
			msgs = hh.dir.take()
			if n := len(showsTo(msgs, "user-1")); n != 0 {
				t.Fatalf("%d native shows: the late notice for connection 1 sent a prompt on connection 2 to the native helper", n)
			}
			if n := len(showsTo(msgs, "assist-1")); n != 0 {
				t.Fatalf("%d shows drawn again on connection 2 after the restore", n)
			}
			if got := newLost.snapshot(); len(got) != 0 || !hh.h.IsOpen("consent:new") {
				t.Fatalf("the consent shown on connection 2 was lost by the late notice for connection 1: %+v", got)
			}
			// The consent drawn on connection 1 is lost once, as at any drop.
			if got := oldLost.snapshot(); len(got) != 1 || got[0].reason != "renderer_gone" {
				t.Fatalf("consent on connection 1 lost = %+v, want one renderer_gone", got)
			}
			if r := hh.act("assist-1", re.PromptID, re.Rev, re.Lease, "postpone"); r.Result != ipc.PromptActionAccepted {
				t.Fatalf("action on connection 2's lease = %q, want accepted", r.Result)
			}
		})
	}
}
