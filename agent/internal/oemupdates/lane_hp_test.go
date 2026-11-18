package oemupdates

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Everything HP here is written from HP's documents (testdata/hp/README.md). Real
// behaviour is confirmed only by the HP lab wave (W14).

type hpFixture struct {
	lane    *hpLane
	toolDir string
	work    string
	store   *memStore
	maker   string
	makerE  error
	pending bool
	pendE   error
	boot    time.Time
	bootE   error
	now     time.Time

	// The CMSL module tree, as directory -> subdirectory names.
	programFiles string
	dirs         map[string][]string
	dirChecks    int
	cmslVerifier *fakeVerifier
}

func realTempDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func newHpFixture(t *testing.T) *hpFixture {
	t.Helper()
	now := time.Date(2026, 11, 18, 1, 5, 0, 0, time.UTC)
	f := &hpFixture{
		toolDir: realTempDir(t),
		work:    realTempDir(t),
		store:   newMemStore(),
		maker:   "HP",
		boot:    now.Add(-time.Hour),
		now:     now,

		programFiles: `C:\Program Files`,
		dirs:         map[string][]string{},
		cmslVerifier: &fakeVerifier{publisher: "HP Inc."},
	}
	f.lane = newHPLane(hpHost{
		identity:      func() (string, string, error) { return f.maker, "EliteBook 840", f.makerE },
		toolDir:       func() (string, error) { return f.toolDir, nil },
		exists:        regularFileNoLink,
		fileVersion:   func(string) (string, error) { return "5.3.7.0", nil },
		rebootPending: func() (bool, error) { return f.pending, f.pendE },
		bootTime:      func() (time.Time, error) { return f.boot, f.bootE },
		now:           func() time.Time { return f.now },
		store:         f.store,
		programFiles:  func() string { return f.programFiles },
		dirExists: func(p string) bool {
			f.dirChecks++
			_, ok := f.dirs[p]
			return ok
		},
		listDir:    func(p string) []string { return f.dirs[p] },
		verifier:   f.cmslVerifier,
		powershell: func() string { return testPowerShell },
	})
	return f
}

func (f *hpFixture) tool() ToolState {
	return ToolState{Present: true, Path: filepath.Join(f.toolDir, hpToolExe), Version: "5.3.7.0"}
}

func (f *hpFixture) installTool(t *testing.T) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(f.toolDir, hpToolExe), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (f *hpFixture) plan(t *testing.T, cats, blocked []string) FilterPlan {
	t.Helper()
	plan, err := f.lane.Filter(cats, blocked)
	if err != nil {
		t.Fatal(err)
	}
	plan.WorkDir = f.work
	return plan
}

func hpFixtureBytes(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "hp", "doc-derived", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// hpExecWriting writes a report where the arguments say to, the way HPIA does.
func hpExecWriting(t *testing.T, report []byte, code int64) *fakeExec {
	t.Helper()
	return &fakeExec{run: func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
		if report != nil {
			writeHpReport(t, spec, report)
		}
		return ExecResult{ExitCode: code}, nil
	}}
}

func writeHpReport(t *testing.T, spec ExecSpec, report []byte) {
	t.Helper()
	for _, a := range spec.Args {
		if dir, ok := strings.CutPrefix(a, "/ReportFolder:"); ok {
			if err := os.WriteFile(filepath.Join(dir, "report.xml"), report, 0o600); err != nil {
				t.Fatal(err)
			}
			return
		}
	}
	t.Fatalf("no /ReportFolder in %v", spec.Args)
}

func spListOf(spec ExecSpec) (string, bool) {
	for _, a := range spec.Args {
		if p, ok := strings.CutPrefix(a, "/SPList:"); ok {
			data, err := os.ReadFile(p)
			if err != nil {
				return "", false
			}
			return string(data), true
		}
	}
	return "", false
}

func (f *hpFixture) apply(t *testing.T, cats, blocked []string, ex Exec) RunResult {
	t.Helper()
	r, err := f.lane.Apply(context.Background(), f.tool(), f.plan(t, cats, blocked), ex)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func hpCode(r RunResult) string {
	if r.ErrorCode == nil {
		return ""
	}
	return *r.ErrorCode
}

func containsArg(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func TestHpArgv(t *testing.T) {
	f := newHpFixture(t)
	ex := hpExecWriting(t, hpFixtureBytes(t, "report-none.xml"), 0)
	f.apply(t, []string{CategoryApplication, CategoryDriver, CategoryFirmware}, nil, ex)
	calls := ex.Calls()
	if len(calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(calls))
	}
	want := []string{
		"/Operation:Analyze",
		"/Action:Install",
		"/Category:Firmware,Drivers,Software",
		"/Selection:All",
		"/Silent",
		"/ReportFolder:" + filepath.Join(f.work, hpReportDir),
		"/SoftPaqDownloadFolder:" + filepath.Join(f.work, hpSoftPaqDir),
		"/AutoCleanup",
		"/IgnoreGenericOsError",
	}
	if got := calls[0].Args; strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("argv\n got %q\nwant %q", got, want)
	}
	if calls[0].Path != f.tool().Path {
		t.Fatalf("path = %q", calls[0].Path)
	}
}

func TestHpCategoryListOnlyWhatWasAsked(t *testing.T) {
	f := newHpFixture(t)
	ex := hpExecWriting(t, hpFixtureBytes(t, "report-none.xml"), 0)
	f.apply(t, []string{CategoryDriver}, nil, ex)
	if !containsArg(ex.Calls()[0].Args, "/Category:Drivers") {
		t.Fatalf("args = %v", ex.Calls()[0].Args)
	}
}

func TestHpExitMap(t *testing.T) {
	for _, tc := range []struct {
		code   int64
		want   Outcome
		reboot bool
		err    string
	}{
		{0, OutcomeSuccess, false, ""},
		{256, OutcomeNoUpdates, false, ""},
		{257, OutcomeNoUpdates, false, ""},
		{3010, OutcomeSuccessRebootRequired, true, ""},
		// HP: 3011 takes precedence over 3010 and 3020, so it can hide a reboot.
		{3011, OutcomePartial, true, "non_ssm_softpaqs"},
		// "One or more failed": the others may have installed and want the reboot.
		{3020, OutcomeFailed, true, "install_failed"},
		{4096, OutcomeNotSupported, false, ""},
		{4097, OutcomeFailed, false, "unmapped_exit_code"},
		{4104, OutcomeFailed, false, "unmapped_exit_code"},
		{1, OutcomeFailed, false, "unmapped_exit_code"},
		{-1, OutcomeFailed, false, "unmapped_exit_code"},
	} {
		f := newHpFixture(t)
		r := f.apply(t, []string{CategoryDriver}, nil, hpExecWriting(t, hpFixtureBytes(t, "report-none.xml"), tc.code))
		if r.Outcome != tc.want || r.RebootRequired != tc.reboot || hpCode(r) != tc.err {
			t.Errorf("exit %d: outcome=%s reboot=%v code=%q, want %s %v %q", tc.code, r.Outcome, r.RebootRequired, hpCode(r), tc.want, tc.reboot, tc.err)
		}
		if r.RawExitCode == nil || *r.RawExitCode != tc.code {
			t.Errorf("exit %d: raw = %v", tc.code, r.RawExitCode)
		}
		if err := r.Validate(); err != nil {
			t.Errorf("exit %d: %v", tc.code, err)
		}
	}
}

func TestHpFailedFirmwareRunOwesAReboot(t *testing.T) {
	for code, want := range map[int64]string{3020: "install_failed", 4097: "firmware_install_uncertain"} {
		f := newHpFixture(t)
		r := f.apply(t, []string{CategoryFirmware, CategoryDriver}, nil, hpExecWriting(t, nil, code))
		if r.Outcome != OutcomeFailed || !r.RebootRequired || hpCode(r) != want {
			t.Errorf("exit %d: %+v code=%q", code, r, hpCode(r))
		}
		if _, err := f.store.ReadFile(hpRebootOwedFile); err != nil {
			t.Errorf("exit %d: the owed reboot was not recorded: %v", code, err)
		}
	}
}

func TestHpEveryRebootAskedForIsRecorded(t *testing.T) {
	for _, code := range []int64{3010, 3011, 3020} {
		f := newHpFixture(t)
		f.apply(t, []string{CategoryDriver}, nil, hpExecWriting(t, nil, code))
		if _, err := f.store.ReadFile(hpRebootOwedFile); err != nil {
			t.Errorf("exit %d: %v", code, err)
		}
	}
}

func TestHpItemsFromReport(t *testing.T) {
	f := newHpFixture(t)
	r := f.apply(t, []string{CategoryDriver, CategoryApplication}, nil, hpExecWriting(t, hpFixtureBytes(t, "report-recommendations.xml"), 3010))
	if len(r.Items) != 3 {
		t.Fatalf("items = %+v", r.Items)
	}
	want := []Item{
		{Title: "Example Network Driver", Category: CategoryDriver, Version: "1.2.0", Result: ItemInstalled},
		{Title: "Example Audio Driver", Category: CategoryDriver, Version: "2.1.0", Result: ItemInstalled},
		{Title: "Example Utility", Category: CategoryApplication, Version: "3.0.1", Result: ItemInstalled},
	}
	for i := range want {
		if r.Items[i] != want[i] {
			t.Errorf("item %d = %+v, want %+v", i, r.Items[i], want[i])
		}
	}
}

func hpReportWith(status string) []byte {
	return []byte(`<HPIA><Recommendations><Drivers><Recommendation><Solution><Softpaq><Id>sp1</Id><Name>n</Name><Version>1</Version></Softpaq></Solution>` +
		`<Status>` + status + `</Status></Recommendation></Drivers></Recommendations></HPIA>`)
}

func TestHpReportStatusSpellings(t *testing.T) {
	for status, want := range map[string]string{
		"Installed":     ItemInstalled,
		"SUCCESS":       ItemInstalled,
		"Failed":        ItemFailed,
		"error":         ItemFailed,
		"Downloaded":    ItemSkipped,
		"Download Only": ItemSkipped,
		"DownloadOnly":  ItemSkipped,
	} {
		f := newHpFixture(t)
		r := f.apply(t, []string{CategoryDriver}, nil, hpExecWriting(t, hpReportWith(status), 0))
		if len(r.Items) != 1 || r.Items[0].Result != want {
			t.Errorf("%q: items = %+v, want %s", status, r.Items, want)
		}
	}
}

func TestHpHostileTextIsSanitized(t *testing.T) {
	report := "<HPIA><Recommendations><Drivers><Recommendation><Solution><Softpaq><Id>sp1</Id>" +
		"<Name>a&#9;b " + strings.Repeat("x", 3000) + "</Name><Version>1\xc3\x28</Version></Softpaq></Solution></Recommendation></Drivers></Recommendations></HPIA>"
	f := newHpFixture(t)
	r := f.apply(t, []string{CategoryDriver}, nil, hpExecWriting(t, []byte(report), 0))
	if err := r.Validate(); err != nil {
		t.Fatalf("%v: %+v", err, r)
	}
}

func TestHpReportParserEdges(t *testing.T) {
	rec := func(id string) string {
		return `<Recommendation><Solution><Softpaq><Id>` + id + `</Id><Name>n</Name><Version>1</Version></Softpaq></Solution></Recommendation>`
	}
	for name, tc := range map[string]struct {
		doc  string
		ok   bool
		want int
	}{
		"a byte order mark":   {"\xef\xbb\xbf<?xml version=\"1.0\" encoding=\"utf-8\"?><HPIA><Recommendations><Drivers>" + rec("sp1") + "</Drivers></Recommendations></HPIA>", true, 1},
		"any element case":    {"<hpia><RECOMMENDATIONS><drivers><recommendation><solution><SOFTPAQ><ID>sp1</ID></SOFTPAQ></solution></recommendation></drivers></RECOMMENDATIONS></hpia>", true, 1},
		"an unknown group":    {"<HPIA><Recommendations><Foo>" + rec("sp1") + "</Foo></Recommendations></HPIA>", true, 0},
		"outside any group":   {"<HPIA>" + rec("sp1") + "</HPIA>", true, 0},
		"a nested one is one": {"<HPIA><Recommendations><Drivers><Recommendation>" + rec("sp1") + "</Recommendation></Drivers></Recommendations></HPIA>", true, 1},
		"two roots":           {"<HPIA></HPIA><HPIA></HPIA>", false, 0},
		"no root":             {"", false, 0},
	} {
		t.Run(name, func(t *testing.T) {
			recs, ok := parseHpReport([]byte(tc.doc))
			if ok != tc.ok || len(recs) != tc.want {
				t.Fatalf("ok=%v recs=%+v, want %v and %d", ok, recs, tc.ok, tc.want)
			}
		})
	}
}

func TestHpReportTextIsBounded(t *testing.T) {
	doc := `<HPIA><Recommendations><Drivers><Recommendation><Solution><Softpaq><Id>sp1</Id><Name>` +
		strings.Repeat("x", maxHpTextBytes+1) + `</Name></Softpaq></Solution></Recommendation></Drivers></Recommendations></HPIA>`
	recs, ok := parseHpReport([]byte(doc))
	if !ok || len(recs) != 1 || len(recs[0].name) > maxHpTextBytes {
		t.Fatalf("ok=%v len=%d", ok, len(recs))
	}
}

func TestHpReadReportPicksAReadableFile(t *testing.T) {
	dir := realTempDir(t)
	good := []byte(`<HPIA><Recommendations/></HPIA>`)
	for name, data := range map[string][]byte{"a.xml": []byte("<<<"), "b.XML": good, "c.html": []byte("<html/>")} {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, ok := readHpReport(dir); !ok {
		t.Fatal("a readable report was passed over")
	}
}

func TestHpReadReportRefusesOversizeAndLinks(t *testing.T) {
	dir := realTempDir(t)
	// A valid document, so only the size can refuse it.
	big := append([]byte(`<HPIA/>`), bytes.Repeat([]byte(" "), maxHpReportBytes)...)
	if err := os.WriteFile(filepath.Join(dir, "big.xml"), big, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := readHpReport(dir); ok {
		t.Fatal("an oversize report was read")
	}
	target := filepath.Join(realTempDir(t), "t.xml")
	if err := os.WriteFile(target, []byte(`<HPIA/>`), 0o600); err != nil {
		t.Fatal(err)
	}
	linked := realTempDir(t)
	if err := os.Symlink(target, filepath.Join(linked, "l.xml")); err != nil {
		t.Skip("no symlinks here")
	}
	if _, ok := readHpReport(linked); ok {
		t.Fatal("a linked report was read")
	}
}

func TestHpBlockedInstallWithUnreadableReportIsUnconfirmed(t *testing.T) {
	// Only the report could show the install honoured /SPList.
	f := newHpFixture(t)
	analysis := hpFixtureBytes(t, "report-recommendations.xml")
	ex := &fakeExec{}
	ex.run = func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
		if _, second := spListOf(spec); second {
			return ExecResult{ExitCode: 3010}, nil
		}
		writeHpReport(t, spec, analysis)
		return ExecResult{}, nil
	}
	r := f.apply(t, []string{CategoryDriver}, []string{"sp100002"}, ex)
	if r.Outcome != OutcomePartial || !r.RebootRequired || hpCode(r) != "blocked_updates_unconfirmed" {
		t.Fatalf("%+v code=%q", r, hpCode(r))
	}
}

func TestHpSecondStepExitMapping(t *testing.T) {
	analysis := hpFixtureBytes(t, "report-recommendations.xml")
	for code, want := range map[int64]Outcome{3010: OutcomeSuccessRebootRequired, 3020: OutcomeFailed, 4097: OutcomeFailed} {
		f := newHpFixture(t)
		ex := &fakeExec{}
		ex.run = func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
			writeHpReport(t, spec, analysis)
			if _, second := spListOf(spec); second {
				return ExecResult{ExitCode: code}, nil
			}
			return ExecResult{}, nil
		}
		r := f.apply(t, []string{CategoryDriver}, []string{"sp100002"}, ex)
		if r.Outcome != want || r.RawExitCode == nil || *r.RawExitCode != code {
			t.Errorf("exit %d: %+v", code, r)
		}
	}
}

func TestHpItemsWithoutStatusNotClaimedOnAFailedRun(t *testing.T) {
	// The report has no per-update result, and 3020 says only "one or more".
	f := newHpFixture(t)
	r := f.apply(t, []string{CategoryDriver}, nil, hpExecWriting(t, hpFixtureBytes(t, "report-recommendations.xml"), 3020))
	if len(r.Items) != 0 {
		t.Fatalf("items = %+v", r.Items)
	}
}

func TestHpUnreadableReportDoesNotFailRun(t *testing.T) {
	for name, report := range map[string][]byte{
		"missing":  nil,
		"garbage":  []byte("not xml <<<"),
		"foreign":  []byte(`<?xml version="1.0"?><Other><Recommendations/></Other>`),
		"entities": []byte(`<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><HPIA>&x;</HPIA>`),
		"doctype":  []byte(`<?xml version="1.0"?><!DOCTYPE HPIA><HPIA><Recommendations/></HPIA>`),
		"trailing": []byte(`<HPIA><Recommendations/></HPIA><HPIA><Recommendations/></HPIA>`),
		"cut off":  []byte(`<HPIA><Recommendations><Drivers>`),
	} {
		t.Run(name, func(t *testing.T) {
			f := newHpFixture(t)
			r := f.apply(t, []string{CategoryDriver}, nil, hpExecWriting(t, report, 3010))
			if r.Outcome != OutcomeSuccessRebootRequired || hpCode(r) != "report_unavailable" || len(r.Items) != 0 {
				t.Fatalf("%+v code=%q", r, hpCode(r))
			}
		})
	}
}

func TestHpStaleReportIsNotParsed(t *testing.T) {
	f := newHpFixture(t)
	dir := filepath.Join(f.work, hpReportDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "old.xml"), hpFixtureBytes(t, "report-recommendations.xml"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := f.apply(t, []string{CategoryDriver}, nil, hpExecWriting(t, nil, 0))
	if len(r.Items) != 0 || hpCode(r) != "report_unavailable" {
		t.Fatalf("a previous run's report was read: %+v", r)
	}
}

func TestHpItemsCappedAt200(t *testing.T) {
	var b strings.Builder
	b.WriteString(`<HPIA><Recommendations><Drivers>`)
	for i := 0; i < 450; i++ {
		b.WriteString(`<Recommendation><Solution><Softpaq><Id>sp1</Id><Name>n</Name><Version>1</Version></Softpaq></Solution></Recommendation>`)
	}
	b.WriteString(`</Drivers></Recommendations></HPIA>`)
	f := newHpFixture(t)
	r := f.apply(t, []string{CategoryDriver}, nil, hpExecWriting(t, []byte(b.String()), 0))
	if len(r.Items) != maxItems {
		t.Fatalf("items = %d", len(r.Items))
	}
}

func TestHpBlockedIdsUseAnalyzeThenSpList(t *testing.T) {
	f := newHpFixture(t)
	report := hpFixtureBytes(t, "report-recommendations.xml")
	var list string
	ex := &fakeExec{}
	ex.run = func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
		writeHpReport(t, spec, report)
		if got, ok := spListOf(spec); ok {
			list = got
			return ExecResult{ExitCode: 3010}, nil
		}
		return ExecResult{}, nil
	}
	r := f.apply(t, []string{CategoryDriver, CategoryApplication}, []string{"SP100002"}, ex)
	calls := ex.Calls()
	if len(calls) != 2 {
		t.Fatalf("calls = %d, want analyze then install", len(calls))
	}
	if !containsArg(calls[0].Args, "/Action:List") || containsArg(calls[0].Args, "/Action:Install") {
		t.Fatalf("step 1 must only list: %v", calls[0].Args)
	}
	if !containsArg(calls[1].Args, "/Action:Install") {
		t.Fatalf("step 2 = %v", calls[1].Args)
	}
	// The guide: raw numbers, no sp prefix, one per line.
	if list != "100001\n100003\n" {
		t.Fatalf("list = %q", list)
	}
	if r.Outcome != OutcomeSuccessRebootRequired || !r.RebootRequired {
		t.Fatalf("%+v", r)
	}
	var skipped int
	for _, it := range r.Items {
		if it.Title == "Example Audio Driver" {
			skipped++
			if it.Result != ItemSkipped {
				t.Fatalf("blocked item = %+v", it)
			}
		}
	}
	if skipped != 1 {
		t.Fatalf("items = %+v", r.Items)
	}
}

func TestHpNoBlockedIdsIsOneStep(t *testing.T) {
	f := newHpFixture(t)
	ex := hpExecWriting(t, hpFixtureBytes(t, "report-none.xml"), 0)
	f.apply(t, []string{CategoryDriver}, []string{}, ex)
	if len(ex.Calls()) != 1 {
		t.Fatalf("calls = %d", len(ex.Calls()))
	}
}

func TestHpBlockedIdFormsAllMatch(t *testing.T) {
	for _, id := range []string{"sp100002", "SP100002", "100002", " sp100002 "} {
		f := newHpFixture(t)
		report := hpFixtureBytes(t, "report-recommendations.xml")
		var list string
		ex := &fakeExec{}
		ex.run = func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
			writeHpReport(t, spec, report)
			if got, ok := spListOf(spec); ok {
				list = got
			}
			return ExecResult{}, nil
		}
		f.apply(t, []string{CategoryDriver}, []string{id}, ex)
		if list == "" || strings.Contains(list, "100002") {
			t.Errorf("%q did not block: list = %q", id, list)
		}
	}
}

func TestHpBlockedFailsClosedWithoutAReadableAnalysis(t *testing.T) {
	for name, report := range map[string][]byte{"missing": nil, "garbage": []byte("<<<")} {
		t.Run(name, func(t *testing.T) {
			f := newHpFixture(t)
			ex := hpExecWriting(t, report, 0)
			r := f.apply(t, []string{CategoryDriver}, []string{"sp100002"}, ex)
			if len(ex.Calls()) != 1 {
				t.Fatalf("installed without knowing what was blocked: %d calls", len(ex.Calls()))
			}
			if r.Outcome != OutcomeFailed || hpCode(r) != "report_unavailable" {
				t.Fatalf("%+v code=%q", r, hpCode(r))
			}
		})
	}
}

func TestHpBlockedAnalysisAnswers(t *testing.T) {
	for _, tc := range []struct {
		code int64
		want Outcome
		err  string
	}{
		{256, OutcomeNoUpdates, ""},
		{257, OutcomeNoUpdates, ""},
		{4096, OutcomeNotSupported, ""},
		{3020, OutcomeFailed, "analyze_failed"},
		{4098, OutcomeFailed, "analyze_failed"},
	} {
		f := newHpFixture(t)
		ex := hpExecWriting(t, nil, tc.code)
		r := f.apply(t, []string{CategoryDriver}, []string{"sp1"}, ex)
		if len(ex.Calls()) != 1 || r.Outcome != tc.want || hpCode(r) != tc.err {
			t.Errorf("exit %d: calls=%d %+v code=%q", tc.code, len(ex.Calls()), r, hpCode(r))
		}
	}
}

func TestHpEverythingBlockedInstallsNothing(t *testing.T) {
	f := newHpFixture(t)
	ex := hpExecWriting(t, hpFixtureBytes(t, "report-recommendations.xml"), 0)
	r := f.apply(t, []string{CategoryDriver, CategoryApplication}, []string{"sp100001", "sp100002", "sp100003"}, ex)
	if len(ex.Calls()) != 1 || r.Outcome != OutcomeNoUpdates || len(r.Items) != 3 {
		t.Fatalf("calls=%d %+v", len(ex.Calls()), r)
	}
}

func TestHpSpListCannotCarryAnUnsafeReportId(t *testing.T) {
	// The report is tool output: an id that is not a SoftPaq number never reaches
	// the file HPIA reads.
	report := `<HPIA><Recommendations><Drivers>
	<Recommendation><Solution><Softpaq><Id>sp100001</Id><Name>ok</Name><Version>1</Version></Softpaq></Solution></Recommendation>
	<Recommendation><Solution><Softpaq><Id>..\..\evil</Id><Name>bad</Name><Version>1</Version></Softpaq></Solution></Recommendation>
	<Recommendation><Solution><Softpaq><Id>1&#10;2</Id><Name>bad</Name><Version>1</Version></Softpaq></Solution></Recommendation>
	</Drivers></Recommendations></HPIA>`
	f := newHpFixture(t)
	var list string
	ex := &fakeExec{}
	ex.run = func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
		writeHpReport(t, spec, []byte(report))
		if got, ok := spListOf(spec); ok {
			list = got
		}
		return ExecResult{}, nil
	}
	f.apply(t, []string{CategoryDriver}, []string{"sp9"}, ex)
	if list != "100001\n" {
		t.Fatalf("list = %q", list)
	}
}

func TestHpSpListKeepsToTheCategoriesAsked(t *testing.T) {
	// HPIA was asked for drivers only. A firmware or BIOS entry in its report still
	// must not reach the list, and BIOS never does: it goes through CMSL.
	report := `<HPIA><Recommendations>
	<BIOS><Recommendation><Solution><Softpaq><Id>sp1</Id><Name>b</Name><Version>1</Version></Softpaq></Solution></Recommendation></BIOS>
	<Firmware><Recommendation><Solution><Softpaq><Id>sp2</Id><Name>f</Name><Version>1</Version></Softpaq></Solution></Recommendation></Firmware>
	<Accessories><Recommendation><Solution><Softpaq><Id>sp3</Id><Name>a</Name><Version>1</Version></Softpaq></Solution></Recommendation></Accessories>
	<Drivers><Recommendation><Solution><Softpaq><Id>sp4</Id><Name>d</Name><Version>1</Version></Softpaq></Solution></Recommendation></Drivers>
	</Recommendations></HPIA>`
	f := newHpFixture(t)
	var list string
	ex := &fakeExec{}
	ex.run = func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
		writeHpReport(t, spec, []byte(report))
		if got, ok := spListOf(spec); ok {
			list = got
		}
		return ExecResult{}, nil
	}
	f.apply(t, []string{CategoryDriver}, []string{"sp9"}, ex)
	if list != "4\n" {
		t.Fatalf("list = %q", list)
	}
}

func TestHpBlockedUpdateReportedInstalledIsNamed(t *testing.T) {
	// HP documents /SPList for downloads; the lab confirms an install honours it.
	report := `<HPIA><Recommendations><Drivers>
	<Recommendation><Solution><Softpaq><Id>sp1</Id><Name>wanted</Name><Version>1</Version></Softpaq></Solution><Status>Installed</Status></Recommendation>
	<Recommendation><Solution><Softpaq><Id>sp2</Id><Name>blocked</Name><Version>1</Version></Softpaq></Solution><Status>Installed</Status></Recommendation>
	</Drivers></Recommendations></HPIA>`
	f := newHpFixture(t)
	r := f.apply(t, []string{CategoryDriver}, []string{"sp2"}, hpExecWriting(t, []byte(report), 0))
	if r.Outcome != OutcomePartial || hpCode(r) != "blocked_update_installed" {
		t.Fatalf("%+v code=%q", r, hpCode(r))
	}
}

func TestHpSureAdminDownloadOnlyIsPartial(t *testing.T) {
	for _, code := range []int64{0, 3010} {
		f := newHpFixture(t)
		r := f.apply(t, []string{CategoryDriver, CategoryFirmware}, nil, hpExecWriting(t, hpFixtureBytes(t, "report-download-only.xml"), code))
		if r.Outcome != OutcomePartial || hpCode(r) != "sure_admin_download_only" {
			t.Fatalf("exit %d: %+v code=%q", code, r, hpCode(r))
		}
		if r.RebootRequired != (code == 3010) {
			t.Fatalf("exit %d: reboot = %v", code, r.RebootRequired)
		}
		var firmware *Item
		for i := range r.Items {
			if r.Items[i].Category == CategoryFirmware {
				firmware = &r.Items[i]
			}
		}
		if firmware == nil || firmware.Result != ItemSkipped {
			t.Fatalf("a downloaded update must not read as installed: %+v", r.Items)
		}
		if err := r.Validate(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestHpGateInAgentOwnedDirOnly(t *testing.T) {
	f := newHpFixture(t)
	var asked []string
	f.lane.host.exists = func(p string) bool {
		asked = append(asked, p)
		// A copy everywhere else on disk.
		return !strings.HasPrefix(p, f.toolDir)
	}
	if state := f.lane.Gate().Get(); state.Present {
		t.Fatalf("a copy outside the agent-owned directory was found: %+v", state)
	}
	want := filepath.Join(f.toolDir, hpToolExe)
	if len(asked) != 1 || asked[0] != want {
		t.Fatalf("looked at %v, want only %s", asked, want)
	}

	f.lane.host.exists = regularFileNoLink
	f.installTool(t)
	f.lane.Gate().Invalidate()
	state := f.lane.Gate().Get()
	if !state.Present || state.Path != want || state.Version != "5.3.7.0" {
		t.Fatalf("state = %+v", state)
	}
}

func TestHpGateRefusesALinkInTheToolDir(t *testing.T) {
	plain := filepath.Join(realTempDir(t), "f")
	if err := os.WriteFile(plain, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !regularFileNoLink(plain) {
		t.Fatal("a plain file must count")
	}
	dir := realTempDir(t)
	link := filepath.Join(dir, hpToolExe)
	if err := os.Symlink(plain, link); err != nil {
		t.Skip("no symlinks here")
	}
	if regularFileNoLink(link) {
		t.Fatal("a symlink was accepted as the tool")
	}
	if regularFileNoLink(dir) {
		t.Fatal("a directory was accepted as the tool")
	}
}

func TestHpGateAbsentWhenToolDirUnavailable(t *testing.T) {
	f := newHpFixture(t)
	f.lane.host.toolDir = func() (string, error) { return "", errors.New("no store") }
	if f.lane.Gate().Get().Present {
		t.Fatal("present without a tool directory")
	}
}

func TestHpGateQuietWhenAbsent(t *testing.T) {
	buf := captureLogs(t)
	f := newHpFixture(t)
	for i := 0; i < 3; i++ {
		f.lane.Gate().Get()
	}
	if s := buf.String(); strings.Contains(s, "level=WARN") || strings.Contains(s, "level=INFO") {
		t.Fatalf("an absent tool logged above DEBUG:\n%s", s)
	}
}

func TestHpInstallerExtractsIntoTheToolDir(t *testing.T) {
	f := newHpFixture(t)
	got := f.lane.InstallArgs(`C:\store\downloads\tool.exe`, `C:\store\downloads\tool.log`)
	want := []string{"/s", "/e", "/f", f.toolDir}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("args = %q", got)
	}
	// Never the SoftPaq's default extract location, which standard users can reach.
	f.lane.host.toolDir = func() (string, error) { return "", errors.New("no store") }
	installer := filepath.Join("store", "downloads", "tool.exe")
	got = f.lane.InstallArgs(installer, "l")
	if got[len(got)-1] != filepath.Dir(installer) {
		t.Fatalf("args = %q", got)
	}
}

func TestHpRangeIsTheSecurityFloor(t *testing.T) {
	f := newHpFixture(t)
	r := f.lane.Range()
	if r.Min != "5.3.3" || r.MaxExclusive != "6.0.0" {
		t.Fatalf("range = %+v", r)
	}
	f.installTool(t)
	for v, wantCode := range map[string]string{"5.3.2.0": "tool_below_floor", "6.0.0.0": "tool_above_supported_range"} {
		f.lane.host.fileVersion = func(string) (string, error) { return v, nil }
		f.lane.Gate().Invalidate()
		_, outcome, err := EnsureTool(context.Background(), f.lane, nil, Deps{Verifier: &fakeVerifier{publisher: "HP Inc."}})
		if outcome != OutcomeToolUnavailable || errorCodeOf(err) != wantCode {
			t.Errorf("%s: %s %v", v, outcome, err)
		}
	}
}

func TestHpPublisherNearMissesRefused(t *testing.T) {
	for _, publisher := range []string{"Hewlett Packard Enterprise", "HPE", "Hewlett-Packard", "HP", "HP Inc", "hp inc.", "Dell Inc", ""} {
		f := newHpFixture(t)
		f.installTool(t)
		_, outcome, err := EnsureTool(context.Background(), f.lane, nil, Deps{Verifier: &fakeVerifier{publisher: publisher}})
		if outcome != OutcomeToolUnavailable || errorCodeOf(err) != "publisher_mismatch" {
			t.Errorf("%q: %s %v", publisher, outcome, err)
		}
	}
	f := newHpFixture(t)
	f.installTool(t)
	if _, outcome, err := EnsureTool(context.Background(), f.lane, nil, Deps{Verifier: &fakeVerifier{publisher: "HP Inc."}}); outcome != "" || err != nil {
		t.Fatalf("HP's own signature refused: %s %v", outcome, err)
	}
}

func TestHpAllowlist(t *testing.T) {
	allow, ok := laneAllowlist(LaneHP)
	if !ok {
		t.Fatal("no hp allowlist")
	}
	if strings.Join(allow.Publishers, ",") != "HP Inc." {
		t.Fatalf("publishers = %v", allow.Publishers)
	}
	for _, h := range allow.Hosts {
		if !strings.HasSuffix(h, ".hp.com") {
			t.Errorf("host %q is not HP's", h)
		}
	}
	if !contains(allow.Hosts, "hpia.hpcloud.hp.com") {
		t.Fatalf("hosts = %v", allow.Hosts)
	}
	f := newHpFixture(t)
	if strings.Join(f.lane.Allow().Hosts, ",") != strings.Join(allow.Hosts, ",") {
		t.Fatal("the lane must use the compiled list")
	}
}

// The API's rule (applicability.ts) over its own near-miss list.
func TestHpIdentityNearMissesNeverAuthorize(t *testing.T) {
	for _, maker := range []string{"HP", "hp", "HP Inc.", "HP Inc", "Hewlett-Packard", "  HP Inc.  "} {
		if !isHPIdentity(maker) {
			t.Errorf("%q must be HP", maker)
		}
	}
	for _, maker := range []string{
		"HPE", "Hewlett Packard Enterprise", "HP Enterprise", "CHP Systems", "SHP",
		"Hewlett Packard", "Hewlett-Packard Enterprise", "HP Inc. Compatible", "Dell Inc.", "", " ",
	} {
		if isHPIdentity(maker) {
			t.Errorf("%q must not be HP", maker)
		}
	}
}

func TestHpEnsureToolRefusesOffHpHardwareBeforeAnyDownload(t *testing.T) {
	spec := &ToolSpec{
		Version: "5.3.7", SupportedRange: VersionRange{Min: "5.3.3", MaxExclusive: "6.0.0"},
		URL: "https://hpia.hpcloud.hp.com/t.exe", SHA256: strings.Repeat("a", 64), Prerequisites: []Prerequisite{},
	}
	for name, tc := range map[string]struct {
		maker string
		err   error
		want  Outcome
		code  string
	}{
		"HPE":               {maker: "Hewlett Packard Enterprise", want: OutcomeNotSupported, code: "not_hp"},
		"unreadable SMBIOS": {err: errors.New("no key"), want: OutcomeToolUnavailable, code: "smbios_unreadable"},
	} {
		t.Run(name, func(t *testing.T) {
			f := newHpFixture(t)
			f.maker, f.makerE = tc.maker, tc.err
			fetch := &fakeFetcher{}
			ex := &fakeExec{}
			_, outcome, err := EnsureTool(context.Background(), f.lane, spec, Deps{Fetcher: fetch, Exec: ex, Store: newMemStore(), Verifier: &fakeVerifier{publisher: "HP Inc."}})
			if outcome != tc.want || errorCodeOf(err) != tc.code {
				t.Fatalf("%s %v", outcome, err)
			}
			if len(fetch.Fetched()) != 0 || len(ex.Calls()) != 0 {
				t.Fatal("something was fetched or run off HP hardware")
			}
		})
	}
}

func TestHpFilterPureAndOrdered(t *testing.T) {
	f := newHpFixture(t)
	plan, err := f.lane.Filter([]string{CategoryApplication, CategoryBIOS, CategoryDriver}, []string{"sp1", "AB12C"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(plan.Categories, ",") != "bios,driver,application" || len(plan.BlockedIDs) != 2 {
		t.Fatalf("plan = %+v", plan)
	}
	if _, err := f.lane.Filter([]string{"nope"}, nil); errorCodeOf(err) != "invalid_filter" {
		t.Fatalf("err = %v", err)
	}
	// Blocked ids are only ever compared, so another vendor's id does no harm.
	if err := checkNarrowed(plan, []string{CategoryApplication, CategoryBIOS, CategoryDriver}, []string{"sp1", "AB12C"}); err != nil {
		t.Fatal(err)
	}
}

func TestHpFlashesOutsideFilterUntilTheLabSaysOtherwise(t *testing.T) {
	f := newHpFixture(t)
	if !f.lane.FlashesOutsideFilter() {
		t.Fatal("a driver run must hold the flash guard until W14 shows HPIA keeps to its categories")
	}
	want := strings.Join([]string{CategoryBIOS, CategoryFirmware}, ",")
	if strings.Join(f.lane.SkippedForNoReboot(), ",") != want {
		t.Fatalf("skipped = %v", f.lane.SkippedForNoReboot())
	}
	if _, ok := f.lane.Prerequisite(dotnetDesktopRuntime); ok {
		t.Fatal("HPIA has no prerequisite a payload may install")
	}
}

func TestHpExistingPendingRebootBlocks(t *testing.T) {
	f := newHpFixture(t)
	f.pending = true
	ex := &fakeExec{}
	r := f.apply(t, []string{CategoryDriver}, nil, ex)
	if r.Outcome != OutcomeBlockedRebootPending || !r.RebootRequired || len(ex.Calls()) != 0 {
		t.Fatalf("%+v calls=%d", r, len(ex.Calls()))
	}
}

func TestHpUnreadableRebootStateBlocks(t *testing.T) {
	f := newHpFixture(t)
	f.pendE = errors.New("registry")
	ex := &fakeExec{}
	r, err := f.lane.Apply(context.Background(), f.tool(), f.plan(t, []string{CategoryDriver}, nil), ex)
	if err == nil || r.Outcome != OutcomeBlockedRebootPending || hpCode(r) != "reboot_state_unreadable" || len(ex.Calls()) != 0 {
		t.Fatalf("%+v %v", r, err)
	}
}

// W03 reads a clean result as "an earlier flash's reboot happened". HPIA has no
// exit code for an owed reboot, and the registry flag is not guaranteed.
func TestHpOwedRebootIsRememberedUntilTheMachineReboots(t *testing.T) {
	f := newHpFixture(t)
	r := f.apply(t, []string{CategoryDriver}, nil, hpExecWriting(t, nil, 3010))
	if !r.RebootRequired {
		t.Fatalf("%+v", r)
	}

	f.now = f.now.Add(24 * time.Hour)
	ex := hpExecWriting(t, nil, 256)
	r = f.apply(t, []string{CategoryDriver}, nil, ex)
	if r.Outcome != OutcomeBlockedRebootPending || !r.RebootRequired || len(ex.Calls()) != 0 {
		t.Fatalf("no reboot yet, but: %+v calls=%d", r, len(ex.Calls()))
	}

	f.boot = f.now.Add(-time.Minute)
	f.now = f.now.Add(time.Hour)
	r = f.apply(t, []string{CategoryDriver}, nil, ex)
	if r.Outcome != OutcomeNoUpdates || r.RebootRequired || len(ex.Calls()) != 1 {
		t.Fatalf("after the reboot: %+v calls=%d", r, len(ex.Calls()))
	}
	if _, err := f.store.ReadFile(hpRebootOwedFile); err == nil {
		t.Fatal("the record outlived the reboot")
	}
}

func TestHpCleanRunRecordsNoReboot(t *testing.T) {
	f := newHpFixture(t)
	f.apply(t, []string{CategoryDriver}, nil, hpExecWriting(t, nil, 0))
	if _, err := f.store.ReadFile(hpRebootOwedFile); err == nil {
		t.Fatal("a run that owes nothing wrote a record")
	}
}

func TestHpOwedRebootFailsClosedOnAnUnreadableBootTime(t *testing.T) {
	f := newHpFixture(t)
	f.apply(t, []string{CategoryDriver}, nil, hpExecWriting(t, nil, 3010))
	f.bootE = errors.New("no boot time")
	ex := &fakeExec{}
	r, err := f.lane.Apply(context.Background(), f.tool(), f.plan(t, []string{CategoryDriver}, nil), ex)
	if err == nil || r.Outcome != OutcomeBlockedRebootPending || hpCode(r) != "reboot_state_unreadable" || len(ex.Calls()) != 0 {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestHpCorruptOwedRecordBlocksOnceThenHeals(t *testing.T) {
	f := newHpFixture(t)
	if err := f.store.WriteFile(hpRebootOwedFile, []byte("{not json")); err != nil {
		t.Fatal(err)
	}
	ex := hpExecWriting(t, nil, 256)
	r, err := f.lane.Apply(context.Background(), f.tool(), f.plan(t, []string{CategoryDriver}, nil), ex)
	if err == nil || r.Outcome != OutcomeBlockedRebootPending || len(ex.Calls()) != 0 {
		t.Fatalf("%+v %v", r, err)
	}
	r = f.apply(t, []string{CategoryDriver}, nil, ex)
	if r.Outcome != OutcomeNoUpdates {
		t.Fatalf("never healed: %+v", r)
	}
}

func TestHpInstallEndingWithoutAnExitCodeOwesAReboot(t *testing.T) {
	// Killed at the guard's ceiling, say: it may have been staging firmware.
	f := newHpFixture(t)
	ex := &fakeExec{run: func(context.Context, ExecSpec) (ExecResult, error) { return ExecResult{}, errors.New("killed") }}
	r := f.apply(t, []string{CategoryDriver}, nil, ex)
	if r.Outcome != OutcomeFailed || !r.RebootRequired || hpCode(r) != "tool_exec_failed" || r.RawExitCode != nil {
		t.Fatalf("%+v code=%q", r, hpCode(r))
	}
	if _, err := f.store.ReadFile(hpRebootOwedFile); err != nil {
		t.Fatalf("the owed reboot was not recorded: %v", err)
	}
}

func TestHpAnalyzeEndingWithoutAnExitCodeOwesNothing(t *testing.T) {
	// /Action:List installs nothing, and the runner decides this outcome.
	f := newHpFixture(t)
	ex := &fakeExec{run: func(context.Context, ExecSpec) (ExecResult, error) { return ExecResult{}, errors.New("spawn") }}
	r, err := f.lane.Apply(context.Background(), f.tool(), f.plan(t, []string{CategoryDriver}, []string{"sp1"}), ex)
	if err == nil || r.Outcome != "" || r.RebootRequired {
		t.Fatalf("%+v %v", r, err)
	}
	if _, rerr := f.store.ReadFile(hpRebootOwedFile); rerr == nil {
		t.Fatal("recorded a reboot for a run that installed nothing")
	}
}

func TestHpBootAtTheRecordedTimeIsStillOwed(t *testing.T) {
	f := newHpFixture(t)
	f.apply(t, []string{CategoryDriver}, nil, hpExecWriting(t, nil, 3010))
	f.boot = f.now
	if owed, err := f.lane.rebootOwed(); err != nil || !owed {
		t.Fatalf("owed=%v err=%v", owed, err)
	}
}

func TestHpEmptyOwedRecordIsCorrupt(t *testing.T) {
	f := newHpFixture(t)
	if err := f.store.WriteFile(hpRebootOwedFile, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lane.rebootOwed(); err == nil {
		t.Fatal("a record with no time read as nothing owed")
	}
	if owed, err := f.lane.rebootOwed(); err != nil || owed {
		t.Fatalf("never healed: owed=%v err=%v", owed, err)
	}
}

func TestHpCheckHardwareRunsBeforeAToolFreeBranch(t *testing.T) {
	l := &hwCheckedFreeLane{fakeLane: newFakeLane()}
	_, outcome, err := EnsureTool(context.Background(), l, nil, Deps{})
	if outcome != OutcomeNotSupported || errorCodeOf(err) != "not_hp" || l.readied {
		t.Fatalf("%s %v readied=%v", outcome, err, l.readied)
	}
}

// hwCheckedFreeLane is both kinds of lane: the hardware check must still run.
type hwCheckedFreeLane struct {
	*fakeLane
	readied bool
}

func (l *hwCheckedFreeLane) toolFree() {}
func (l *hwCheckedFreeLane) Ready() (ToolState, Outcome, error) {
	l.readied = true
	return ToolState{}, "", nil
}
func (l *hwCheckedFreeLane) CheckHardware() (Outcome, error) {
	return OutcomeNotSupported, runErr("not_hp", errors.New("no"))
}

func TestHpLaneRegistered(t *testing.T) {
	l, ok := LaneFor(LaneHP)
	if !ok || l.ID() != LaneHP {
		t.Fatal("no hp lane")
	}
	again, _ := LaneFor(LaneHP)
	if again.Gate() != l.Gate() {
		t.Fatal("the lane must be a singleton so its availability gate stays cached")
	}
}

// Through the real runner, on a machine that is not HP's.
func TestHpRunOffHpHardwareIsNotSupported(t *testing.T) {
	rf := newRunFixture(t)
	f := newHpFixture(t)
	f.maker = "Hewlett Packard Enterprise"
	rf.req.Lane = LaneHP
	rf.req.Categories = []string{CategoryBIOS, CategoryDriver}
	r := Run(context.Background(), rf.req, f.lane, rf.deps)
	if r.Outcome != OutcomeNotSupported || hpCode(r) != "not_hp" || len(rf.exec.Calls()) != 0 {
		t.Fatalf("%+v calls=%d", r, len(rf.exec.Calls()))
	}
}
