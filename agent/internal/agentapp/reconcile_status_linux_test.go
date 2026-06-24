//go:build linux

package agentapp

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func withTempStatusPath(t *testing.T) {
	t.Helper()
	orig := reconcileStatusPath
	reconcileStatusPath = filepath.Join(t.TempDir(), "reconcile-status")
	t.Cleanup(func() { reconcileStatusPath = orig })
}

func TestReconcileStatusRoundTrip(t *testing.T) {
	withTempStatusPath(t)

	if reason, ok := readReconcileFailure(); ok {
		t.Fatalf("expected no failure recorded initially, got %q", reason)
	}

	recordReconcileFailure("reconcile subcommand: restart: Job failed")
	reason, ok := readReconcileFailure()
	if !ok {
		t.Fatal("expected a recorded failure after recordReconcileFailure")
	}
	if reason != "reconcile subcommand: restart: Job failed" {
		t.Fatalf("unexpected reason %q", reason)
	}

	clearReconcileStatus()
	if _, ok := readReconcileFailure(); ok {
		t.Fatal("expected no failure after clearReconcileStatus")
	}
	// clear is idempotent — a second clear on an absent file must not error/panic.
	clearReconcileStatus()
}

func TestReconcileStatusSanitizesNewlines(t *testing.T) {
	withTempStatusPath(t)

	recordReconcileFailure("line one\nline two")
	reason, ok := readReconcileFailure()
	if !ok {
		t.Fatal("expected a recorded failure")
	}
	// Newlines collapse to spaces so the single-line, tab-delimited breadcrumb
	// (reason \t timestamp) can't be corrupted by a multi-line reason.
	if strings.ContainsAny(reason, "\n\t") {
		t.Fatalf("reason must be a single tab-free line, got %q", reason)
	}
	if reason != "line one line two" {
		t.Fatalf("expected newlines collapsed to spaces, got %q", reason)
	}
}

func TestReadReconcileFailureIgnoresForeignContent(t *testing.T) {
	withTempStatusPath(t)

	if err := os.WriteFile(reconcileStatusPath, []byte("ok\tnothing wrong\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if reason, ok := readReconcileFailure(); ok {
		t.Fatalf("expected non-failure content to be ignored, got %q", reason)
	}
}
