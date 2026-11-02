package isolation

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

var errCrash = errors.New("simulated crash")

// crashAt makes the manager die (stop with no further journal writes or
// effects) right before its n-th effect, counted from 0.
func crashAt(m *Manager, n int) *int {
	count := 0
	m.beforeEffect = func(Effect) error {
		defer func() { count++ }()
		if count == n {
			return errCrash
		}
		return nil
	}
	return &count
}

// endStateOK: verified-isolated (journal committed, the installed rules are
// the journalled ones) or confirmed-absent (no Breeze rule, terminal or empty
// journal).
func endStateOK(t *testing.T, h *harness, label string) {
	t.Helper()
	j := h.journal()
	installed, _, digest := h.iso.state()
	switch {
	case j.Phase == journal.PhaseCommitted && installed && j.Episode != nil && string(digest) == j.Episode.RuleDigest && j.AttemptID == "":
	case !installed && (j.Phase == journal.PhaseNone || j.Phase == journal.PhaseReleased || j.Phase == journal.PhaseRolledBack):
	default:
		t.Fatalf("%s: neither verified-isolated nor confirmed-absent: phase=%s installed=%v digest=%s journal=%+v attempt=%q",
			label, j.Phase, installed, digest, j.Episode, j.AttemptID)
	}
}

type scenario struct {
	name  string
	setup func(h *harness) // runs uncrashed
	op    func(h *harness) // the operation crashed at each effect index
}

func crashScenarios() []scenario {
	return []scenario{
		{"apply", func(*harness) {}, func(h *harness) { h.isolate(idA, 1) }},
		{"release", func(h *harness) { h.mustIsolate(idA, 1) }, func(h *harness) {
			h.m.HandleRelease(context.Background(), map[string]any{"isolationId": idA, "generation": float64(2)})
		}},
		{"extend", func(h *harness) { h.mustIsolate(idA, 1) }, func(h *harness) {
			h.m.HandleIsolate(context.Background(), h.payload(idA, 2, 100*time.Hour))
		}},
		{"refresh", func(h *harness) {
			h.mustIsolate(idA, 1)
			h.lookup.set(controlHost, "192.0.2.77")
			h.clock.Advance(ReverifyInterval)
		}, func(h *harness) { h.m.Tick(context.Background()) }},
		{"expiry", func(h *harness) {
			h.mustIsolate(idA, 1)
			h.clock.Advance(72 * time.Hour)
		}, func(h *harness) { h.m.Tick(context.Background()) }},
		{"local release", func(h *harness) { h.mustIsolate(idA, 1) }, func(h *harness) {
			_ = h.m.LocalRelease(context.Background(), "", true)
		}},
	}
}

func TestManagerCrashAtEveryEffect(t *testing.T) {
	for _, sc := range crashScenarios() {
		// Count the effects of an uncrashed run.
		ref := newHarness(t)
		sc.setup(ref)
		counter := crashAt(ref.m, -1)
		sc.op(ref)
		total := *counter
		if total == 0 {
			t.Fatalf("%s: the operation ran no effects", sc.name)
		}
		for n := 0; n < total; n++ {
			label := fmt.Sprintf("%s crash before effect %d/%d", sc.name, n, total)
			t.Run(label, func(t *testing.T) {
				h := newHarness(t)
				sc.setup(h)
				crashAt(h.m, n)
				sc.op(h)

				// Restart: a new manager over the same kernel and journal.
				h.m = h.newManager()
				ctx := context.Background()
				h.m.Startup(ctx)
				h.m.Tick(ctx)
				h.clock.Advance(ProvisionalWindow + time.Second)
				h.m.Tick(ctx)
				endStateOK(t, h, label)
			})
		}
	}
}

// A crash leaves a journal the next process can read: never a torn file.
func TestManagerCrashNeverLeavesUnreadableJournal(t *testing.T) {
	h := newHarness(t)
	crashAt(h.m, 2)
	h.isolate(idA, 1)
	if _, err := journal.Load(journal.Path(h.dir)); err != nil {
		t.Fatalf("journal unreadable after crash: %v", err)
	}
}
