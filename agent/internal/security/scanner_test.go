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
