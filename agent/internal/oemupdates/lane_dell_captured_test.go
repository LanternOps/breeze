package oemupdates

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testdata/dell/captured/ is real dcu-cli.exe 5.7.2.42 stdout from the W10 lab
// (OptiPlex 7060, 2026-11-19), raw bytes as a pipe sees them (ASCII, CRLF).
// See testdata/dell/README.md for what each file is.

func captured(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "dell", "captured", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// W10 D1: DCU refuses -outputLog, -report and -exportSettings paths under
// ProgramData, Program Files and Windows with exit 107 ("reserved folder"), so
// the lane reads stdout and passes no path at all. -silent would hide that
// stdout. -localblockedswb is a /configure option, not an /applyUpdates one.
func TestDellArgvPassesNoPathAndNoSilent(t *testing.T) {
	l := testDellLane(t, nil)
	plan := dellPlan(t, l, []string{CategoryDriver, CategoryBIOS}, nil)
	want := []string{"/applyUpdates", "-reboot=disable", "-autoSuspendBitLocker=enable", "-updateType=bios,driver"}
	if got := l.argv(plan); strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv = %q, want %q", got, want)
	}
	if got := l.scanArgv(plan); strings.Join(got, "\x00") != strings.Join([]string{"/scan", "-updateType=bios,driver"}, "\x00") {
		t.Fatalf("scan argv = %q", got)
	}
	for _, a := range append(l.argv(plan), l.scanArgv(plan)...) {
		la := strings.ToLower(a)
		for _, banned := range []string{"-outputlog", "-report", "-silent", "-localblockedswb", "/configure", "-reboot=enable"} {
			if strings.HasPrefix(la, banned) {
				t.Fatalf("argument %q must not be passed", a)
			}
		}
	}
}

// Blocked ids cannot be honoured on /applyUpdates (W10 D1), and the lab showed
// blocking one release id makes DCU offer another package for the same
// component. Until that is designed, a run with blocked ids is refused.
func TestDellBlockedIDsAreRefusedNotIgnored(t *testing.T) {
	l := testDellLane(t, nil)
	_, err := l.Filter([]string{CategoryDriver}, []string{"NP58K"})
	if err == nil || codeOf(err) != "blocked_ids_unsupported" {
		t.Fatalf("err = %v, want blocked_ids_unsupported", err)
	}
	if _, err := l.Filter([]string{CategoryDriver}, nil); err != nil {
		t.Fatalf("no blocked ids: %v", err)
	}
}

// captureExec answers /scan and /applyUpdates with captured stdout.
func captureExec(scanOut []byte, scanCode int64, applyOut []byte, applyCode int64) *fakeExec {
	return &fakeExec{run: func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
		if len(spec.Args) > 0 && spec.Args[0] == "/scan" {
			return ExecResult{ExitCode: scanCode, Stdout: scanOut}, nil
		}
		return ExecResult{ExitCode: applyCode, Stdout: applyOut}, nil
	}}
}

func applyCaptured(t *testing.T, cats []string, ex *fakeExec) RunResult {
	t.Helper()
	l := testDellLane(t, nil)
	plan := dellPlan(t, l, cats, nil)
	r, err := l.Apply(context.Background(), ToolState{Present: true, Path: dcu64, Version: "5.7.2"}, plan, ex)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestDellScanThenApplyOnTheVerifiedPath(t *testing.T) {
	ex := captureExec(captured(t, "scan-driver-application.txt"), 0, captured(t, "apply-no-updates.txt"), 500)
	applyCaptured(t, []string{CategoryDriver, CategoryApplication}, ex)
	calls := ex.Calls()
	if len(calls) != 2 || calls[0].Args[0] != "/scan" || calls[1].Args[0] != "/applyUpdates" {
		t.Fatalf("calls = %+v, want /scan then /applyUpdates", calls)
	}
	for _, c := range calls {
		if c.Path != dcu64 {
			t.Fatalf("ran %q, want the verified tool path", c.Path)
		}
	}
}

// The application apply captured in the lab: two items, both installed.
func TestDellParsesCapturedApply(t *testing.T) {
	scan := []byte("DF8CW: Dell Security Advisory Update - DSA-2021-088 - Application -- Urgent -- SY\r\n" +
		"YV0M0: Dell SupportAssist OS Recovery Plugin for Dell Update - Application -- Recommended -- AP\r\n" +
		"The program exited with return code: 0\r\n")
	r := applyCaptured(t, []string{CategoryApplication}, captureExec(scan, 0, captured(t, "apply-application-installed.txt"), 0))
	want := []Item{
		{Title: "Dell Security Advisory Update - DSA-2021-088", Category: CategoryApplication, Version: "2.1.0", Result: ItemInstalled},
		{Title: "Dell SupportAssist OS Recovery Plugin for Dell Update", Category: CategoryApplication, Version: "5.5.17.0", Result: ItemInstalled},
	}
	if r.Outcome != OutcomeSuccess || r.ErrorCode != nil || len(r.Items) != len(want) {
		t.Fatalf("result = %+v", r)
	}
	for i := range want {
		if r.Items[i] != want[i] {
			t.Errorf("item %d = %+v, want %+v", i, r.Items[i], want[i])
		}
	}
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestDellParsesCapturedScanCategories(t *testing.T) {
	got := parseDellScan(captured(t, "scan-driver-application.txt"))
	want := map[string]string{"NP58K": CategoryDriver, "VP20T": CategoryDriver, "GPXYY": CategoryDriver}
	if len(got) != len(want) {
		t.Fatalf("scan = %v", got)
	}
	for id, c := range want {
		if got[id] != c {
			t.Errorf("%s = %q, want %q", id, got[id], c)
		}
	}
}

func TestDellCapturedNoUpdatesIsCleanNoUpdates(t *testing.T) {
	r := applyCaptured(t, []string{CategoryApplication}, captureExec(nil, 0, captured(t, "apply-no-updates.txt"), 500))
	if r.Outcome != OutcomeNoUpdates || len(r.Items) != 0 || r.ErrorCode != nil {
		t.Fatalf("result = %+v", r)
	}
}

// Items are only claimed when every selected update is accounted for: a
// partial summary, an item the scan did not label, a failed scan or
// truncated output each cost the item list, never the run.
func TestDellItemsOnlyWhenFullyAccountedFor(t *testing.T) {
	apply := string(captured(t, "apply-application-installed.txt"))
	scan := []byte("DF8CW: Dell Security Advisory Update - DSA-2021-088 - Application -- Urgent -- SY\r\n" +
		"YV0M0: Dell SupportAssist OS Recovery Plugin for Dell Update - Application -- Recommended -- AP\r\n")
	cases := map[string]*fakeExec{
		"partial summary": captureExec(scan, 0, []byte(strings.Replace(apply, "2 of 2 update(s)", "1 of 2 update(s)", 1)), 0),
		"unlabelled item": captureExec(scan[:strings.Index(string(scan), "YV0M0")], 0, []byte(apply), 0),
		"scan failed":     captureExec(scan, 1000, []byte(apply), 0),
		"no summary":      captureExec(scan, 0, []byte(strings.Replace(apply, "2 of 2 update(s) successfully installed.", "", 1)), 0),
		"truncated output": {run: func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
			if spec.Args[0] == "/scan" {
				return ExecResult{Stdout: scan}, nil
			}
			return ExecResult{Stdout: []byte(apply), StdoutTruncated: true}, nil
		}},
	}
	for name, ex := range cases {
		r := applyCaptured(t, []string{CategoryApplication}, ex)
		if r.Outcome != OutcomeSuccess || len(r.Items) != 0 || errCode(r) != "report_unavailable" {
			t.Errorf("%s: result = %+v", name, r)
		}
	}
}

func TestDellUnmappedExitStillFailsWithRawCode(t *testing.T) {
	r := applyCaptured(t, []string{CategoryDriver}, captureExec(nil, 0, []byte("The path provided for option '-outputLog' is a reserved folder that may not be used.\r\n"), 107))
	if r.Outcome != OutcomeFailed || errCode(r) != "unmapped_exit_code" || r.RawExitCode == nil || *r.RawExitCode != 107 {
		t.Fatalf("result = %+v", r)
	}
}

func TestDellOutputItemsCappedAndSanitized(t *testing.T) {
	var scan, apply strings.Builder
	n := 260
	for i := range n {
		id := string([]byte{byte('A' + i%26), byte('A' + i/26%26), byte('0' + i%10), 'X', 'Y'})
		scan.WriteString(id + ": Driver " + id + " - Driver -- Urgent -- CS\r\n")
		apply.WriteString("[" + string(rune('0'+i%10)) + "] " + id + ", Bad \xff\x1b[31m Title, 1.0\r\n")
	}
	apply.WriteString("260 of 260 update(s) successfully installed.\r\n")
	r := applyCaptured(t, []string{CategoryDriver}, captureExec([]byte(scan.String()), 0, []byte(apply.String()), 0))
	if len(r.Items) != maxItems {
		t.Fatalf("items = %d, want %d (%v)", len(r.Items), maxItems, r.ErrorCode)
	}
	if hasControl(r.Items[0].Title) || !strings.Contains(r.Items[0].Title, "�") {
		t.Fatalf("title = %q", r.Items[0].Title)
	}
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
}
