package yarac

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	yx "github.com/niallnsec/yaraxwasm"
)

const stderrChildEnv = "BREEZE_YARAC_STDERR_CHILD"

// closedStderr returns an *os.File whose handle is no longer valid. It stands
// in for the stderr a Windows service inherits: no console, so the handle the
// runtime wraps as os.Stderr fails GetFileType ("The handle is invalid", #9253).
// A closed file fails Stat the same way on every OS, which is the call wazero
// makes on the WASI stderr writer while instantiating the guest module.
func closedStderr(t *testing.T) *os.File {
	t.Helper()
	f, err := os.Create(filepath.Join(t.TempDir(), "stderr"))
	if err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	return f
}

// #9253: on a Windows service the YARA-X engine never started because
// yaraxwasm hands os.Stderr to the WASI guest and that handle is invalid
// without a console. The engine loads once per process, so this runs in a
// fresh child whose os.Stderr is unusable from the start. One child carries
// both halves (each extra child pays a full guest compile, which is slow
// under -race): the control first shows yaraxwasm failing exactly as in the
// field with no guard, then EnsureEngine must make the same process work.
func TestEngineStartsWithUnusableStderr(t *testing.T) {
	if os.Getenv(stderrChildEnv) == "1" {
		os.Stderr = closedStderr(t)

		// Control — no guard yet. yaraxwasm compiles the guest, then fails to
		// instantiate it. Without this failure a pass below proves nothing.
		ctlErr := func() (err error) {
			defer func() {
				if r := recover(); r != nil {
					err = fmt.Errorf("panic: %v", r)
				}
			}()
			_, err = yx.Compile(markerRule)
			return err
		}()
		if ctlErr == nil || !strings.Contains(ctlErr.Error(), "instantiate guest module") {
			fmt.Println("CONTROL_DID_NOT_REPRODUCE", ctlErr)
			os.Exit(2)
		}

		if err := EnsureEngine(); err != nil {
			fmt.Println("ENGINE_ERR", err)
			os.Exit(3)
		}
		if replaced, reason := StderrRedirect(); !replaced || reason == nil {
			fmt.Println("REDIRECT_NOT_REPORTED", replaced, reason)
			os.Exit(4)
		}
		if errs := ValidateSet(set("s", r("fixture_marker", markerRule)), DefaultPolicy); len(errs) != 0 {
			fmt.Println("COMPILE_ERR", errs)
			os.Exit(5)
		}
		rules, setErrs, err := CompileSets([]Set{set("s", r("fixture_marker", markerRule))}, DefaultPolicy)
		if err != nil || len(setErrs) != 0 || rules == nil {
			fmt.Println("COMPILE_SETS_ERR", err, setErrs)
			os.Exit(6)
		}
		s := yx.NewScanner(rules)
		defer s.Destroy()
		res, err := s.ScanFile(td("files/fixture-a.bin"))
		if err != nil || len(res.MatchingRules()) != 1 {
			fmt.Println("SCAN_ERR", err)
			os.Exit(7)
		}
		os.Exit(0)
	}
	// Own deadline, so a hung child fails this test by name instead of
	// eating the package's whole -timeout budget.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestEngineStartsWithUnusableStderr$", "-test.timeout=5m")
	cmd.Env = append(os.Environ(), stderrChildEnv+"=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("engine did not start with an unusable stderr (%v): %s", err, out)
	}
}

func TestEnsureUsableStderrKeepsAWorkingStderr(t *testing.T) {
	orig := os.Stderr
	t.Cleanup(func() { os.Stderr = orig })
	w := filepath.Join(t.TempDir(), "console")
	f, err := os.Create(w)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close() })
	os.Stderr = f

	replaced, reason, err := ensureUsableStderr()
	if err != nil || replaced || reason != nil {
		t.Fatalf("a working stderr must be left alone: replaced=%v reason=%v err=%v", replaced, reason, err)
	}
	if os.Stderr != f {
		t.Fatal("os.Stderr was swapped although it was usable")
	}
}

func TestEnsureUsableStderrReplacesAnUnusableStderr(t *testing.T) {
	orig := os.Stderr
	t.Cleanup(func() { os.Stderr = orig })

	for name, bad := range map[string]*os.File{"closed": closedStderr(t), "nil": nil} {
		t.Run(name, func(t *testing.T) {
			os.Stderr = bad
			replaced, reason, err := ensureUsableStderr()
			if err != nil {
				t.Fatalf("replacement failed: %v", err)
			}
			if !replaced || reason == nil {
				t.Fatalf("want a replacement with the reason it was needed, got replaced=%v reason=%v", replaced, reason)
			}
			if os.Stderr == nil || os.Stderr == bad {
				t.Fatal("os.Stderr was not replaced")
			}
			if _, err := os.Stderr.Stat(); err != nil {
				t.Fatalf("replacement stderr is not usable: %v", err)
			}
			if _, err := fmt.Fprintln(os.Stderr, "discarded"); err != nil {
				t.Fatalf("replacement stderr is not writable: %v", err)
			}
			_ = os.Stderr.Close()
		})
	}
}
