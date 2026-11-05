package oemupdates

import (
	"context"
	"errors"
	"strings"
	"testing"
)

const dcuPath = `C:\Program Files\Dell\CommandUpdate\dcu-cli.exe`

func toolSpec() *ToolSpec {
	return &ToolSpec{
		Version: "5.7.2", MinSafeVersion: "5.7.1",
		SupportedRange: VersionRange{Min: "5.7.1", MaxExclusive: "6.0.0"},
		URL:            "https://dl.dell.com/dcu.exe", SHA256: strings.Repeat("a", 64),
		Prerequisites: []Prerequisite{},
	}
}

type installFixture struct {
	lane  *fakeLane
	ver   *fakeVerifier
	fetch *fakeFetcher
	exec  *fakeExec
	deps  Deps
}

func newInstallFixture() *installFixture {
	l := newFakeLane()
	f := &installFixture{
		lane:  l,
		ver:   &fakeVerifier{publisher: "Dell Inc"},
		fetch: &fakeFetcher{fail: map[string]error{}},
	}
	f.exec = installingExec(l, nil)
	f.deps = Deps{Exec: f.exec, Verifier: f.ver, Fetcher: f.fetch, Store: newMemStore()}
	return f
}

func codeOf(err error) string {
	var re *RunError
	if errors.As(err, &re) {
		return re.Code
	}
	return ""
}

func TestToolInRangeNotReinstalled(t *testing.T) {
	f := newInstallFixture()
	f.lane.setTool(ToolState{Present: true, Path: dcuPath, Version: "5.7.2"})
	state, outcome, err := EnsureTool(context.Background(), f.lane, toolSpec(), f.deps)
	if err != nil || outcome != "" || state.Path != dcuPath {
		t.Fatalf("state=%+v outcome=%q err=%v", state, outcome, err)
	}
	if len(f.fetch.Fetched()) != 0 || len(f.exec.Calls()) != 0 {
		t.Fatal("an in-range tool was reinstalled")
	}
	if got := f.ver.Verified(); len(got) != 1 || got[0] != dcuPath {
		t.Fatalf("verified %v, want the installed tool once", got)
	}
}

func TestToolBelowFloorReinstalled(t *testing.T) {
	f := newInstallFixture()
	f.lane.setTool(ToolState{Present: true, Path: dcuPath, Version: "5.7.0"})
	f.lane.onInstall = &ToolState{Present: true, Path: dcuPath, Version: "5.7.2"}
	state, outcome, err := EnsureTool(context.Background(), f.lane, toolSpec(), f.deps)
	if err != nil || outcome != "" {
		t.Fatalf("outcome=%q err=%v", outcome, err)
	}
	if state.Version != "5.7.2" {
		t.Fatalf("version after install = %q", state.Version)
	}
	if got := f.fetch.Fetched(); len(got) != 1 {
		t.Fatalf("fetched %v", got)
	}
}

func TestCompiledFloorBeatsPayload(t *testing.T) {
	// A payload that names an older floor cannot make the agent run a version
	// below the compiled one (5.7.1, DSA fix).
	f := newInstallFixture()
	f.lane.setTool(ToolState{Present: true, Path: dcuPath, Version: "5.7.0"})
	spec := toolSpec()
	spec.MinSafeVersion, spec.SupportedRange.Min, spec.Version = "5.0.0", "5.0.0", "5.7.0"
	_, outcome, err := EnsureTool(context.Background(), f.lane, spec, f.deps)
	if outcome != OutcomeToolUnavailable || codeOf(err) != "manifest_version_out_of_range" {
		t.Fatalf("outcome=%q code=%q", outcome, codeOf(err))
	}
	if len(f.exec.Calls()) != 0 {
		t.Fatal("ran something")
	}
}

func TestToolAboveRangeRefused(t *testing.T) {
	f := newInstallFixture()
	f.lane.setTool(ToolState{Present: true, Path: dcuPath, Version: "6.0.0"})
	_, outcome, err := EnsureTool(context.Background(), f.lane, toolSpec(), f.deps)
	if outcome != OutcomeToolUnavailable || codeOf(err) != "tool_above_supported_range" {
		t.Fatalf("outcome=%q code=%q", outcome, codeOf(err))
	}
	if len(f.fetch.Fetched()) != 0 || len(f.exec.Calls()) != 0 {
		t.Fatal("a newer tool must not be downgraded or run")
	}
}

func TestUnparseableInstalledVersionIsNotRun(t *testing.T) {
	f := newInstallFixture()
	f.lane.setTool(ToolState{Present: true, Path: dcuPath, Version: "garbage"})
	_, outcome, _ := EnsureTool(context.Background(), f.lane, nil, f.deps)
	if outcome != OutcomeToolUnavailable {
		t.Fatalf("outcome=%q", outcome)
	}
}

func TestUrlGoneWithToolInRangeKeepsWorking(t *testing.T) {
	f := newInstallFixture()
	f.lane.setTool(ToolState{Present: true, Path: dcuPath, Version: "5.7.1"})
	spec := toolSpec()
	f.fetch.fail[spec.URL] = errors.New("404")
	_, outcome, err := EnsureTool(context.Background(), f.lane, spec, f.deps)
	if err != nil || outcome != "" {
		t.Fatalf("outcome=%q err=%v", outcome, err)
	}
}

func TestUrlGoneNoToolIsToolUnavailable(t *testing.T) {
	f := newInstallFixture()
	spec := toolSpec()
	f.fetch.fail[spec.URL] = errors.New("404")
	_, outcome, err := EnsureTool(context.Background(), f.lane, spec, f.deps)
	if outcome != OutcomeToolUnavailable || codeOf(err) != "download_failed" {
		t.Fatalf("outcome=%q code=%q", outcome, codeOf(err))
	}
}

func TestNoManifestToolAndNoToolIsToolUnavailable(t *testing.T) {
	f := newInstallFixture()
	_, outcome, err := EnsureTool(context.Background(), f.lane, nil, f.deps)
	if outcome != OutcomeToolUnavailable || codeOf(err) != "tool_absent" {
		t.Fatalf("outcome=%q code=%q", outcome, codeOf(err))
	}
}

func TestWrongPublisherOnDownloadNeverRuns(t *testing.T) {
	f := newInstallFixture()
	f.ver.publisher = "Dell Inc Evil"
	_, outcome, err := EnsureTool(context.Background(), f.lane, toolSpec(), f.deps)
	if outcome != OutcomeToolUnavailable || codeOf(err) != "publisher_mismatch" {
		t.Fatalf("outcome=%q code=%q", outcome, codeOf(err))
	}
	if len(f.exec.Calls()) != 0 {
		t.Fatal("an installer with the wrong publisher ran")
	}
}

func TestWrongPublisherRefusedAfterInstall(t *testing.T) {
	f := newInstallFixture()
	f.lane.onInstall = &ToolState{Present: true, Path: dcuPath, Version: "5.7.2"}
	f.ver.byPath = map[string]string{dcuPath: "Someone Else"}
	_, outcome, err := EnsureTool(context.Background(), f.lane, toolSpec(), f.deps)
	if outcome != OutcomeToolUnavailable || codeOf(err) != "publisher_mismatch" {
		t.Fatalf("outcome=%q code=%q", outcome, codeOf(err))
	}
}

func TestInstalledToolWithWrongPublisherIsNotRunWithoutAManifest(t *testing.T) {
	f := newInstallFixture()
	f.lane.setTool(ToolState{Present: true, Path: dcuPath, Version: "5.7.2"})
	f.ver.byPath = map[string]string{dcuPath: "Someone Else"}
	before := f.lane.detects.Load()
	_, outcome, err := EnsureTool(context.Background(), f.lane, nil, f.deps)
	if outcome != OutcomeToolUnavailable || codeOf(err) != "publisher_mismatch" {
		t.Fatalf("outcome=%q code=%q", outcome, codeOf(err))
	}
	f.lane.Gate().Get()
	if f.lane.detects.Load() == before {
		t.Fatal("a failed verification must invalidate the gate")
	}
}

func TestPrerequisiteInstalledFirstAndVerified(t *testing.T) {
	f := newInstallFixture()
	f.lane.onInstall = &ToolState{Present: true, Path: dcuPath, Version: "5.7.2"}
	f.lane.prereqs["dotnet_desktop_runtime"] = &fakePrereq{installed: "8.0.1", becomes: "10.0.8"}
	f.ver.publisher = ""
	f.ver.byPath = map[string]string{dcuPath: "Dell Inc"}
	spec := toolSpec()
	spec.Prerequisites = []Prerequisite{{Name: "dotnet_desktop_runtime", MinVersion: "10.0.8",
		URL: "https://builds.dotnet.microsoft.com/rt.exe", SHA256: strings.Repeat("b", 64)}}
	// Downloads are named by role, so the verifier can sign each differently.
	// The tool allowlist stays Dell-only: the runtime is trusted through its
	// own role's list, never the tool's.
	f.deps.Verifier = verifierFunc(func(path string) (string, error) {
		switch {
		case strings.HasSuffix(path, "prereq-0.exe"):
			return "Microsoft Corporation", nil
		default:
			return "Dell Inc", nil
		}
	})
	_, outcome, err := EnsureTool(context.Background(), f.lane, spec, f.deps)
	if err != nil || outcome != "" {
		t.Fatalf("outcome=%q err=%v", outcome, err)
	}
	calls := f.exec.Calls()
	if len(calls) != 2 || calls[0].Args[0] != "/install" || calls[1].Args[0] != "/s" {
		t.Fatalf("install order = %+v, want prerequisite then tool", calls)
	}
	if got := f.fetch.Fetched(); len(got) != 2 || got[0] != spec.Prerequisites[0].URL {
		t.Fatalf("fetch order = %v", got)
	}
}

func TestPrerequisiteWithWrongPublisherNeverRuns(t *testing.T) {
	f := newInstallFixture()
	f.lane.prereqs["dotnet_desktop_runtime"] = &fakePrereq{installed: "", becomes: "10.0.8"}
	spec := toolSpec()
	spec.Prerequisites = []Prerequisite{{Name: "dotnet_desktop_runtime", MinVersion: "10.0.8",
		URL: "https://builds.dotnet.microsoft.com/rt.exe", SHA256: strings.Repeat("b", 64)}}
	f.ver.publisher = "Not Microsoft"
	_, outcome, err := EnsureTool(context.Background(), f.lane, spec, f.deps)
	if outcome != OutcomeToolUnavailable || codeOf(err) != "publisher_mismatch" || len(f.exec.Calls()) != 0 {
		t.Fatalf("outcome=%q code=%q calls=%d", outcome, codeOf(err), len(f.exec.Calls()))
	}
}

func TestUnknownPrerequisiteRefused(t *testing.T) {
	f := newInstallFixture()
	spec := toolSpec()
	spec.Prerequisites = []Prerequisite{{Name: "anything_else", MinVersion: "1.0",
		URL: "https://dl.dell.com/x.exe", SHA256: strings.Repeat("c", 64)}}
	_, outcome, err := EnsureTool(context.Background(), f.lane, spec, f.deps)
	if outcome != OutcomeToolUnavailable || codeOf(err) != "unknown_prerequisite" || len(f.exec.Calls()) != 0 {
		t.Fatalf("outcome=%q code=%q", outcome, codeOf(err))
	}
}

func TestPrerequisiteAlreadyPresentIsSkipped(t *testing.T) {
	f := newInstallFixture()
	f.lane.onInstall = &ToolState{Present: true, Path: dcuPath, Version: "5.7.2"}
	f.lane.prereqs["dotnet_desktop_runtime"] = &fakePrereq{installed: "10.0.9"}
	spec := toolSpec()
	spec.Prerequisites = []Prerequisite{{Name: "dotnet_desktop_runtime", MinVersion: "10.0.8",
		URL: "https://builds.dotnet.microsoft.com/rt.exe", SHA256: strings.Repeat("b", 64)}}
	if _, outcome, err := EnsureTool(context.Background(), f.lane, spec, f.deps); err != nil || outcome != "" {
		t.Fatalf("outcome=%q err=%v", outcome, err)
	}
	if got := f.fetch.Fetched(); len(got) != 1 || got[0] != spec.URL {
		t.Fatalf("fetched %v, want only the tool", got)
	}
}

// Dell's installer can exit 0 without installing when .NET is missing (§5).
func TestSilentInstallWithoutPrerequisiteDetected(t *testing.T) {
	f := newInstallFixture()
	f.lane.onInstall = nil // the installer "succeeds" and nothing appears
	_, outcome, err := EnsureTool(context.Background(), f.lane, toolSpec(), f.deps)
	if outcome != OutcomeToolUnavailable || codeOf(err) != "install_incomplete" {
		t.Fatalf("outcome=%q code=%q", outcome, codeOf(err))
	}
}

func TestPrerequisiteThatDoesNotTakeIsDetected(t *testing.T) {
	f := newInstallFixture()
	f.lane.prereqs["dotnet_desktop_runtime"] = &fakePrereq{installed: "8.0.0"} // never becomes 10
	f.deps.Verifier = verifierFunc(func(path string) (string, error) {
		if strings.HasSuffix(path, "prereq-0.exe") {
			return "Microsoft Corporation", nil
		}
		return "Dell Inc", nil
	})
	spec := toolSpec()
	spec.Prerequisites = []Prerequisite{{Name: "dotnet_desktop_runtime", MinVersion: "10.0.8",
		URL: "https://builds.dotnet.microsoft.com/rt.exe", SHA256: strings.Repeat("b", 64)}}
	_, outcome, err := EnsureTool(context.Background(), f.lane, spec, f.deps)
	if outcome != OutcomeToolUnavailable || codeOf(err) != "prerequisite_install_incomplete" {
		t.Fatalf("outcome=%q code=%q", outcome, codeOf(err))
	}
	for _, c := range f.exec.Calls() {
		if c.Args[0] == "/s" {
			t.Fatal("the tool installed after its prerequisite failed")
		}
	}
}

func TestInstallInvalidatesGate(t *testing.T) {
	f := newInstallFixture()
	f.lane.onInstall = &ToolState{Present: true, Path: dcuPath, Version: "5.7.2"}
	f.lane.Gate().Get() // cache "absent"
	state, outcome, err := EnsureTool(context.Background(), f.lane, toolSpec(), f.deps)
	if err != nil || outcome != "" || !state.Present {
		t.Fatalf("state=%+v outcome=%q err=%v", state, outcome, err)
	}
	if !f.lane.Gate().Get().Present {
		t.Fatal("the gate still reports the tool absent after an install")
	}
}

func TestDownloadsRemovedAfterInstall(t *testing.T) {
	f := newInstallFixture()
	f.lane.onInstall = &ToolState{Present: true, Path: dcuPath, Version: "5.7.2"}
	if _, _, err := EnsureTool(context.Background(), f.lane, toolSpec(), f.deps); err != nil {
		t.Fatal(err)
	}
	dir, _ := f.deps.Store.Dir(downloadsDir)
	if entries := readDirNames(t, dir); len(entries) != 0 {
		t.Fatalf("downloads left: %v", entries)
	}
}

func TestVersionCompare(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"5.7.2", "5.7.1", 1}, {"5.7.1", "5.7.1", 0}, {"5.7", "5.7.0", 0}, {"5.10.0", "5.9.9", 1},
		{"10.0.8", "9.99", 1}, {"5.7.1.1234", "5.7.1", 1},
	}
	for _, c := range cases {
		got, err := compareVersions(c.a, c.b)
		if err != nil || got != c.want {
			t.Errorf("compare(%s,%s) = %d, %v; want %d", c.a, c.b, got, err, c.want)
		}
	}
	for _, bad := range []string{"", "v5", "5..7", "5.x", "5.7.2-beta", "1.2.3.4.5"} {
		if _, err := parseVersion(bad); err == nil {
			t.Errorf("parseVersion(%q) accepted", bad)
		}
	}
}
