//go:build darwin

package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
)

type fakeDarwinOps struct {
	calls []string
	err   error
}

func (f *fakeDarwinOps) RecoveryExpireCheck(context.Context) error {
	f.calls = append(f.calls, "expire-check")
	return f.err
}
func (f *fakeDarwinOps) DarwinBootApply(context.Context) error {
	f.calls = append(f.calls, "darwin-boot-apply")
	return f.err
}
func (f *fakeDarwinOps) DarwinRollbackIfOverdue(_ context.Context, attempt string) error {
	f.calls = append(f.calls, "darwin-rollback-if-overdue "+attempt)
	return f.err
}
func (f *fakeDarwinOps) ReleaseAll(_ context.Context, reason string) error {
	f.calls = append(f.calls, "release-all "+reason)
	return f.err
}

// launchd runs one command line for RunAtLoad and for every StartInterval, so
// on macOS boot-apply and the rollback job must be the deadline-aware variants:
// the OS-neutral ones would roll back an apply that is still inside its window.
func TestDarwinSubcommandsUseTheLaunchdSafeOperations(t *testing.T) {
	for args, want := range map[string]string{
		"boot-apply --data-dir /x":                           "darwin-boot-apply",
		"expire-check --data-dir /x":                         "expire-check",
		"rollback-if-uncommitted --data-dir /x --attempt a1": "darwin-rollback-if-overdue a1",
		"release-all --data-dir /x --reason uninstall":       "release-all uninstall",
	} {
		t.Run(args, func(t *testing.T) {
			ops := &fakeDarwinOps{}
			var gotDir string
			deps := darwinRecoveryDependencies(func(dataDir string) darwinRecoveryOps { gotDir = dataDir; return ops }, func(context.Context) error { return nil })
			var out, errOut bytes.Buffer
			if code := runWithDependencies(strings.Fields(args), &out, &errOut, deps); code != 0 {
				t.Fatalf("exit %d: %s", code, errOut.String())
			}
			if gotDir != "/x" || strings.Join(ops.calls, ";") != want {
				t.Fatalf("dir %q calls %v, want %s", gotDir, ops.calls, want)
			}
		})
	}
}

func TestDarwinOperationFailureExitsNonZero(t *testing.T) {
	ops := &fakeDarwinOps{err: errors.New("pf refused")}
	deps := darwinRecoveryDependencies(func(string) darwinRecoveryOps { return ops }, nil)
	var out, errOut bytes.Buffer
	if code := runWithDependencies([]string{"boot-apply", "--data-dir", "/x"}, &out, &errOut, deps); code != 1 || !strings.Contains(errOut.String(), "pf refused") {
		t.Fatalf("exit %d stderr %q", code, errOut.String())
	}
}
