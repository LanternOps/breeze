package wakeconfig

import (
	"context"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/biosconfig"
	"github.com/breeze-rmm/agent/internal/security"
)

type fwHarness struct {
	m       *Manager
	clock   *fakeClock
	fw      *fakeFirmware
	bl      *blReaders
	uploads atomic.Int32
	last    atomic.Value // Snapshot
}

func newFWHarness(t *testing.T, allowWrites bool) *fwHarness {
	t.Helper()
	h := &fwHarness{clock: &fakeClock{t: t0}, fw: newDellFirmware(), bl: &blReaders{state: security.BitLockerStateOff}}
	mach := goodMachine()
	h.m = New(Options{
		Collect: func(ctx context.Context) (Inputs, error) {
			in := dellInputs(nil, "")
			in.Windows = mach.read()
			in.Firmware = ReadFirmware(ctx, h.fw)
			in.FirmwareAdapter = h.fw
			return in, nil
		},
		Upload: func(ctx context.Context, s Snapshot) error {
			h.last.Store(s)
			h.uploads.Add(1)
			return nil
		},
		Now:                 h.clock.Now,
		Writer:              &fakeWriter{machine: mach},
		Reread:              func(ctx context.Context) (*WindowsReadings, error) { return mach.read(), nil },
		BootID:              func() (string, error) { return "bootid:1", nil },
		BitLockerState:      h.bl.readers().State,
		BitLockerProtectors: h.bl.readers().Protectors,
		StatePath:           filepath.Join(t.TempDir(), StateFileName),
		Interval:            time.Hour,
		testAllowWrites:     allowWrites,
	})
	t.Cleanup(func() { stopAndWait(t, h.m) })
	return h
}

func (h *fwHarness) snapshot() Snapshot { s, _ := h.last.Load().(Snapshot); return s }

func TestManagerWritesFirmwareOnlyWithAFirmwareWritesGrant(t *testing.T) {
	h := newFWHarness(t, true)
	h.m.ApplySettings(Settings{Enabled: true, ConfigureSettings: true})
	h.m.Start(context.Background())
	waitFor(t, "first upload", func() bool { return h.uploads.Load() > 0 })
	if n := len(h.fw.calls()); n != 0 {
		t.Fatalf("%d firmware writes without firmware_writes", n)
	}
	if s := h.snapshot(); s.ReadinessState != StateNotConfigured {
		t.Fatalf("without grant: %s %v", s.ReadinessState, s.ReasonCodes)
	}
	h.m.ApplySettings(Settings{Enabled: true, ConfigureSettings: true, FirmwareWrites: biosconfig.VendorDell})
	waitFor(t, "firmware write", func() bool { return len(h.fw.calls()) == 2 })
	waitFor(t, "needs_reboot upload", func() bool { return h.snapshot().ReadinessState == StateNeedsReboot })
}

// A grant for another vendor does not cover a Dell.
func TestManagerFirmwareGrantIsPerVendor(t *testing.T) {
	h := newFWHarness(t, true)
	h.m.ApplySettings(Settings{Enabled: true, ConfigureSettings: true, FirmwareWrites: biosconfig.VendorHP | biosconfig.VendorLenovo})
	h.m.Start(context.Background())
	waitFor(t, "first upload", func() bool { return h.uploads.Load() > 0 })
	if n := len(h.fw.calls()); n != 0 {
		t.Fatalf("%d Dell writes on a non-Dell grant", n)
	}
}

// The production gate: until activation (W06) a delivered firmware_writes
// grant with configure_settings true reaches neither Apply nor BitLocker.
func TestFirmwareWritesInactiveUntilActivation(t *testing.T) {
	if writesActivated {
		t.Fatal("firmware writes must stay inactive until the activation wave")
	}
	h := newFWHarness(t, false)
	h.m.ApplySettings(Settings{Enabled: true, ConfigureSettings: true, FirmwareWrites: biosconfig.VendorDell})
	h.m.Start(context.Background())
	waitFor(t, "first upload", func() bool { return h.uploads.Load() > 0 })
	if n := len(h.fw.calls()); n != 0 {
		t.Fatalf("inactive build made %d firmware writes", n)
	}
	if h.bl.stateN.Load() != 0 || h.bl.protN.Load() != 0 {
		t.Fatal("inactive build read BitLocker")
	}
	if s := h.snapshot(); s.ReadinessState != StateNotConfigured {
		t.Fatalf("inactive: %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

// firmware_writes lives in memory only and lapses 24 h after the last
// settings that carried it (observe-first amendment: same rule as
// observe_vendors).
func TestFirmwareGrantLapses24hAfterTheLastHeartbeat(t *testing.T) {
	clock := &fakeClock{t: t0}
	m := New(Options{Now: clock.Now})
	if m.firmwareGrant(clock.Now()) != 0 {
		t.Fatal("a new manager has no grant")
	}
	m.ApplySettings(Settings{Enabled: true, FirmwareWrites: biosconfig.VendorDell})
	if !m.firmwareGrant(clock.Now()).Has(biosconfig.VendorDell) {
		t.Fatal("grant not held")
	}
	clock.Advance(23 * time.Hour)
	if !m.firmwareGrant(clock.Now()).Has(biosconfig.VendorDell) {
		t.Fatal("grant lapsed early")
	}
	clock.Advance(2 * time.Hour)
	if m.firmwareGrant(clock.Now()) != 0 {
		t.Fatal("grant outlived 24 h without a heartbeat")
	}
	// A heartbeat carrying it again renews it; one without it revokes it.
	m.ApplySettings(Settings{Enabled: true, FirmwareWrites: biosconfig.VendorDell})
	if !m.firmwareGrant(clock.Now()).Has(biosconfig.VendorDell) {
		t.Fatal("grant not renewed")
	}
	m.ApplySettings(Settings{Enabled: true})
	if m.firmwareGrant(clock.Now()) != 0 {
		t.Fatal("grant not revoked")
	}
	m.ApplySettings(Settings{Enabled: false, FirmwareWrites: biosconfig.VendorDell})
	if m.firmwareGrant(clock.Now()) != 0 {
		t.Fatal("a disabled policy grants nothing")
	}
}

// Toggling the server's firmware switch does not reset the failure history.
func TestFirmwareGrantNotInPolicyFingerprint(t *testing.T) {
	a := policyFingerprint(Settings{Enabled: true, ConfigureSettings: true})
	b := policyFingerprint(Settings{Enabled: true, ConfigureSettings: true, FirmwareWrites: biosconfig.VendorDell})
	if a != b {
		t.Fatalf("fingerprint moved with firmware_writes: %s vs %s", a, b)
	}
}
