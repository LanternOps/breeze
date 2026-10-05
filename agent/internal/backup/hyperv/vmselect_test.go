package hyperv

import (
	"errors"
	"strings"
	"testing"
)

// selectsByNameParameter reports whether a script hands a VM or checkpoint name
// to a Hyper-V cmdlet's wildcard-aware -Name/-VMName parameter.
func selectsByNameParameter(script string) bool {
	for _, p := range []string{"-Name '", "-Name $", "-VMName '", "-VMName $"} {
		if strings.Contains(script, p) {
			return true
		}
	}
	return false
}

func TestBuildSelectVMByNameScript_ExactMatchRefusesAmbiguity(t *testing.T) {
	for _, tc := range hostileNames {
		t.Run(tc.name, func(t *testing.T) {
			s, err := buildSelectVMByNameScript(tc.in, "$vm.Id.Guid")
			if err != nil {
				t.Fatalf("buildSelectVMByNameScript: %v", err)
			}
			if selectsByNameParameter(s) {
				t.Fatalf("script selects via a wildcard-aware -Name parameter:\n%s", s)
			}
			for _, want := range []string{
				"$ErrorActionPreference = 'Stop'",
				"@(Get-VM | Where-Object { $_.Name -eq $name })",
				"$found.Count -eq 0",
				"$found.Count -gt 1",
				"$vm = $found[0]",
				"$vm.Id.Guid",
			} {
				if !strings.Contains(s, want) {
					t.Errorf("script missing %q\n%s", want, s)
				}
			}
			got, rest := assignedLiteral(t, s, "name")
			if got != tc.in || rest != "" {
				t.Fatalf("name literal decoded %q (rest %q), want %q", got, rest, tc.in)
			}
		})
	}
	if _, err := buildSelectVMByNameScript("  ", "x"); err == nil {
		t.Fatal("expected error for blank name")
	}
}

func TestResolveVMIDWith(t *testing.T) {
	ps := &fakePS{outputs: []string{"noise\r\n" + testVMID + "\r\n"}}
	id, err := resolveVMIDWith(ps.run, "prod*")
	if err != nil || id != testVMID {
		t.Fatalf("resolveVMIDWith = %q, %v", id, err)
	}

	ps = &fakePS{errs: []error{errors.New("2 VMs are named 'web' on this host")}}
	if _, err := resolveVMIDWith(ps.run, "web"); err == nil || !strings.Contains(err.Error(), "2 VMs") {
		t.Fatalf("expected ambiguity error to surface, got %v", err)
	}

	ps = &fakePS{outputs: []string{"'; Remove-VM"}}
	if _, err := resolveVMIDWith(ps.run, "web"); err == nil {
		t.Fatal("expected error for non-GUID output")
	}
}

func TestExportVMWith_BindsEveryStepToResolvedID(t *testing.T) {
	cases := []struct {
		name        string
		consistency string
		outputs     []string
		wantScripts []string
	}{
		{
			name:        "application",
			consistency: "application",
			outputs:     []string{testVMID, ""},
			wantScripts: []string{
				"",
				"Get-VM -Id '" + testVMID + "' | Export-VM -Path 'D:\\Exp\\it''s'",
			},
		},
		{
			name:        "crash",
			consistency: "crash",
			outputs:     []string{testVMID, "Running\r\n", "", "", ""},
			wantScripts: []string{
				"",
				"(Get-VM -Id '" + testVMID + "').State.ToString()",
				"Get-VM -Id '" + testVMID + "' | Save-VM",
				"Get-VM -Id '" + testVMID + "' | Export-VM -Path 'D:\\Exp\\it''s'",
				"Get-VM -Id '" + testVMID + "' | Start-VM",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ps := &fakePS{outputs: tc.outputs}
			id, warnings, err := exportVMWith(ps.run, "web*", `D:\Exp\it's`, tc.consistency)
			if err != nil {
				t.Fatalf("exportVMWith: %v", err)
			}
			if id != testVMID || len(warnings) != 0 {
				t.Fatalf("id=%q warnings=%v", id, warnings)
			}
			if len(ps.scripts) != len(tc.wantScripts) {
				t.Fatalf("ran %d scripts, want %d: %q", len(ps.scripts), len(tc.wantScripts), ps.scripts)
			}
			for i, want := range tc.wantScripts {
				if i == 0 {
					if !strings.Contains(ps.scripts[0], "Where-Object { $_.Name -eq $name }") {
						t.Errorf("first script must resolve the VM by exact name:\n%s", ps.scripts[0])
					}
					continue
				}
				if ps.scripts[i] != want {
					t.Errorf("script %d = %q, want %q", i, ps.scripts[i], want)
				}
			}
		})
	}
}

// TestExportVMWith_CrashConsistencyFollowsVMState covers #7623: Save-VM only
// accepts a Running or Paused VM, so an Off or Saved VM (already consistent on
// disk) must be exported directly and must not be started afterwards.
func TestExportVMWith_CrashConsistencyFollowsVMState(t *testing.T) {
	sel := "Get-VM -Id '" + testVMID + "'"
	stateQuery := "(" + sel + ").State.ToString()"
	save := sel + " | Save-VM"
	export := sel + " | Export-VM -Path 'D:\\Exp'"
	start := sel + " | Start-VM"
	cases := []struct {
		state        string
		wantScripts  []string
		wantWarnings []string
	}{
		{state: "Running", wantScripts: []string{stateQuery, save, export, start}},
		{state: "Off", wantScripts: []string{stateQuery, export}},
		{state: "Saved", wantScripts: []string{stateQuery, export}},
		{
			state:        "Paused",
			wantScripts:  []string{stateQuery, save, export},
			wantWarnings: []string{"was Paused", "left in the Saved state"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.state, func(t *testing.T) {
			ps := &fakePS{outputs: []string{testVMID, "noise\r\n" + tc.state + "\r\n"}}
			id, warnings, err := exportVMWith(ps.run, "web", `D:\Exp`, "crash")
			if err != nil {
				t.Fatalf("exportVMWith(%s): %v", tc.state, err)
			}
			if id != testVMID {
				t.Fatalf("id = %q", id)
			}
			got := ps.scripts[1:]
			if strings.Join(got, "\n") != strings.Join(tc.wantScripts, "\n") {
				t.Fatalf("scripts for %s VM:\n got  %q\n want %q", tc.state, got, tc.wantScripts)
			}
			if len(tc.wantWarnings) == 0 && len(warnings) != 0 {
				t.Fatalf("unexpected warnings: %v", warnings)
			}
			for _, w := range tc.wantWarnings {
				if len(warnings) != 1 || !strings.Contains(warnings[0], w) {
					t.Fatalf("warnings %v missing %q", warnings, w)
				}
			}
		})
	}
}

func TestExportVMWith_CrashRefusesTransitionalAndCriticalStates(t *testing.T) {
	for _, state := range []string{"Starting", "Stopping", "Saving", "Pausing", "Resuming", "Reset", "Other", "RunningCritical", "OffCritical", "FastSaved", ""} {
		t.Run(state, func(t *testing.T) {
			ps := &fakePS{outputs: []string{testVMID, state}}
			_, _, err := exportVMWith(ps.run, "web", `D:\Exp`, "crash")
			if err == nil {
				t.Fatalf("expected refusal for state %q", state)
			}
			if state != "" && !strings.Contains(err.Error(), state) {
				t.Errorf("error should name the state %q: %v", state, err)
			}
			if len(ps.scripts) != 2 {
				t.Fatalf("nothing may be saved or exported in state %q; ran %q", state, ps.scripts)
			}
		})
	}
}

func TestExportVMWith_CrashStateQueryFailureStops(t *testing.T) {
	ps := &fakePS{outputs: []string{testVMID}, errs: []error{nil, errors.New("Get-VM failed")}}
	if _, _, err := exportVMWith(ps.run, "web", `D:\Exp`, "crash"); err == nil || !strings.Contains(err.Error(), "Get-VM failed") {
		t.Fatalf("expected state query error to surface, got %v", err)
	}
	if len(ps.scripts) != 2 {
		t.Fatalf("nothing may be saved or exported after a failed state query; ran %q", ps.scripts)
	}
}

// A crash backup that saved a Running VM must restart it even when the export
// fails, or the backup leaves a production VM down.
func TestExportVMWith_CrashRestartsRunningVMWhenExportFails(t *testing.T) {
	sel := "Get-VM -Id '" + testVMID + "'"
	ps := &fakePS{
		outputs: []string{testVMID, "Running"},
		errs:    []error{nil, nil, nil, errors.New("disk full")},
	}
	_, _, err := exportVMWith(ps.run, "web", `D:\Exp`, "crash")
	if err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Fatalf("expected export error, got %v", err)
	}
	if len(ps.scripts) != 5 || ps.scripts[4] != sel+" | Start-VM" {
		t.Fatalf("Running VM not restarted after a failed export; ran %q", ps.scripts)
	}

	ps = &fakePS{
		outputs: []string{testVMID, "Running"},
		errs:    []error{nil, nil, nil, errors.New("disk full"), errors.New("start refused")},
	}
	_, _, err = exportVMWith(ps.run, "web", `D:\Exp`, "crash")
	if err == nil || !strings.Contains(err.Error(), "disk full") || !strings.Contains(err.Error(), "start refused") {
		t.Fatalf("expected both export and restart errors, got %v", err)
	}

	for _, state := range []string{"Off", "Saved", "Paused"} {
		ps = &fakePS{outputs: []string{testVMID, state}}
		ps.errs = make([]error, 5)
		failAt := 2
		if state == "Paused" {
			failAt = 3
		}
		ps.errs[failAt] = errors.New("disk full")
		_, _, err := exportVMWith(ps.run, "web", `D:\Exp`, "crash")
		if err == nil || !strings.Contains(err.Error(), "disk full") {
			t.Fatalf("%s: expected export error, got %v", state, err)
		}
		// A Paused VM was saved before the export failed: the error must say
		// it is now Saved, not Paused.
		if leftSaved := strings.Contains(err.Error(), "left in the Saved state"); leftSaved != (state == "Paused") {
			t.Fatalf("%s: error %q mentions left-Saved=%v", state, err, leftSaved)
		}
		for _, s := range ps.scripts {
			if strings.HasSuffix(s, "| Start-VM") {
				t.Fatalf("%s VM must not be started after a failed export; ran %q", state, ps.scripts)
			}
		}
	}
}

// A Running VM whose restart fails after a successful export is reported as a
// warning (the backup itself succeeded), never dropped.
func TestExportVMWith_CrashRestartFailureAfterExportIsAWarning(t *testing.T) {
	ps := &fakePS{
		outputs: []string{testVMID, "Running"},
		errs:    []error{nil, nil, nil, nil, errors.New("start refused")},
	}
	_, warnings, err := exportVMWith(ps.run, "web", `D:\Exp`, "crash")
	if err != nil {
		t.Fatalf("exportVMWith: %v", err)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "failed to restart VM") || !strings.Contains(warnings[0], "start refused") {
		t.Fatalf("warnings = %v", warnings)
	}
}

func TestExportVMWith_StopsWhenNameIsAmbiguous(t *testing.T) {
	ps := &fakePS{errs: []error{errors.New("2 VMs are named 'web'")}}
	if _, _, err := exportVMWith(ps.run, "web", `D:\Exp`, "crash"); err == nil {
		t.Fatal("expected error")
	}
	if len(ps.scripts) != 1 {
		t.Fatalf("no VM may be saved or exported after a failed resolve; ran %d scripts", len(ps.scripts))
	}
}

func TestBuildCheckpointScript(t *testing.T) {
	cases := []struct {
		action string
		cpName string
		want   []string
	}{
		{
			action: "create", cpName: "pre-patch [1]",
			want: []string{"$vm | Checkpoint-VM -SnapshotName $cpName"},
		},
		{
			action: "delete", cpName: "*",
			want: []string{
				"@(Get-VMSnapshot -VM $vm | Where-Object { $_.Name -eq $cpName })",
				"$cps.Count -eq 0", "$cps.Count -gt 1",
				"$cps[0] | Remove-VMSnapshot",
			},
		},
		{
			action: "apply", cpName: "before'; Remove-VM",
			want: []string{
				"@(Get-VMSnapshot -VM $vm | Where-Object { $_.Name -eq $cpName })",
				"$cps[0] | Restore-VMSnapshot -Confirm:$false",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.action, func(t *testing.T) {
			s, err := buildCheckpointScript("web[01]", tc.action, tc.cpName)
			if err != nil {
				t.Fatalf("buildCheckpointScript: %v", err)
			}
			if selectsByNameParameter(s) {
				t.Fatalf("script selects via a wildcard-aware -Name parameter:\n%s", s)
			}
			if !strings.Contains(s, "Where-Object { $_.Name -eq $name }") {
				t.Errorf("VM not resolved by exact name:\n%s", s)
			}
			for _, w := range tc.want {
				if !strings.Contains(s, w) {
					t.Errorf("script missing %q\n%s", w, s)
				}
			}
			got, rest := assignedLiteral(t, s, "cpName")
			if got != tc.cpName || rest != "" {
				t.Errorf("cpName literal decoded %q (rest %q)", got, rest)
			}
		})
	}
	if _, err := buildCheckpointScript("vm", "explode", "x"); err == nil {
		t.Fatal("expected error for unsupported action")
	}
	if _, err := buildCheckpointScript("vm", "delete", ""); err == nil {
		t.Fatal("expected error for delete without a checkpoint name")
	}
}

func TestBuildVMStateScript(t *testing.T) {
	cases := map[string]string{
		"start":      "$vm | Start-VM",
		"stop":       "$vm | Stop-VM -Force:$false",
		"force_stop": "$vm | Stop-VM -Force -TurnOff",
		"pause":      "$vm | Suspend-VM",
		"resume":     "$vm | Resume-VM",
		"save":       "$vm | Save-VM",
	}
	for state, want := range cases {
		t.Run(state, func(t *testing.T) {
			s, err := buildVMStateScript("prod?", state)
			if err != nil {
				t.Fatalf("buildVMStateScript: %v", err)
			}
			if selectsByNameParameter(s) {
				t.Fatalf("script selects via a wildcard-aware -Name parameter:\n%s", s)
			}
			if !strings.Contains(s, "$found.Count -gt 1") || !strings.HasSuffix(strings.TrimSpace(s), want) {
				t.Errorf("script for %s:\n%s", state, s)
			}
		})
	}
	if _, err := buildVMStateScript("vm", "explode"); err == nil {
		t.Fatal("expected error for unsupported state")
	}
}

func TestPrepareVMRestoreWith_ChecksNameThenCreatesDirectory(t *testing.T) {
	ps := &fakePS{outputs: []string{"C:\\ProgramData\\Microsoft\\Windows\\Hyper-V\\breeze-restore-x\r\n"}}
	dir, err := prepareVMRestoreWith(ps.run, "x'; y", "", "breeze-restore-x")
	if err != nil {
		t.Fatalf("prepareVMRestoreWith: %v", err)
	}
	if dir != `C:\ProgramData\Microsoft\Windows\Hyper-V\breeze-restore-x` {
		t.Fatalf("dir = %q", dir)
	}
	s := ps.scripts[0]
	for _, want := range []string{
		"Where-Object { $_.Name -eq $name }",
		"(Get-VMHost).VirtualMachinePath",
		"Test-Path -LiteralPath $dest",
		"[System.IO.Directory]::CreateDirectory($dest)",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("script missing %q\n%s", want, s)
		}
	}
	if strings.Index(s, "$_.Name -eq $name") > strings.Index(s, "CreateDirectory") {
		t.Errorf("name check must precede directory creation\n%s", s)
	}
	if strings.Contains(strings.ToLower(s), "temp") {
		t.Errorf("restore directory must not be derived from a temp path\n%s", s)
	}
}

func TestPrepareVMRestoreWith_Failures(t *testing.T) {
	ps := &fakePS{errs: []error{errors.New("A VM named 'x' already exists on this host")}}
	if _, err := prepareVMRestoreWith(ps.run, "x", "", "d"); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("expected name-collision error, got %v", err)
	}
	ps = &fakePS{outputs: []string{"relative\\dir"}}
	if _, err := prepareVMRestoreWith(ps.run, "x", "", "d"); err == nil {
		t.Fatal("expected error for a non-absolute directory")
	}
	ps = &fakePS{}
	if _, err := prepareVMRestoreWith(ps.run, "x", "", `..\up`); err == nil || len(ps.scripts) != 0 {
		t.Fatalf("expected refusal without running PowerShell, err=%v scripts=%d", err, len(ps.scripts))
	}
}

func TestBuildCreateVMScript_PlacesConfigInRestoreDirectory(t *testing.T) {
	s, err := buildCreateVMScript("vm", `D:\VMs\r\Virtual Hard Disks\vm.vhdx`, 1024, `D:\VMs\r`)
	if err != nil {
		t.Fatalf("buildCreateVMScript: %v", err)
	}
	if !strings.Contains(s, "New-VM -Name $name -Path $vmPath -Generation 2") {
		t.Errorf("New-VM must place the VM config in the restore directory\n%s", s)
	}
	if got, rest := assignedLiteral(t, s, "vmPath"); got != `D:\VMs\r` || rest != "" {
		t.Errorf("vmPath literal = %q (rest %q)", got, rest)
	}
}

func TestRequireVMNameFreeWith(t *testing.T) {
	ps := &fakePS{}
	if err := requireVMNameFreeWith(ps.run, "a'b"); err != nil {
		t.Fatalf("requireVMNameFreeWith: %v", err)
	}
	if !strings.Contains(ps.scripts[0], "Where-Object { $_.Name -eq $name }") {
		t.Fatalf("script:\n%s", ps.scripts[0])
	}
	if got, rest := assignedLiteral(t, ps.scripts[0], "name"); got != "a'b" || rest != "" {
		t.Fatalf("name literal %q rest %q", got, rest)
	}
	ps = &fakePS{errs: []error{errors.New("A VM named 'a' already exists")}}
	if err := requireVMNameFreeWith(ps.run, "a"); err == nil {
		t.Fatal("expected collision error")
	}
	if err := requireVMNameFreeWith((&fakePS{}).run, " "); err == nil {
		t.Fatal("expected error for blank name")
	}
}

func TestNewRestoreDirName(t *testing.T) {
	a, err := newRestoreDirName("web")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := newRestoreDirName("web")
	if a == b || !isSafePathElement(a) || !strings.HasPrefix(a, "breeze-restore-web-") {
		t.Fatalf("newRestoreDirName: %q %q", a, b)
	}
}
