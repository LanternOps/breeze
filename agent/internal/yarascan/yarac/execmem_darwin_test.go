//go:build darwin && cgo

package yarac

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	yx "github.com/niallnsec/yaraxwasm"
)

const hardenedChildEnv = "BREEZE_YARAC_HARDENED_CHILD"

// A `go test` binary is linker-signed (arm64) or unsigned (amd64): no
// hardened runtime, so the probe must read real state and let the engine run.
func TestPlatformCodeSigningOnTestBinary(t *testing.T) {
	if os.Getenv(hardenedChildEnv) != "" {
		t.Skip("parent only")
	}
	cs, err := platformCodeSigning()
	if err != nil {
		t.Fatalf("platformCodeSigning: %v", err)
	}
	if cs.enforced || cs.allowUnsignedExecutableMemory || cs.disableExecutablePageProtection || cs.allowJIT {
		t.Fatalf("unexpected code-signing state for an unhardened test binary: %+v", cs)
	}
	if err := checkExecutableMemory(); err != nil {
		t.Fatalf("unhardened process must be allowed to run the engine: %v", err)
	}
}

// TestHardenedRuntimeYaraEngine re-signs a copy of this test binary ad hoc
// with the hardened runtime and each entitlements file, then runs the real
// engine in it. Ad-hoc signing enforces the same executable-page rule as the
// Developer ID release signature, so this reproduces #10375 on any Mac
// without signing credentials:
//   - the shipped agent entitlements: the engine compiles and scans;
//   - the helpers entitlements (no exception): the guard refuses, no crash;
//   - control, guard bypassed: the kernel SIGKILLs the process — the crash
//     the guard prevents, and proof the ad-hoc signature enforces it;
//   - allow-jit alone, guard bypassed: still SIGKILLed (wazero has no MAP_JIT).
func TestHardenedRuntimeYaraEngine(t *testing.T) {
	if os.Getenv(hardenedChildEnv) != "" {
		t.Skip("parent only")
	}
	if testing.Short() {
		t.Skip("starts the YARA engine in four re-signed child processes")
	}
	if _, err := exec.LookPath("codesign"); err != nil {
		t.Skip("codesign not available")
	}
	agentPlist, err := filepath.Abs("../../../entitlements/agent-macos.entitlements.plist")
	if err != nil {
		t.Fatal(err)
	}
	helpersPlist, err := filepath.Abs("../../../entitlements/helpers-macos.entitlements.plist")
	if err != nil {
		t.Fatal(err)
	}
	jitPlist := filepath.Join(t.TempDir(), "jit.plist")
	if err := os.WriteFile(jitPlist, []byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
`), 0o600); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name, plist, mode string
		wantKilled        bool
	}{
		{"agent entitlements run the engine", agentPlist, "engine", false},
		{"helpers entitlements are refused by the guard", helpersPlist, "guarded", false},
		{"control: helpers entitlements without the guard are killed", helpersPlist, "unguarded", true},
		{"control: allow-jit alone without the guard is killed", jitPlist, "unguarded", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bin := filepath.Join(t.TempDir(), "yarac.test")
			copyExecutable(t, os.Args[0], bin)
			if out, err := exec.Command("codesign", "--force", "--sign", "-", "--options", "runtime",
				"--entitlements", tc.plist, bin).CombinedOutput(); err != nil {
				t.Fatalf("codesign: %v: %s", err, out)
			}
			cmd := exec.Command(bin, "-test.run=^TestHardenedRuntimeChild$")
			cmd.Env = append(os.Environ(), hardenedChildEnv+"="+tc.mode)
			out, err := cmd.CombinedOutput()
			killed := false
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() && ws.Signal() == syscall.SIGKILL {
					killed = true
				}
			}
			if killed != tc.wantKilled {
				t.Fatalf("killed = %v, want %v (err %v): %s", killed, tc.wantKilled, err, out)
			}
			if !tc.wantKilled && err != nil {
				t.Fatalf("child failed: %v: %s", err, out)
			}
		})
	}
}

func copyExecutable(t *testing.T, src, dst string) {
	t.Helper()
	in, err := os.Open(src)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o700)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
}

// TestHardenedRuntimeChild runs inside the re-signed copy.
func TestHardenedRuntimeChild(t *testing.T) {
	mode := os.Getenv(hardenedChildEnv)
	if mode == "" {
		t.Skip("child only")
	}
	cs, err := platformCodeSigning()
	if err != nil {
		fmt.Println("PROBE_ERR", err)
		os.Exit(10)
	}
	if !cs.enforced {
		fmt.Printf("NOT_ENFORCED %+v\n", cs)
		os.Exit(11)
	}
	switch mode {
	case "engine":
		if !cs.allowUnsignedExecutableMemory {
			fmt.Printf("ENTITLEMENT_NOT_READ %+v\n", cs)
			os.Exit(12)
		}
	case "guarded":
		if cs.allowUnsignedExecutableMemory {
			fmt.Printf("UNEXPECTED_ENTITLEMENT %+v\n", cs)
			os.Exit(12)
		}
		if err := EnsureEngine(); !errors.Is(err, ErrExecutableMemoryDenied) {
			fmt.Println("NOT_DENIED", err)
			os.Exit(13)
		}
		os.Exit(0)
	case "unguarded":
		readCodeSigning = func() (codeSigning, error) { return codeSigning{}, nil }
	default:
		fmt.Println("UNKNOWN_MODE", mode)
		os.Exit(14)
	}
	if err := EnsureEngine(); err != nil {
		fmt.Println("ENGINE_ERR", err)
		os.Exit(15)
	}
	// ValidateSet executes guest code (the compiler); the scan executes the
	// compiled rule module too.
	if errs := ValidateSet(set("s", r("fixture_marker", markerRule)), DefaultPolicy); len(errs) != 0 {
		fmt.Println("COMPILE_ERR", errs)
		os.Exit(16)
	}
	rules, setErrs, err := CompileSets([]Set{set("s", r("fixture_marker", markerRule))}, DefaultPolicy)
	if err != nil || len(setErrs) != 0 || rules == nil {
		fmt.Println("COMPILE_SETS_ERR", err, setErrs)
		os.Exit(17)
	}
	res, err := scanMarker(rules)
	if err != nil || !strings.Contains(res, "fixture_marker") {
		fmt.Println("SCAN_ERR", err, res)
		os.Exit(18)
	}
	os.Exit(0)
}

// scanMarker scans an in-memory buffer holding the fixture marker and returns
// the matching rule identifiers.
func scanMarker(rules *yx.Rules) (string, error) {
	s := yx.NewScanner(rules)
	defer s.Destroy()
	res, err := s.Scan([]byte("prefix breeze_yara_fixture_marker_7f3a suffix"))
	if err != nil {
		return "", err
	}
	var ids []string
	for _, m := range res.MatchingRules() {
		ids = append(ids, m.Identifier())
	}
	return strings.Join(ids, ","), nil
}
