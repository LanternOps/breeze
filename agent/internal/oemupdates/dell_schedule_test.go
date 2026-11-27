package oemupdates

import (
	"errors"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"unicode/utf16"
)

// The refusal codes are the API's and the console's vocabulary too
// (packages/shared OEM_TOOL_CONFIG_ERROR_CODES). A code added or renamed on one
// side only fails here.
const sharedOemUtilsPath = "../../../packages/shared/src/utils/oemUpdates.ts"

func TestDellScheduleCodesMatchShared(t *testing.T) {
	src, err := os.ReadFile(sharedOemUtilsPath)
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?s)OEM_TOOL_CONFIG_ERROR_CODES = \[(.*?)\] as const`).FindSubmatch(src)
	if m == nil {
		t.Fatal("OEM_TOOL_CONFIG_ERROR_CODES not found in the shared utils")
	}
	var shared []string
	for _, q := range regexp.MustCompile(`'([a-z_]+)'`).FindAllSubmatch(m[1], -1) {
		shared = append(shared, string(q[1]))
	}
	agent := []string{codeScheduleNotManual, codeSchedulePolicyNotManual, codeScheduleUnreadable,
		codeSchedulePolicyUnknown, codeToolNotInstalled}
	if strings.Join(shared, ",") != strings.Join(agent, ",") {
		t.Fatalf("shared codes %q, agent codes %q", shared, agent)
	}
}

// fakeRegistry answers regReader calls from fixed readings. A key it does not
// know reads as absent. Every read is recorded, so a test can show which keys
// the detector asked for.
type fakeRegistry struct {
	mu     sync.Mutex
	values map[string]regRead
	errs   map[string]error
	reads  []string
}

func regKey(key, name string) string { return key + `|` + name }

func newFakeRegistry() *fakeRegistry {
	return &fakeRegistry{values: map[string]regRead{}, errs: map[string]error{}}
}

// setString stores a REG_SZ value, and so its key.
func (f *fakeRegistry) setString(key, name, v string) *fakeRegistry {
	f.values[regKey(key, name)] = regRead{KeyExists: true, ValueExists: true, String: true, Value: v}
	return f
}

// setWrongType stores a value that is not REG_SZ (a DWORD, say).
func (f *fakeRegistry) setWrongType(key, name string) *fakeRegistry {
	f.values[regKey(key, name)] = regRead{KeyExists: true, ValueExists: true}
	return f
}

// setKeyOnly makes the key exist with no value of that name.
func (f *fakeRegistry) setKeyOnly(key, name string) *fakeRegistry {
	f.values[regKey(key, name)] = regRead{KeyExists: true}
	return f
}

func (f *fakeRegistry) fail(key, name string, err error) *fakeRegistry {
	f.errs[regKey(key, name)] = err
	return f
}

func (f *fakeRegistry) read(key, name string) (regRead, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads = append(f.reads, regKey(key, name))
	if err, ok := f.errs[regKey(key, name)]; ok {
		return regRead{KeyExists: true}, err
	}
	return f.values[regKey(key, name)], nil
}

func manualDellRegistry() *fakeRegistry {
	return newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, dellManualUpdates)
}

var errAccessDenied = errors.New("access is denied")

// Every state the lab saw, plus the ones it could not rule out. Only an exact
// ManualUpdates in the settings key, with no policy saying otherwise, passes.
func TestDellScheduleModeStates(t *testing.T) {
	cases := []struct {
		name       string
		reg        *fakeRegistry
		manual     bool
		state      scheduleValueState
		mode       string
		source     string
		readErr    bool
		code       string
		noteSubstr string
	}{
		{name: "fresh install, no Schedule key", reg: newFakeRegistry(),
			state: scheduleValueAbsent, source: scheduleSourceSettings, code: codeScheduleNotManual},
		{name: "after restore-defaults, key with no value",
			reg:   newFakeRegistry().setKeyOnly(dellScheduleKey, dellScheduleModeValue),
			state: scheduleValueAbsent, source: scheduleSourceSettings, code: codeScheduleNotManual},
		{name: "ManualUpdates", reg: manualDellRegistry(), manual: true,
			state: scheduleValueString, mode: "ManualUpdates", source: scheduleSourceSettings},
		{name: "Auto", reg: newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "Auto"),
			state: scheduleValueString, mode: "Auto", source: scheduleSourceSettings, code: codeScheduleNotManual},
		{name: "Daily", reg: newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "Daily"),
			state: scheduleValueString, mode: "Daily", source: scheduleSourceSettings, code: codeScheduleNotManual},
		{name: "Weekly", reg: newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "Weekly"),
			state: scheduleValueString, mode: "Weekly", source: scheduleSourceSettings, code: codeScheduleNotManual},
		{name: "Monthly", reg: newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "Monthly"),
			state: scheduleValueString, mode: "Monthly", source: scheduleSourceSettings, code: codeScheduleNotManual},
		{name: "unknown string", reg: newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "Hourly"),
			state: scheduleValueString, mode: "Hourly", source: scheduleSourceSettings, code: codeScheduleNotManual},
		{name: "case differs", reg: newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "manualupdates"),
			state: scheduleValueString, mode: "manualupdates", source: scheduleSourceSettings, code: codeScheduleNotManual},
		{name: "padded", reg: newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, " ManualUpdates"),
			state: scheduleValueString, mode: " ManualUpdates", source: scheduleSourceSettings, code: codeScheduleNotManual},
		{name: "embedded NUL after the name", reg: newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "ManualUpdates\x00Auto"),
			state: scheduleValueString, mode: "ManualUpdates\x00Auto", source: scheduleSourceSettings, code: codeScheduleNotManual},
		{name: "trailing space", reg: newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "ManualUpdates "),
			state: scheduleValueString, mode: "ManualUpdates ", source: scheduleSourceSettings, code: codeScheduleNotManual},
		{name: "the enum number as text", reg: newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "0"),
			state: scheduleValueString, mode: "0", source: scheduleSourceSettings, code: codeScheduleNotManual},
		{name: "wrong value type", reg: newFakeRegistry().setWrongType(dellScheduleKey, dellScheduleModeValue),
			state: scheduleValueWrongType, source: scheduleSourceSettings, code: codeScheduleNotManual},
		{name: "access denied", reg: newFakeRegistry().fail(dellScheduleKey, dellScheduleModeValue, errAccessDenied),
			source: scheduleSourceSettings, readErr: true, code: codeScheduleUnreadable},

		// Policy key: its layout and precedence are not verified (#12267).
		{name: "policy sets Auto over a manual setting",
			reg:   manualDellRegistry().setString(dellPolicyKey, dellScheduleModeValue, "Auto"),
			state: scheduleValueString, mode: "Auto", source: scheduleSourcePolicy, code: codeSchedulePolicyNotManual},
		{name: "policy sets Auto in the settings-shaped subkey",
			reg:   manualDellRegistry().setString(dellPolicyScheduleKey, dellScheduleModeValue, "Auto"),
			state: scheduleValueString, mode: "Auto", source: scheduleSourcePolicy, code: codeSchedulePolicyNotManual},
		{name: "policy value of another type",
			reg:   manualDellRegistry().setWrongType(dellPolicyKey, dellScheduleModeValue),
			state: scheduleValueWrongType, source: scheduleSourcePolicy, code: codeSchedulePolicyNotManual},
		{name: "policy says manual, settings manual", manual: true,
			reg:   manualDellRegistry().setString(dellPolicyKey, dellScheduleModeValue, "ManualUpdates"),
			state: scheduleValueString, mode: "ManualUpdates", source: scheduleSourceSettings,
			noteSubstr: "precedence is not verified"},
		{name: "policy says manual does not stand in for an absent setting",
			reg:   newFakeRegistry().setString(dellPolicyKey, dellScheduleModeValue, "ManualUpdates"),
			state: scheduleValueAbsent, source: scheduleSourceSettings, code: codeScheduleNotManual,
			noteSubstr: "precedence is not verified"},
		// A policy key in a layout this does not know fails closed: refusing a
		// policy-managed device beats running beside a second scheduler.
		{name: "policy key present without ScheduleMode, settings manual",
			reg:   manualDellRegistry().setKeyOnly(dellPolicyKey, dellScheduleModeValue),
			state: scheduleValueAbsent, source: scheduleSourcePolicy, code: codeSchedulePolicyUnknown,
			noteSubstr: "layout not recognised"},
		{name: "policy key present without ScheduleMode, settings Auto",
			reg: newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "Auto").
				setKeyOnly(dellPolicyKey, dellScheduleModeValue),
			state: scheduleValueAbsent, source: scheduleSourcePolicy, code: codeSchedulePolicyUnknown,
			noteSubstr: "layout not recognised"},
		{name: "only the settings-shaped policy subkey, without ScheduleMode",
			reg:   manualDellRegistry().setKeyOnly(dellPolicyScheduleKey, dellScheduleModeValue),
			state: scheduleValueAbsent, source: scheduleSourcePolicy, code: codeSchedulePolicyUnknown,
			noteSubstr: "layout not recognised"},
		{name: "both policy keys present, neither has ScheduleMode",
			reg: manualDellRegistry().setKeyOnly(dellPolicyKey, dellScheduleModeValue).
				setKeyOnly(dellPolicyScheduleKey, dellScheduleModeValue),
			state: scheduleValueAbsent, source: scheduleSourcePolicy, code: codeSchedulePolicyUnknown,
			noteSubstr: "layout not recognised"},
		{name: "policy manual in the subkey, top policy key without a value", manual: true,
			reg: manualDellRegistry().setKeyOnly(dellPolicyKey, dellScheduleModeValue).
				setString(dellPolicyScheduleKey, dellScheduleModeValue, "ManualUpdates"),
			state: scheduleValueString, mode: "ManualUpdates", source: scheduleSourceSettings,
			noteSubstr: "precedence is not verified"},
		{name: "policy manual, settings Auto",
			reg: newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, "Auto").
				setString(dellPolicyKey, dellScheduleModeValue, "ManualUpdates"),
			state: scheduleValueString, mode: "Auto", source: scheduleSourceSettings, code: codeScheduleNotManual,
			noteSubstr: "precedence is not verified"},
		{name: "policy value with an embedded NUL",
			reg:   manualDellRegistry().setString(dellPolicyKey, dellScheduleModeValue, "ManualUpdates\x00Auto"),
			state: scheduleValueString, mode: "ManualUpdates\x00Auto", source: scheduleSourcePolicy, code: codeSchedulePolicyNotManual},
		{name: "policy key unreadable",
			reg:    manualDellRegistry().fail(dellPolicyKey, dellScheduleModeValue, errAccessDenied),
			source: scheduleSourcePolicy, readErr: true, code: codeScheduleUnreadable},
		{name: "policy subkey unreadable",
			reg:    manualDellRegistry().fail(dellPolicyScheduleKey, dellScheduleModeValue, errAccessDenied),
			source: scheduleSourcePolicy, readErr: true, code: codeScheduleUnreadable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := readDellScheduleMode(tc.reg.read)
			if m.Manual() != tc.manual {
				t.Fatalf("Manual() = %v, want %v (%+v)", m.Manual(), tc.manual, m)
			}
			if (m.Err != nil) != tc.readErr {
				t.Fatalf("Err = %v, want a read error: %v", m.Err, tc.readErr)
			}
			if !tc.readErr && m.State != tc.state {
				t.Fatalf("State = %v, want %v", m.State, tc.state)
			}
			if m.Mode != tc.mode {
				t.Fatalf("Mode = %q, want %q", m.Mode, tc.mode)
			}
			if m.Source != tc.source {
				t.Fatalf("Source = %q, want %q", m.Source, tc.source)
			}
			if got := m.refusalCode(); got != tc.code {
				t.Fatalf("refusalCode() = %q, want %q", got, tc.code)
			}
			if tc.noteSubstr != "" && !strings.Contains(m.Note, tc.noteSubstr) {
				t.Fatalf("Note = %q, want it to say %q", m.Note, tc.noteSubstr)
			}
			if tc.noteSubstr == "" && m.Note != "" {
				t.Fatalf("Note = %q, want none", m.Note)
			}
		})
	}
}

// A read error is never mistaken for an absent value, and vice versa.
func TestDellScheduleModeErrorIsNotAbsent(t *testing.T) {
	absent := readDellScheduleMode(newFakeRegistry().read)
	if absent.Err != nil || absent.State != scheduleValueAbsent {
		t.Fatalf("absent reading = %+v", absent)
	}
	denied := readDellScheduleMode(newFakeRegistry().fail(dellScheduleKey, dellScheduleModeValue, errAccessDenied).read)
	if denied.Err == nil || !errors.Is(denied.Err, errAccessDenied) {
		t.Fatalf("denied reading = %+v, want the access error", denied)
	}
}

// No reader at all (a lane built without one) refuses rather than passing.
func TestDellScheduleModeNilReaderRefuses(t *testing.T) {
	m := readDellScheduleMode(nil)
	if m.Manual() || m.Err == nil || m.refusalCode() != codeScheduleUnreadable {
		t.Fatalf("nil reader = %+v", m)
	}
}

// The policy key is read before the settings key, and only the three named
// keys are asked for.
func TestDellScheduleModeReadsOnlyTheNamedKeys(t *testing.T) {
	reg := manualDellRegistry()
	readDellScheduleMode(reg.read)
	want := map[string]bool{
		regKey(dellPolicyKey, dellScheduleModeValue):         true,
		regKey(dellPolicyScheduleKey, dellScheduleModeValue): true,
		regKey(dellScheduleKey, dellScheduleModeValue):       true,
	}
	if len(reg.reads) != len(want) {
		t.Fatalf("reads = %q", reg.reads)
	}
	for _, r := range reg.reads {
		if !want[r] {
			t.Fatalf("read an unexpected key %q", r)
		}
	}
	if reg.reads[len(reg.reads)-1] != regKey(dellScheduleKey, dellScheduleModeValue) {
		t.Fatalf("the settings key was not read last: %q", reg.reads)
	}
	for _, k := range dellRegistryKeys {
		if !strings.HasPrefix(k, `SOFTWARE\Dell\`) && !strings.HasPrefix(k, `SOFTWARE\Policies\Dell\`) {
			t.Fatalf("registry read list holds a key outside Dell's: %q", k)
		}
	}
}

// The REG_SZ bytes are compared whole (#12267 review): only the one
// terminating NUL is dropped. A string conversion that stops at the first NUL
// would read "ManualUpdates\x00Auto" as manual.
func TestDecodeRegSZKeepsEverythingAfterTheName(t *testing.T) {
	utf16le := func(s string) []byte {
		var b []byte
		for _, u := range utf16.Encode([]rune(s)) {
			b = append(b, byte(u), byte(u>>8))
		}
		return b
	}
	cases := []struct {
		name string
		raw  []byte
		want string
		ok   bool
	}{
		{"terminated", utf16le("ManualUpdates\x00"), "ManualUpdates", true},
		{"unterminated", utf16le("ManualUpdates"), "ManualUpdates", true},
		{"embedded NUL", utf16le("ManualUpdates\x00Auto\x00"), "ManualUpdates\x00Auto", true},
		{"embedded NUL, unterminated", utf16le("ManualUpdates\x00Auto"), "ManualUpdates\x00Auto", true},
		{"two terminating NULs", utf16le("ManualUpdates\x00\x00"), "ManualUpdates\x00", true},
		{"trailing space", utf16le("ManualUpdates \x00"), "ManualUpdates ", true},
		{"empty", nil, "", true},
		{"just a NUL", utf16le("\x00"), "", true},
		{"odd byte count", append(utf16le("ManualUpdates"), 0), "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := decodeRegSZ(tc.raw)
			if got != tc.want || ok != tc.ok {
				t.Fatalf("decodeRegSZ = %q, %v; want %q, %v", got, ok, tc.want, tc.ok)
			}
			if tc.want != dellManualUpdates && ok {
				reg := newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, got)
				if readDellScheduleMode(reg.read).Manual() {
					t.Fatalf("%q read as manual", got)
				}
			}
		})
	}
}

// A refused value is shown as it is, not trimmed into the passing one: a
// trailing space or an embedded NUL must be visible in the log and the error.
func TestDellRefusalShowsTheValueAsRead(t *testing.T) {
	for raw, want := range map[string]string{
		"ManualUpdates ":        `"ManualUpdates " (14 bytes)`,
		"ManualUpdates\x00Auto": `"ManualUpdates\x00Auto" (18 bytes)`,
	} {
		l := testDellLane(t, map[string]string{dcu64: "5.7.2"})
		l.host.registry = newFakeRegistry().setString(dellScheduleKey, dellScheduleModeValue, raw).read
		outcome, err := l.CheckToolConfig()
		if outcome != OutcomeToolUnavailable || err == nil {
			t.Fatalf("%q: outcome %q, err %v", raw, outcome, err)
		}
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("%q: error %q does not show %s", raw, err.Error(), want)
		}
		if got := shownMode(raw); got != want {
			t.Fatalf("shownMode(%q) = %s, want %s", raw, got, want)
		}
	}
}
