package main

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/flashguard"
	"github.com/breeze-rmm/agent/internal/watchdog"
)

// The watchdog is a separate process. It sees a section through the state on
// disk, and it must not replace the agent during one.
func TestDoUpdateAgentRefusedDuringSection(t *testing.T) {
	g := flashguard.New(t.TempDir(), flashguard.WithLockWait(50*time.Millisecond))
	t.Cleanup(flashguard.SetDefault(g))
	if _, err := g.Enter("bios", "cmd-1", time.Hour); err != nil {
		t.Fatalf("Enter: %v", err)
	}
	journal, err := watchdog.NewJournal(t.TempDir(), 10, 3)
	if err != nil {
		t.Fatalf("NewJournal: %v", err)
	}
	defer func() { _ = journal.Close() }()

	serverCalled := false
	serverURL := func() string { serverCalled = true; return "https://example.invalid" }

	err = doUpdateAgent("9.9.9", serverURL, &tokenHolder{}, journal)
	if !errors.Is(err, flashguard.ErrFlashInProgress) {
		t.Fatalf("doUpdateAgent = %v, want ErrFlashInProgress", err)
	}
	if serverCalled {
		t.Fatal("a refused update must not reach for the server")
	}
	if msg := failoverUpdateErrMsg(err); !strings.Contains(msg, "firmware update") {
		t.Fatalf("the failover result should say why, got %q", msg)
	}
}

func TestDoUpdateAgentWithNoSectionIsUnchanged(t *testing.T) {
	g := flashguard.New(t.TempDir(), flashguard.WithLockWait(50*time.Millisecond))
	t.Cleanup(flashguard.SetDefault(g))
	journal, err := watchdog.NewJournal(t.TempDir(), 10, 3)
	if err != nil {
		t.Fatalf("NewJournal: %v", err)
	}
	defer func() { _ = journal.Close() }()

	err = doUpdateAgent("9.9.9", func() string { return "https://example.invalid" }, &tokenHolder{}, journal)
	if err == nil || !strings.Contains(err.Error(), "no auth token") {
		t.Fatalf("doUpdateAgent = %v, want its existing missing-token failure", err)
	}
	// It let go of its admission on the way out.
	release, err := g.Enter("bios", "cmd-1", time.Hour)
	if err != nil {
		t.Fatalf("Enter after a failed update: %v", err)
	}
	_ = release()
}
