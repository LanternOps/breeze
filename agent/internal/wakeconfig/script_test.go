package wakeconfig

import (
	"bytes"
	"context"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
)

// #12138: a missing cmdlet raises CommandNotFoundException, whose category is
// ObjectNotFound, so the Get-NetAdapter catch used to swallow it and report
// "no wired adapter". The script must probe for the cmdlets first.
func TestReadScriptProbesNetAdapterCmdlets(t *testing.T) {
	for _, c := range []string{"Get-NetAdapter", "Get-NetAdapterPowerManagement", "Get-NetAdapterAdvancedProperty"} {
		if !strings.Contains(readScript, "'"+c+"'") {
			t.Fatalf("script must probe for %s with Get-Command", c)
		}
	}
	if !strings.Contains(readScript, "Get-Command") || !strings.Contains(readScript, "netAdapter=") {
		t.Fatal("script must probe with Get-Command and emit netAdapter")
	}
}

// Runs the real script under pwsh on a non-Windows host, where the NetAdapter
// module does not exist: the host must come back as not assessable.
func TestReadScriptWithoutNetAdapterModuleUnderPwsh(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the NetAdapter module exists on Windows")
	}
	pwsh, err := exec.LookPath("pwsh")
	if err != nil {
		t.Skip("pwsh not installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, pwsh, "-NoProfile", "-NonInteractive", "-Command", readScript)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("pwsh: %v: %s", err, stderr.String())
	}
	r, err := ParseWindowsReadings(bytes.TrimPrefix(bytes.TrimSpace(stdout.Bytes()), []byte("\xef\xbb\xbf")))
	if err != nil {
		t.Fatalf("%v: %q", err, stdout.String())
	}
	if !r.NetAdapterCmdletsUnavailable || len(r.Adapters) != 0 {
		t.Fatalf("want not assessable with no adapters, got %+v from %q", r, stdout.String())
	}
	if s := Compute(Inputs{OS: "windows", Windows: r, Now: time.Now()}); s.ReadinessState != StateUnproven {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

func TestReadScriptIsReadOnlyAndKeywordMatched(t *testing.T) {
	s := strings.ToLower(readScript)
	if !strings.Contains(readScript, "-RegistryKeyword '*EEE'") {
		t.Fatal("script must match EEE by -RegistryKeyword '*EEE'")
	}
	for _, bad := range []string{"displayname", "displayvalue"} {
		if strings.Contains(s, bad) {
			t.Fatalf("script must not look up localised %s", bad)
		}
	}
	for _, bad := range []string{"set-", "enable-", "disable-", "new-", "remove-", "restart-", "rename-",
		"reg add", "reg delete", "invoke-wmimethod", "invoke-cimmethod"} {
		if strings.Contains(s, bad) {
			t.Fatalf("script must be read-only but contains %q", bad)
		}
	}
	// Registry access: the only cmdlet touching a registry path is Get-ItemProperty.
	for _, m := range regexp.MustCompile(`(?i)[a-z]+-itemproperty\w*|hklm:|hkcu:|\bregistry::`).FindAllString(readScript, -1) {
		lm := strings.ToLower(m)
		if lm != "get-itemproperty" && lm != "hklm:" {
			t.Fatalf("unexpected registry access %q", m)
		}
	}
	if !strings.Contains(s, "get-itemproperty") {
		t.Fatal("expected Get-ItemProperty for HiberbootEnabled")
	}
}
