package hpwarrantyobserve

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	oemobserve "github.com/breeze-rmm/agent/internal/oemupdates/observe"
)

const pf = `C:\Program Files`

// fakeHost is a consumer HP by default; tests override what they need.
type fakeHost struct {
	bios      oemobserve.BIOSInfo
	script    []byte
	scriptErr error
	scriptRan int
	dirs      map[string][]string
	files     map[string]bool
	programs  []oemobserve.ProgramEntry
	strs      map[string]string
	dwords    map[string]uint64
}

func newFakeHost(t *testing.T) *fakeHost {
	t.Helper()
	return &fakeHost{
		bios: oemobserve.BIOSInfo{
			SystemManufacturer: "HP",
			SystemProductName:  "HP Laptop 15-dy2xxx",
			SystemFamily:       "103C_5335KV HP Notebook",
		},
		script: readTestdata(t, "doc-derived/script_consumer.json"),
		dirs: map[string][]string{
			pf + `\WindowsPowerShell\Modules`: {"Microsoft.PowerShell.Operation.Validation", "PackageManagement", "Pester", "PowerShellGet", "PSReadline"},
			pf + `\WindowsApps`: {
				"Microsoft.DesktopAppInstaller_1.19.10173.0_x64__8wekyb3d8bbwe",
				"Microsoft.DesktopAppInstaller_1.21.3482.0_x64__8wekyb3d8bbwe",
				"Microsoft.WindowsCalculator_11.2210.0.0_x64__8wekyb3d8bbwe",
			},
		},
		files: map[string]bool{
			pf + `\WindowsApps\Microsoft.DesktopAppInstaller_1.19.10173.0_x64__8wekyb3d8bbwe\winget.exe`: true,
			pf + `\WindowsApps\Microsoft.DesktopAppInstaller_1.21.3482.0_x64__8wekyb3d8bbwe\winget.exe`:  true,
		},
		programs: []oemobserve.ProgramEntry{
			{DisplayName: "HP Support Assistant", DisplayVersion: "9.30.37.0"},
			{DisplayName: "HP Documentation", DisplayVersion: "1.0.0.1"},
		},
		strs:   map[string]string{RegPowerShellEngine + "|PowerShellVersion": "5.1.19041.1"},
		dwords: map[string]uint64{},
	}
}

func (f *fakeHost) host() Host {
	return Host{
		BIOSInfo:        func() (oemobserve.BIOSInfo, error) { return f.bios, nil },
		IsWow64Process2: func() (uint16, uint16, error) { return machineAMD64, machineAMD64, nil },
		ListDirs: func(path string) ([]string, error) {
			d, ok := f.dirs[path]
			if !ok {
				return nil, os.ErrNotExist
			}
			return d, nil
		},
		RegularFile:    func(path string) bool { return f.files[path] },
		ProgramFiles:   func() string { return pf },
		ProgramEntries: func() ([]oemobserve.ProgramEntry, error) { return f.programs, nil },
		RegistryString: func(path, name string) (string, bool, error) {
			v, ok := f.strs[path+"|"+name]
			return v, ok, nil
		},
		RegistryDWORD: func(path, name string) (uint64, bool, error) {
			v, ok := f.dwords[path+"|"+name]
			return v, ok, nil
		},
		RunWMIScript: func(context.Context) ([]byte, error) {
			f.scriptRan++
			return f.script, f.scriptErr
		},
	}
}

func readTestdata(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func encode(t *testing.T, o *Observation) []byte {
	t.Helper()
	b, err := json.MarshalIndent(o, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return append(b, '\n')
}

func businessHost(t *testing.T) *fakeHost {
	f := newFakeHost(t)
	f.bios = oemobserve.BIOSInfo{
		SystemManufacturer: "HP",
		SystemProductName:  "HP EliteBook 840 G8 Notebook PC",
		SystemFamily:       "103C_5336AN HP EliteBook",
	}
	f.script = readTestdata(t, "doc-derived/script_business.json")
	modules := pf + `\WindowsPowerShell\Modules`
	f.dirs[modules] = append(f.dirs[modules], "HPCMSL", "HP.ClientManagement", "HPE.Something")
	f.dirs[modules+`\HPCMSL`] = []string{"1.8.6"}
	f.dirs[modules+`\HP.ClientManagement`] = []string{"1.8.6", "notes"}
	delete(f.dirs, pf+`\WindowsApps`)
	f.programs = nil
	f.dwords[RegNetFx64+"|SchUseStrongCrypto"] = 1
	f.dwords[RegNetFx32+"|SchUseStrongCrypto"] = 1
	return f
}

// The wire goldens are what the shared zod schema parses; these pin the Go
// encoding to them byte for byte.
func TestWireGoldensRoundTrip(t *testing.T) {
	for _, name := range []string{"consumer_absent.json", "business_present.json"} {
		t.Run(name, func(t *testing.T) {
			raw := readTestdata(t, "wire/"+name)
			dec := json.NewDecoder(bytes.NewReader(raw))
			dec.DisallowUnknownFields()
			var o Observation
			if err := dec.Decode(&o); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if got := encode(t, &o); !bytes.Equal(got, raw) {
				t.Fatalf("re-encoded golden differs:\n%s", got)
			}
		})
	}
}

// The whole pipeline, from doc-derived script output and fake host reads to
// the record, lands exactly on the goldens.
func TestCollectProducesGoldens(t *testing.T) {
	cases := map[string]*fakeHost{
		"consumer_absent.json":  newFakeHost(t),
		"business_present.json": businessHost(t),
	}
	for name, f := range cases {
		t.Run(name, func(t *testing.T) {
			o := Collect(context.Background(), f.host(), "observe")
			if o == nil {
				t.Fatal("Collect returned nil for an HP machine")
			}
			if got, want := encode(t, o), readTestdata(t, "wire/"+name); !bytes.Equal(got, want) {
				t.Fatalf("observation differs from golden:\n%s", got)
			}
		})
	}
}

func TestNameFilterParity(t *testing.T) {
	var cases []struct {
		Name    string `json:"name"`
		Allowed bool   `json:"allowed"`
	}
	if err := json.Unmarshal(readTestdata(t, "wire/name_filter.json"), &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if got := IsObservableName(c.Name); got != c.Allowed {
			t.Errorf("IsObservableName(%q) = %v, want %v", c.Name, got, c.Allowed)
		}
	}
}

// Deny beats allow, per name: a SerialNumber and a ProductNumber are reported
// by name and type only, even when the script printed their values, while a
// WarrantyEndDate next to them keeps its value.
func TestDenyBeatsAllow(t *testing.T) {
	f := businessHost(t)
	o := Collect(context.Background(), f.host(), "observe")
	row := o.HPWarranty.Rows[0]
	for _, denied := range []string{"SerialNumber", "ProductNumber"} {
		if _, ok := row[denied]; ok {
			t.Errorf("row carries %s", denied)
		}
	}
	if v := row["WarrantyEndDate"]; v == nil || *v != "2027-01-14" {
		t.Errorf("WarrantyEndDate = %v, want 2027-01-14", v)
	}
	b, _ := json.Marshal(o)
	for _, leaked := range []string{"5CD1234XYZ", "3C6A1EA#ABA"} {
		if bytes.Contains(b, []byte(leaked)) {
			t.Fatalf("observation leaks %q: %s", leaked, b)
		}
	}
	names := map[string]bool{}
	for _, p := range o.HPWarranty.Properties {
		names[p.Name] = true
	}
	if !names["SerialNumber"] || !names["ProductNumber"] {
		t.Error("denied properties must still be listed by name and type")
	}

	// A denied name whose own text also matches allow (SerialEndDate) stays
	// denied.
	if IsObservableName("SerialEndDate") || IsObservableName("CustomerType") {
		t.Fatal("deny must win over allow")
	}
}

func TestNamespaceAbsentRecorded(t *testing.T) {
	f := newFakeHost(t)
	o := Collect(context.Background(), f.host(), "observe")
	want := Namespaces{RootHP: StateAbsent, InstrumentedServices: StateAbsent, V1: StateAbsent, InstrumentedBIOS: StateAbsent}
	if o.Namespaces != want {
		t.Fatalf("namespaces = %+v, want %+v", o.Namespaces, want)
	}
	if o.Classes != nil || o.HPWarranty != nil || o.HPEntitlements != nil {
		t.Fatal("an absent v1 namespace must report no classes")
	}
	if len(o.Errors) != 0 {
		t.Fatalf("an absent namespace is an answer, not an error: %+v", o.Errors)
	}
}

func TestNamespaceDeniedAndUnknownCodes(t *testing.T) {
	f := newFakeHost(t)
	f.script = []byte(`{"rootHp":{"s":"present","n":"InstrumentedServices"},"isv":{"s":"cim_AccessDenied","n":[]},"v1":{"s":"0x80041013","n":[]}}`)
	o := Collect(context.Background(), f.host(), "observe")
	if o.Namespaces.InstrumentedServices != StateAccessDenied {
		t.Errorf("isv = %s, want access_denied", o.Namespaces.InstrumentedServices)
	}
	if o.Namespaces.InstrumentedBIOS != StateAbsent {
		t.Errorf("instrumentedBios = %s, want absent (root/HP has no such child)", o.Namespaces.InstrumentedBIOS)
	}
	if o.Namespaces.V1 != StateError {
		t.Errorf("v1 = %s, want error", o.Namespaces.V1)
	}
	if len(o.Errors) != 1 || o.Errors[0] != (StepError{Step: "wmi_v1", Code: "0x80041013"}) {
		t.Errorf("errors = %+v", o.Errors)
	}
}

func TestScriptFailureIsACodeNotText(t *testing.T) {
	cases := map[error]string{
		context.DeadlineExceeded:                     "timeout",
		ErrOutputTooLarge:                            "output_too_large",
		ErrCommandRefused:                            "refused",
		errors.New("Access is denied. (0x80070005)"): "script_failed",
	}
	for err, code := range cases {
		f := newFakeHost(t)
		f.scriptErr = err
		o := Collect(context.Background(), f.host(), "observe")
		if o.Namespaces.V1 != StateNotChecked {
			t.Errorf("%v: v1 = %s, want not_checked", err, o.Namespaces.V1)
		}
		if len(o.Errors) != 1 || o.Errors[0] != (StepError{Step: "wmi", Code: code}) {
			t.Errorf("%v: errors = %+v, want wmi/%s", err, o.Errors, code)
		}
	}
	f := newFakeHost(t)
	f.script = []byte("WARNING: not json")
	if o := Collect(context.Background(), f.host(), "observe"); o.Errors[0].Code != "output_unparsable" {
		t.Errorf("errors = %+v", o.Errors)
	}
	// A code that is not an identifier is not reported as text.
	f = newFakeHost(t)
	f.script = []byte(`{"rootHp":{"s":"Access is denied.","n":[]},"isv":{"s":"present","n":[]},"v1":{"s":"present","n":[]}}`)
	if o := Collect(context.Background(), f.host(), "observe"); o.Errors[0].Code != "unrecognized" {
		t.Errorf("errors = %+v", o.Errors)
	}
}

func TestDateFormatClassified(t *testing.T) {
	cases := map[string]string{
		"20270114000000.000000+000":     "cim_datetime",
		"/Date(1799884800000)/":         "ms_json_date",
		"/Date(1799884800000+0100)/":    "ms_json_date",
		"2027-01-14":                    "iso8601",
		"2027-01-14T00:00:00Z":          "iso8601",
		"2027-01-14T00:00:00.000+01:00": "iso8601",
		"01/14/2027":                    "other",
		"14.01.2027":                    "other",
	}
	for v, want := range cases {
		if got := dateFormat(v); got != want {
			t.Errorf("dateFormat(%q) = %s, want %s", v, got, want)
		}
	}
	// A CIM DateTime property arrives as a datetime and is reported as such.
	if v, f := normalizeValue(scriptValue{K: "datetime", V: new("2026-11-02T08:15:00.1234567+00:00")}); f != "cim_datetime" || *v != "2026-11-02T08:15:00Z" {
		t.Errorf("datetime = %v %s", *v, f)
	}
	// A non-date name gets no date format even when its value looks like one.
	f := businessHost(t)
	o := Collect(context.Background(), f.host(), "observe")
	if _, ok := o.HPWarranty.DateFormats["Status"]; ok {
		t.Error("Status is not a date field")
	}
}

func TestBoundsTruncate(t *testing.T) {
	var props, row []string
	for i := range 200 {
		props = append(props, fmt.Sprintf(`{"n":"Status%03d","t":"String"}`, i))
		row = append(row, fmt.Sprintf(`"Status%03d":{"k":"string","v":"%s\u0007"}`, i, strings.Repeat("x", 200)))
	}
	var rows []string
	for range 40 {
		rows = append(rows, "{"+strings.Join(row, ",")+"}")
	}
	var classes []string
	for i := range 100 {
		classes = append(classes, fmt.Sprintf(`"Class%03d"`, i))
	}
	script := fmt.Sprintf(`{"rootHp":{"s":"present","n":["InstrumentedServices"]},"isv":{"s":"present","n":["v1"]},"v1":{"s":"present","n":[]},`+
		`"classes":{"s":"present","total":100,"n":[%s]},`+
		`"cls":{"HP_Warranty":{"s":"present","props":[%s],"rows":40,"values":[%s]}}}`,
		strings.Join(classes, ","), strings.Join(props, ","), strings.Join(rows, ","))

	f := newFakeHost(t)
	f.script = []byte(script)
	f.bios.SystemProductName = strings.Repeat("M", 100)
	o := Collect(context.Background(), f.host(), "observe")

	if len(o.Classes.Names) != maxClasses || o.Classes.Total != 100 {
		t.Errorf("classes = %d names, total %d", len(o.Classes.Names), o.Classes.Total)
	}
	if len(*o.Model) != maxTextLen {
		t.Errorf("model length = %d", len(*o.Model))
	}
	if n := len(o.HPWarranty.Properties); n > maxProperties {
		t.Errorf("properties = %d", n)
	}
	if n := len(o.HPWarranty.Rows); n > maxRows {
		t.Errorf("rows = %d", n)
	}
	for _, r := range o.HPWarranty.Rows {
		for k, v := range r {
			if v != nil && (len(*v) > maxValueLen || strings.ContainsRune(*v, 7)) {
				t.Fatalf("value %s not bounded/cleaned: %q", k, *v)
			}
		}
	}
	if s := size(o); s > MaxBytes {
		t.Fatalf("observation is %d bytes, over %d", s, MaxBytes)
	}
	last := o.Errors[len(o.Errors)-1]
	if last != (StepError{Step: "bound", Code: "truncated"}) {
		t.Errorf("truncation not recorded: %+v", o.Errors)
	}
}

func TestHpeNotHp(t *testing.T) {
	for _, maker := range []string{"HPE", "Hewlett Packard Enterprise", "HP Enterprise", "Dell Inc.", "", "  "} {
		f := newFakeHost(t)
		f.bios.SystemManufacturer = maker
		if o := Collect(context.Background(), f.host(), "observe"); o != nil {
			t.Errorf("%q observed as HP", maker)
		}
		if f.scriptRan != 0 {
			t.Errorf("%q: the WMI script ran on a non-HP machine", maker)
		}
	}
	for _, maker := range []string{"HP", "HP Inc.", "Hewlett-Packard", " hp "} {
		f := newFakeHost(t)
		f.bios.SystemManufacturer = maker
		if o := Collect(context.Background(), f.host(), "observe"); o == nil {
			t.Errorf("%q not observed", maker)
		}
	}
	// No BIOS reader or an unreadable one: not known to be HP, nothing runs.
	f := newFakeHost(t)
	h := f.host()
	h.BIOSInfo = func() (oemobserve.BIOSInfo, error) { return oemobserve.BIOSInfo{}, errors.New("x") }
	if Collect(context.Background(), h, "observe") != nil || f.scriptRan != 0 {
		t.Error("unreadable manufacturer must observe nothing")
	}
	if Collect(context.Background(), Host{}, "observe") != nil {
		t.Error("empty host must observe nothing")
	}
}

func TestPrerequisites(t *testing.T) {
	f := newFakeHost(t)
	f.strs[RegPowerShellEngine+"|PowerShellVersion"] = "2.0"
	f.dwords[RegNetFx64+"|SchUseStrongCrypto"] = 0
	f.dwords[RegNetFx32+"|SchUseStrongCrypto"] = 7
	f.dwords[RegSchannelTLS12+"|Enabled"] = 1
	f.programs = append(f.programs, oemobserve.ProgramEntry{DisplayName: "HP Insights Analytics", DisplayVersion: "garbage"})
	o := Collect(context.Background(), f.host(), "act")
	if o.Mode != "act" {
		t.Errorf("mode = %s", o.Mode)
	}
	if o.PowerShell.V51 == nil || *o.PowerShell.V51 {
		t.Errorf("v51 = %v, want false", o.PowerShell.V51)
	}
	if o.PowerShell.StrongCrypto64 != RegDisabled || o.PowerShell.StrongCrypto32 != RegOther || o.PowerShell.SchannelTLS12Client != RegEnabled {
		t.Errorf("tls = %+v", o.PowerShell)
	}
	if len(o.Conflicts) != 2 || o.Conflicts[1].Name != "hp_insights" || o.Conflicts[1].Version != nil {
		t.Errorf("conflicts = %+v", o.Conflicts)
	}
	if o.Winget.Version == nil || *o.Winget.Version != "v1.21.3482.0" {
		t.Errorf("winget picks the highest version with winget.exe: %+v", o.Winget)
	}
}

// PowerShell 5.1 collapses one-element arrays; every list in the script
// output must still decode.
func TestScriptScalarCollapse(t *testing.T) {
	f := newFakeHost(t)
	f.script = []byte(`{"rootHp":{"s":"present","n":"InstrumentedBIOS"},"isv":{"s":"cim_InvalidNamespace","n":[]},"v1":{"s":"cim_InvalidNamespace","n":null}}`)
	o := Collect(context.Background(), f.host(), "observe")
	if o.Namespaces.InstrumentedBIOS != StatePresent || len(o.Errors) != 0 {
		t.Fatalf("namespaces = %+v errors = %+v", o.Namespaces, o.Errors)
	}
}

// Review #1: an arch read that fails (IsWow64Process2 missing on older
// Windows) is an error code in the record, not a panic.
func TestCollectSurvivesArchError(t *testing.T) {
	f := newFakeHost(t)
	h := f.host()
	h.IsWow64Process2 = func() (uint16, uint16, error) { return 0, 0, errors.New("proc not found") }
	o := Collect(context.Background(), h, "observe")
	if o == nil || o.NativeArch != "unknown" {
		t.Fatalf("observation = %+v", o)
	}
	if o.Errors[0] != (StepError{Step: "arch", Code: "unavailable"}) {
		t.Fatalf("errors = %+v", o.Errors)
	}
}

// Review #2: CIM type names carry digits (UInt32, Real64, UInt8Array).
func TestCIMTypesWithDigitsKept(t *testing.T) {
	f := newFakeHost(t)
	f.script = []byte(`{"rootHp":{"s":"present","n":[]},"isv":{"s":"present","n":"v1"},"v1":{"s":"present","n":[]},` +
		`"cls":{"HP_Warranty":{"s":"present","props":[{"n":"Status","t":"UInt32"},{"n":"Level","t":"Real64"},{"n":"Codes","t":"UInt8Array"},{"n":"X","t":"9Bad"}],"rows":0,"values":[]}}}`)
	o := Collect(context.Background(), f.host(), "observe")
	got := []string{}
	for _, p := range o.HPWarranty.Properties {
		got = append(got, p.CIMType)
	}
	if strings.Join(got, ",") != "UInt32,Real64,UInt8Array,Other" {
		t.Fatalf("cim types = %v", got)
	}
}

// Review #3: the truncation marker itself must fit under the cap, at every
// size the trimmed record can land on.
func TestBoundNeverExceedsCapWithMarker(t *testing.T) {
	for valueLen := 1; valueLen <= maxValueLen; valueLen++ {
		var props, row []string
		for i := range 64 {
			props = append(props, fmt.Sprintf(`{"n":"Status%02d","t":"String"}`, i))
			row = append(row, fmt.Sprintf(`"Status%02d":{"k":"string","v":"%s"}`, i, strings.Repeat("y", valueLen)))
		}
		var rows []string
		for range 25 {
			rows = append(rows, "{"+strings.Join(row, ",")+"}")
		}
		f := newFakeHost(t)
		f.script = fmt.Appendf(nil, `{"rootHp":{"s":"present","n":[]},"isv":{"s":"present","n":"v1"},"v1":{"s":"present","n":[]},`+
			`"cls":{"HP_Warranty":{"s":"present","props":[%s],"rows":25,"values":[%s]}}}`, strings.Join(props, ","), strings.Join(rows, ","))
		o := Collect(context.Background(), f.host(), "observe")
		if s := size(o); s > MaxBytes {
			t.Fatalf("value length %d: observation is %d bytes, over %d", valueLen, s, MaxBytes)
		}
	}
}

// Review #4: a module version directory too long for the contract is dropped,
// not shipped to be rejected.
func TestModuleVersionTooLongDropped(t *testing.T) {
	f := newFakeHost(t)
	modules := pf + `\WindowsPowerShell\Modules`
	f.dirs[modules] = append(f.dirs[modules], "HPCMSL")
	f.dirs[modules+`\HPCMSL`] = []string{"1.8.6", "123456789.123456789.123456789.123456789"}
	o := Collect(context.Background(), f.host(), "observe")
	if len(o.CMSL) != 1 || len(o.CMSL[0].Versions) != 1 || o.CMSL[0].Versions[0] != "v1.8.6" {
		t.Fatalf("cmsl = %+v", o.CMSL)
	}
}

// Review (low): a UTF-8 byte-order mark before the JSON still parses.
func TestScriptOutputWithBOM(t *testing.T) {
	f := newFakeHost(t)
	f.script = append([]byte("\xef\xbb\xbf"), f.script...)
	o := Collect(context.Background(), f.host(), "observe")
	if o.Namespaces.V1 != StateAbsent || len(o.Errors) != 0 {
		t.Fatalf("namespaces = %+v errors = %+v", o.Namespaces, o.Errors)
	}
}
