package biosconfig

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"sync"
	"testing"
)

// fakeDellWriter stands in for the PowerShell run of dellApplyScript.
type fakeDellWriter struct {
	mu    sync.Mutex
	out   []byte
	err   error
	calls []fakeCall
}

func (f *fakeDellWriter) write(_ context.Context, script string, stdin []byte) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, fakeCall{script: script, stdin: append([]byte(nil), stdin...)})
	return f.out, f.err
}

func (f *fakeDellWriter) n() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.calls) }

func dellWithWriter(w *fakeDellWriter) *dellAdapter {
	return &dellAdapter{
		run: func(ctx context.Context, script string) ([]byte, error) {
			return []byte(`{"biosAttributes":true,"enumeration":[],"passwords":[{"NameId":"Admin","IsPasswordSet":0}]}`), nil
		},
		write: w.write,
	}
}

func TestDellApplyRunsTheOneWriteScriptWithNameAndValueAsStdin(t *testing.T) {
	w := &fakeDellWriter{out: []byte(`{"status":0,"returnValue":0,"error":null}`)}
	if err := dellWithWriter(w).Apply(context.Background(), "WakeOnLan", "LanOnly"); err != nil {
		t.Fatalf("Apply = %v", err)
	}
	if w.n() != 1 {
		t.Fatalf("%d runs, want 1", w.n())
	}
	c := w.calls[0]
	if c.script != dellApplyScript {
		t.Fatal("Apply ran a script other than dellApplyScript")
	}
	var req map[string]string
	if err := json.Unmarshal(c.stdin, &req); err != nil {
		t.Fatalf("stdin is not JSON: %v", err)
	}
	if len(req) != 2 || req["name"] != "WakeOnLan" || req["value"] != "LanOnly" {
		t.Fatalf("stdin = %v", req)
	}
}

// SetAttribute's Status (Dell native BIOS WMI, doc-derived): 0 success,
// 1 failed, 2 invalid parameter, 3 access denied, 4 not supported, 5 memory
// error, 6 protocol error. Only an exact 0 is success; anything else, and any
// output that is not a clean status, is a failure.
func TestDellReturnCodesMapToApplyFailed(t *testing.T) {
	ok := []string{
		`{"status":0,"returnValue":0,"error":null}`,
		`{"status":0,"returnValue":null,"error":null}`,
		`{"status":null,"returnValue":0,"error":null}`,
	}
	for _, out := range ok {
		w := &fakeDellWriter{out: []byte(out)}
		if err := dellWithWriter(w).Apply(context.Background(), "WakeOnLan", "LanOnly"); err != nil {
			t.Errorf("%s: Apply = %v, want nil", out, err)
		}
	}
	for code := 1; code <= 6; code++ {
		raw, _ := json.Marshal(map[string]any{"status": code, "returnValue": 0, "error": nil})
		w := &fakeDellWriter{out: raw}
		err := dellWithWriter(w).Apply(context.Background(), "WakeOnLan", "LanOnly")
		var de *DellStatusError
		if !errors.As(err, &de) || de.Code != code || !errors.Is(err, ErrApplyFailed) {
			t.Errorf("status %d: Apply = %v, want DellStatusError{%d}", code, err, code)
		}
		if de != nil && de.Error() == "" {
			t.Errorf("status %d has no message", code)
		}
	}
	bad := []string{
		`{"status":7,"returnValue":0,"error":null}`,
		`{"status":-1,"returnValue":0,"error":null}`,
		`{"status":0,"returnValue":1,"error":null}`,
		`{"status":1,"returnValue":0,"error":null}`,
		`{"status":null,"returnValue":null,"error":null}`,
		`{"status":"0","returnValue":0,"error":null}`,
		`{"status":0.5,"returnValue":0,"error":null}`,
		`{"status":0,"returnValue":0,"error":"value_not_allowed"}`,
		`{"status":null,"returnValue":null,"error":"exception"}`,
		`{"returnValue":0}`,
		`{}`,
		`[]`,
		`not json`,
		``,
	}
	for _, out := range bad {
		w := &fakeDellWriter{out: []byte(out)}
		if err := dellWithWriter(w).Apply(context.Background(), "WakeOnLan", "LanOnly"); !errors.Is(err, ErrApplyFailed) {
			t.Errorf("%q: Apply = %v, want ErrApplyFailed", out, err)
		}
	}
	// The script's own refusal codes come back as text, never device output.
	w := &fakeDellWriter{out: []byte(`{"status":null,"returnValue":null,"error":"value_not_allowed"}`)}
	if err := dellWithWriter(w).Apply(context.Background(), "WakeOnLan", "LanOnly"); err == nil || !strings.Contains(err.Error(), "value_not_allowed") {
		t.Errorf("refusal code not reported: %v", err)
	}
	w = &fakeDellWriter{out: []byte(`{"status":null,"returnValue":null,"error":"C:\\secret path; drop"}`)}
	if err := dellWithWriter(w).Apply(context.Background(), "WakeOnLan", "LanOnly"); err == nil || strings.Contains(err.Error(), "secret") {
		t.Errorf("an unexpected error text must not be echoed: %v", err)
	}
}

func TestDellApplyRunErrorIsAFailure(t *testing.T) {
	boom := errors.New("powershell exit 1")
	w := &fakeDellWriter{err: boom}
	if err := dellWithWriter(w).Apply(context.Background(), "WakeOnLan", "LanOnly"); !errors.Is(err, boom) || !errors.Is(err, ErrApplyFailed) {
		t.Fatalf("Apply = %v", err)
	}
}

// Only plain identifiers reach the script: nothing that could be a second
// argument, a wildcard or a script fragment.
func TestDellApplyRefusesUnsafeNamesAndValues(t *testing.T) {
	for _, nv := range [][2]string{
		{"", "LanOnly"}, {"WakeOnLan", ""}, {"Wake On Lan", "LanOnly"}, {"WakeOnLan", "Lan'Only"},
		{"WakeOnLan;", "LanOnly"}, {"WakeOnLan", "LanOnly\n"}, {"Wake*", "LanOnly"}, {"WakeOnLan", "$x"},
		{strings.Repeat("A", 65), "LanOnly"}, {"WakeOnLan", "Lan\u00e9"},
	} {
		w := &fakeDellWriter{out: []byte(`{"status":0,"returnValue":0,"error":null}`)}
		if err := dellWithWriter(w).Apply(context.Background(), nv[0], nv[1]); err == nil {
			t.Errorf("%q=%q: Apply accepted", nv[0], nv[1])
		}
		if w.n() != 0 {
			t.Errorf("%q=%q: script ran", nv[0], nv[1])
		}
	}
}

// An adapter with no writer (every OS but Windows) refuses and runs nothing.
func TestDellApplyWithoutWriterRunsNothing(t *testing.T) {
	a := &dellAdapter{run: func(ctx context.Context, script string) ([]byte, error) {
		t.Fatal("Apply must not run a read either")
		return nil, nil
	}}
	if err := a.Apply(context.Background(), "WakeOnLan", "LanOnly"); !errors.Is(err, ErrNotEnabled) {
		t.Fatalf("got %v", err)
	}
}

// A read cached just before a write must not be served as its read-back.
func TestDellApplyDropsTheCachedRead(t *testing.T) {
	reads := 0
	w := &fakeDellWriter{out: []byte(`{"status":0,"returnValue":0,"error":null}`)}
	a := &dellAdapter{run: func(ctx context.Context, script string) ([]byte, error) {
		reads++
		return readCapture(t), nil
	}, write: w.write}
	ctx := context.Background()
	_, _ = a.Read(ctx)
	if err := a.Apply(ctx, "WakeOnLan", "LanOnly"); err != nil {
		t.Fatal(err)
	}
	_, _ = a.Read(ctx)
	if reads != 2 {
		t.Fatalf("%d reads, want 2 (the read after a write is fresh)", reads)
	}
	// Also after a failed write.
	w.out = []byte(`{"status":1,"returnValue":0,"error":null}`)
	_ = a.Apply(ctx, "WakeOnLan", "LanOnly")
	_, _ = a.Read(ctx)
	if reads != 3 {
		t.Fatalf("%d reads, want 3", reads)
	}
}

// The write script is one fixed SetAttribute call with no password (SecType 0,
// no handle), on Dell's BIOS attribute namespace only. It re-checks on the
// machine that the name is listed exactly once and the value is one the model
// allows, and it reads the name and value only from stdin.
func TestDellApplyScriptShape(t *testing.T) {
	s := dellApplyScript
	for _, want := range []string{
		"-MethodName SetAttribute",
		"SecType=[uint32]0",
		"SecHndCount=[uint32]0",
		"SecHandle=[byte[]]@()",
		"[Console]::In.ReadToEnd()",
		"'EnumerationAttribute'",
		"'BIOSAttributeInterface'",
		"-ccontains $value",
		"$attr.Count -ne 1",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("write script lacks %q", want)
		}
	}
	if n := strings.Count(s, "Invoke-CimMethod"); n != 1 {
		t.Errorf("%d Invoke-CimMethod calls, want 1", n)
	}
	lower := strings.ToLower(s)
	for _, bad := range []string{"password", "suspend", "bitlocker", "restart", "shutdown", "invoke-expression", "iex ",
		"add-type", "set-", "new-", "remove-", "wmisecurity", "cctk", "%s", "%v", "%q"} {
		if strings.Contains(lower, bad) {
			t.Errorf("write script contains %q", bad)
		}
	}
	for _, m := range regexp.MustCompile(`(?i)-namespace\s+'([^']+)'`).FindAllStringSubmatch(s, -1) {
		if strings.ToLower(m[1]) != `root\dcim\sysman\biosattributes` {
			t.Errorf("unexpected namespace %q", m[1])
		}
	}
	if strings.Contains(dellReadScript, "SetAttribute") || strings.Contains(dellReadScript, "Invoke-CimMethod") {
		t.Error("the read script must stay read-only")
	}
}
