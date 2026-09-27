package hyperv

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testVMID = "5b1f0c2e-8a4d-4c7e-9f11-2a3b4c5d6e7f"

// fakePS records every script it is handed and replays canned outputs in order.
type fakePS struct {
	scripts []string
	outputs []string
	errs    []error
}

func (f *fakePS) run(script string) (string, error) {
	i := len(f.scripts)
	f.scripts = append(f.scripts, script)
	var out string
	var err error
	if i < len(f.outputs) {
		out = f.outputs[i]
	}
	if i < len(f.errs) {
		err = f.errs[i]
	}
	return out, err
}

// psQuoteChars are the characters PowerShell treats as a single quote inside a
// single-quoted string literal.
var psQuoteChars = map[rune]bool{'\'': true, '\u2018': true, '\u2019': true, '\u201A': true, '\u201B': true}

// parsePSSingleQuoted tokenizes a PowerShell single-quoted literal at the start
// of s the way PowerShell does: any quote char opens/closes, a doubled quote
// char is one literal quote. Returns the decoded value and the remainder.
func parsePSSingleQuoted(t *testing.T, s string) (string, string) {
	t.Helper()
	rs := []rune(s)
	if len(rs) == 0 || !psQuoteChars[rs[0]] {
		t.Fatalf("literal does not start with a quote: %q", s)
	}
	var b strings.Builder
	for i := 1; i < len(rs); i++ {
		if psQuoteChars[rs[i]] {
			if i+1 < len(rs) && psQuoteChars[rs[i+1]] {
				b.WriteRune(rs[i])
				i++
				continue
			}
			return b.String(), string(rs[i+1:])
		}
		b.WriteRune(rs[i])
	}
	t.Fatalf("unterminated literal: %q", s)
	return "", ""
}

// assignedLiteral finds `$<variable> = '<literal>'` in script and returns the
// decoded literal plus whatever followed it on the same line.
func assignedLiteral(t *testing.T, script, variable string) (string, string) {
	t.Helper()
	prefix := "$" + variable + " = "
	for _, line := range strings.Split(script, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, prefix) {
			return parsePSSingleQuoted(t, strings.TrimPrefix(line, prefix))
		}
	}
	t.Fatalf("no assignment to $%s in script:\n%s", variable, script)
	return "", ""
}

var hostileNames = []struct {
	name string
	in   string
}{
	{"plain", "WebServer01"},
	{"ascii quote", "O'Brien"},
	{"quote then statement", "x'; Remove-VM -Name * -Force; '"},
	{"semicolon", "db;prod"},
	{"right single quote", "x\u2019; Stop-VM -Name * -Force; \u2019"},
	{"left single quote", "x\u2018; Get-VM | Remove-VM; \u2018"},
	{"low-9 quote", "x\u201A; Get-VM | Remove-VM; \u201A"},
	{"reversed quote", "x\u201B; Get-VM | Remove-VM; \u201B"},
	{"subexpression", "$(Get-VM | Remove-VM)"},
	{"backtick", "a`nb"},
	{"wildcard", "prod*"},
}

func TestPSQuote_RoundTripsHostileStrings(t *testing.T) {
	for _, tc := range hostileNames {
		t.Run(tc.name, func(t *testing.T) {
			got, rest := parsePSSingleQuoted(t, psQuote(tc.in))
			if got != tc.in {
				t.Fatalf("decoded %q, want %q", got, tc.in)
			}
			if rest != "" {
				t.Fatalf("literal terminated early; trailing text %q", rest)
			}
		})
	}
}

func TestBuildImportVMScript_ImportsCopyWithNewIDIntoExplicitDirectory(t *testing.T) {
	script, err := buildImportVMScript(importVMParams{
		ConfigPath: `C:\staging\export\MyVM\Virtual Machines\ABC.vmcx`,
		VMName:     "MyVM-restored",
		DirName:    "breeze-restore-myvm-restored-20260926T000000Z-deadbeef",
	})
	if err != nil {
		t.Fatalf("buildImportVMScript: %v", err)
	}

	mustContain := []string{
		"$ErrorActionPreference = 'Stop'",
		"(Get-VMHost).VirtualMachinePath",
		"Import-VM -Path $config -Copy -GenerateNewId -VirtualMachinePath $dest -SnapshotFilePath $dest -SmartPagingFilePath $dest -VhdDestinationPath $vhdDest",
		"Get-VM -Id $vmId | Rename-VM -NewName $name",
		"Where-Object { $_.Name -eq $name }",
		"Test-Path -LiteralPath $dest",
	}
	for _, s := range mustContain {
		if !strings.Contains(script, s) {
			t.Errorf("script missing %q\n%s", s, script)
		}
	}
	mustNotContain := []string{"Sort-Object", "CreationTime", "Select-Object -First", "Get-VM -Name"}
	for _, s := range mustNotContain {
		if strings.Contains(script, s) {
			t.Errorf("script must not select a VM by %q\n%s", s, script)
		}
	}

	// The name-collision refusal must run before anything is imported.
	if strings.Index(script, "$_.Name -eq $name") > strings.Index(script, "Import-VM") {
		t.Errorf("name-collision check must precede Import-VM\n%s", script)
	}

	cfg, _ := assignedLiteral(t, script, "config")
	if cfg != `C:\staging\export\MyVM\Virtual Machines\ABC.vmcx` {
		t.Errorf("config literal = %q", cfg)
	}
	dir, _ := assignedLiteral(t, script, "dirName")
	if dir != "breeze-restore-myvm-restored-20260926T000000Z-deadbeef" {
		t.Errorf("dirName literal = %q", dir)
	}
}

func TestBuildImportVMScript_ExplicitRestoreRoot(t *testing.T) {
	script, err := buildImportVMScript(importVMParams{
		ConfigPath:  `C:\x\a.vmcx`,
		VMName:      "vm",
		RestoreRoot: `D:\Hyper-V\O'Restores`,
		DirName:     "d",
	})
	if err != nil {
		t.Fatalf("buildImportVMScript: %v", err)
	}
	root, rest := assignedLiteral(t, script, "root")
	if root != `D:\Hyper-V\O'Restores` || rest != "" {
		t.Errorf("root literal = %q (rest %q)", root, rest)
	}
}

func TestBuildImportVMScript_QuotesHostileNames(t *testing.T) {
	for _, tc := range hostileNames {
		t.Run(tc.name, func(t *testing.T) {
			script, err := buildImportVMScript(importVMParams{
				ConfigPath: `C:\x\it's; here.vmcx`,
				VMName:     tc.in,
				DirName:    "d",
			})
			if err != nil {
				t.Fatalf("buildImportVMScript: %v", err)
			}
			got, rest := assignedLiteral(t, script, "name")
			if got != tc.in || rest != "" {
				t.Fatalf("name literal decoded %q (rest %q), want %q", got, rest, tc.in)
			}
			cfg, rest := assignedLiteral(t, script, "config")
			if cfg != `C:\x\it's; here.vmcx` || rest != "" {
				t.Fatalf("config literal decoded %q (rest %q)", cfg, rest)
			}
			// The raw name must only ever appear inside its quoted assignment.
			if tc.in != "WebServer01" && strings.Count(script, psQuote(tc.in)) != 1 {
				t.Fatalf("name interpolated more than once\n%s", script)
			}
		})
	}
}

func TestBuildImportVMScript_RejectsMissingInputs(t *testing.T) {
	cases := []importVMParams{
		{ConfigPath: "", VMName: "vm", DirName: "d"},
		{ConfigPath: `C:\a.vmcx`, VMName: "", DirName: "d"},
		{ConfigPath: `C:\a.vmcx`, VMName: "   ", DirName: "d"},
		{ConfigPath: `C:\a.vmcx`, VMName: "vm", DirName: ""},
		{ConfigPath: `C:\a.vmcx`, VMName: "vm", DirName: `..\escape`},
	}
	for i, p := range cases {
		if _, err := buildImportVMScript(p); err == nil {
			t.Errorf("case %d: expected error for %+v", i, p)
		}
	}
}

func TestImportVMWith_BindsResultToImportedVMID(t *testing.T) {
	ps := &fakePS{outputs: []string{
		"WARNING: something noisy\r\n" +
			fmt.Sprintf(`{"Id":"%s","Name":"MyVM-restored","Path":"C:\\VMs\\breeze-restore-x"}`, testVMID) + "\r\n",
	}}
	res, err := importVMWith(ps.run, importVMParams{ConfigPath: `C:\a.vmcx`, VMName: "MyVM-restored", DirName: "breeze-restore-x"})
	if err != nil {
		t.Fatalf("importVMWith: %v", err)
	}
	if len(ps.scripts) != 1 {
		t.Fatalf("expected exactly one PowerShell invocation (import+rename bound to one ID), got %d", len(ps.scripts))
	}
	if res.NewVMID != testVMID {
		t.Errorf("NewVMID = %q, want %q", res.NewVMID, testVMID)
	}
	if res.VMName != "MyVM-restored" {
		t.Errorf("VMName = %q", res.VMName)
	}
	if res.RestorePath != `C:\VMs\breeze-restore-x` {
		t.Errorf("RestorePath = %q", res.RestorePath)
	}
	if res.Status != "completed" {
		t.Errorf("Status = %q", res.Status)
	}
}

func TestImportVMWith_Failures(t *testing.T) {
	cases := []struct {
		name    string
		out     string
		runErr  error
		wantMsg string
	}{
		{
			name:    "name collision refused by script",
			runErr:  errors.New(`powershell failed: exit status 1: A VM named 'MyVM' already exists on this host`),
			wantMsg: "already exists",
		},
		{name: "no JSON output", out: "", wantMsg: "no result"},
		{name: "non-GUID id", out: `{"Id":"'; Remove-VM *","Name":"vm","Path":"C:\\x"}`, wantMsg: "invalid VM id"},
		{name: "renamed to something else", out: fmt.Sprintf(`{"Id":"%s","Name":"other","Path":"C:\\x"}`, testVMID), wantMsg: "name"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ps := &fakePS{outputs: []string{tc.out}, errs: []error{tc.runErr}}
			_, err := importVMWith(ps.run, importVMParams{ConfigPath: `C:\a.vmcx`, VMName: "vm", DirName: "d"})
			if err == nil {
				t.Fatal("expected error")
			}
			if !errors.Is(err, ErrImportFailed) {
				t.Errorf("error %v is not ErrImportFailed", err)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Errorf("error %q does not mention %q", err, tc.wantMsg)
			}
		})
	}
}

func TestImportVMWith_EmptyNameNeverRunsPowerShell(t *testing.T) {
	ps := &fakePS{}
	if _, err := importVMWith(ps.run, importVMParams{ConfigPath: `C:\a.vmcx`, VMName: "", DirName: "d"}); err == nil {
		t.Fatal("expected error for empty VM name")
	}
	if len(ps.scripts) != 0 {
		t.Fatalf("PowerShell must not run for invalid input, ran %d scripts", len(ps.scripts))
	}
}

func TestRestoreDirName(t *testing.T) {
	now := time.Date(2026, 9, 26, 1, 2, 3, 0, time.UTC)
	got := restoreDirName(`..\..\Windows\x'; y`, now, "cafe")
	if strings.ContainsAny(got, `\/:'";*?<>|`) || strings.Contains(got, "..") {
		t.Fatalf("restoreDirName produced unsafe leaf %q", got)
	}
	if !strings.HasPrefix(got, "breeze-restore-") || !strings.HasSuffix(got, "-20260926T010203Z-cafe") {
		t.Fatalf("restoreDirName = %q", got)
	}
}

func TestSafeFileStem(t *testing.T) {
	cases := map[string]string{
		"WebServer01":            "WebServer01",
		`..\..\Windows\System32`: "Windows-System32",
		"a/b":                    "a-b",
		"x'; y":                  "x-y",
		"   ":                    "vm",
		"..":                     "vm",
	}
	for in, want := range cases {
		if got := safeFileStem(in); got != want {
			t.Errorf("safeFileStem(%q) = %q, want %q", in, got, want)
		}
		if got := safeFileStem(in); filepath.Base(got) != got {
			t.Errorf("safeFileStem(%q) = %q is not a single path element", in, got)
		}
	}
}

func TestCreateAndConfigureVMWith_OperatesOnlyOnCreatedID(t *testing.T) {
	cases := []struct {
		name       string
		switchName string
		outputs    []string
		wantSwitch string
	}{
		{name: "explicit switch", switchName: "Ext'Net", outputs: []string{testVMID + "\r\n", "", ""}, wantSwitch: "Ext'Net"},
		{name: "default switch", switchName: "", outputs: []string{testVMID + "\r\n", "", "Default Switch\r\n", ""}, wantSwitch: "Default Switch"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ps := &fakePS{outputs: tc.outputs}
			id, err := createAndConfigureVMWith(ps.run, "x'; Remove-VM *; '", `C:\work\vm.vhdx`, `C:\work`, 4096, 2, tc.switchName)
			if err != nil {
				t.Fatalf("createAndConfigureVMWith: %v", err)
			}
			if id != testVMID {
				t.Fatalf("id = %q", id)
			}
			create := ps.scripts[0]
			if !strings.Contains(create, "Where-Object { $_.Name -eq $name }") ||
				strings.Index(create, "$_.Name -eq $name") > strings.Index(create, "New-VM") {
				t.Errorf("create script must refuse an existing name before New-VM\n%s", create)
			}
			if got, rest := assignedLiteral(t, create, "name"); got != "x'; Remove-VM *; '" || rest != "" {
				t.Errorf("name literal decoded %q rest %q", got, rest)
			}
			for i, s := range ps.scripts[1:] {
				if strings.Contains(s, "-Name ") || strings.Contains(s, "-VMName ") {
					t.Errorf("follow-up script %d selects by name:\n%s", i+1, s)
				}
			}
			var sawCPU, sawSwitch bool
			for _, s := range ps.scripts[1:] {
				if strings.Contains(s, "Set-VM -ProcessorCount 2") {
					sawCPU = true
					if !strings.Contains(s, "Get-VM -Id '"+testVMID+"'") {
						t.Errorf("CPU change not bound to ID:\n%s", s)
					}
				}
				if strings.Contains(s, "Connect-VMNetworkAdapter -SwitchName "+psQuote(tc.wantSwitch)) {
					sawSwitch = true
					if !strings.Contains(s, "Get-VM -Id '"+testVMID+"'") {
						t.Errorf("switch change not bound to ID:\n%s", s)
					}
				}
			}
			if !sawCPU || !sawSwitch {
				t.Errorf("sawCPU=%v sawSwitch=%v scripts=%q", sawCPU, sawSwitch, ps.scripts)
			}
		})
	}
}

func TestCreateAndConfigureVMWith_RejectsNonGUIDOutput(t *testing.T) {
	ps := &fakePS{outputs: []string{"not-a-guid"}}
	if _, err := createAndConfigureVMWith(ps.run, "vm", `C:\v.vhdx`, "", 1024, 1, ""); err == nil {
		t.Fatal("expected error when New-VM does not yield a GUID")
	}
	if len(ps.scripts) != 1 {
		t.Fatalf("no follow-up script may run without a bound ID; ran %d", len(ps.scripts))
	}
}

func TestStartVMByIDScript(t *testing.T) {
	s, err := startVMByIDScript(testVMID)
	if err != nil || s != "Get-VM -Id '"+testVMID+"' | Start-VM" {
		t.Fatalf("startVMByIDScript = %q, %v", s, err)
	}
	if _, err := startVMByIDScript("x' ; Get-VM | Start-VM ; '"); err == nil {
		t.Fatal("expected error for non-GUID id")
	}
}

func TestBuildImportVMScript_AcceptsRestoreDirNameForLongVMName(t *testing.T) {
	name := strings.Repeat("LongProductionDatabaseServer", 3)
	dir := restoreDirName(name, time.Date(2026, 9, 26, 0, 0, 0, 0, time.UTC), "deadbeef")
	if _, err := buildImportVMScript(importVMParams{ConfigPath: `C:\a.vmcx`, VMName: name, DirName: dir}); err != nil {
		t.Fatalf("restoreDirName output %q rejected: %v", dir, err)
	}
}
