package isolation

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
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
	t.Run("no policy leaves no revision, and a malformed one is not journalled", func(t *testing.T) {
		h := newHarness(t)
		p := h.payload(idA, 1, 72*time.Hour)
		p["parameters"].(map[string]any)["policyRevision"] = true
		if out := h.m.HandleIsolate(context.Background(), p); out.Failed() {
			t.Fatalf("isolate: %+v", out)
		}
		if ep := h.journal().Episode; ep.PolicyRevision != "" || ep.PolicyGeneration != 1 {
			t.Fatalf("episode %+v", ep)
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
