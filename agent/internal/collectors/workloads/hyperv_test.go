package workloads

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeRunner records every exec and answers from a function.
type fakeRunner struct {
	calls atomic.Int32
	argv  [][]string
	fn    func(path string, args []string) (cmdOutput, error)
}

func (f *fakeRunner) run(_ context.Context, path string, args ...string) (cmdOutput, error) {
	f.calls.Add(1)
	f.argv = append(f.argv, append([]string{path}, args...))
	return f.fn(path, args)
}

func stdout(s string) func(string, []string) (cmdOutput, error) {
	return func(string, []string) (cmdOutput, error) { return cmdOutput{Stdout: []byte(s)}, nil }
}

var hvNow = func() time.Time { return time.Date(2026, 10, 6, 12, 0, 20, 0, time.UTC) }

func newTestHyperV(state serviceState, r *fakeRunner) *hypervDriver {
	return &hypervDriver{
		service:    func() serviceState { return state },
		version:    func() string { return "10.0.20348" },
		powershell: testPowerShell,
		run:        r.run,
		now:        hvNow,
	}
}

func TestHyperVDetectNeverExecs(t *testing.T) {
	cases := []struct {
		state  serviceState
		want   Detection
		detail string
	}{
		{serviceMissing, Detection{State: DetectionAbsent}, "role not installed"},
		{serviceUnknown, Detection{State: DetectionUnknown, Reason: ReasonUnreachable}, "SCM query failed"},
		{serviceStopped, Detection{State: DetectionPresent, Version: "10.0.20348", Reason: ReasonNotRunning}, "vmms stopped"},
		{serviceRunning, Detection{State: DetectionPresent, Version: "10.0.20348"}, "vmms running"},
	}
	for _, tc := range cases {
		t.Run(tc.detail, func(t *testing.T) {
			r := &fakeRunner{fn: stdout("[]")}
			if got := newTestHyperV(tc.state, r).Detect(context.Background()); got != tc.want {
				t.Fatalf("Detect = %+v, want %+v", got, tc.want)
			}
			if r.calls.Load() != 0 {
				t.Fatal("Detect executed a command")
			}
		})
	}
}

func TestHyperVCollectMapsFixture(t *testing.T) {
	r := &fakeRunner{fn: stdout(string(fixture(t, "hyperv_vms.json")))}
	d := newTestHyperV(serviceRunning, r)
	res := d.Collect(context.Background(), d.Detect(context.Background()))
	if res.Collection != CollectionOK || !res.Complete || res.Error != "" || res.ObservedCount != 5 {
		t.Fatalf("result = %+v", res)
	}
	if len(r.argv) != 1 || r.argv[0][0] != testPowerShell || strings.Join(r.argv[0][1:], "\x00") != strings.Join(hypervArgs, "\x00") {
		t.Fatalf("argv = %q", r.argv)
	}
	byName := map[string]Workload{}
	for _, w := range res.Workloads {
		byName[w.Name] = w
		if w.Kind != KindVM {
			t.Errorf("%s kind = %s", w.Name, w.Kind)
		}
	}
	type want struct {
		id, state, raw string
		cpu, mem       int
		started        string
	}
	for name, w := range map[string]want{
		"app-01":       {"6f1c2a9e-0b4d-4c41-9e1a-1d2f3a4b5c6d", StateRunning, "Running", 4, 8192, "2026-10-06T09:59:00Z"},
		"build-runner": {"7a2d3b0f-1c5e-4d52-8f2b-2e3f4a5b6c7e", StateStopped, "Off", 2, 2048, ""},
		"lab-dc":       {"8b3e4c1a-2d6f-4e63-9a3c-3f4a5b6c7d8f", StatePaused, "Paused", 2, 4096, ""},
		"archive-vm":   {"9c4f5d2b-3e7a-4f74-8b4d-4a5b6c7d8e9a", StateStopped, "Saved", 1, 1024, ""},
		"edge-gw":      {"ad506e3c-4f8b-4a85-9c5e-5b6c7d8e9fab", StateRunning, "RunningCritical", 1, 1024, "2026-10-06T11:55:00Z"},
	} {
		got, ok := byName[name]
		if !ok {
			t.Errorf("missing %s", name)
			continue
		}
		if got.WorkloadID != w.id || got.State != w.state || deref(got.RawState) != w.raw ||
			deref(got.StartedAt) != w.started || derefInt(got.CPUCount) != w.cpu || derefInt(got.MemoryMB) != w.mem {
			t.Errorf("%s = %s", name, mustJSON(got))
		}
		if got.ImageRef != nil || got.GuestOS != nil || got.RestartPolicy != nil || got.RuntimeCreatedAt != nil {
			t.Errorf("%s reports fields outside the Hyper-V allowlist: %s", name, mustJSON(got))
		}
	}
	if res.Workloads[0].State != StateRunning || res.Workloads[1].State != StateRunning {
		t.Errorf("running VMs are not ordered first: %s", mustJSON(res.Workloads))
	}
}

// started_at is derived from uptime; it must not move between two collections
// a few seconds apart, or every collection would look like a change.
func TestHyperVStartedAtIsStableAcrossCollections(t *testing.T) {
	collectAt := func(now time.Time, uptime int) string {
		r := &fakeRunner{fn: stdout(fmt.Sprintf(`[{"Id":"6f1c2a9e-0b4d-4c41-9e1a-1d2f3a4b5c6d","Name":"a","State":2,"UptimeSeconds":%d}]`, uptime))}
		d := newTestHyperV(serviceRunning, r)
		d.now = func() time.Time { return now }
		return deref(d.Collect(context.Background(), Detection{State: DetectionPresent}).Workloads[0].StartedAt)
	}
	t0 := time.Date(2026, 10, 6, 12, 0, 20, 0, time.UTC)
	a := collectAt(t0, 3600)
	b := collectAt(t0.Add(65*time.Minute+1*time.Second), 3600+65*60)
	if a == "" || a != b {
		t.Fatalf("started_at moved: %q -> %q", a, b)
	}
}

func TestHyperVSingleObjectBOMAndCase(t *testing.T) {
	out := "\xef\xbb\xbf" + `{"Id":"6F1C2A9E-0B4D-4C41-9E1A-1D2F3A4B5C6D","Name":"solo-vm","State":2,"ProcessorCount":2,"MemoryAssigned":2147483648,"UptimeSeconds":59}` + "\r\n"
	r := &fakeRunner{fn: stdout(out)}
	res := newTestHyperV(serviceRunning, r).Collect(context.Background(), Detection{State: DetectionPresent})
	if res.Collection != CollectionOK || len(res.Workloads) != 1 {
		t.Fatalf("result = %+v", res)
	}
	if res.Workloads[0].WorkloadID != "6f1c2a9e-0b4d-4c41-9e1a-1d2f3a4b5c6d" {
		t.Fatalf("id = %q", res.Workloads[0].WorkloadID)
	}
}

func TestHyperVCollectFailures(t *testing.T) {
	exit := func(code int) func(string, []string) (cmdOutput, error) {
		return func(string, []string) (cmdOutput, error) {
			return cmdOutput{ExitCode: code, Stderr: []byte("Get-VM : raw error text")}, nil
		}
	}
	fail := func(err error) func(string, []string) (cmdOutput, error) {
		return func(string, []string) (cmdOutput, error) { return cmdOutput{}, err }
	}
	cases := []struct {
		name       string
		fn         func(string, []string) (cmdOutput, error)
		collection string
		code       string
		complete   bool
	}{
		{"empty host", stdout("[]"), CollectionOK, "", true},
		// null decodes without error; it must never read as an empty host
		{"null", stdout("null"), CollectionError, "decode_failed", false},
		{"null array entry", stdout("[null]"), CollectionOK, "invalid_entry", false},
		{"object without id", stdout("{}"), CollectionOK, "invalid_entry", false},
		{"entry without id", stdout(`[{"Name":"x","State":2}]`), CollectionOK, "invalid_entry", false},
		{"empty host, whitespace", stdout(" []\r\n"), CollectionOK, "", true},
		{"no output at all", stdout(""), CollectionError, "empty_output", false},
		{"malformed json", stdout(`[{"Id":`), CollectionError, "decode_failed", false},
		{"not json", stdout("Get-VM : something"), CollectionError, "decode_failed", false},
		{"module missing", exit(hypervExitCmdletMissing), CollectionUnavailable, "cmdlet_missing", false},
		{"permission denied", exit(hypervExitPermissionDenied), CollectionPermissionDenied, ReasonPermissionDenied, false},
		{"other failure", exit(1), CollectionError, "command_failed", false},
		{"timeout", fail(context.DeadlineExceeded), CollectionUnavailable, ReasonTimeout, false},
		{"oversize", fail(errTooLarge), CollectionError, "response_too_large", false},
		{"powershell missing", fail(&fs.PathError{Op: "fork/exec", Path: testPowerShell, Err: fs.ErrNotExist}), CollectionUnavailable, "tool_missing", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := newTestHyperV(serviceRunning, &fakeRunner{fn: tc.fn}).Collect(context.Background(), Detection{State: DetectionPresent})
			if res.Collection != tc.collection || res.Error != tc.code || res.Complete != tc.complete {
				t.Fatalf("result = %+v, want %s/%q complete=%v", res, tc.collection, tc.code, tc.complete)
			}
			if res.Collection != CollectionOK && len(res.Workloads) != 0 {
				t.Fatal("a failed collection returned workloads")
			}
		})
	}
}

func TestHyperVCollectDoesNotExecWhenNotRunning(t *testing.T) {
	for _, reason := range []string{ReasonNotRunning, ReasonPermissionDenied} {
		r := &fakeRunner{fn: stdout("[]")}
		res := newTestHyperV(serviceStopped, r).Collect(context.Background(), Detection{State: DetectionPresent, Reason: reason})
		if res.Collection == CollectionOK || r.calls.Load() != 0 {
			t.Fatalf("reason %s: result = %+v, execs = %d", reason, res, r.calls.Load())
		}
	}
	d := newTestHyperV(serviceRunning, &fakeRunner{fn: stdout("[]")})
	d.powershell = ""
	if res := d.Collect(context.Background(), Detection{State: DetectionPresent}); res.Collection != CollectionUnavailable || res.Error != "tool_missing" {
		t.Fatalf("no powershell: %+v", res)
	}
}

func TestHyperVCapsAtMaxWorkloads(t *testing.T) {
	var b strings.Builder
	b.WriteString("[")
	for i := 0; i < MaxWorkloadsPerRuntime+5; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `{"Id":"00000000-0000-0000-0000-%012d","Name":"vm-%d","State":3}`, i, i)
	}
	b.WriteString("]")
	res := newTestHyperV(serviceRunning, &fakeRunner{fn: stdout(b.String())}).Collect(context.Background(), Detection{State: DetectionPresent})
	if res.Collection != CollectionOK || res.Complete || res.Error != "truncated" ||
		len(res.Workloads) != MaxWorkloadsPerRuntime || res.ObservedCount != MaxWorkloadsPerRuntime+5 {
		t.Fatalf("collection=%s complete=%v error=%q n=%d observed=%d", res.Collection, res.Complete, res.Error, len(res.Workloads), res.ObservedCount)
	}
}

// The settings gate lives in the collector: a disabled runtime is detected but
// never enumerated, and Detect itself runs nothing.
func TestHyperVDisabledNeverExecs(t *testing.T) {
	r := &fakeRunner{fn: stdout(string(fixture(t, "hyperv_vms.json")))}
	s := enabled()
	s.HyperV = false
	rep := New([]Driver{newTestHyperV(serviceRunning, r)}, WithClock(fixedNow)).Collect(context.Background(), s)
	if rt := rep.Runtimes[0]; rt.Collection != CollectionDisabled || rt.Detection != DetectionPresent || len(rt.Workloads) != 0 {
		t.Fatalf("runtime = %+v", rt)
	}
	if r.calls.Load() != 0 {
		t.Fatalf("a disabled runtime executed %d commands", r.calls.Load())
	}
	rep = New([]Driver{newTestHyperV(serviceRunning, r)}, WithClock(fixedNow)).Collect(context.Background(), DefaultSettings())
	if rep.Runtimes[0].Collection != CollectionDisabled || r.calls.Load() != 0 {
		t.Fatal("default settings (master switch off) enumerated Hyper-V")
	}
}

func TestHyperVReportThroughCollectorHasNoNUL(t *testing.T) {
	out := `[{"Id":"6f1c2a9e-0b4d-4c41-9e1a-1d2f3a4b5c6d","Name":"bad\u0000name","State":2,"UptimeSeconds":10}]`
	rep := New([]Driver{newTestHyperV(serviceRunning, &fakeRunner{fn: stdout(out)})}, WithClock(fixedNow)).Collect(context.Background(), enabled())
	raw, _ := json.Marshal(rep)
	if strings.Contains(string(raw), `\u0000`) {
		t.Fatalf("NUL reached the wire: %s", raw)
	}
	if rt := rep.Runtimes[0]; rt.Runtime != RuntimeHyperV || rt.Collection != CollectionOK || rt.Workloads[0].Name != "badname" {
		t.Fatalf("runtime = %s", mustJSON(rt))
	}
}

// The script travels as one argv element through Go's Windows command-line
// quoting and PowerShell's -Command parser; double quotes and newlines are
// where that goes wrong, so the fixed text has neither.
func TestHyperVScriptIsSingleLineAndSingleQuoted(t *testing.T) {
	if strings.ContainsAny(hypervScript, "\"\r\n") {
		t.Fatalf("script contains a double quote or newline: %s", hypervScript)
	}
	if !strings.Contains(hypervScript, "Get-VM") || !strings.Contains(hypervScript, "ConvertTo-Json") {
		t.Fatal("script lost its cmdlets")
	}
	// Windows PowerShell writes redirected stdout in the OEM code page unless
	// told otherwise, which would mangle non-ASCII VM names.
	if !strings.Contains(hypervScript, "[Console]::OutputEncoding") || !strings.Contains(hypervScript, "UTF8Encoding") {
		t.Fatal("script does not switch stdout to UTF-8")
	}
	if !allowedCommand(testPowerShell, hypervArgs) {
		t.Fatal("the production argv is not on the allowlist")
	}
}

func TestHyperVStateMapping(t *testing.T) {
	cases := []struct {
		raw   string
		state string
		name  string
	}{
		{`2`, StateRunning, "Running"},
		{`3`, StateStopped, "Off"},
		{`6`, StateStopped, "Saved"},
		{`9`, StatePaused, "Paused"},
		{`10`, StateOther, "Starting"},
		{`11`, StateRestarting, "Reset"},
		{`32779`, StateStopped, "FastSaved"},
		{`32783`, StateStopped, "Hibernated"},
		{`32785`, StateRunning, "RunningCritical"},
		{`32786`, StateStopped, "OffCritical"},
		{`32789`, StatePaused, "PausedCritical"},
		{`"Running"`, StateRunning, "Running"},
		{`"Off"`, StateStopped, "Off"},
		{`"Paused"`, StatePaused, "Paused"},
		{`4242`, StateOther, "4242"},
		{`"Weird"`, StateOther, "Weird"},
		{`null`, StateOther, ""},
	}
	for _, tc := range cases {
		state, name := hypervState(json.RawMessage(tc.raw))
		if state != tc.state || name != tc.name {
			t.Errorf("hypervState(%s) = %s/%q, want %s/%q", tc.raw, state, name, tc.state, tc.name)
		}
	}
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func derefInt(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
