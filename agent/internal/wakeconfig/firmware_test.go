package wakeconfig

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/biosconfig"
)

// dellCaptured mirrors the lab OptiPlex 7060 capture
// (biosconfig/testdata/dell-optiplex-7060-bios-read.json): WOL off, deep sleep
// in S4 and S5, the Dell defaults.
func dellCaptured() *FirmwareReadings {
	return &FirmwareReadings{
		Vendor: "dell",
		Status: FirmwareRead,
		Settings: []biosconfig.Setting{
			{Name: "UsbWake", Value: "Enabled", Allowed: []string{"Disabled", "Enabled"}},
			{Name: "WakeOnLan", Value: "Disabled", Allowed: []string{"Disabled", "LanOnly", "WlanOnly", "LanWlan", "LanWithPxeBoot"}},
			{Name: "DeepSleepCtrl", Value: "S4AndS5", Allowed: []string{"Disabled", "S5Only", "S4AndS5"}},
		},
		Protection: biosconfig.ProtectionNone,
	}
}

func dellConfigured() *FirmwareReadings {
	f := dellCaptured()
	f.Settings[1].Value = "LanOnly"
	f.Settings[2].Value = "Disabled"
	return f
}

func readyNIC(mac string) AdapterReading {
	return AdapterReading{MAC: mac, MagicPacket: "enabled", EEE: "disabled"}
}

func dellInputs(fw *FirmwareReadings, fast string, adapters ...AdapterReading) Inputs {
	in := winInputs(fast, adapters...)
	in.Model = "OptiPlex 7060"
	in.Firmware = fw
	return in
}

func TestComputeReady(t *testing.T) {
	for _, nic := range []AdapterReading{readyNIC("aa:bb:cc:dd:ee:01"), goodNIC("aa:bb:cc:dd:ee:01")} {
		s := Compute(dellInputs(dellConfigured(), "disabled", nic))
		if s.ReadinessState != "ready" || len(s.ReasonCodes) != 0 {
			t.Fatalf("eee=%s: got %s %v", nic.EEE, s.ReadinessState, s.ReasonCodes)
		}
		if s.Details["firmware"] != "read" {
			t.Fatalf("details.firmware = %v", s.Details["firmware"])
		}
		want := map[string]string{"WakeOnLan": "LanOnly", "DeepSleepCtrl": "Disabled"}
		if !reflect.DeepEqual(s.Details["firmwareSettings"], want) {
			t.Fatalf("details.firmwareSettings = %v", s.Details["firmwareSettings"])
		}
		if s.Details["firmwareProtection"] != "none" {
			t.Fatalf("details.firmwareProtection = %v", s.Details["firmwareProtection"])
		}
	}
}

// Ready needs every layer known-good: one unknown keeps it unproven.
func TestComputeReadyNeedsEveryLayerKnown(t *testing.T) {
	cases := map[string]struct {
		in     Inputs
		reason string
	}{
		"fast startup unknown": {dellInputs(dellConfigured(), "unknown", readyNIC("aa:bb:cc:dd:ee:01")), "fast_startup_unknown"},
		"eee unknown":          {dellInputs(dellConfigured(), "disabled", AdapterReading{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "enabled", EEE: "unknown"}), "nic_eee_unknown"},
		"magic packet unknown": {dellInputs(dellConfigured(), "disabled", AdapterReading{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "unknown", EEE: "disabled"}), "nic_magic_packet_unknown"},
	}
	for name, c := range cases {
		s := Compute(c.in)
		if s.ReadinessState != "unproven" || !hasReason(s, c.reason) {
			t.Errorf("%s: got %s %v", name, s.ReadinessState, s.ReasonCodes)
		}
	}
}

// The capture itself: firmware and Fast Startup both wrong.
func TestComputeDellCaptureIsNotConfigured(t *testing.T) {
	s := Compute(dellInputs(dellCaptured(), "enabled", readyNIC("aa:bb:cc:dd:ee:01")))
	want := []string{"fast_startup_enabled", "firmware_deep_sleep_enabled", "firmware_wake_on_lan_not_lan_only"}
	if s.ReadinessState != "not_configured" || !reflect.DeepEqual(s.ReasonCodes, want) {
		t.Fatalf("got %s %v, want not_configured %v", s.ReadinessState, s.ReasonCodes, want)
	}
	want2 := map[string]string{"WakeOnLan": "Disabled", "DeepSleepCtrl": "S4AndS5"}
	if !reflect.DeepEqual(s.Details["firmwareSettings"], want2) {
		t.Fatalf("details.firmwareSettings = %v", s.Details["firmwareSettings"])
	}
}

func TestComputeFirmwareOnlyWrong(t *testing.T) {
	for _, tc := range []struct{ name, value, reason string }{
		{"WakeOnLan", "LanWithPxeBoot", "firmware_wake_on_lan_not_lan_only"},
		{"WakeOnLan", "WlanOnly", "firmware_wake_on_lan_not_lan_only"},
		{"DeepSleepCtrl", "S5Only", "firmware_deep_sleep_enabled"},
	} {
		fw := dellConfigured()
		for i := range fw.Settings {
			if fw.Settings[i].Name == tc.name {
				fw.Settings[i].Value = tc.value
			}
		}
		s := Compute(dellInputs(fw, "disabled", readyNIC("aa:bb:cc:dd:ee:01")))
		if s.ReadinessState != "not_configured" || !reflect.DeepEqual(s.ReasonCodes, []string{tc.reason}) {
			t.Errorf("%s=%s: got %s %v", tc.name, tc.value, s.ReadinessState, s.ReasonCodes)
		}
	}
}

// A model whose list lacks a target name (a laptop without DeepSleepCtrl, a
// renamed setting) is never guessed at: unproven, not not_configured.
func TestUnrecognisedSettingNameIsUnproven(t *testing.T) {
	fw := dellConfigured()
	fw.Settings = fw.Settings[:2] // drop DeepSleepCtrl
	s := Compute(dellInputs(fw, "disabled", readyNIC("aa:bb:cc:dd:ee:01")))
	if s.ReadinessState != "unproven" || !reflect.DeepEqual(s.ReasonCodes, []string{"firmware_setting_unrecognised"}) {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
	// Names match exactly: a different case is not the same setting.
	fw = dellConfigured()
	fw.Settings[1].Name = "wakeonlan"
	if s = Compute(dellInputs(fw, "disabled", readyNIC("aa:bb:cc:dd:ee:01"))); s.ReadinessState != "unproven" || !hasReason(s, "firmware_setting_unrecognised") {
		t.Fatalf("case variant: got %s %v", s.ReadinessState, s.ReasonCodes)
	}
	// A wrong value on another target does not turn an unrecognised list into not_configured.
	fw = dellCaptured()
	fw.Settings = fw.Settings[:2]
	if s = Compute(dellInputs(fw, "disabled", readyNIC("aa:bb:cc:dd:ee:01"))); s.ReadinessState != "unproven" {
		t.Fatalf("partial list: got %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

func TestTargetValueNotInAllowedListIsUnproven(t *testing.T) {
	fw := dellCaptured()
	fw.Settings[1].Allowed = []string{"Disabled", "Enabled"} // a model without LanOnly
	s := Compute(dellInputs(fw, "disabled", readyNIC("aa:bb:cc:dd:ee:01")))
	if s.ReadinessState != "unproven" || !hasReason(s, "firmware_value_not_allowed") {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
	if hasReason(s, "firmware_wake_on_lan_not_lan_only") {
		t.Fatalf("an unwritable target must not be reported as fixable: %v", s.ReasonCodes)
	}
}

func TestDetectNilForOtherMakesIsUnproven(t *testing.T) {
	in := winInputs("disabled", readyNIC("aa:bb:cc:dd:ee:01"))
	in.Manufacturer, in.Model = "HP", "EliteDesk 800 G6"
	in.Firmware = ReadFirmware(context.Background(), biosconfig.Detect(in.Manufacturer, in.Model))
	if in.Firmware != nil {
		t.Fatalf("no adapter must mean no readings, got %+v", in.Firmware)
	}
	s := Compute(in)
	if s.ReadinessState != "unproven" || !reflect.DeepEqual(s.ReasonCodes, []string{"firmware_adapter_unavailable"}) {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

// A vendor with an adapter but no target list is never ready.
func TestFirmwareVendorWithoutTargetsIsUnproven(t *testing.T) {
	fw := dellConfigured()
	fw.Vendor = "acme"
	s := Compute(dellInputs(fw, "disabled", readyNIC("aa:bb:cc:dd:ee:01")))
	if s.ReadinessState != "unproven" || !hasReason(s, "firmware_setting_unrecognised") {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

// A firmware read failure keeps the Windows layer: wrong Windows settings still
// show, and otherwise the device is unproven with the firmware reason.
func TestFirmwareUnreadableKeepsWindowsLayer(t *testing.T) {
	for status, reason := range map[string]string{
		FirmwareUnreadable:           "firmware_unreadable",
		FirmwareInterfaceUnavailable: "firmware_interface_unavailable",
	} {
		fw := &FirmwareReadings{Vendor: "dell", Status: status, Protection: biosconfig.ProtectionUnknown}
		s := Compute(dellInputs(fw, "disabled", readyNIC("aa:bb:cc:dd:ee:01")))
		if s.ReadinessState != "unproven" || !reflect.DeepEqual(s.ReasonCodes, []string{reason}) {
			t.Errorf("%s: got %s %v", status, s.ReadinessState, s.ReasonCodes)
		}
		if s.Details["firmware"] != status {
			t.Errorf("%s: details.firmware = %v", status, s.Details["firmware"])
		}
		s = Compute(dellInputs(fw, "enabled", readyNIC("aa:bb:cc:dd:ee:01")))
		if s.ReadinessState != "not_configured" || !hasReason(s, "fast_startup_enabled") || !hasReason(s, reason) {
			t.Errorf("%s + fast startup: got %s %v", status, s.ReadinessState, s.ReasonCodes)
		}
	}
}

func TestFirmwareLayerOnlyAppliesWithAWiredAdapter(t *testing.T) {
	in := dellInputs(dellCaptured(), "disabled")
	if s := Compute(in); s.ReadinessState != "no_wired_adapter" {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
	in = dellInputs(dellConfigured(), "disabled", readyNIC("aa:bb:cc:dd:ee:01"))
	in.Virtual = true
	if s := Compute(in); s.ReadinessState != "unsupported_vm" {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

// W02 reads protection but does not act on it: a set password does not change
// the state (firmware_protected arrives with the W04 write path).
func TestProtectionIsReportedNotActedOn(t *testing.T) {
	for p, want := range map[biosconfig.Protection]string{
		biosconfig.ProtectionNone: "none", biosconfig.ProtectionSet: "set", biosconfig.ProtectionUnknown: "unknown",
	} {
		fw := dellConfigured()
		fw.Protection = p
		s := Compute(dellInputs(fw, "disabled", readyNIC("aa:bb:cc:dd:ee:01")))
		if s.ReadinessState != "ready" || s.Details["firmwareProtection"] != want {
			t.Errorf("%v: got %s %v", p, s.ReadinessState, s.Details["firmwareProtection"])
		}
	}
}

func TestFirmwareChangeChangesFingerprint(t *testing.T) {
	base := Compute(dellInputs(dellConfigured(), "disabled", readyNIC("aa:bb:cc:dd:ee:01"))).Fingerprint
	fw := dellConfigured()
	fw.Settings[2].Value = "S5Only"
	if Compute(dellInputs(fw, "disabled", readyNIC("aa:bb:cc:dd:ee:01"))).Fingerprint == base {
		t.Fatal("a firmware value change must change the fingerprint")
	}
	if Compute(dellInputs(nil, "disabled", readyNIC("aa:bb:cc:dd:ee:01"))).Fingerprint == base {
		t.Fatal("losing the firmware adapter must change the fingerprint")
	}
	// Settings outside the target list and protection do not move it.
	fw = dellConfigured()
	fw.Settings[0].Value = "Disabled"
	fw.Protection = biosconfig.ProtectionSet
	if Compute(dellInputs(fw, "disabled", readyNIC("aa:bb:cc:dd:ee:01"))).Fingerprint != base {
		t.Fatal("non-target settings and protection must not change the fingerprint")
	}
}

// testdata/windows_dell_optiplex7060.json is readScript's output on the lab
// OptiPlex 7060 (Intel I219-LM, EEE only under EEELinkAdvertisement, on), MAC
// scrubbed. With the capture's firmware it is not_configured on every layer.
func TestDellCapturesEndToEnd(t *testing.T) {
	win, err := ParseWindowsReadings(readFixture(t, "windows_dell_optiplex7060.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(win.Adapters) != 1 || win.Adapters[0].EEE != "enabled" || win.Adapters[0].MagicPacket != "enabled" {
		t.Fatalf("%+v", win.Adapters)
	}
	in := dellInputs(dellCaptured(), "")
	in.Windows = win
	s := Compute(in)
	want := []string{"fast_startup_enabled", "firmware_deep_sleep_enabled", "firmware_wake_on_lan_not_lan_only", "nic_eee_enabled"}
	if s.ReadinessState != "not_configured" || !reflect.DeepEqual(s.ReasonCodes, want) {
		t.Fatalf("got %s %v, want %v", s.ReadinessState, s.ReasonCodes, want)
	}
}

// Review: a remembered (absent) adapter must not prove ready while a present
// wired adapter is wrong; with nothing present (undocked) the remembered one
// keeps readiness, per the spec's 30-day memory.
func TestReadyNeedsAPresentAdapterWhenOneIsPresent(t *testing.T) {
	in := dellInputs(dellConfigured(), "disabled", AdapterReading{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "disabled", EEE: "disabled"})
	in.Memory = AdapterMemory{"aa:bb:cc:dd:ee:09": {LastSeenAt: t0.Add(-20 * 24 * time.Hour), MagicPacket: "enabled", EEE: "disabled"}}
	if s := Compute(in); s.ReadinessState == "ready" {
		t.Fatalf("remembered adapter proved ready over a present wrong one: %v", s.ReasonCodes)
	}
	undocked := dellInputs(dellConfigured(), "disabled")
	undocked.Memory = AdapterMemory{"aa:bb:cc:dd:ee:09": {LastSeenAt: t0.Add(-20 * 24 * time.Hour), MagicPacket: "enabled", EEE: "disabled"}}
	if s := Compute(undocked); s.ReadinessState != "ready" {
		t.Fatalf("undocked with a remembered good adapter: got %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

// Review: a current value that is empty or outside the model's own list was
// not really read; it is unproven, never "wrong and fixable".
func TestUnrecognisedCurrentValueIsUnproven(t *testing.T) {
	for _, v := range []string{"", "SomethingNew"} {
		fw := dellConfigured()
		fw.Settings[1].Value = v
		s := Compute(dellInputs(fw, "disabled", readyNIC("aa:bb:cc:dd:ee:01")))
		if s.ReadinessState != "unproven" || !reflect.DeepEqual(s.ReasonCodes, []string{"firmware_value_unrecognised"}) {
			t.Errorf("value %q: got %s %v", v, s.ReadinessState, s.ReasonCodes)
		}
	}
}

// Review: a target name listed twice is ambiguous: unproven.
func TestDuplicateTargetNameIsUnproven(t *testing.T) {
	fw := dellConfigured()
	fw.Settings = append(fw.Settings, biosconfig.Setting{Name: "WakeOnLan", Value: "Disabled", Allowed: fw.Settings[1].Allowed})
	s := Compute(dellInputs(fw, "disabled", readyNIC("aa:bb:cc:dd:ee:01")))
	if s.ReadinessState != "unproven" || !hasReason(s, "firmware_setting_unrecognised") {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

func TestProtectionZeroValueIsUnknown(t *testing.T) {
	var p biosconfig.Protection
	if p != biosconfig.ProtectionUnknown {
		t.Fatalf("zero Protection = %v, want unknown", p)
	}
}

type fakeAdapter struct {
	settings []biosconfig.Setting
	readErr  error
	prot     biosconfig.Protection
	protErr  error
}

func (f fakeAdapter) Vendor() string { return "dell" }
func (f fakeAdapter) Read(context.Context) ([]biosconfig.Setting, error) {
	return f.settings, f.readErr
}
func (f fakeAdapter) Protection(context.Context) (biosconfig.Protection, error) {
	return f.prot, f.protErr
}
func (f fakeAdapter) Apply(context.Context, string, string) error {
	panic("Apply must never be called in this release")
}

func TestReadFirmware(t *testing.T) {
	ok := ReadFirmware(context.Background(), fakeAdapter{settings: dellCaptured().Settings, prot: biosconfig.ProtectionNone})
	if ok == nil || ok.Status != FirmwareRead || ok.Vendor != "dell" || len(ok.Settings) != 3 || ok.Protection != biosconfig.ProtectionNone {
		t.Fatalf("%+v", ok)
	}
	un := ReadFirmware(context.Background(), fakeAdapter{readErr: biosconfig.ErrInterfaceUnavailable, protErr: biosconfig.ErrInterfaceUnavailable, prot: biosconfig.ProtectionUnknown})
	if un.Status != FirmwareInterfaceUnavailable || len(un.Settings) != 0 {
		t.Fatalf("%+v", un)
	}
	bad := ReadFirmware(context.Background(), fakeAdapter{readErr: errors.New("exit 1"), prot: biosconfig.ProtectionNone})
	if bad.Status != FirmwareUnreadable || len(bad.Settings) != 0 {
		t.Fatalf("%+v", bad)
	}
	// A protection read failure is Unknown, whatever value came with it.
	pe := ReadFirmware(context.Background(), fakeAdapter{settings: dellCaptured().Settings, prot: biosconfig.ProtectionNone, protErr: errors.New("x")})
	if pe.Status != FirmwareRead || pe.Protection != biosconfig.ProtectionUnknown {
		t.Fatalf("%+v", pe)
	}
	if ReadFirmware(context.Background(), nil) != nil {
		t.Fatal("nil adapter must give nil readings")
	}
}
