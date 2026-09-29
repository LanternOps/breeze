package desktop

import (
	"fmt"
	"testing"
)

// chooseDPIAwareness must prefer per-monitor-v2 (physical coordinates on every
// monitor, matching DXGI output geometry), then per-monitor, then the legacy
// system-DPI call, and report which one took effect.
func TestChooseDPIAwareness(t *testing.T) {
	tests := []struct {
		name           string
		v2, pm, legacy bool
		want           string
	}{
		{"v2 available", true, true, true, dpiModePerMonitorV2},
		{"v2 missing, per-monitor available", false, true, true, dpiModePerMonitor},
		{"only legacy", false, false, true, dpiModeSystem},
		{"nothing works", false, false, false, dpiModeUnaware},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			calls := []string{}
			mk := func(name string, ok bool) func() bool {
				return func() bool { calls = append(calls, name); return ok }
			}
			got := chooseDPIAwareness(mk("v2", tc.v2), mk("pm", tc.pm), mk("legacy", tc.legacy))
			if got != tc.want {
				t.Fatalf("got %q want %q (calls %v)", got, tc.want, calls)
			}
			// Must stop at the first success — later calls fail with
			// ERROR_ACCESS_DENIED once the process mode is set.
			switch tc.want {
			case dpiModePerMonitorV2:
				if len(calls) != 1 {
					t.Fatalf("expected 1 call, got %v", calls)
				}
			case dpiModePerMonitor:
				if len(calls) != 2 {
					t.Fatalf("expected 2 calls, got %v", calls)
				}
			default:
				if len(calls) != 3 {
					t.Fatalf("expected every tier attempted (3 calls), got %v", calls)
				}
			}
		})
	}
}

func TestHresultSucceeded(t *testing.T) {
	cases := map[uintptr]bool{
		0x00000000: true,  // S_OK
		0x00000001: true,  // S_FALSE
		0x80070005: false, // E_ACCESSDENIED — mode already set; int64(hr) >= 0 would wrongly pass
		0x80070057: false, // E_INVALIDARG
	}
	for hr, want := range cases {
		if got := hresultSucceeded(hr); got != want {
			t.Errorf("0x%08x: got %v want %v", hr, got, want)
		}
	}
}

// Only a weaker-than-per-monitor Windows mode misplaces input; "n/a" is the
// non-Windows value and must not warn.
func TestDPIModeMisplacesInput(t *testing.T) {
	for mode, want := range map[string]bool{
		dpiModePerMonitorV2: false,
		dpiModePerMonitor:   false,
		dpiModeSystem:       true,
		dpiModeUnaware:      true,
		"n/a":               false,
	} {
		if got := dpiModeMisplacesInput(mode); got != want {
			t.Errorf("dpiModeMisplacesInput(%q) = %v, want %v", mode, got, want)
		}
	}
}

// fakeDPIProcess models the Windows DPI state that the init-time resolver
// sees: the effective awareness a manifest (or an earlier set call) pinned,
// which query APIs this Windows build exports, and the rule that every set
// call fails once the awareness is already set.
type fakeDPIProcess struct {
	mode   string // effective awareness; "" = never set (unaware default)
	locked bool   // awareness already set; set calls fail with access denied

	hasProcessContext bool // GetDpiAwarenessContextForProcess (1803+)
	hasThreadContext  bool // GetThreadDpiAwarenessContext + friends (1607+)
	hasShcoreQuery    bool // GetProcessDpiAwareness (8.1+)
	hasV2             bool // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (1703+)

	setCalls []string
}

func (p *fakeDPIProcess) effective() string {
	if p.mode == "" {
		return dpiModeUnaware
	}
	return p.mode
}

// ctx encodes the effective mode as an opaque DPI_AWARENESS_CONTEXT value.
func (p *fakeDPIProcess) ctx() (uintptr, bool) {
	return map[string]uintptr{dpiModeUnaware: 0x10, dpiModeSystem: 0x11, dpiModePerMonitor: 0x12, dpiModePerMonitorV2: 0x22}[p.effective()], true
}

func (p *fakeDPIProcess) queryAPIs() dpiQueryAPIs {
	var apis dpiQueryAPIs
	if p.hasProcessContext {
		apis.processContext = p.ctx
	}
	if p.hasThreadContext {
		apis.threadContext = p.ctx
		apis.awarenessFromContext = func(ctx uintptr) int32 {
			switch ctx {
			case 0x10:
				return 0
			case 0x11:
				return 1
			case 0x12, 0x22:
				return 2
			}
			return -1
		}
		apis.isPerMonitorV2 = func(ctx uintptr) bool { return ctx == 0x22 }
	}
	if p.hasShcoreQuery {
		apis.processAwareness = func() (uint32, bool) {
			return map[string]uint32{dpiModeUnaware: 0, dpiModeSystem: 1, dpiModePerMonitor: 2, dpiModePerMonitorV2: 2}[p.effective()], true
		}
	}
	return apis
}

func (p *fakeDPIProcess) set(name, mode string, supported bool) func() bool {
	return func() bool {
		p.setCalls = append(p.setCalls, name)
		if !supported || p.locked {
			return false
		}
		p.mode, p.locked = mode, true
		return true
	}
}

func (p *fakeDPIProcess) resolve() (string, string) {
	return resolveDPIAwareness(
		func() (string, bool) { return queryEffectiveDPIMode(p.queryAPIs()) },
		func() string {
			return chooseDPIAwareness(
				p.set("v2", dpiModePerMonitorV2, p.hasV2),
				p.set("pm", dpiModePerMonitor, true),
				p.set("legacy", dpiModeSystem, true),
			)
		},
	)
}

// The reported mode must be the EFFECTIVE awareness, not whichever redundant
// set call happened to succeed: with a manifest-declared awareness every set
// call fails, and inferring from them misreports a per-monitor-v2 process
// (#7391 review).
func TestResolveDPIAwareness(t *testing.T) {
	modern := func(mode string, locked bool) *fakeDPIProcess {
		return &fakeDPIProcess{mode: mode, locked: locked, hasProcessContext: true, hasThreadContext: true, hasShcoreQuery: true, hasV2: true}
	}
	tests := []struct {
		name         string
		proc         *fakeDPIProcess
		wantMode     string
		wantSource   string
		wantSetCalls []string
	}{
		{"manifest per-monitor-v2: reported as such, no set calls",
			modern(dpiModePerMonitorV2, true), dpiModePerMonitorV2, dpiSourcePreset, nil},
		{"manifest per-monitor (v1): accepted, no set calls",
			modern(dpiModePerMonitor, true), dpiModePerMonitor, dpiSourcePreset, nil},
		{"no manifest: API elevates to per-monitor-v2",
			modern("", false), dpiModePerMonitorV2, dpiSourceSet, []string{"v2"}},
		{"manifest pins system: set calls all fail, still reports system",
			modern(dpiModeSystem, true), dpiModeSystem, dpiSourceSet, []string{"v2", "pm", "legacy"}},
		{"1607 (no process-context API, no V2): thread context confirms per-monitor",
			&fakeDPIProcess{hasThreadContext: true, hasShcoreQuery: true}, dpiModePerMonitor, dpiSourceSet, []string{"v2", "pm"}},
		{"only shcore query: manifest per-monitor read as per-monitor",
			&fakeDPIProcess{mode: dpiModePerMonitor, locked: true, hasShcoreQuery: true}, dpiModePerMonitor, dpiSourcePreset, nil},
		{"no query API, pre-V2 build: inferred per-monitor from set calls",
			&fakeDPIProcess{}, dpiModePerMonitor, dpiSourceInferred, []string{"v2", "pm"}},
		{"no query API, everything already locked: inferred unaware",
			&fakeDPIProcess{locked: true}, dpiModeUnaware, dpiSourceInferred, []string{"v2", "pm", "legacy"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			mode, source := tc.proc.resolve()
			if mode != tc.wantMode || source != tc.wantSource {
				t.Fatalf("got (%q, %q), want (%q, %q); set calls %v", mode, source, tc.wantMode, tc.wantSource, tc.proc.setCalls)
			}
			if fmt.Sprint(tc.proc.setCalls) != fmt.Sprint(tc.wantSetCalls) {
				t.Fatalf("set calls %v, want %v", tc.proc.setCalls, tc.wantSetCalls)
			}
		})
	}
}

// Legacy-only: no query API and only SetProcessDPIAware works, so the
// resolver falls back to the set-call inference.
func TestResolveDPIAwarenessLegacyOnly(t *testing.T) {
	calls := 0
	mode, source := resolveDPIAwareness(
		func() (string, bool) { return "", false },
		func() string {
			calls++
			return chooseDPIAwareness(func() bool { return false }, func() bool { return false }, func() bool { return true })
		},
	)
	if mode != dpiModeSystem || source != dpiSourceInferred || calls != 1 {
		t.Fatalf("got (%q, %q) after %d elevate calls, want (system, inferred) after 1", mode, source, calls)
	}
}

// queryEffectiveDPIMode classifies raw Win32 query results.
func TestQueryEffectiveDPIMode(t *testing.T) {
	ctx := func(v uintptr) func() (uintptr, bool) { return func() (uintptr, bool) { return v, v != 0 } }
	aware := func(m map[uintptr]int32) func(uintptr) int32 {
		return func(c uintptr) int32 {
			if v, ok := m[c]; ok {
				return v
			}
			return -1
		}
	}
	isV2 := func(c uintptr) bool { return c == 0x22 }
	shcore := func(v uint32, ok bool) func() (uint32, bool) { return func() (uint32, bool) { return v, ok } }
	tests := []struct {
		name   string
		apis   dpiQueryAPIs
		want   string
		wantOK bool
	}{
		{"process context v2", dpiQueryAPIs{processContext: ctx(0x22), threadContext: ctx(0x11), awarenessFromContext: aware(map[uintptr]int32{0x22: 2, 0x11: 1}), isPerMonitorV2: isV2}, dpiModePerMonitorV2, true},
		{"process context wins over thread context", dpiQueryAPIs{processContext: ctx(0x11), threadContext: ctx(0x22), awarenessFromContext: aware(map[uintptr]int32{0x22: 2, 0x11: 1}), isPerMonitorV2: isV2}, dpiModeSystem, true},
		{"per-monitor v1", dpiQueryAPIs{processContext: ctx(0x12), awarenessFromContext: aware(map[uintptr]int32{0x12: 2}), isPerMonitorV2: isV2}, dpiModePerMonitor, true},
		{"unaware", dpiQueryAPIs{threadContext: ctx(0x10), awarenessFromContext: aware(map[uintptr]int32{0x10: 0}), isPerMonitorV2: isV2}, dpiModeUnaware, true},
		{"null process context falls back to thread", dpiQueryAPIs{processContext: ctx(0), threadContext: ctx(0x22), awarenessFromContext: aware(map[uintptr]int32{0x22: 2}), isPerMonitorV2: isV2}, dpiModePerMonitorV2, true},
		{"invalid awareness falls back to shcore", dpiQueryAPIs{threadContext: ctx(0x99), awarenessFromContext: aware(nil), isPerMonitorV2: isV2, processAwareness: shcore(1, true)}, dpiModeSystem, true},
		{"context getters without awareness reader are unusable", dpiQueryAPIs{processContext: ctx(0x22), processAwareness: shcore(2, true)}, dpiModePerMonitor, true},
		{"shcore unaware", dpiQueryAPIs{processAwareness: shcore(0, true)}, dpiModeUnaware, true},
		{"shcore failed HRESULT", dpiQueryAPIs{processAwareness: shcore(2, false)}, "", false},
		{"shcore out-of-range value", dpiQueryAPIs{processAwareness: shcore(7, true)}, "", false},
		{"no API at all", dpiQueryAPIs{}, "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := queryEffectiveDPIMode(tc.apis)
			if got != tc.want || ok != tc.wantOK {
				t.Fatalf("got (%q, %v), want (%q, %v)", got, ok, tc.want, tc.wantOK)
			}
		})
	}
}
