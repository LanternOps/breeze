package isolation

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/wire"
)

// Fixture revisions have the shape resolveContainmentPolicy emits (#10915).
const (
	revA = "c1:0123456789abcdef0123456789abcdef"
	revB = "c1:fedcba9876543210fedcba9876543210"
)

func TestPolicyRevisionWire(t *testing.T) {
	for _, tc := range []struct {
		raw   string
		want  PolicyRevision
		valid bool
	}{
		{`"` + revA + `"`, revA, true},
		{`"c1i:0123456789abcdef"`, "c1i:0123456789abcdef", true},
		{`"revision-1"`, "revision-1", true},
		{`7`, "7", true},
		{`null`, "", false},
		{`""`, "", false},
		{`"  "`, "  ", false},
		{`"a b"`, "a b", false},
		{`"a\nb"`, "a\nb", false},
		{`"` + strings.Repeat("x", maxPolicyRevisionLen+1) + `"`, PolicyRevision(strings.Repeat("x", maxPolicyRevisionLen+1)), false},
		{`0`, malformedPolicyRevision, false},
		{`-1`, malformedPolicyRevision, false},
		{`1.5`, malformedPolicyRevision, false},
		{`true`, malformedPolicyRevision, false},
		{`{"a":1}`, malformedPolicyRevision, false},
		{`[1]`, malformedPolicyRevision, false},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			var d Desired
			// A malformed revision must never fail the decode: the block sits inside
			// the heartbeat response, and a decode error would drop every command in it.
			if err := json.Unmarshal([]byte(`{"desired":"isolated","policyRevision":`+tc.raw+`}`), &d); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if d.PolicyRevision != tc.want || d.PolicyRevision.Valid() != tc.valid {
				t.Fatalf("got %q valid=%v, want %q valid=%v", d.PolicyRevision, d.PolicyRevision.Valid(), tc.want, tc.valid)
			}
		})
	}
	var d Desired
	if err := json.Unmarshal([]byte(`{"desired":"isolated"}`), &d); err != nil || d.PolicyRevision != "" || d.PolicyRevision.Valid() {
		t.Fatalf("absent revision: %q err=%v", d.PolicyRevision, err)
	}
}

func TestEpisodeJournalsPolicyRevision(t *testing.T) {
	t.Run("heartbeat", func(t *testing.T) {
		h := newHarness(t)
		block := h.desired(idA, 3, DesiredIsolated, 72*time.Hour, true)
		block.NetworkIsolation.PolicyRevision = revA
		h.m.Reconcile(context.Background(), block)
		ep := h.journal().Episode
		if ep == nil || ep.PolicyRevision != revA || ep.PolicyGeneration != 3 {
			t.Fatalf("episode %+v", ep)
		}
	})
	t.Run("command", func(t *testing.T) {
		h := newHarness(t)
		p := h.payload(idA, 2, 72*time.Hour)
		p["parameters"].(map[string]any)["policyRevision"] = revA
		if out := h.m.HandleIsolate(context.Background(), p); out.Failed() {
			t.Fatalf("isolate: %+v", out)
		}
		ep := h.journal().Episode
		if ep.PolicyRevision != revA || ep.PolicyGeneration != 2 {
			t.Fatalf("episode %+v", ep)
		}
	})
	t.Run("no policy leaves no revision", func(t *testing.T) {
		h := newHarness(t)
		h.mustIsolate(idA, 1)
		if ep := h.journal().Episode; ep.PolicyRevision != "" || ep.PolicyGeneration != 1 {
			t.Fatalf("episode %+v", ep)
		}
	})
	t.Run("a malformed revision is refused even with no policy entries", func(t *testing.T) {
		// Read as "no policy", it would narrow a held policy and be recorded as a
		// deliberate removal, hiding a server serialisation bug.
		for _, rev := range []any{true, 0, 1.5, "a b", strings.Repeat("x", maxPolicyRevisionLen+1)} {
			h := newHarness(t)
			p := h.payload(idA, 1, 72*time.Hour)
			p["parameters"].(map[string]any)["policyRevision"] = rev
			if out := h.m.HandleIsolate(context.Background(), p); !out.Failed() || out.ErrorCode != wire.ErrCodeIsolationInvalidSpec || h.iso.applies != 0 {
				t.Fatalf("revision %v: outcome %+v, applies %d", rev, out, h.iso.applies)
			}
		}
	})
	t.Run("the new fields are additive on disk", func(t *testing.T) {
		b, err := json.Marshal(journal.EpisodeRecord{IsolationID: idA})
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), "policy") {
			t.Fatalf("empty policy fields must be omitted: %s", b)
		}
	})
}

func policyExtra(cidr string) AllowEntry {
	return AllowEntry{Kind: KindCIDR, CIDR: cidr, Proto: ProtoTCP, Ports: []uint16{8443}, Scope: ScopeAny}
}

// policyBlock is a desired block: the harness's management-plane permits, then
// the policy's extras, as buildIsolationAllowlist orders them.
func (h *harness) policyBlock(gen int, rev PolicyRevision, extras ...AllowEntry) *DesiredBlock {
	block := h.desired(idA, gen, DesiredIsolated, 72*time.Hour, false)
	block.NetworkIsolation.PolicyRevision = rev
	block.NetworkIsolation.Allow = append(block.NetworkIsolation.Allow, extras...)
	return block
}

// heldPolicy commits an episode at gen holding revA and one extra.
func (h *harness) heldPolicy(gen int) AllowEntry {
	h.t.Helper()
	extra := policyExtra("203.0.113.0/24")
	h.m.Reconcile(context.Background(), h.policyBlock(gen, revA, extra))
	j := h.journal()
	if j.Phase != journal.PhaseCommitted || j.Episode.PolicyRevision != revA || j.Episode.PolicyGeneration != gen {
		h.t.Fatalf("held policy not committed: phase %s episode %+v", j.Phase, j.Episode)
	}
	if !h.installedHas(extra) {
		h.t.Fatal("the policy entry was not installed")
	}
	h.log.reset()
	return extra
}

func (h *harness) installedHas(want AllowEntry) bool {
	_, spec, _ := h.iso.state()
	for _, e := range spec.Entries {
		if !e.Proxy && allowKey(e.AllowEntry) == allowKey(want) {
			return true
		}
	}
	return false
}

func policyEvents(j *journal.Journal, typ string) []journal.Event {
	var out []journal.Event
	for _, e := range j.Events {
		if e.Type == typ {
			out = append(out, e)
		}
	}
	return out
}

func TestManagerRefusesAnyScopeWithoutValidRevision(t *testing.T) {
	for _, rev := range []PolicyRevision{"", malformedPolicyRevision, "  ", "a b"} {
		h := newHarness(t)
		h.m.Reconcile(context.Background(), h.policyBlock(1, rev, policyExtra("203.0.113.0/24")))
		if h.m.Active() || h.iso.applies != 0 {
			t.Fatalf("revision %q: scope:any accepted without a valid revision", rev)
		}
	}
}

func TestPolicyEntriesAcceptedWithRevision(t *testing.T) {
	h := newHarness(t)
	h.heldPolicy(1)
	got := policyEvents(h.journal(), "policy_applied")
	if len(got) != 1 || got[0].Detail != revA || got[0].IsolationID != idA || got[0].Generation != 1 {
		t.Fatalf("policy_applied events %+v", got)
	}
	// The same assertion on the next heartbeat changes nothing.
	applies := h.iso.applies
	h.m.Reconcile(context.Background(), h.policyBlock(1, revA, policyExtra("203.0.113.0/24")))
	if h.iso.applies != applies {
		t.Fatal("an unchanged desired state re-applied the rules")
	}
}

// The hazard behind #11034: a desired state that omits the policy's entries must
// narrow the installed rules in place. It must not release, must not open a new
// provisional episode, and must not repeat on the next heartbeat.
func TestPolicyOmissionNarrowsWithoutReisolating(t *testing.T) {
	for _, tc := range []struct {
		name string
		gen  int
	}{{"new generation", 3}, {"same generation", 2}} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			extra := h.heldPolicy(2)
			applies := h.iso.applies

			h.m.Reconcile(context.Background(), h.policyBlock(tc.gen, ""))

			j := h.journal()
			if h.installedHas(extra) {
				t.Fatal("the removed policy entry is still installed")
			}
			if j.Phase != journal.PhaseCommitted || j.Episode.State != StateVerified || j.Episode.Generation != tc.gen {
				t.Fatalf("episode left the committed state: phase %s %+v", j.Phase, j.Episode)
			}
			if j.Episode.PolicyRevision != "" || j.Episode.PolicyGeneration != tc.gen {
				t.Fatalf("policy not cleared: %+v", j.Episode)
			}
			for _, e := range j.Episode.Allow {
				if e.Scope == ScopeAny {
					t.Fatalf("journal still holds %+v", e)
				}
			}
			if calls := h.log.all(); containsStr(calls, "journal:provisional") || containsStr(calls, "journal:releasing") || containsStr(calls, "iso:Release") {
				t.Fatalf("narrowing re-isolated: %v", calls)
			}
			if !containsStr(eventTypes(j), "refreshed") {
				t.Fatalf("narrowing was not a verified refresh: %v", eventTypes(j))
			}
			removed := policyEvents(j, "policy_removed")
			if len(removed) != 1 || removed[0].Detail != revA {
				t.Fatalf("policy_removed events %+v", removed)
			}
			if h.iso.applies != applies+1 {
				t.Fatalf("applies = %d, want exactly one more than %d", h.iso.applies, applies)
			}

			h.m.Reconcile(context.Background(), h.policyBlock(tc.gen, ""))
			if h.iso.applies != applies+1 {
				t.Fatal("the omission was re-applied on the next heartbeat")
			}
		})
	}
}

// Narrowing must not become a way back up: the entries it removed return only
// with a new generation.
func TestPolicyWideningNeedsNewGenerationAfterNarrowing(t *testing.T) {
	h := newHarness(t)
	extra := h.heldPolicy(2)
	h.m.Reconcile(context.Background(), h.policyBlock(2, ""))

	h.m.Reconcile(context.Background(), h.policyBlock(2, revA, extra))
	if h.installedHas(extra) {
		t.Fatal("a stale block widened the rules at the generation that narrowed them")
	}
	if got := policyEvents(h.journal(), "policy_rejected"); len(got) != 1 || got[0].Detail != string(PolicyRejectGenerationNotAdvanced) {
		t.Fatalf("policy_rejected events %+v", got)
	}

	h.m.Reconcile(context.Background(), h.policyBlock(3, revA, extra))
	if !h.installedHas(extra) {
		t.Fatal("a new generation could not restore the policy")
	}
}

func TestPolicyRevisionRules(t *testing.T) {
	second := policyExtra("192.0.2.128/25")
	first := policyExtra("203.0.113.0/24")
	for _, tc := range []struct {
		name   string
		block  func(h *harness) *DesiredBlock
		reason PolicyRejectReason // empty: accepted
		rev    string
		gen    int
	}{
		{"new generation, new revision", func(h *harness) *DesiredBlock { return h.policyBlock(3, revB, first, second) }, "", revB, 3},
		{"new generation, same entries, new revision", func(h *harness) *DesiredBlock { return h.policyBlock(3, revB, first) }, "", revB, 3},
		{"new generation, same revision", func(h *harness) *DesiredBlock { return h.policyBlock(3, revA, first) }, "", revA, 3},
		{"same generation, different revision", func(h *harness) *DesiredBlock { return h.policyBlock(2, revB, first) }, PolicyRejectRevisionRegressed, revA, 2},
		{"same generation, different revision, widening", func(h *harness) *DesiredBlock { return h.policyBlock(2, revB, first, second) }, PolicyRejectRevisionRegressed, revA, 2},
		{"same generation, same revision, widening", func(h *harness) *DesiredBlock { return h.policyBlock(2, revA, first, second) }, PolicyRejectGenerationNotAdvanced, revA, 2},
		{"same generation, same revision, changed entry", func(h *harness) *DesiredBlock { return h.policyBlock(2, revA, second) }, PolicyRejectGenerationNotAdvanced, revA, 2},
		{"same generation, same revision, changed ports", func(h *harness) *DesiredBlock {
			moved := first
			moved.Ports = []uint16{443}
			return h.policyBlock(2, revA, moved)
		}, PolicyRejectGenerationNotAdvanced, revA, 2},
		{"same generation, same revision, changed protocol", func(h *harness) *DesiredBlock {
			moved := first
			moved.Proto = ProtoUDPTCP
			return h.policyBlock(2, revA, moved)
		}, PolicyRejectGenerationNotAdvanced, revA, 2},
		{"older generation, different revision", func(h *harness) *DesiredBlock { return h.policyBlock(1, revB, first) }, PolicyRejectRevisionRegressed, revA, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.heldPolicy(2)
			before := h.journal().Episode
			applies := h.iso.applies

			h.m.Reconcile(context.Background(), tc.block(h))

			j := h.journal()
			rejected := policyEvents(j, "policy_rejected")
			if j.Episode.PolicyRevision != tc.rev || j.Episode.Generation != tc.gen {
				t.Fatalf("episode %+v, want revision %s generation %d", j.Episode, tc.rev, tc.gen)
			}
			if tc.reason == "" {
				if len(rejected) != 0 {
					t.Fatalf("unexpected rejection %+v", rejected)
				}
				return
			}
			if len(rejected) != 1 || rejected[0].Detail != string(tc.reason) {
				t.Fatalf("policy_rejected events %+v, want reason %s", rejected, tc.reason)
			}
			if h.iso.applies != applies || !allowEqual(j.Episode.Allow, before.Allow) || j.Phase != journal.PhaseCommitted {
				t.Fatalf("a rejected block changed the rules: applies %d→%d allow %+v", applies, h.iso.applies, j.Episode.Allow)
			}
			// The server repeats itself every heartbeat; the journal must not fill up.
			h.m.Reconcile(context.Background(), tc.block(h))
			if got := policyEvents(h.journal(), "policy_rejected"); len(got) != 1 {
				t.Fatalf("a repeated rejection journalled again: %+v", got)
			}
		})
	}
}

// A rejected block is rejected whole: its secret is not stored either.
// A rejected policy must not cost the device its break-glass secret: the secret
// belongs to the episode, not to the allowlist, and is the offline way out.
func TestRejectedPolicyBlockStillDeliversSecret(t *testing.T) {
	h := newHarness(t)
	first := h.heldPolicy(2)
	second := policyExtra("192.0.2.128/25")
	block := h.policyBlock(2, revB, first, second)
	block.NetworkIsolation.BreakGlassSecret = h.secret
	h.m.Reconcile(context.Background(), block)
	j := h.journal()
	if string(j.Episode.BreakGlassSecret) != string(h.secret) || j.SecretAckSeq == 0 {
		t.Fatalf("the secret was not stored: %+v", j.Episode)
	}
	if h.installedHas(second) || j.Episode.PolicyRevision != revA {
		t.Fatalf("the rejected policy was applied: %+v", j.Episode)
	}
	if got := policyEvents(j, "policy_rejected"); len(got) != 1 {
		t.Fatalf("policy_rejected events %+v", got)
	}
}

// Removing one permit of several is the common narrowing.
func TestPolicyPartialNarrowingAtSameGeneration(t *testing.T) {
	h := newHarness(t)
	first, second := policyExtra("203.0.113.0/24"), policyExtra("192.0.2.128/25")
	h.m.Reconcile(context.Background(), h.policyBlock(2, revA, first, second))
	h.m.Reconcile(context.Background(), h.policyBlock(2, revA, first))
	j := h.journal()
	if !h.installedHas(first) || h.installedHas(second) || j.Episode.PolicyRevision != revA {
		t.Fatalf("not narrowed to the first permit: %+v", j.Episode)
	}
	if got := policyEvents(j, "policy_rejected"); len(got) != 0 {
		t.Fatalf("a narrowing was rejected: %+v", got)
	}
}

func TestNewEpisodeStartsWithItsOwnPolicy(t *testing.T) {
	h := newHarness(t)
	h.heldPolicy(5)
	block := h.desired(idB, 1, DesiredIsolated, 72*time.Hour, false)
	h.m.Reconcile(context.Background(), block)
	j := h.journal()
	if j.Episode.IsolationID != idB || j.Episode.PolicyRevision != "" || j.Episode.PolicyGeneration != 1 || hasAnyScope(j.Episode.Allow) {
		t.Fatalf("the new episode inherited the old policy: %+v", j.Episode)
	}
}

// A crash at any point of a policy refresh leaves either the old or the new
// rules, and the next heartbeat after restart still completes the change.
func TestCrashDuringPolicyRefreshRecovers(t *testing.T) {
	for n := 0; ; n++ {
		h := newHarness(t)
		first := h.heldPolicy(2)
		second := policyExtra("192.0.2.128/25")
		count := crashAt(h.m, n)
		h.m.Reconcile(context.Background(), h.policyBlock(3, revB, first, second))
		if *count <= n {
			if n == 0 {
				t.Fatal("the refresh ran no effects")
			}
			return // every effect index has been crashed at
		}
		h.m = h.newManager()
		h.m.Startup(context.Background())
		endStateOK(t, h, fmt.Sprintf("crash before effect %d", n))
		if ep := h.journal().Episode; ep.PolicyRevision != revA && ep.PolicyRevision != revB {
			t.Fatalf("crash %d: revision %q", n, ep.PolicyRevision)
		}

		h.m.Reconcile(context.Background(), h.policyBlock(3, revB, first, second))
		j := h.journal()
		if !h.installedHas(first) || !h.installedHas(second) || j.Episode.PolicyRevision != revB || j.Episode.PolicyGeneration != 3 {
			t.Fatalf("crash %d: the retry did not complete the change: %+v", n, j.Episode)
		}
	}
}

// The command path and the heartbeat path serialise on the Manager; under the
// race detector neither may corrupt the policy state of the other.
func TestPolicyPathsConcurrently(t *testing.T) {
	h := newHarness(t)
	first := h.heldPolicy(2)
	second := policyExtra("192.0.2.128/25")
	ctx := context.Background()
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(3)
		go func() { defer wg.Done(); h.m.Reconcile(ctx, h.policyBlock(3, revB, first, second)) }()
		go func() { defer wg.Done(); h.m.Reconcile(ctx, h.policyBlock(2, revB, first)) }()
		go func() { defer wg.Done(); h.m.NotePolicyRejected(ctx, idA, 2, PolicyRejectRevisionMissing) }()
	}
	wg.Wait()
	endStateOK(t, h, "after concurrent policy operations")
	j := h.journal()
	if j.Episode.PolicyRevision != revB || !h.installedHas(second) || j.Episode.PolicyGeneration != 3 {
		t.Fatalf("final state %+v", j.Episode)
	}
}

func TestIsolateCommandRefusesAnyScopeWithoutRevision(t *testing.T) {
	h := newHarness(t)
	p := h.payload(idA, 1, 72*time.Hour)
	params := p["parameters"].(map[string]any)
	params["allow"] = append(params["allow"].([]any), map[string]any{"kind": "cidr", "cidr": "203.0.113.0/24", "proto": "tcp", "ports": []any{float64(8443)}, "scope": "any"})
	if out := h.m.HandleIsolate(context.Background(), p); !out.Failed() || out.ErrorCode != wire.ErrCodeIsolationInvalidSpec || h.iso.applies != 0 {
		t.Fatalf("outcome %+v", out)
	}
}

// Dedupe holds per reason and generation, survives alternation, and lets a
// rejection journal again once a policy has been adopted in between.
func TestPolicyRejectionDedupe(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	for _, reason := range []PolicyRejectReason{PolicyRejectRevisionMissing, PolicyRejectRevisionInvalid, PolicyRejectRevisionMissing, PolicyRejectRevisionInvalid} {
		h.m.NotePolicyRejected(ctx, idA, 1, reason)
	}
	if got := len(h.m.Report().Events); got != 2 {
		t.Fatalf("alternating rejections journalled %d events, want 2", got)
	}
	h.heldPolicy(1)
	h.m.NotePolicyRejected(ctx, idA, 1, PolicyRejectRevisionMissing)
	if got := policyEvents(h.journal(), "policy_rejected"); len(got) != 3 {
		t.Fatalf("after an adoption the rejection was not journalled again: %+v", got)
	}
}

// A generation that extends the episode but fails to install the rules must not
// lock the policy out at that generation: the next heartbeat retries it.
func TestFailedPolicyRefreshRetriesAtSameGeneration(t *testing.T) {
	h := newHarness(t)
	first := h.heldPolicy(2)
	second := policyExtra("192.0.2.128/25")
	h.iso.set(func(f *fakeIsolator) { f.failApplyN = f.applies + 1 })

	h.m.Reconcile(context.Background(), h.policyBlock(3, revB, first, second))
	j := h.journal()
	if h.installedHas(second) || !h.installedHas(first) || j.Episode.Generation != 3 || j.Episode.PolicyRevision != revA || j.Episode.PolicyGeneration != 2 {
		t.Fatalf("after the failed refresh: %+v", j.Episode)
	}

	h.m.Reconcile(context.Background(), h.policyBlock(3, revB, first, second))
	j = h.journal()
	if !h.installedHas(second) || j.Episode.PolicyRevision != revB || j.Episode.PolicyGeneration != 3 {
		t.Fatalf("the retry did not adopt the policy: %+v", j.Episode)
	}
	if got := policyEvents(j, "policy_rejected"); len(got) != 0 {
		t.Fatalf("the retry was rejected: %+v", got)
	}
}

// A revision change with identical entries moves no rules, but it still has to
// be recorded and has to raise the bar for same-generation changes.
func TestPolicyRevisionAdoptedWithoutApplyWhenEntriesMatch(t *testing.T) {
	h := newHarness(t)
	first := h.heldPolicy(2)
	applies := h.iso.applies

	h.m.Reconcile(context.Background(), h.policyBlock(3, revB, first))

	j := h.journal()
	if h.iso.applies != applies {
		t.Fatal("identical entries re-applied the rules")
	}
	if j.Episode.PolicyRevision != revB || j.Episode.PolicyGeneration != 3 {
		t.Fatalf("revision not adopted: %+v", j.Episode)
	}
	if got := policyEvents(j, "policy_applied"); len(got) != 2 || got[1].Detail != revB {
		t.Fatalf("policy_applied events %+v", got)
	}
}

// A journal with no policy fields (written before them, or rewritten by an older
// recovery binary) can adopt what it already holds, but cannot widen.
func TestLegacyJournalAdoptsHeldEntriesOnly(t *testing.T) {
	stripPolicy := func(h *harness) {
		h.t.Helper()
		j := h.journal()
		j.Episode.PolicyRevision, j.Episode.PolicyGeneration = "", 0
		if err := journal.Save(journal.Path(h.dir), j); err != nil {
			h.t.Fatal(err)
		}
		h.m = h.newManager()
	}
	h := newHarness(t)
	first := h.heldPolicy(2)
	stripPolicy(h)
	applies := h.iso.applies

	h.m.Reconcile(context.Background(), h.policyBlock(2, revA, first))
	if j := h.journal(); j.Episode.PolicyRevision != revA || j.Episode.PolicyGeneration != 2 || h.iso.applies != applies {
		t.Fatalf("held entries not adopted: %+v (applies %d→%d)", j.Episode, applies, h.iso.applies)
	}

	stripPolicy(h)
	second := policyExtra("192.0.2.128/25")
	h.m.Reconcile(context.Background(), h.policyBlock(2, revB, first, second))
	if h.installedHas(second) {
		t.Fatal("a journal with no policy fields allowed a same-generation widening")
	}
}

// The command path shares the rule, and reports it as a refusal.
func TestIsolateCommandCannotChangePolicyAtSameGeneration(t *testing.T) {
	h := newHarness(t)
	h.heldPolicy(2)
	p := h.payload(idA, 2, 72*time.Hour)
	p["parameters"].(map[string]any)["policyRevision"] = revB
	out := h.m.HandleIsolate(context.Background(), p)
	if !out.Failed() || out.ErrorCode != wire.ErrCodeIsolationInvalidSpec {
		t.Fatalf("outcome %+v", out)
	}
	if got := policyEvents(h.journal(), "policy_rejected"); len(got) != 1 || got[0].Detail != string(PolicyRejectRevisionRegressed) {
		t.Fatalf("policy_rejected events %+v", got)
	}
}

// A release never depends on the policy: a tombstone ends the episode whatever
// revision the agent holds or the tombstone carries.
func TestPolicyDoesNotGateRelease(t *testing.T) {
	h := newHarness(t)
	h.heldPolicy(2)
	block := h.desired(idA, 2, DesiredReleased, time.Hour, false)
	block.NetworkIsolation.PolicyRevision = malformedPolicyRevision
	h.m.Reconcile(context.Background(), block)
	if h.m.Active() || h.journal().Phase != journal.PhaseReleased {
		t.Fatalf("the tombstone did not release: phase %s", h.journal().Phase)
	}
}

func TestNotePolicyRejected(t *testing.T) {
	ctx := context.Background()
	t.Run("an inert agent with no journal writes none", func(t *testing.T) {
		h := newHarness(t)
		h.iso.set(func(f *fakeIsolator) { f.cap = Capability{Mechanism: "wfp", UnsupportedReason: "not_activated"} })
		h.m.NotePolicyRejected(ctx, idA, 1, PolicyRejectRevisionMissing)
		if _, err := journal.Load(journal.Path(h.dir)); err == nil {
			t.Fatal("capability 0 created a journal")
		}
	})
	t.Run("a capable agent reports it in the absent form", func(t *testing.T) {
		h := newHarness(t)
		h.m.NotePolicyRejected(ctx, idA, 4, PolicyRejectRevisionMissing)
		r := h.m.Report()
		if r == nil || r.IsolationID != "" || r.Phase != journal.PhaseNone || len(r.Events) != 1 {
			t.Fatalf("report %+v", r)
		}
		if e := r.Events[0]; e.Type != "policy_rejected" || e.Detail != string(PolicyRejectRevisionMissing) || e.IsolationID != idA || e.Generation != 4 {
			t.Fatalf("event %+v", e)
		}
		if h.m.Active() {
			t.Fatal("a rejection activated isolation")
		}
	})
	t.Run("an unvalidated identity is not journalled", func(t *testing.T) {
		// The server's report schema requires a UUID here; one bad value would
		// cost the whole report.
		h := newHarness(t)
		h.m.NotePolicyRejected(ctx, "not-a-uuid", 4, PolicyRejectSpecInvalid)
		h.m.NotePolicyRejected(ctx, idA, -1, PolicyRejectSpecInvalid)
		evs := h.m.Report().Events
		if len(evs) != 2 || evs[0].IsolationID != "" || evs[0].Generation != 0 || evs[1].IsolationID != idA || evs[1].Generation != 0 {
			t.Fatalf("events %+v", evs)
		}
	})
	t.Run("an unreadable journal is not overwritten", func(t *testing.T) {
		// Replacing it would forget that rules may exist with no episode to explain them.
		h := newHarness(t)
		if err := os.WriteFile(journal.Path(h.dir), []byte("{not json"), 0o600); err != nil {
			t.Fatal(err)
		}
		h.m.NotePolicyRejected(ctx, idA, 1, PolicyRejectRevisionMissing)
		if b, err := os.ReadFile(journal.Path(h.dir)); err != nil || string(b) != "{not json" {
			t.Fatalf("journal rewritten: %q err=%v", b, err)
		}
	})
}
