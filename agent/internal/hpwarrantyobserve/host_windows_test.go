//go:build windows

package hpwarrantyobserve

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
)

// These run the real script on the CI Windows runner (Test Agent (Windows)
// lists this package). The runner is not HP, which exercises exactly the path
// the canary fleet is expected to take: root/HP absent. A script that does
// not parse under Windows PowerShell 5.1, or a namespace code the mapping
// does not know, fails here instead of on customer machines.

func TestRealScriptRunsAndMapsAbsent(t *testing.T) {
	out, err := runWMIScript(context.Background())
	if err != nil {
		t.Fatalf("runWMIScript: %v", err)
	}
	var s scriptOutput
	if err := json.Unmarshal(bytes.TrimPrefix(bytes.TrimSpace(out), []byte("\xef\xbb\xbf")), &s); err != nil {
		t.Fatalf("script output does not decode: %v\n%s", err, out)
	}
	c := &collector{ctx: context.Background(), o: &Observation{Errors: []StepError{}}}
	for step, code := range map[string]string{"rootHp": s.RootHP.S, "isv": s.ISV.S, "v1": s.V1.S} {
		if got := c.namespaceState(step, code); got != StateAbsent {
			t.Errorf("%s: code %q mapped to %s, want absent on a non-HP host", step, code, got)
		}
	}
	if s.Classes != nil || len(s.Cls) != 0 {
		t.Errorf("no v1 namespace, yet the script listed classes: %s", out)
	}
}

func TestRealCollectOnNonHPHost(t *testing.T) {
	// The runner's manufacturer is not HP, so the real host observes nothing
	// and runs no script.
	if o := Collect(context.Background(), SystemHost(), "observe"); o != nil {
		t.Fatalf("observed a non-HP runner as HP: %+v", o)
	}
}

func TestRunnerRefusesAnyOtherCommand(t *testing.T) {
	args := powershellArgs()
	args[4] = "Get-Process"
	if _, err := runFixed(context.Background(), systemPowerShell, args); !errors.Is(err, ErrCommandRefused) {
		t.Fatalf("changed argv: err = %v, want refused", err)
	}
	if _, err := runFixed(context.Background(), `C:\Temp\powershell.exe`, powershellArgs()); !errors.Is(err, ErrCommandRefused) {
		t.Fatalf("other program: err = %v, want refused", err)
	}
	if _, _, err := registryDWORD(`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, "UBR"); !errors.Is(err, errKeyRefused) {
		t.Fatalf("registry key off the list: err = %v, want refused", err)
	}
}
