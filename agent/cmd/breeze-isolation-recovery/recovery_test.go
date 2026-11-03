package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"reflect"
	"testing"
)

type fakeRecovery struct {
	calls []string
	err   error
}

func (f *fakeRecovery) RecoveryExpireCheck(context.Context) error {
	f.calls = append(f.calls, "expire-check")
	return f.err
}
func (f *fakeRecovery) BootApply(context.Context) error {
	f.calls = append(f.calls, "boot-apply")
	return f.err
}
func (f *fakeRecovery) RollbackIfUncommitted(_ context.Context, attempt string) error {
	f.calls = append(f.calls, "rollback:"+attempt)
	return f.err
}
func (f *fakeRecovery) ReleaseAll(_ context.Context, reason string) error {
	f.calls = append(f.calls, "release:"+reason)
	return f.err
}

func TestRecoveryDispatchAndFailureExit(t *testing.T) {
	for _, tc := range []struct {
		args []string
		call string
	}{
		{[]string{"expire-check"}, "expire-check"},
		{[]string{"boot-apply"}, "boot-apply"},
		{[]string{"rollback-if-uncommitted", "--attempt", "attempt-id"}, "rollback:attempt-id"},
		{[]string{"release-all", "--reason", "uninstall"}, "release:uninstall"},
	} {
		for _, failure := range []bool{false, true} {
			t.Run(tc.call+map[bool]string{false: "/success", true: "/failure"}[failure], func(t *testing.T) {
				fake := &fakeRecovery{}
				if failure {
					fake.err = errors.New("cleanup not confirmed")
				}
				dir := t.TempDir()
				deps := recoveryDependencies{manager: func(got string) (recoveryManager, error) {
					if got != dir {
						t.Fatalf("dir=%q", got)
					}
					return fake, nil
				}}
				var out, errOut bytes.Buffer
				got := runWithDependencies(append(tc.args, "--data-dir", dir), &out, &errOut, deps)
				want := 0
				if failure {
					want = 1
				}
				if got != want {
					t.Fatalf("exit=%d want=%d stderr=%s", got, want, errOut.String())
				}
				if !reflect.DeepEqual(fake.calls, []string{tc.call}) {
					t.Fatal(fake.calls)
				}
			})
		}
	}
}

type fakeRecoveryEngine struct {
	err   error
	calls int
}

func (f *fakeRecoveryEngine) Owned(context.Context) (bool, error) { f.calls++; return true, f.err }

func TestRecoverySelfTestChecksEngineAndReadableDirectoryWithoutEffects(t *testing.T) {
	for _, mode := range []string{"ready", "engine unavailable", "directory unavailable"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			engine := &fakeRecoveryEngine{}
			if mode == "engine unavailable" {
				engine.err = errors.New("engine unavailable")
			}
			target := dir
			if mode == "directory unavailable" {
				target += "/absent"
			}
			err := recoverySelfTest(context.Background(), engine, target)
			if (err != nil) != (mode != "ready") {
				t.Fatalf("error=%v", err)
			}
			entries, readErr := os.ReadDir(dir)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if len(entries) != 0 {
				t.Fatal("self-test wrote state")
			}
		})
	}
}

func TestRecoverySelfTestDispatchIgnoresActivation(t *testing.T) {
	called := false
	deps := recoveryDependencies{selfTest: func(context.Context) error { called = true; return nil }}
	var out, errOut bytes.Buffer
	if got := runWithDependencies([]string{"self-test"}, &out, &errOut, deps); got != 0 || !called {
		t.Fatalf("self-test exit=%d called=%v", got, called)
	}
}

func TestRecoveryJournalSchemaQuery(t *testing.T) {
	var out, errOut bytes.Buffer
	if got := run([]string{"--journal-schema"}, &out, &errOut); got != 0 {
		t.Fatalf("schema query exit=%d stderr=%s", got, errOut.String())
	}
	if out.String() != "1\n" {
		t.Fatalf("schema query=%q", out.String())
	}
	if got := run([]string{"--journal-schema", "extra"}, &out, &errOut); got != 2 {
		t.Fatalf("extra schema query arg exit=%d", got)
	}
}
