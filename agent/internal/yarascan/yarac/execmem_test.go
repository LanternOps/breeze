package yarac

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestExecutableMemoryDecision(t *testing.T) {
	readFailed := errors.New("csops failed")
	cases := []struct {
		name    string
		cs      codeSigning
		readErr error
		denied  bool
	}{
		{"no hardened runtime (linker/ad-hoc signed, Linux, Windows)", codeSigning{}, nil, false},
		{"hardened runtime without the entitlement", codeSigning{enforced: true}, nil, true},
		{"hardened runtime with allow-jit only (wazero does not use MAP_JIT)", codeSigning{enforced: true, allowJIT: true}, nil, true},
		{"hardened runtime with allow-unsigned-executable-memory", codeSigning{enforced: true, allowUnsignedExecutableMemory: true}, nil, false},
		{"hardened runtime with disable-executable-page-protection", codeSigning{enforced: true, disableExecutablePageProtection: true}, nil, false},
		{"code-signing state unreadable fails closed", codeSigning{}, readFailed, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := executableMemoryDecision(tc.cs, tc.readErr)
			if got := errors.Is(err, ErrExecutableMemoryDenied); got != tc.denied {
				t.Fatalf("denied = %v (err %v), want %v", got, err, tc.denied)
			}
			if tc.denied && !strings.Contains(err.Error(), EntitlementAllowUnsignedExecutableMemory) {
				t.Fatalf("denial must name the missing entitlement so an operator can act on it: %v", err)
			}
		})
	}
}

// EnsureEngine runs once per process, so the wiring check runs in a fresh
// child where it is the first engine call.
func TestEnsureEngineRefusesBeforeInitialiseWhenExecutableMemoryDenied(t *testing.T) {
	if os.Getenv("BREEZE_YARAC_EXECMEM_CHILD") == "1" {
		readCodeSigning = func() (codeSigning, error) { return codeSigning{enforced: true}, nil }
		initialised := false
		initialiseEngine = func() error { initialised = true; return nil }
		err := EnsureEngine()
		if !errors.Is(err, ErrExecutableMemoryDenied) {
			fmt.Println("NOT_DENIED", err)
			os.Exit(3)
		}
		if initialised {
			fmt.Println("INITIALISED_ANYWAY")
			os.Exit(4)
		}
		errs := ValidateSet(set("s", r("fixture_marker", markerRule)), DefaultPolicy)
		if len(errs) != 1 || errs[0].Code != CodeEngine || !strings.Contains(errs[0].Message, EntitlementAllowUnsignedExecutableMemory) {
			fmt.Println("VALIDATE_NOT_ENGINE_ERROR", errs)
			os.Exit(5)
		}
		if _, setErrs, err := CompileSets([]Set{set("s", r("fixture_marker", markerRule))}, DefaultPolicy); err == nil && len(setErrs) == 0 {
			fmt.Println("COMPILE_SUCCEEDED")
			os.Exit(6)
		}
		os.Exit(0)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestEnsureEngineRefusesBeforeInitialiseWhenExecutableMemoryDenied$")
	cmd.Env = append(os.Environ(), "BREEZE_YARAC_EXECMEM_CHILD=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child failed (%v): %s", err, out)
	}
}
