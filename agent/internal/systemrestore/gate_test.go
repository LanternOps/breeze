package systemrestore

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/vss"
)

// The real gate, not a fake: a backup holding the VSS creation gate must make
// a checkpoint report busy once the caller's wait budget runs out.
func TestWithSnapshotGateReportsBusyWhileABackupHoldsTheGate(t *testing.T) {
	release, err := vss.AcquireSnapshotCreation(context.Background())
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer release()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	ran := false
	out := withSnapshotGate(ctx, func() Outcome { ran = true; return Outcome{Status: StatusCreated} })
	if ran {
		t.Fatal("the checkpoint ran while the backup held the gate")
	}
	if out.Status != StatusBusy {
		t.Fatalf("Status = %q, want %q", out.Status, StatusBusy)
	}
}

func TestWithSnapshotGateHoldsTheGateForTheDurationAndReleasesIt(t *testing.T) {
	out := withSnapshotGate(context.Background(), func() Outcome {
		if !vss.SnapshotCreationBusy() {
			t.Error("the gate was not held while the checkpoint ran")
		}
		return Outcome{Status: StatusCreated}
	})
	if out.Status != StatusCreated {
		t.Fatalf("Status = %q, want %q", out.Status, StatusCreated)
	}
	if vss.SnapshotCreationBusy() {
		t.Fatal("the gate is still held after the checkpoint returned")
	}
}

func TestWithSnapshotGateCapsTheWaitEvenWithABackgroundContext(t *testing.T) {
	// The legacy patch caller passes context.Background(); gateWaitBudget is
	// then the only bound on how long an update waits behind a backup.
	prev := gateWaitBudget
	gateWaitBudget = 30 * time.Millisecond
	t.Cleanup(func() { gateWaitBudget = prev })

	release, err := vss.AcquireSnapshotCreation(context.Background())
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer release()

	start := time.Now()
	out := withSnapshotGate(context.Background(), func() Outcome { return Outcome{Status: StatusCreated} })
	if out.Status != StatusBusy {
		t.Fatalf("Status = %q, want %q", out.Status, StatusBusy)
	}
	if time.Since(start) > time.Second {
		t.Fatal("the gate wait ignored gateWaitBudget")
	}
}

func TestWithSnapshotGateReportsACallerCancellationAsSuch(t *testing.T) {
	prev := acquireGate
	t.Cleanup(func() { acquireGate = prev })
	acquireGate = func(ctx context.Context) (func(), error) { <-ctx.Done(); return nil, ctx.Err() }

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out := withSnapshotGate(ctx, func() Outcome { return Outcome{Status: StatusCreated} })
	if out.Status != StatusFailed || !strings.Contains(out.Message, "cancel") {
		t.Fatalf("a cancelled caller must not read as a busy gate: %+v", out)
	}
}
