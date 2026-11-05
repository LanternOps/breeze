package isolation

import (
	"context"
	"testing"
	"time"
)

// notingIsolator is an isolator that has something to say about an apply
// that still succeeded (the nft isolator: conntrack missing, so existing
// flows were not flushed).
type notingIsolator struct {
	*fakeIsolator
	notes []string
}

func (n *notingIsolator) TakeApplyNotes() []string {
	out := n.notes
	n.notes = nil
	return out
}

func TestApplyNotesAreJournalledWithTheCommit(t *testing.T) {
	h := newHarness(t)
	iso := &notingIsolator{fakeIsolator: h.iso, notes: []string{"conntrack_unavailable", "Not A Valid Event Type"}}
	h.m = NewManager(ManagerDeps{
		Isolator: iso, Scheduler: h.sched, DataDir: h.dir, Resolver: NewResolver(h.lookup.lookup),
		VerifyRoundTrip: h.verify.call, Clock: h.clock, Dialer: h.dialer,
	})
	h.m.negativeTimeout = 40 * time.Millisecond
	h.m.probeBudget = 3 * time.Second
	out := h.m.HandleIsolate(context.Background(), h.payload("11111111-2222-4333-8444-000000000001", 1, 72*time.Hour))
	if out.Failed() {
		t.Fatalf("isolate: %+v", out)
	}
	types := eventTypes(h.journal())
	if !containsStr(types, "conntrack_unavailable") {
		t.Fatalf("events %v lack the apply note", types)
	}
	for _, typ := range types {
		if typ == "Not A Valid Event Type" {
			t.Fatal("a note the server's event schema would reject must not be journalled")
		}
	}
}
