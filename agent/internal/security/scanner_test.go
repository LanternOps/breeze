package security

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestScanWithContextReportsTimeout(t *testing.T) {
	s := &SecurityScanner{Timeout: time.Nanosecond}
	out, err := s.ScanWithContext(context.Background(), "custom", []string{t.TempDir()})
	if err != nil {
		t.Fatalf("ScanWithContext returned err %v; a deadline is an outcome, not an error", err)
	}
	if !out.TimedOut || !out.Partial {
		t.Fatalf("TimedOut=%v Partial=%v, want both true", out.TimedOut, out.Partial)
	}
}

func TestScanWithContextRejectsUnknownScanType(t *testing.T) {
	s := &SecurityScanner{}
	if _, err := s.ScanWithContext(context.Background(), "sideways", nil); err == nil {
		t.Fatal("expected an error for an unsupported scanType")
	}
}

func TestScanWithContextCustomRequiresPaths(t *testing.T) {
	s := &SecurityScanner{}
	if _, err := s.ScanWithContext(context.Background(), "custom", nil); err == nil {
		t.Fatal("expected an error for a custom scan with no paths")
	}
}

func TestScanWithContextAutoQuarantinesWhenEnabled(t *testing.T) {
	root := t.TempDir()
	victim := filepath.Join(root, avTestToken()+".com")
	if err := os.WriteFile(victim, []byte(avTestContent()), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	s := &SecurityScanner{
		QuarantineDir:  filepath.Join(root, "quarantine"),
		AutoQuarantine: true,
	}
	out, err := s.ScanWithContext(context.Background(), "custom", []string{root})
	if err != nil {
		t.Fatalf("ScanWithContext: %v", err)
	}
	if len(out.Threats) != 1 {
		t.Fatalf("got %d threats, want 1: %+v", len(out.Threats), out.Threats)
	}
	if out.Threats[0].QuarantinedTo == "" || !strings.HasSuffix(out.Threats[0].QuarantinedTo, ".bqz") {
		t.Fatalf("QuarantinedTo = %q, want a .bqz payload path", out.Threats[0].QuarantinedTo)
	}
	if _, err := os.Stat(victim); !os.IsNotExist(err) {
		t.Fatalf("original still on disk: %v", err)
	}
}

func TestScanWithContextFlagsQuarantineFailureDistinctlyFromDisabled(t *testing.T) {
	root := t.TempDir()
	victim := filepath.Join(root, avTestToken()+".com")
	if err := os.WriteFile(victim, []byte(avTestContent()), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	// A regular file where the quarantine directory should be makes
	// os.MkdirAll fail inside QuarantineThreat, forcing the auto-quarantine
	// attempt to error without disabling AutoQuarantine.
	quarantinePath := filepath.Join(root, "quarantine")
	if err := os.WriteFile(quarantinePath, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("write quarantine blocker: %v", err)
	}

	s := &SecurityScanner{
		QuarantineDir:  quarantinePath,
		AutoQuarantine: true,
	}
	out, err := s.ScanWithContext(context.Background(), "custom", []string{root})
	if err != nil {
		t.Fatalf("ScanWithContext: %v", err)
	}
	if len(out.Threats) != 1 {
		t.Fatalf("got %d threats, want 1: %+v", len(out.Threats), out.Threats)
	}
	threat := out.Threats[0]
	if threat.QuarantinedTo != "" {
		t.Fatalf("QuarantinedTo = %q, want empty on a failed quarantine attempt", threat.QuarantinedTo)
	}
	if !threat.QuarantineFailed {
		t.Fatal("QuarantineFailed = false, want true so the server can distinguish this from auto-quarantine-off")
	}
	// The disabled-auto-quarantine case must NOT set QuarantineFailed, or the
	// two states collapse back into being indistinguishable.
	disabled := &SecurityScanner{QuarantineDir: quarantinePath, AutoQuarantine: false}
	disabledOut, err := disabled.ScanWithContext(context.Background(), "custom", []string{root})
	if err != nil {
		t.Fatalf("ScanWithContext (disabled): %v", err)
	}
	if len(disabledOut.Threats) != 1 {
		t.Fatalf("got %d threats, want 1: %+v", len(disabledOut.Threats), disabledOut.Threats)
	}
	if disabledOut.Threats[0].QuarantineFailed {
		t.Fatal("QuarantineFailed = true with AutoQuarantine off, want false")
	}
	if _, err := os.Stat(victim); err != nil {
		t.Fatalf("original should still be on disk after a failed quarantine attempt: %v", err)
	}
}

func TestScanWithContextLeavesThreatsInPlaceWhenDisabled(t *testing.T) {
	root := t.TempDir()
	victim := filepath.Join(root, avTestToken()+".com")
	if err := os.WriteFile(victim, []byte(avTestContent()), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	s := &SecurityScanner{
		QuarantineDir:  filepath.Join(root, "quarantine"),
		AutoQuarantine: false,
	}
	out, err := s.ScanWithContext(context.Background(), "custom", []string{root})
	if err != nil {
		t.Fatalf("ScanWithContext: %v", err)
	}
	if len(out.Threats) != 1 {
		t.Fatalf("got %d threats, want 1: %+v", len(out.Threats), out.Threats)
	}
	if out.Threats[0].QuarantinedTo != "" {
		t.Fatalf("QuarantinedTo = %q, want empty", out.Threats[0].QuarantinedTo)
	}
	if _, err := os.Stat(victim); err != nil {
		t.Fatalf("original should still be on disk: %v", err)
	}
}
