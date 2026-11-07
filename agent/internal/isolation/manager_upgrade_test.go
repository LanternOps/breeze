package isolation

import (
	"bytes"
	"context"
	"errors"
	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"os"
	"reflect"
	"testing"
)

func TestUpgradePermitsSurviveSwapAndStartupPrunesOldPaths(t *testing.T) {
	h := newHarness(t)
	current := []string{"/old/breeze-agent.exe"}
	h.m.deps.BinaryPaths = func() []string { return current }
	h.mustIsolate("11111111-2222-4333-8444-555555555555", 1)
	next := []string{"/new/breeze-agent.exe"}
	if err := h.m.PrepareUpgrade(context.Background(), next, journal.SchemaVersion); err != nil {
		t.Fatal(err)
	}
	want := []string{"/new/breeze-agent.exe", "/old/breeze-agent.exe"}
	if !reflect.DeepEqual(h.iso.spec.BinaryPaths, want) {
		t.Fatalf("across swap: %v", h.iso.spec.BinaryPaths)
	}
	// A recovery tick and an agent refresh cannot discard the staged permits.
	if err := h.m.RecoveryExpireCheck(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.m.OnNetworkChange(context.Background())
	if !reflect.DeepEqual(h.iso.spec.BinaryPaths, want) {
		t.Fatalf("refresh discarded handoff: %v", h.iso.spec.BinaryPaths)
	}
	current = next
	restarted := h.newManager()
	restarted.deps.BinaryPaths = func() []string { return current }
	restarted.Startup(context.Background())
	if !reflect.DeepEqual(h.iso.spec.BinaryPaths, next) {
		t.Fatalf("after startup: %v", h.iso.spec.BinaryPaths)
	}
	if h.journal().Phase != journal.PhaseCommitted {
		t.Fatal("upgrade released isolation")
	}
}

func TestUpgradeRefusesIncompatibleSchemaAndUnverifiedPermits(t *testing.T) {
	for _, failure := range []string{"schema", "probe", "apply"} {
		t.Run(failure, func(t *testing.T) {
			h := newHarness(t)
			h.m.deps.BinaryPaths = func() []string { return []string{"/old/breeze-agent.exe"} }
			h.mustIsolate("11111111-2222-4333-8444-555555555555", 1)
			schema := journal.SchemaVersion
			switch failure {
			case "schema":
				schema++
			case "probe":
				h.verify.err = errors.New("probe failed")
			case "apply":
				h.iso.applyErr = errors.New("apply failed")
			}
			if err := h.m.PrepareUpgrade(context.Background(), []string{"/new/breeze-agent.exe"}, schema); err == nil {
				t.Fatal("unsafe upgrade accepted")
			}
		})
	}
}

func TestUpgradeSamePathChecksSchemaWithoutApplying(t *testing.T) {
	h := newHarness(t)
	bins := []string{"/installed/breeze-agent.exe"}
	h.m.deps.BinaryPaths = func() []string { return bins }
	h.mustIsolate("11111111-2222-4333-8444-555555555555", 1)
	before := h.iso.applies
	if err := h.m.PrepareUpgrade(context.Background(), bins, journal.SchemaVersion); err != nil {
		t.Fatal(err)
	}
	if h.iso.applies != before {
		t.Fatal("same-path update changed rules")
	}
	if err := h.m.PrepareUpgrade(context.Background(), bins, journal.SchemaVersion+1); err == nil {
		t.Fatal("same-path update bypassed schema gate")
	}
}

func TestUpgradeRefusesUnreadableJournalWithoutResettingIt(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate("11111111-2222-4333-8444-555555555555", 1)
	contents := []byte(`{"schemaVersion":999,"phase":"committed","nextSeq":1}`)
	if err := os.WriteFile(h.m.path(), contents, 0600); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 2; n++ {
		if err := h.m.PrepareUpgrade(context.Background(), []string{"/installed/breeze-agent.exe"}, journal.SchemaVersion); err == nil {
			t.Fatal("unknown journal accepted")
		}
		if !h.m.Active() {
			t.Fatal("failed handoff disabled subsequent isolation gating")
		}
	}
	got, err := os.ReadFile(h.m.path())
	if err != nil || !bytes.Equal(got, contents) {
		t.Fatalf("journal changed: %s %v", got, err)
	}
}
