package wakeconfig

import (
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)

func winInputs(fast string, adapters ...AdapterReading) Inputs {
	return Inputs{
		OS: "windows", Manufacturer: "Dell Inc.", Model: "OptiPlex 7090",
		Windows: &WindowsReadings{FastStartup: fast, Adapters: adapters},
		Now:     t0,
	}
}

func goodNIC(mac string) AdapterReading {
	return AdapterReading{MAC: mac, MagicPacket: "enabled", EEE: "absent"}
}

func hasReason(s Snapshot, r string) bool {
	for _, c := range s.ReasonCodes {
		if c == r {
			return true
		}
	}
	return false
}

func TestComputeVirtualMachineWins(t *testing.T) {
	in := winInputs("enabled", AdapterReading{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "disabled", EEE: "enabled"})
	in.Virtual = true
	s := Compute(in)
	if s.ReadinessState != "unsupported_vm" || !reflect.DeepEqual(s.ReasonCodes, []string{"virtual_machine"}) {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

func TestComputeNoWiredAdapter(t *testing.T) {
	s := Compute(winInputs("disabled"))
	if s.ReadinessState != "no_wired_adapter" || !reflect.DeepEqual(s.ReasonCodes, []string{"no_wired_adapter"}) {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
	if s.LastWiredAdapterSeenAt != nil {
		t.Fatalf("no adapter was ever seen, got %v", *s.LastWiredAdapterSeenAt)
	}
}

func TestComputeNotConfiguredWithReasonPerLayer(t *testing.T) {
	// fast startup on
	s := Compute(winInputs("enabled", goodNIC("aa:bb:cc:dd:ee:01")))
	if s.ReadinessState != "not_configured" || !hasReason(s, "fast_startup_enabled") {
		t.Fatalf("fast startup: %s %v", s.ReadinessState, s.ReasonCodes)
	}
	// magic packet off (and unsupported maps to the same reason)
	for _, mp := range []string{"disabled", "unsupported"} {
		s = Compute(winInputs("disabled", AdapterReading{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: mp, EEE: "absent"}))
		if s.ReadinessState != "not_configured" || !hasReason(s, "nic_magic_packet_disabled") {
			t.Fatalf("magic %s: %s %v", mp, s.ReadinessState, s.ReasonCodes)
		}
	}
	// EEE on
	s = Compute(winInputs("disabled", AdapterReading{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "enabled", EEE: "enabled"}))
	if s.ReadinessState != "not_configured" || !reflect.DeepEqual(s.ReasonCodes, []string{"nic_eee_enabled"}) {
		t.Fatalf("eee: %s %v", s.ReadinessState, s.ReasonCodes)
	}
	// two bad adapters: reasons are de-duplicated and sorted
	s = Compute(winInputs("enabled",
		AdapterReading{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "disabled", EEE: "enabled"},
		AdapterReading{MAC: "aa:bb:cc:dd:ee:02", MagicPacket: "disabled", EEE: "enabled"}))
	want := []string{"fast_startup_enabled", "nic_eee_enabled", "nic_magic_packet_disabled"}
	if !reflect.DeepEqual(s.ReasonCodes, want) || !sort.StringsAreSorted(s.ReasonCodes) {
		t.Fatalf("reasons %v, want %v", s.ReasonCodes, want)
	}
	// one good adapter is enough: a second bad one adds no NIC reason
	s = Compute(winInputs("disabled", goodNIC("aa:bb:cc:dd:ee:01"),
		AdapterReading{MAC: "aa:bb:cc:dd:ee:02", MagicPacket: "disabled", EEE: "absent"}))
	if hasReason(s, "nic_magic_packet_disabled") || s.ReadinessState == "not_configured" {
		t.Fatalf("one good adapter must satisfy the NIC layer: %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

func TestComputeUnprovenWithoutFirmwareAdapter(t *testing.T) {
	s := Compute(winInputs("disabled", goodNIC("aa:bb:cc:dd:ee:01")))
	if s.ReadinessState != "unproven" || !reflect.DeepEqual(s.ReasonCodes, []string{"firmware_adapter_unavailable"}) {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
	if s.Details["firmware"] != "adapter_unavailable" {
		t.Fatalf("details.firmware = %v", s.Details["firmware"])
	}
	// unknown readings alone stay unproven, never not_configured
	s = Compute(winInputs("unknown", AdapterReading{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "unknown", EEE: "unknown"}))
	if s.ReadinessState != "unproven" || !hasReason(s, "fast_startup_unknown") || !hasReason(s, "nic_magic_packet_unknown") {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

func TestUndockedKeepsAdapterAndStateFor30Days(t *testing.T) {
	first := Compute(winInputs("disabled", goodNIC("aa:bb:cc:dd:ee:01")))
	in := winInputs("disabled") // undocked: no wired adapter present
	in.Memory = first.Memory
	in.Now = t0.Add(29 * 24 * time.Hour)
	s := Compute(in)
	if s.ReadinessState == "no_wired_adapter" {
		t.Fatalf("adapter seen 29 days ago must be remembered")
	}
	adapters := s.Details["adapters"].([]map[string]any)
	if len(adapters) != 1 || adapters[0]["present"] != false || adapters[0]["magicPacket"] != "enabled" {
		t.Fatalf("remembered adapter lost its last readings: %v", adapters)
	}
	if s.LastWiredAdapterSeenAt == nil || *s.LastWiredAdapterSeenAt != t0.Format(time.RFC3339) {
		t.Fatalf("lastWiredAdapterSeenAt = %v", s.LastWiredAdapterSeenAt)
	}
}

func TestNoWiredAdapterAfter30Days(t *testing.T) {
	first := Compute(winInputs("disabled", goodNIC("aa:bb:cc:dd:ee:01")))
	in := winInputs("disabled")
	in.Memory = first.Memory
	in.Now = t0.Add(31 * 24 * time.Hour)
	s := Compute(in)
	if s.ReadinessState != "no_wired_adapter" {
		t.Fatalf("got %s", s.ReadinessState)
	}
	if len(s.Memory) != 0 {
		t.Fatalf("expired adapter must be dropped from memory: %v", s.Memory)
	}
}

func TestDockChangeDoesNotChangeFingerprint(t *testing.T) {
	docked := Compute(winInputs("disabled", goodNIC("aa:bb:cc:dd:ee:01")))
	in := winInputs("disabled")
	in.Memory = docked.Memory
	in.Now = t0.Add(time.Hour)
	undocked := Compute(in)
	if len(docked.Fingerprint) != 64 || docked.Fingerprint != undocked.Fingerprint {
		t.Fatalf("dock change moved the fingerprint: %s vs %s", docked.Fingerprint, undocked.Fingerprint)
	}
	// a real change (fast startup flips) does move it
	in2 := winInputs("enabled", goodNIC("aa:bb:cc:dd:ee:01"))
	if Compute(in2).Fingerprint == docked.Fingerprint {
		t.Fatal("fast startup change must change the fingerprint")
	}
	// a new MAC joins the remembered set
	in3 := winInputs("disabled", goodNIC("aa:bb:cc:dd:ee:01"), goodNIC("aa:bb:cc:dd:ee:09"))
	if Compute(in3).Fingerprint == docked.Fingerprint {
		t.Fatal("a new wired adapter must change the fingerprint")
	}
}

func TestVendorNormalisation(t *testing.T) {
	cases := map[string]string{"Dell Inc.": "dell", "HP": "hp", "Hewlett-Packard": "hp", "LENOVO": "lenovo", "Microsoft Corporation": "microsoft"}
	for in, want := range cases {
		if got := normaliseVendor(in); got == nil || *got != want {
			t.Errorf("%q -> %v want %s", in, got, want)
		}
	}
	if normaliseVendor("  ") != nil || normaliseVendor("") != nil {
		t.Error("empty manufacturer must give nil vendor")
	}
	long := "Some Very Long Manufacturer Name That Exceeds Thirty Two Characters"
	if got := normaliseVendor(long); got == nil || len(*got) != 32 {
		t.Errorf("long vendor not cut to 32: %v", got)
	}
}

func TestSnapshotJSONMatchesServerContract(t *testing.T) {
	s := Compute(winInputs("disabled", goodNIC("aa:bb:cc:dd:ee:01")))
	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	want := []string{"collectedAt", "details", "fingerprint", "lastApplyAt", "lastApplyResult", "lastWiredAdapterSeenAt", "readinessState", "reasonCodes", "vendor"}
	if !reflect.DeepEqual(keys, want) {
		t.Fatalf("keys %v, want %v", keys, want)
	}
	if m["vendor"] != "dell" || m["lastApplyAt"] != nil || m["lastApplyResult"] != nil {
		t.Fatalf("vendor/apply fields: %v", m)
	}
	for _, k := range []string{"collectedAt", "lastWiredAdapterSeenAt"} {
		if _, err := time.Parse(time.RFC3339, m[k].(string)); err != nil {
			t.Fatalf("%s not RFC3339: %v", k, m[k])
		}
	}
	d := m["details"].(map[string]any)
	for _, k := range []string{"os", "manufacturer", "model", "virtual", "fastStartup", "firmware", "adapters"} {
		if _, ok := d[k]; !ok {
			t.Fatalf("details missing %s: %v", k, d)
		}
	}
	a := d["adapters"].([]any)[0].(map[string]any)
	for _, k := range []string{"mac", "present", "lastSeenAt", "magicPacket", "eee"} {
		if _, ok := a[k]; !ok {
			t.Fatalf("adapter missing %s: %v", k, a)
		}
	}
	// empty manufacturer -> null vendor, reasonCodes still an array
	in := winInputs("disabled")
	in.Manufacturer = ""
	raw, _ = json.Marshal(Compute(in))
	m = map[string]any{}
	_ = json.Unmarshal(raw, &m)
	if m["vendor"] != nil {
		t.Fatalf("vendor = %v, want null", m["vendor"])
	}
	if _, ok := m["reasonCodes"].([]any); !ok {
		t.Fatalf("reasonCodes must be an array: %v", m["reasonCodes"])
	}
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestNicMatchesByRegistryKeywordNotDisplayName(t *testing.T) {
	r, err := ParseWindowsReadings(readFixture(t, "windows_de.json"))
	if err != nil {
		t.Fatal(err)
	}
	if r.FastStartup != "disabled" || len(r.Adapters) != 1 {
		t.Fatalf("%+v", r)
	}
	// RegistryValue "1" decides; the German DisplayValue "Deaktiviert" is ignored.
	if r.Adapters[0].EEE != "enabled" || r.Adapters[0].MAC != "aa:bb:cc:dd:ee:03" {
		t.Fatalf("%+v", r.Adapters[0])
	}
	r, err = ParseWindowsReadings(readFixture(t, "windows_en.json"))
	if err != nil {
		t.Fatal(err)
	}
	if r.FastStartup != "enabled" || r.Adapters[1].EEE != "absent" || r.Adapters[1].MagicPacket != "disabled" {
		t.Fatalf("%+v", r)
	}
}

func TestParseUnexpectedValuesAreUnknown(t *testing.T) {
	raw := `{"hiberboot":7,"adapters":[
	 {"name":"a","mac":"AA-BB-CC-DD-EE-01","magicPacket":"Manual","eee":"2"},
	 {"name":"b","mac":"aa:bb:cc:dd:ee:02","magicPacket":null,"eee":"error"},
	 {"name":"c","mac":"not-a-mac","magicPacket":"enabled","eee":"0"}]}`
	r, err := ParseWindowsReadings([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if r.FastStartup != "unknown" {
		t.Fatalf("fast startup %s", r.FastStartup)
	}
	if len(r.Adapters) != 2 {
		t.Fatalf("an adapter without a valid MAC cannot be tracked and must be skipped: %+v", r.Adapters)
	}
	for _, a := range r.Adapters {
		if a.MagicPacket != "unknown" || a.EEE != "unknown" {
			t.Fatalf("%+v", a)
		}
	}
	if _, err := ParseWindowsReadings([]byte("not json")); err == nil {
		t.Fatal("garbage must be an error")
	}
	r, _ = ParseWindowsReadings([]byte(`{"hiberboot":null,"adapters":[]}`))
	if r.FastStartup != "unknown" {
		t.Fatalf("missing hiberboot -> %s", r.FastStartup)
	}
}
