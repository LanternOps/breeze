package heartbeat

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/networkdiagnostic"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func TestTopologyDiagnosticRejectsMalformedBeforeOpeningJournal(t *testing.T) {
	h := &Heartbeat{}
	got := handleTopologyDiagnostic(h, Command{ID: "x", Type: tools.CmdNetworkDiagnostic, Payload: map[string]any{"version": 1}})
	if got.Status != "failed" || h.topologyDiagnosticJournal != nil {
		t.Fatal(got)
	}
}
func TestTopologyDiagnosticCancelPersistsBeforeAcknowledgment(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal")
	j, err := networkdiagnostic.OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	commandID := "11111111-1111-4111-8111-111111111111"
	runID := "22222222-2222-4222-8222-222222222222"
	attemptID := "33333333-3333-4333-8333-333333333333"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := &Heartbeat{topologyDiagnosticJournal: j, topologyDiagnosticActive: map[string]activeTopologyDiagnostic{commandID: {runID, attemptID, cancel}}}
	got := handleTopologyDiagnosticCancel(h, Command{Type: tools.CmdNetworkDiagnosticCancel, Payload: map[string]any{"version": 1, "runId": runID, "attemptId": attemptID, "commandId": commandID}})
	if got.Status != "completed" || ctx.Err() == nil {
		t.Fatal(got, ctx.Err())
	}
	if err = j.Close(); err != nil {
		t.Fatal(err)
	}
	j, err = networkdiagnostic.OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = j.Close() }()
	if _, err = j.Accept(networkdiagnostic.Command{CommandID: commandID, RunID: runID, AttemptID: attemptID}); err != networkdiagnostic.ErrCancelled {
		t.Fatal(err)
	}
}
func TestTopologyDiagnosticCancelInvalidDoesNotOpenJournal(t *testing.T) {
	h := &Heartbeat{}
	got := handleTopologyDiagnosticCancel(h, Command{Payload: map[string]any{"version": 1, "runId": "bad", "attemptId": "bad", "commandId": "bad"}})
	if got.Status != "failed" || h.topologyDiagnosticJournal != nil {
		t.Fatal(got)
	}
}
