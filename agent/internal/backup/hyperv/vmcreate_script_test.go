package hyperv

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"
)

func validCreateVMRequest() CreateVMRequest {
	return CreateVMRequest{VMName: "w06-proof", VHDXPath: `C:\ProgramData\Breeze\rebuild\out\dev-1.vhdx`}
}

func TestValidateCreateVMRequest(t *testing.T) {
	long := func(n int) string { return strings.Repeat("a", n) }
	for name, tt := range map[string]struct {
		mutate func(*CreateVMRequest)
		want   string // substring of the error; "" means valid
	}{
		"valid defaults":        {func(*CreateVMRequest) {}, ""},
		"valid full":            {func(r *CreateVMRequest) { r.SwitchName = "LAN"; r.MemoryMB = 8192; r.CPUCount = 4 }, ""},
		"name 100 runes":        {func(r *CreateVMRequest) { r.VMName = long(100) }, ""},
		"empty name":            {func(r *CreateVMRequest) { r.VMName = "" }, "vmName is required"},
		"blank name":            {func(r *CreateVMRequest) { r.VMName = "   " }, "vmName is required"},
		"name 101 runes":        {func(r *CreateVMRequest) { r.VMName = long(101) }, "vmName"},
		"name newline":          {func(r *CreateVMRequest) { r.VMName = "a\nb" }, "control character"},
		"name carriage return":  {func(r *CreateVMRequest) { r.VMName = "a\rb" }, "control character"},
		"name NUL":              {func(r *CreateVMRequest) { r.VMName = "a\x00b" }, "control character"},
		"name tab":              {func(r *CreateVMRequest) { r.VMName = "a\tb" }, "control character"},
		"name DEL":              {func(r *CreateVMRequest) { r.VMName = "a\x7fb" }, "control character"},
		"name C1 NEL":           {func(r *CreateVMRequest) { r.VMName = "a\u0085b" }, "control character"},
		"name invalid utf8":     {func(r *CreateVMRequest) { r.VMName = "a\xffb" }, "UTF-8"},
		"switch newline":        {func(r *CreateVMRequest) { r.SwitchName = "LAN\n" }, "control character"},
		"switch NUL":            {func(r *CreateVMRequest) { r.SwitchName = "LAN\x00" }, "control character"},
		"switch blank":          {func(r *CreateVMRequest) { r.SwitchName = "  " }, "switchName"},
		"switch 201 runes":      {func(r *CreateVMRequest) { r.SwitchName = long(201) }, "switchName"},
		"vhdx empty":            {func(r *CreateVMRequest) { r.VHDXPath = "" }, "VHDX path is required"},
		"vhdx newline":          {func(r *CreateVMRequest) { r.VHDXPath = "C:\\x\n.vhdx" }, "control character"},
		"memory below minimum":  {func(r *CreateVMRequest) { r.MemoryMB = 511 }, "memoryMb"},
		"memory negative":       {func(r *CreateVMRequest) { r.MemoryMB = -1 }, "memoryMb"},
		"cpu negative":          {func(r *CreateVMRequest) { r.CPUCount = -1 }, "cpuCount"},
		"memory absurdly large": {func(r *CreateVMRequest) { r.MemoryMB = 1 << 50 }, "memoryMb"},
		"cpu too many":          {func(r *CreateVMRequest) { r.CPUCount = 1000 }, "cpuCount"},
		"memory at maximum":     {func(r *CreateVMRequest) { r.MemoryMB = 12582912 }, ""},
		"memory one over max":   {func(r *CreateVMRequest) { r.MemoryMB = 12582914 }, "memoryMb"},
		"memory odd":            {func(r *CreateVMRequest) { r.MemoryMB = 4097 }, "multiple of 2"},
		"memory odd at minimum": {func(r *CreateVMRequest) { r.MemoryMB = 513 }, "multiple of 2"},
		"cpu at maximum":        {func(r *CreateVMRequest) { r.CPUCount = 240 }, ""},
		"cpu one over max":      {func(r *CreateVMRequest) { r.CPUCount = 241 }, "cpuCount"},
	} {
		t.Run(name, func(t *testing.T) {
			req := validCreateVMRequest()
			tt.mutate(&req)
			err := ValidateCreateVMRequest(req)
			if tt.want == "" {
				if err != nil {
					t.Fatalf("ValidateCreateVMRequest(%+v) = %v, want nil", req, err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("ValidateCreateVMRequest(%+v) = %v, want error containing %q", req, err, tt.want)
			}
		})
	}
}

// soleAssignedLiteral finds the single `$<v> = '...'` line for v in script and
// returns the literal's parsed value, failing if the literal does not end
// the line (i.e. the value broke out of its quotes). It reuses
// restore_identity_test.go's PowerShell-accurate parsePSSingleQuoted.
func soleAssignedLiteral(t *testing.T, script, v string) string {
	t.Helper()
	prefix := "$" + v + " = "
	var found []string
	for _, line := range strings.Split(script, "\n") {
		if strings.HasPrefix(line, prefix) {
			found = append(found, strings.TrimPrefix(line, prefix))
		}
	}
	if len(found) != 1 {
		t.Fatalf("want exactly one %s assignment, got %d in:\n%s", prefix, len(found), script)
	}
	value, rest := parsePSSingleQuoted(t, found[0])
	if rest != "" {
		t.Fatalf("value broke out of its literal: %s%s (trailing %q)", prefix, found[0], rest)
	}
	return value
}

func TestBuildCreateVMFromVHDXScript_NoSwitchMeansNoNIC(t *testing.T) {
	script, err := buildCreateVMFromVHDXScript(validCreateVMRequest())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"$ErrorActionPreference = 'Stop'",
		psRequireVMNameFree,
		"Test-Path -LiteralPath $vhd -PathType Leaf",
		"New-VM -Name $name -Generation 2 -MemoryStartupBytes 4294967296 -VHDPath $vhd",
		"Set-VM -VM $vm -ProcessorCount 2",
		"Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows",
		"Get-VMNetworkAdapter -VM $vm | Remove-VMNetworkAdapter",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("script missing %q:\n%s", want, script)
		}
	}
	// No NIC unless a switch is named: never connect, never fall back to
	// "the first switch on the host" the way the vmrestore path does.
	for _, banned := range []string{"Connect-VMNetworkAdapter", "Get-VMSwitch", "Select-Object -First 1", "$switch"} {
		if strings.Contains(script, banned) {
			t.Errorf("no-switch script must not contain %q:\n%s", banned, script)
		}
	}
	if got := soleAssignedLiteral(t, script, "name"); got != "w06-proof" {
		t.Errorf("$name = %q", got)
	}
	if got := soleAssignedLiteral(t, script, "vhd"); got != validCreateVMRequest().VHDXPath {
		t.Errorf("$vhd = %q", got)
	}
}

func TestBuildCreateVMFromVHDXScript_SwitchIsExactMatchAndConnected(t *testing.T) {
	req := validCreateVMRequest()
	req.SwitchName, req.MemoryMB, req.CPUCount = "LAN*", 8192, 4
	script, err := buildCreateVMFromVHDXScript(req)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"-MemoryStartupBytes 8589934592",
		"Set-VM -VM $vm -ProcessorCount 4",
		// -Name on Get-VMSwitch is a wildcard; compare with -eq and demand exactly one.
		"@(Get-VMSwitch | Where-Object { $_.Name -eq $switchName })",
		"Get-VMNetworkAdapter -VM $vm | Connect-VMNetworkAdapter -VMSwitch $sw",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("script missing %q:\n%s", want, script)
		}
	}
	if strings.Contains(script, "Remove-VMNetworkAdapter") {
		t.Errorf("a named switch must keep and connect the adapter:\n%s", script)
	}
	if strings.Contains(script, "-SwitchName") {
		t.Errorf("-SwitchName is a wildcard parameter; connect by switch object:\n%s", script)
	}
	if got := soleAssignedLiteral(t, script, "switchName"); got != "LAN*" {
		t.Errorf("$switchName = %q", got)
	}
	// $switch is a PowerShell automatic variable (the switch statement's
	// enumerator); the script must never bind or read it.
	if regexp.MustCompile(`(?i)\$switch\b`).MatchString(script) {
		t.Errorf("script uses the $switch automatic variable:\n%s", script)
	}
	// The switch is resolved before New-VM so a bad switch never leaves a VM behind.
	if strings.Index(script, "Get-VMSwitch") > strings.Index(script, "New-VM") {
		t.Errorf("switch must be resolved before New-VM:\n%s", script)
	}
}

// A failure after New-VM removes the half-configured VM so the name is free
// for a retry — but only the VM's configuration: Remove-VM never deletes
// virtual hard disks, and nothing in the script may touch the VHDX file.
func TestBuildCreateVMFromVHDXScript_RollbackNeverDeletesTheDisk(t *testing.T) {
	req := validCreateVMRequest()
	req.SwitchName = "LAN"
	script, err := buildCreateVMFromVHDXScript(req)
	if err != nil {
		t.Fatal(err)
	}
	catch := script[strings.Index(script, "} catch {"):]
	if !strings.Contains(catch, "Remove-VM -VM $vm -Force") || !strings.Contains(catch, "throw") {
		t.Fatalf("catch block must remove the VM and rethrow:\n%s", catch)
	}
	for _, banned := range []string{"Remove-Item", "Remove-VMHardDiskDrive", "DeleteDisk", "Dismount-", "Clear-"} {
		if strings.Contains(script, banned) {
			t.Errorf("script must never touch the rebuilt disk (found %q):\n%s", banned, script)
		}
	}
	if strings.Index(script, "try {") < strings.Index(script, "$vm = New-VM") {
		t.Errorf("New-VM must precede the try so a failed New-VM never runs Remove-VM:\n%s", script)
	}
}

func TestBuildCreateVMFromVHDXScript_ValuesCannotBreakOut(t *testing.T) {
	hostile := []string{
		`x'; Remove-Item C:\ -Recurse -Force; '`,
		"x‘; Stop-Computer; ‘",
		"x’; Stop-Computer; ’",
		"x‚; Stop-Computer; ‛",
		`x$(Stop-Computer)`,
		"x`$(Stop-Computer)",
		`x"; Stop-Computer; "`,
		`x'' ; Stop-Computer ; ''`,
	}
	for _, v := range hostile {
		t.Run(v, func(t *testing.T) {
			req := CreateVMRequest{VMName: v, SwitchName: v, VHDXPath: `C:\out\` + v + `.vhdx`}
			script, err := buildCreateVMFromVHDXScript(req)
			if err != nil {
				t.Fatal(err)
			}
			if got := soleAssignedLiteral(t, script, "name"); got != req.VMName {
				t.Errorf("$name round-trips to %q, want %q", got, req.VMName)
			}
			if got := soleAssignedLiteral(t, script, "switchName"); got != req.SwitchName {
				t.Errorf("$switchName round-trips to %q, want %q", got, req.SwitchName)
			}
			if got := soleAssignedLiteral(t, script, "vhd"); got != req.VHDXPath {
				t.Errorf("$vhd round-trips to %q, want %q", got, req.VHDXPath)
			}
			// The values appear only in their assignment lines; every command
			// references the variables, never the raw text.
			for _, line := range strings.Split(script, "\n") {
				if strings.HasPrefix(line, "$name = ") || strings.HasPrefix(line, "$switchName = ") || strings.HasPrefix(line, "$vhd = ") {
					continue
				}
				if strings.Contains(line, "Stop-Computer") || strings.Contains(line, "Remove-Item") {
					t.Errorf("hostile value leaked outside its literal: %q", line)
				}
			}
		})
	}
}

func TestBuildCreateVMFromVHDXScript_RefusesNewlinesBeforeRendering(t *testing.T) {
	for _, req := range []CreateVMRequest{
		{VMName: "x'\nStop-Computer\n'", VHDXPath: `C:\x.vhdx`},
		{VMName: "ok", SwitchName: "LAN\nStop-Computer", VHDXPath: `C:\x.vhdx`},
		{VMName: "ok", VHDXPath: "C:\\x\nStop-Computer.vhdx"},
		{VMName: "ok\x00", VHDXPath: `C:\x.vhdx`},
	} {
		if script, err := buildCreateVMFromVHDXScript(req); err == nil {
			t.Errorf("%+v rendered a script instead of refusing:\n%s", req, script)
		}
	}
}

func TestCreateVMFromVHDXWith_PassesCtxAndTenMinuteTimeout(t *testing.T) {
	type ctxKey struct{}
	ctx := context.WithValue(context.Background(), ctxKey{}, "marker")
	var calls int
	run := func(got context.Context, script string, timeout time.Duration) (string, error) {
		calls++
		if got.Value(ctxKey{}) != "marker" {
			t.Errorf("runner did not receive the caller's ctx")
		}
		if timeout != 10*time.Minute {
			t.Errorf("timeout = %s, want 10m", timeout)
		}
		if !strings.Contains(script, "New-VM -Name $name") {
			t.Errorf("unexpected script:\n%s", script)
		}
		return "5b1f0c2e-8a4d-4c7e-9f11-2a3b4c5d6e7f\n", nil
	}
	if err := createVMFromVHDXWith(ctx, run, validCreateVMRequest()); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("runner calls = %d, want 1 (one script, one PowerShell process)", calls)
	}
}

func TestCreateVMFromVHDXWith_SurfacesRunnerErrorAndRefusesBadRequest(t *testing.T) {
	run := func(context.Context, string, time.Duration) (string, error) {
		return "", errors.New("powershell failed: exit status 1: New-VM : access denied")
	}
	err := createVMFromVHDXWith(context.Background(), run, validCreateVMRequest())
	if err == nil || !strings.Contains(err.Error(), "New-VM : access denied") || !strings.Contains(err.Error(), "w06-proof") {
		t.Fatalf("err = %v, want the runner's error with the VM name", err)
	}

	called := false
	bad := func(context.Context, string, time.Duration) (string, error) { called = true; return "", nil }
	if err := createVMFromVHDXWith(context.Background(), bad, CreateVMRequest{VMName: "a\nb", VHDXPath: `C:\x.vhdx`}); err == nil {
		t.Fatal("an invalid request must be refused")
	}
	if called {
		t.Fatal("an invalid request must never reach PowerShell")
	}
}
