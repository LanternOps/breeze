package isolation

import (
	"fmt"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/wire"
)

// An isolator that refuses because the host cannot safely host its rules (the
// pf compatibility check) changed nothing. The console must show
// mechanism_unavailable with the reason, not an apply_error with a rollback.
func TestManagerReportsAnIncompatibleHostAsMechanismUnavailable(t *testing.T) {
	h := newHarness(t)
	reason := "attaching would destroy the anchor com.apple.internet-sharing"
	h.iso.set(func(f *fakeIsolator) { f.applyErr = fmt.Errorf("apply: %w", ErrIncompatible{Reason: reason}) })
	out := h.isolate(idA, 1)
	if !out.Failed() || out.ErrorCode != wire.ErrCodeIsolationMechanismUnavailable || out.Result == nil ||
		out.Result.FailureCode != FailMechanismUnavailable || out.Result.State != StateFailed {
		t.Fatalf("outcome %+v result %+v", out, out.Result)
	}
	if out.Result.Rollback {
		t.Fatal("nothing was installed, so nothing was rolled back")
	}
	if !strings.Contains(out.Error, reason) {
		t.Fatalf("the reason must reach the console: %q", out.Error)
	}
	j := h.journal()
	if j.Phase != journal.PhaseRolledBack || !containsStr(eventTypes(j), "failed_"+FailMechanismUnavailable) {
		t.Fatalf("phase %s events %v", j.Phase, eventTypes(j))
	}
}
