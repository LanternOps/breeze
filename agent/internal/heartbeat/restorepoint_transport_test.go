package heartbeat

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/systemrestore"
	"github.com/breeze-rmm/agent/internal/websocket"
)

func TestToWSCommandResultCarriesRestorePoint(t *testing.T) {
	out := &systemrestore.Outcome{Status: systemrestore.StatusCreated, RequestID: "r1", AttemptedAt: "t", DurationMs: 5}
	ws := toWSCommandResult("cmd-1", tools.CommandResult{Status: "completed", RestorePoint: out})
	if ws.RestorePoint == nil {
		t.Fatal("RestorePoint was dropped by the WS conversion")
	}
	if ws.RestorePoint.RequestID != "r1" || ws.RestorePoint.Status != systemrestore.StatusCreated {
		t.Fatalf("RestorePoint = %+v", ws.RestorePoint)
	}
	b, err := json.Marshal(ws)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(b, &wire); err != nil {
		t.Fatal(err)
	}
	rp, ok := wire["restorePoint"].(map[string]any)
	if !ok || rp["requestId"] != "r1" || rp["status"] != "created" {
		t.Fatalf("wire restorePoint = %v (frame %s)", wire["restorePoint"], b)
	}
}

func TestToWSCommandResultOmitsRestorePointWhenAbsent(t *testing.T) {
	ws := toWSCommandResult("cmd-1", tools.CommandResult{Status: "completed"})
	b, _ := json.Marshal(ws)
	if bytes.Contains(b, []byte("restorePoint")) {
		t.Fatalf("absent RestorePoint must be omitted from the wire form: %s", b)
	}
}

func TestRestorePointDoesNotRideInsideResultOrStdout(t *testing.T) {
	// Script and software-install results already use Stdout for their own
	// payloads with type-specific server parsers. Smuggling the outcome in
	// there would break those parsers; it is a dedicated top-level field.
	out := &systemrestore.Outcome{Status: systemrestore.StatusCreated, RequestID: "r1", AttemptedAt: "t"}
	ws := toWSCommandResult("cmd-1", tools.CommandResult{Status: "completed", Stdout: `{"success":true}`, RestorePoint: out})
	b, _ := json.Marshal(ws.Result)
	if bytes.Contains(b, []byte("restorePoint")) {
		t.Fatalf("restorePoint must not be merged into Result: %s", b)
	}
	if bytes.Contains([]byte(ws.Stdout), []byte("restorePoint")) {
		t.Fatalf("restorePoint must not be merged into Stdout: %s", ws.Stdout)
	}
}

func TestOutboxedResultKeepsRestorePointAcrossFlush(t *testing.T) {
	// A REST-undeliverable result falls back to the outbox (#8296) and is
	// flushed on the next connect, possibly after an agent restart. The
	// outcome must survive that disk round trip or the ledger row stays
	// `requested` forever.
	o := newBackupResultOutbox(filepath.Join(t.TempDir(), "outbox"))
	out := &systemrestore.Outcome{Status: systemrestore.StatusExistingAccepted, RequestID: "11111111-2222-4333-8444-555555555555", AttemptedAt: "t", FrequencyMinutes: 1440}
	if !o.Enqueue(toWSCommandResult("11111111-aaaa-4bbb-8ccc-dddddddddddd", tools.CommandResult{Status: "completed", RestorePoint: out})) {
		t.Fatal("enqueue failed")
	}
	var flushed []websocket.CommandResult
	o.Flush(func(r websocket.CommandResult) error { flushed = append(flushed, r); return nil })
	if len(flushed) != 1 || flushed[0].RestorePoint == nil {
		t.Fatalf("flushed = %+v, want one result carrying RestorePoint", flushed)
	}
	if got := flushed[0].RestorePoint; got.RequestID != out.RequestID || got.Status != out.Status || got.FrequencyMinutes != 1440 {
		t.Fatalf("RestorePoint after the outbox round trip = %+v", got)
	}
}

func TestRESTResultBodyCarriesRestorePoint(t *testing.T) {
	// submitCommandResult marshals tools.CommandResult directly as the REST
	// body, so the field tag on CommandResult IS the REST wire contract.
	out := &systemrestore.Outcome{Status: systemrestore.StatusSkippedNoMutation, RequestID: "r2", AttemptedAt: "t"}
	b, err := json.Marshal(tools.CommandResult{Status: "failed", RestorePoint: out})
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(b, &body); err != nil {
		t.Fatal(err)
	}
	rp, ok := body["restorePoint"].(map[string]any)
	if !ok || rp["status"] != "skipped_no_mutation" || rp["requestId"] != "r2" {
		t.Fatalf("REST body restorePoint = %v (%s)", body["restorePoint"], b)
	}
	b, _ = json.Marshal(tools.CommandResult{Status: "completed"})
	if bytes.Contains(b, []byte("restorePoint")) {
		t.Fatalf("absent RestorePoint must be omitted from the REST body: %s", b)
	}
}
