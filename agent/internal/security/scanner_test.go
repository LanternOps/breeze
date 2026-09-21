package security

import (
	"context"
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
