package collectors

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestRunCollectorOutputExportCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	_, err = RunCollectorOutput(ctx, time.Second, exe, "-test.run=^$")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("context lost: %v", err)
	}
}
