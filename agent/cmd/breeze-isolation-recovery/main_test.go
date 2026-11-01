package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation"
)

func TestRecoveryArgumentValidation(t *testing.T) {
	dir := t.TempDir()
	for _, tc := range []struct {
		name string
		args []string
	}{
		{"missing command", nil}, {"unknown command", []string{"unknown"}},
		{"extra version argument", []string{"--version", "extra"}},
		{"self-test extra argument", []string{"self-test", "extra"}},
		{"missing data dir", []string{"expire-check"}},
		{"blank data dir", []string{"boot-apply", "--data-dir", " "}},
		{"missing attempt", []string{"rollback-if-uncommitted", "--data-dir", dir}},
		{"missing reason", []string{"release-all", "--data-dir", dir}},
		{"unknown flag", []string{"boot-apply", "--data-dir", dir, "--unknown"}},
		{"unexpected position", []string{"expire-check", "--data-dir", dir, "extra"}},
		{"wrong command flag", []string{"expire-check", "--data-dir", dir, "--attempt", "a"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out, errOut bytes.Buffer
			if got := run(tc.args, &out, &errOut); got != 2 {
				t.Fatalf("exit = %d, want 2", got)
			}
			if errOut.Len() == 0 {
				t.Fatal("missing argument error")
			}
		})
	}
}

func TestRecoveryVersion(t *testing.T) {
	var out, errOut bytes.Buffer
	if got := run([]string{"--version"}, &out, &errOut); got != 0 {
		t.Fatalf("exit = %d", got)
	}
	if !strings.Contains(out.String(), version) || errOut.Len() != 0 {
		t.Fatal("unexpected version output")
	}
}

func TestRecoverySelfTestUnsupported(t *testing.T) {
	cap := isolation.NewPlatformIsolator().Capability()
	var out, errOut bytes.Buffer
	got := run([]string{"self-test"}, &out, &errOut)
	if cap.Version >= 1 {
		if got != 0 {
			t.Fatal("capable platform failed self-test")
		}
		return
	}
	if got == 0 || !strings.Contains(errOut.String(), cap.UnsupportedReason) {
		t.Fatal("unsupported platform silently passed self-test")
	}
}

func TestRecoveryOperationsDoNotSilentlySucceed(t *testing.T) {
	dir := t.TempDir()
	for _, args := range [][]string{
		{"expire-check", "--data-dir", dir}, {"boot-apply", "--data-dir", dir},
		{"rollback-if-uncommitted", "--data-dir", dir, "--attempt", "test-attempt"},
		{"release-all", "--data-dir", dir, "--reason", "system"},
	} {
		t.Run(args[0], func(t *testing.T) {
			var out, errOut bytes.Buffer
			if got := run(args, &out, &errOut); got != 1 {
				t.Fatalf("exit = %d, want 1", got)
			}
			if !strings.Contains(errOut.String(), "not implemented on this platform yet (W1g)") {
				t.Fatal("unsupported operation lacks a clear error")
			}
		})
	}
}
