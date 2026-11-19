package wakeconfig

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/biosconfig"
)

func lenovoObservation(iface string) *biosconfig.Observation {
	return &biosconfig.Observation{
		Schema: 1, Vendor: "lenovo", NativeArch: "amd64", Interface: iface, DurationMs: 812, CollectedWith: "0.131.0",
		Lenovo: &biosconfig.LenovoObservation{
			Settings:     []biosconfig.ObservedSetting{{Name: "WakeOnLAN", Value: "ACOnly", PossibleValues: []string{"Disable", "ACOnly"}}},
			Classes:      []string{"Lenovo_BiosSetting"},
			SettingCount: 1,
		},
	}
}

func lenovoInputs() Inputs {
	in := winInputs("disabled", goodNIC("aa:bb:cc:dd:ee:01"))
	in.Manufacturer, in.Model = "LENOVO", "20U9CTO1WW"
	return in
}

// An observe-only vendor is never more than unproven: even with every Windows
// and NIC setting right and the firmware interface present, the state is
// unproven with vendor_observe_only, never ready or firmware_protected.
func TestObserveOnlyVendorIsUnproven(t *testing.T) {
	for _, iface := range []string{biosconfig.InterfacePresent, biosconfig.InterfaceAbsent, biosconfig.InterfaceError} {
		in := lenovoInputs()
		in.Observation = lenovoObservation(iface)
		s := Compute(in)
		if s.ReadinessState != StateUnproven || !reflect.DeepEqual(s.ReasonCodes, []string{"vendor_observe_only"}) {
			t.Fatalf("%s: got %s %v", iface, s.ReadinessState, s.ReasonCodes)
		}
		if s.Details["vendorObservation"] != in.Observation || s.Details["firmware"] != "observe_only" {
			t.Fatalf("%s: details = %v", iface, s.Details)
		}
	}
}

// The observation never wins over an earlier rule, so it never moves the
// state, and the state is what the fingerprint hashes.
func TestObservationDoesNotOverrideEarlierRules(t *testing.T) {
	vm := lenovoInputs()
	vm.Virtual = true
	nc := lenovoInputs()
	nc.Windows.FastStartup = "enabled"
	none := lenovoInputs()
	none.Windows.Adapters = nil
	for name, in := range map[string]Inputs{"vm": vm, "not configured": nc, "no wired": none} {
		without := Compute(in)
		in.Observation = lenovoObservation(biosconfig.InterfacePresent)
		with := Compute(in)
		if with.ReadinessState != without.ReadinessState || !reflect.DeepEqual(with.ReasonCodes, without.ReasonCodes) {
			t.Errorf("%s: %s %v -> %s %v", name, without.ReadinessState, without.ReasonCodes, with.ReadinessState, with.ReasonCodes)
		}
		if with.Details["vendorObservation"] == nil {
			t.Errorf("%s: observation dropped from details", name)
		}
	}
}

// Observation never changes the fingerprint, so it never resets the server's
// consecutive_timeouts.
func TestObservationNeverChangesFingerprint(t *testing.T) {
	in := lenovoInputs()
	base := Compute(in)
	for _, o := range []*biosconfig.Observation{lenovoObservation(biosconfig.InterfacePresent), lenovoObservation(biosconfig.InterfaceError)} {
		in.Observation = o
		if got := Compute(in).Fingerprint; got != base.Fingerprint {
			t.Fatalf("fingerprint moved: %s -> %s", base.Fingerprint, got)
		}
	}
}

// The upload decision has its own key: identical to the fingerprint without an
// observation (so no device re-uploads after this release), moved by a new
// observation, and not moved by timing alone.
func TestUploadKeyTracksObservationNotTiming(t *testing.T) {
	in := lenovoInputs()
	plain := Compute(in)
	if uploadKey(plain) != plain.Fingerprint {
		t.Fatal("upload key without an observation differs from the fingerprint")
	}
	in.Observation = lenovoObservation(biosconfig.InterfacePresent)
	a := Compute(in)
	if uploadKey(a) == plain.Fingerprint {
		t.Fatal("an observation did not move the upload key")
	}
	faster := lenovoObservation(biosconfig.InterfacePresent)
	faster.DurationMs = 90
	in.Observation = faster
	if uploadKey(Compute(in)) != uploadKey(a) {
		t.Fatal("durationMs alone moved the upload key")
	}
	changed := lenovoObservation(biosconfig.InterfacePresent)
	changed.Lenovo.Settings[0].Value = "Disable"
	in.Observation = changed
	if uploadKey(Compute(in)) == uploadKey(a) {
		t.Fatal("a changed setting did not move the upload key")
	}
}

func TestVendorNearMissesAreOther(t *testing.T) {
	for in, want := range map[string]string{
		"HPE": "other", "Hewlett Packard Enterprise": "other", "Delltron": "other", "Dell EMC": "other",
		"HP Inc.": "hp", "Hewlett-Packard": "hp", "Dell Inc.": "dell", "CHP Systems": "chp systems",
	} {
		if got := normaliseVendor(in); got == nil || *got != want {
			t.Errorf("normaliseVendor(%q) = %v, want %s", in, got, want)
		}
	}
}

// observeHarness drives a Manager whose Observe records the grant it was
// handed, on a fake clock.
type observeHarness struct {
	*harness
	observed atomic.Int32
	grant    atomic.Uint32
	panics   atomic.Bool
	snaps    chan Snapshot
}

func newObserveHarness(t *testing.T) *observeHarness {
	t.Helper()
	h := &observeHarness{harness: &harness{clock: &fakeClock{t: t0}, path: filepath.Join(t.TempDir(), "wake_status_state.json")}, snaps: make(chan Snapshot, 16)}
	t.Cleanup(func() { stopAndWait(t, h.m) })
	h.m = New(Options{
		Collect: func(ctx context.Context) (Inputs, error) {
			h.collects.Add(1)
			return lenovoInputs(), nil
		},
		Observe: func(ctx context.Context, in Inputs, grant biosconfig.VendorSet) *biosconfig.Observation {
			h.observed.Add(1)
			h.grant.Store(uint32(grant))
			if h.panics.Load() {
				panic("provider exploded")
			}
			return lenovoObservation(biosconfig.InterfacePresent)
		},
		Upload: func(ctx context.Context, s Snapshot) error {
			h.uploads.Add(1)
			h.snaps <- s
			return nil
		},
		Now:       h.clock.Now,
		StatePath: h.path,
		Interval:  time.Hour,
	})
	return h
}

func (h *observeHarness) nextSnap(t *testing.T) Snapshot {
	t.Helper()
	select {
	case s := <-h.snaps:
		return s
	case <-time.After(5 * time.Second):
		t.Fatal("no upload")
		return Snapshot{}
	}
}

func TestObserveRunsOnlyWithAGrant(t *testing.T) {
	h := newObserveHarness(t)
	h.m.Start(context.Background())
	h.m.ApplySettings(Settings{Enabled: true})
	s := h.nextSnap(t)
	if h.observed.Load() != 0 || s.Details["vendorObservation"] != nil {
		t.Fatal("observed without a grant")
	}
	// A grant arriving is a settings change: it collects at once, and the new
	// observation is uploaded although the fingerprint did not move.
	h.m.ApplySettings(Settings{Enabled: true, Observe: biosconfig.VendorLenovo})
	s2 := h.nextSnap(t)
	if h.observed.Load() != 1 || biosconfig.VendorSet(h.grant.Load()) != biosconfig.VendorLenovo {
		t.Fatalf("observed %d with %v", h.observed.Load(), biosconfig.VendorSet(h.grant.Load()))
	}
	if s2.Fingerprint != s.Fingerprint || s2.Details["vendorObservation"] == nil || !hasReason(s2, "vendor_observe_only") {
		t.Fatalf("snapshot = %+v", s2)
	}
}

// The grant lives in memory only and lapses 24 h after the last heartbeat
// that carried it; a restart starts with no grant.
func TestObserveGrantExpires24hAfterLastHeartbeat(t *testing.T) {
	m := New(Options{Now: (&fakeClock{t: t0}).Now})
	clock := &fakeClock{t: t0}
	m.opts.Now = clock.Now
	m.ApplySettings(Settings{Enabled: true, Observe: biosconfig.VendorHP})
	if g := m.observeGrant(clock.Now()); g != biosconfig.VendorHP {
		t.Fatalf("grant = %v", g)
	}
	clock.Advance(23 * time.Hour)
	if g := m.observeGrant(clock.Now()); g != biosconfig.VendorHP {
		t.Fatalf("grant lapsed early: %v", g)
	}
	// A heartbeat carrying it again refreshes the 24 h.
	m.ApplySettings(Settings{Enabled: true, Observe: biosconfig.VendorHP})
	clock.Advance(23 * time.Hour)
	if g := m.observeGrant(clock.Now()); g != biosconfig.VendorHP {
		t.Fatalf("refreshed grant lapsed: %v", g)
	}
	clock.Advance(2 * time.Hour)
	if g := m.observeGrant(clock.Now()); g != 0 {
		t.Fatalf("grant outlived 24 h: %v", g)
	}
	// Revocation is immediate.
	m.ApplySettings(Settings{Enabled: true, Observe: biosconfig.VendorHP})
	m.ApplySettings(Settings{Enabled: true})
	if g := m.observeGrant(clock.Now()); g != 0 {
		t.Fatalf("revoked grant kept: %v", g)
	}
	// Disabled policy: no grant whatever the list says.
	m.ApplySettings(Settings{Enabled: false, Observe: biosconfig.VendorHP})
	if g := m.observeGrant(clock.Now()); g != 0 {
		t.Fatalf("disabled policy kept a grant: %v", g)
	}
	// A fresh manager (a restart) has none.
	if g := New(Options{Now: clock.Now}).observeGrant(clock.Now()); g != 0 {
		t.Fatalf("fresh manager grant = %v", g)
	}
}

func TestObserveGrantIsNotPersisted(t *testing.T) {
	h := newObserveHarness(t)
	h.m.Start(context.Background())
	h.m.ApplySettings(Settings{Enabled: true, Observe: biosconfig.VendorLenovo})
	h.nextSnap(t)
	raw, err := os.ReadFile(h.path)
	if err != nil {
		t.Fatal(err)
	}
	for _, word := range []string{"observe", "Observe", "lenovo", "grant"} {
		if strings.Contains(string(raw), word) {
			t.Fatalf("state file carries %q: %s", word, raw)
		}
	}
	// The observation itself is not persisted either.
	var st map[string]any
	_ = json.Unmarshal(raw, &st)
	if _, ok := st["vendorObservation"]; ok {
		t.Fatal("observation persisted")
	}
}

// A panic inside a vendor read becomes interface: error; the loop survives and
// the snapshot is still uploaded.
func TestObservePanicIsInterfaceError(t *testing.T) {
	h := newObserveHarness(t)
	h.panics.Store(true)
	h.m.Start(context.Background())
	h.m.ApplySettings(Settings{Enabled: true, Observe: biosconfig.VendorLenovo})
	s := h.nextSnap(t)
	o, ok := s.Details["vendorObservation"].(*biosconfig.Observation)
	if !ok || o.Interface != biosconfig.InterfaceError || o.ErrorCode == nil || *o.ErrorCode != "panic" || o.Vendor != "lenovo" {
		t.Fatalf("observation = %#v", s.Details["vendorObservation"])
	}
	if o.Lenovo == nil || o.Lenovo.Settings == nil {
		t.Fatalf("panic observation must still carry its vendor block: %+v", o)
	}
	select {
	case <-h.m.Done():
		t.Fatal("loop exited after a panic")
	default:
	}
}
