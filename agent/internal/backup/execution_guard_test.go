package backup

import (
	"context"
	"testing"
)

func TestExecutionGuardAcrossManagers(t *testing.T) {
	ctx, release, err := AcquireExecution(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// The helper and its file manager share the same slot through context.
	_, nestedRelease, err := AcquireExecution(ctx)
	if err != nil {
		t.Fatal(err)
	}
	nestedRelease()
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := AcquireExecution(cancelled); err != context.Canceled {
		t.Fatalf("cancelled contender: %v", err)
	}
	release()
	_, releaseNext, err := AcquireExecution(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	releaseNext()
}
