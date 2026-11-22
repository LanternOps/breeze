package wakeconfig

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/biosconfig"
	"github.com/breeze-rmm/agent/internal/security"
)

// fakeFirmware is a firmware adapter over a mutable fake BIOS. Apply changes
// the BIOS unless told to fail or not to stick; seq, when set, records the
// order of every Windows and firmware write.
type fakeFirmware struct {
	mu         sync.Mutex
	vendor     string
	settings   []biosconfig.Setting
	protection biosconfig.Protection
	readErr    error
	applyErr   error
	noStick    bool
	// landsOnError makes a failed Apply still change the BIOS (a killed
	// write that landed anyway).
	landsOnError bool
	applied      []string
	seq          *seqLog
}

type seqLog struct {
	mu  sync.Mutex
	ops []string
}

func (s *seqLog) add(op string) { s.mu.Lock(); s.ops = append(s.ops, op); s.mu.Unlock() }
func (s *seqLog) all() []string { s.mu.Lock(); defer s.mu.Unlock(); return slices.Clone(s.ops) }

func newDellFirmware() *fakeFirmware {
	return &fakeFirmware{vendor: "dell", settings: dellCaptured().Settings, protection: biosconfig.ProtectionNone}
}

func (f *fakeFirmware) Vendor() string { return f.vendor }

func (f *fakeFirmware) Read(context.Context) ([]biosconfig.Setting, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.readErr != nil {
		return nil, f.readErr
	}
	out := make([]biosconfig.Setting, len(f.settings))
	copy(out, f.settings)
	return out, nil
}

func (f *fakeFirmware) Protection(context.Context) (biosconfig.Protection, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.protection, nil
}

func (f *fakeFirmware) Apply(_ context.Context, name, value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.applied = append(f.applied, name+"="+value)
	if f.seq != nil {
		f.seq.add("firmware:" + name)
	}
	if f.applyErr != nil && !f.landsOnError {
		return f.applyErr
	}
	if !f.noStick {
		for i := range f.settings {
			if f.settings[i].Name == name {
				f.settings[i].Value = value
			}
		}
	}
	return f.applyErr
}

func (f *fakeFirmware) calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.applied)
}

func (f *fakeFirmware) set(name, value string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range f.settings {
		if f.settings[i].Name == name {
			f.settings[i].Value = value
		}
	}
}

// goodMachine is a Windows layer with nothing to write.
func goodMachine() *fakeMachine {
	return &fakeMachine{readings: WindowsReadings{FastStartup: "disabled", Adapters: []AdapterReading{
		{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "enabled", EEE: "disabled", ShutdownWake: "absent"},
	}}}
}

type fwRig struct {
	*applyRig
	fw        *fakeFirmware
	bl        *blReaders
	granted   bool
	activated bool
	stillOK   func() bool
}

func newFWRig(m *fakeMachine, fw *fakeFirmware) *fwRig {
	return &fwRig{
		applyRig:  newRig(m),
		fw:        fw,
		bl:        &blReaders{state: security.BitLockerStateOn, listing: tpmListing("7, 11")},
		granted:   true,
		activated: true,
	}
}

func (r *fwRig) run(configure bool, now time.Time) ApplyReport {
	ctx := context.Background()
	return Apply(ctx, ApplyInputs{activated: r.activated,
		Configure:            configure,
		PolicyFingerprint:    "p1",
		Readings:             r.machine.read(),
		Reread:               func(ctx context.Context) (*WindowsReadings, error) { return r.machine.read(), nil },
		Writer:               r.writer,
		State:                r.state,
		Persist:              func(ApplyState) error { r.saves++; return r.saveErr },
		BootID:               func() (string, error) { return r.boot, nil },
		Now:                  now,
		Firmware:             ReadFirmware(ctx, r.fw),
		FirmwareAdapter:      r.fw,
		FirmwareWrites:       r.granted,
		FirmwareStillAllowed: r.stillOK,
		BitLocker:            r.bl.readers(),
	})
}

// snapshot is Compute over a report, the way the manager feeds it.
func (r *fwRig) snapshot(rep ApplyReport) Snapshot {
	in := dellInputs(rep.Firmware, "")
	in.Windows = rep.Readings
	st := rep.Status
	in.Apply = &st
	return Compute(in)
}

var dellTargetWrites = []string{"WakeOnLan=LanOnly", "DeepSleepCtrl=Disabled"}

func TestFirmwareWrittenWhenEveryGatePasses(t *testing.T) {
	r := newFWRig(goodMachine(), newDellFirmware())
	rep := r.run(true, t0)
	if got := r.fw.calls(); !reflect.DeepEqual(got, dellTargetWrites) {
		t.Fatalf("firmware writes %v, want %v", got, dellTargetWrites)
	}
	if len(rep.Failed) != 0 {
		t.Fatalf("failed: %v", rep.Failed)
	}
	if r.bl.stateN.Load() != 1 || r.bl.protN.Load() != 1 {
		t.Fatalf("bitlocker read %d/%d times, want once each", r.bl.stateN.Load(), r.bl.protN.Load())
	}
}

func TestFirmwareSkippedUnlessVendorSwitchOn(t *testing.T) {
	r := newFWRig(goodMachine(), newDellFirmware())
	r.granted = false
	rep := r.run(true, t0)
	if n := len(r.fw.calls()); n != 0 {
		t.Fatalf("%d firmware writes without the vendor switch", n)
	}
	if r.bl.stateN.Load() != 0 {
		t.Fatal("bitlocker read without a possible write")
	}
	s := r.snapshot(rep)
	if s.ReadinessState != StateNotConfigured || hasReason(s, "apply_failed") || hasReason(s, "firmware_password_set") {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
	if !hasReason(s, "firmware_wake_on_lan_not_lan_only") || !hasReason(s, "firmware_deep_sleep_enabled") {
		t.Fatalf("firmware reasons missing: %v", s.ReasonCodes)
	}
}

func TestFirmwareNotWrittenWithoutConfigureOrActivation(t *testing.T) {
	r := newFWRig(goodMachine(), newDellFirmware())
	r.run(false, t0)
	r.activated = false
	r.run(true, t0.Add(48*time.Hour))
	if n := len(r.fw.calls()); n != 0 || r.bl.stateN.Load() != 0 {
		t.Fatalf("writes %d, bitlocker reads %d", n, r.bl.stateN.Load())
	}
}

func TestFirmwareAdapterMustMatchTheReadVendor(t *testing.T) {
	fw := newDellFirmware()
	fw.vendor = "hp"
	r := newFWRig(goodMachine(), fw)
	rep := Apply(context.Background(), ApplyInputs{activated: true, Configure: true, PolicyFingerprint: "p1",
		Readings: r.machine.read(), State: r.state, Persist: func(ApplyState) error { return nil }, Now: t0,
		Firmware: dellCaptured(), FirmwareAdapter: fw, FirmwareWrites: true, BitLocker: r.bl.readers(),
		Reread: func(ctx context.Context) (*WindowsReadings, error) { return r.machine.read(), nil },
	})
	if n := len(fw.calls()); n != 0 || len(rep.Attempted) != 0 {
		t.Fatalf("wrote through a %s adapter: %v", fw.vendor, fw.calls())
	}
}

func TestProtectionSetIsFirmwareProtectedNoApplyCall(t *testing.T) {
	fw := newDellFirmware()
	fw.protection = biosconfig.ProtectionSet
	r := newFWRig(goodMachine(), fw)
	rep := r.run(true, t0)
	if n := len(fw.calls()); n != 0 {
		t.Fatalf("%d writes with a BIOS password set", n)
	}
	if r.bl.stateN.Load() != 0 {
		t.Fatal("bitlocker read although the password already blocks")
	}
	s := r.snapshot(rep)
	if s.ReadinessState != StateFirmwareProtected || !hasReason(s, "firmware_password_set") {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
	if len(r.state.Limiter.Entries) != 0 {
		t.Fatalf("a refused write consumed an attempt: %v", r.state.Limiter.Entries)
	}
}

func TestProtectionUnknownIsFirmwareProtectedNoApplyCall(t *testing.T) {
	fw := newDellFirmware()
	fw.protection = biosconfig.ProtectionUnknown
	r := newFWRig(goodMachine(), fw)
	rep := r.run(true, t0)
	if n := len(fw.calls()); n != 0 {
		t.Fatalf("%d writes with protection unknown", n)
	}
	s := r.snapshot(rep)
	if s.ReadinessState != StateFirmwareProtected || !hasReason(s, "firmware_protection_unknown") {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
	if d, _ := s.Details["apply"].(map[string]any); d["firmwareProtected"] != "firmware_protection_unknown" {
		t.Fatalf("details.apply = %v", s.Details["apply"])
	}
}

// A BitLocker block is firmware_protected, makes no write and spends no
// attempt, so the write goes ahead on the first cycle the guard passes.
func TestBitLockerBlockIsFirmwareProtectedAndSpendsNoAttempt(t *testing.T) {
	for _, tc := range []struct {
		name   string
		bl     *blReaders
		reason string
	}{
		{"pcr1", &blReaders{state: security.BitLockerStateOn, listing: tpmListing("0, 1, 2, 3, 4, 5, 11")}, reasonBitLockerPCR1},
		{"profile unreadable", &blReaders{state: security.BitLockerStateOn, listingErr: errors.New("exit 1")}, reasonBitLockerProfileUnreadable},
		{"state unknown", &blReaders{stateErr: security.ErrBitLockerUnavailable, state: security.BitLockerStateOff}, reasonBitLockerStateUnknown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newFWRig(goodMachine(), newDellFirmware())
			r.bl = tc.bl
			rep := r.run(true, t0)
			if n := len(r.fw.calls()); n != 0 {
				t.Fatalf("%d writes past a bitlocker block", n)
			}
			s := r.snapshot(rep)
			if s.ReadinessState != StateFirmwareProtected || !hasReason(s, tc.reason) {
				t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
			}
			if len(r.state.Limiter.Entries) != 0 || r.saves != 0 {
				t.Fatalf("a blocked write consumed an attempt: %v (saves %d)", r.state.Limiter.Entries, r.saves)
			}
			r.bl = &blReaders{state: security.BitLockerStateOff}
			r.run(true, t0.Add(time.Hour))
			if got := r.fw.calls(); !reflect.DeepEqual(got, dellTargetWrites) {
				t.Fatalf("after the guard passes: %v", got)
			}
		})
	}
}

func TestBitLockerOffAndDefaultProfileWrite(t *testing.T) {
	for name, bl := range map[string]*blReaders{
		"off":     {state: security.BitLockerStateOff},
		"default": {state: security.BitLockerStateOn, listing: tpmListing("7, 11")},
	} {
		r := newFWRig(goodMachine(), newDellFirmware())
		r.bl = bl
		r.run(true, t0)
		if got := r.fw.calls(); !reflect.DeepEqual(got, dellTargetWrites) {
			t.Fatalf("%s: writes %v", name, got)
		}
	}
}

// Only the compile-time targets reach Apply, only with their target value,
// and only those that read wrong: other settings, however they read, never do.
func TestOnlyTargetListNamesReachApply(t *testing.T) {
	fw := newDellFirmware()
	fw.settings = append(fw.settings,
		biosconfig.Setting{Name: "WakeOnLanBootOverride", Value: "Disabled", Allowed: []string{"Disabled", "Enabled"}},
		biosconfig.Setting{Name: "BlockSleep", Value: "Enabled", Allowed: []string{"Disabled", "Enabled"}},
	)
	fw.set("WakeOnLan", "LanOnly") // already right: never rewritten
	r := newFWRig(goodMachine(), fw)
	r.run(true, t0)
	if got := fw.calls(); !reflect.DeepEqual(got, []string{"DeepSleepCtrl=Disabled"}) {
		t.Fatalf("writes %v", got)
	}
	targets := map[string]string{}
	for _, tg := range firmwareTargets["dell"] {
		targets[tg.Name] = tg.Value
	}
	for _, c := range fw.calls() {
		name, value, _ := cut(c)
		if targets[name] != value {
			t.Fatalf("%s is not a target write", c)
		}
	}
}

func cut(s string) (string, string, bool) {
	for i := range s {
		if s[i] == '=' {
			return s[:i], s[i+1:], true
		}
	}
	return s, "", false
}

// An unproven firmware layer is never written, even where one target reads
// wrong: a missing or ambiguous target, a target value the model does not
// allow, an unreadable BIOS, or no interface.
func TestNoFirmwareWriteWhenTheLayerIsUnproven(t *testing.T) {
	cases := map[string]func(f *fakeFirmware){
		"missing target": func(f *fakeFirmware) { f.settings = f.settings[:2] },
		"duplicate target": func(f *fakeFirmware) {
			f.settings = append(f.settings, biosconfig.Setting{Name: "DeepSleepCtrl", Value: "S5Only", Allowed: []string{"Disabled", "S5Only"}})
		},
		"target value not allowed": func(f *fakeFirmware) { f.settings[1].Allowed = []string{"Disabled", "LanWlan"} },
		"current value unrecognised": func(f *fakeFirmware) {
			f.settings[2].Value = ""
		},
		"unreadable":            func(f *fakeFirmware) { f.readErr = errors.New("powershell exit 1") },
		"interface unavailable": func(f *fakeFirmware) { f.readErr = biosconfig.ErrInterfaceUnavailable },
	}
	for name, mutate := range cases {
		fw := newDellFirmware()
		mutate(fw)
		r := newFWRig(goodMachine(), fw)
		rep := r.run(true, t0)
		if n := len(fw.calls()); n != 0 {
			t.Errorf("%s: %d writes", name, n)
		}
		if r.bl.stateN.Load() != 0 {
			t.Errorf("%s: bitlocker read", name)
		}
		if s := r.snapshot(rep); s.ReadinessState != StateUnproven {
			t.Errorf("%s: state %s %v", name, s.ReadinessState, s.ReasonCodes)
		}
	}
}

func TestDellReturnCodesMapToApplyFailedState(t *testing.T) {
	for code := 1; code <= 6; code++ {
		fw := newDellFirmware()
		fw.applyErr = &biosconfig.DellStatusError{Code: code}
		r := newFWRig(goodMachine(), fw)
		rep := r.run(true, t0)
		for _, key := range []string{"firmware:dell:WakeOnLan", "firmware:dell:DeepSleepCtrl"} {
			if rep.Failed[key] != "write_error" {
				t.Fatalf("status %d: failed = %v", code, rep.Failed)
			}
		}
		s := r.snapshot(rep)
		if s.ReadinessState != StateApplyFailed || !hasReason(s, "apply_failed") || *s.LastApplyResult != "failed" {
			t.Fatalf("status %d: got %s %v", code, s.ReadinessState, s.ReasonCodes)
		}
	}
}

func TestFirmwareReadbackMismatchIsApplyFailed(t *testing.T) {
	fw := newDellFirmware()
	fw.noStick = true
	r := newFWRig(goodMachine(), fw)
	rep := r.run(true, t0)
	if rep.Failed["firmware:dell:WakeOnLan"] != "readback_mismatch" {
		t.Fatalf("failed = %v", rep.Failed)
	}
	if s := r.snapshot(rep); s.ReadinessState != StateApplyFailed {
		t.Fatalf("got %s", s.ReadinessState)
	}
}

func TestFirmwareRereadFailureIsReadbackUnavailable(t *testing.T) {
	fw := newDellFirmware()
	r := newFWRig(goodMachine(), fw)
	// The read before the write succeeds; every read after it fails.
	in := ReadFirmware(context.Background(), fw)
	fw.readErr = errors.New("powershell exit 1")
	rep := Apply(context.Background(), ApplyInputs{activated: true, Configure: true, PolicyFingerprint: "p1",
		Readings: r.machine.read(), State: r.state, Persist: func(ApplyState) error { return nil }, Now: t0,
		Reread:   func(ctx context.Context) (*WindowsReadings, error) { return r.machine.read(), nil },
		Firmware: in, FirmwareAdapter: fw, FirmwareWrites: true, BitLocker: r.bl.readers(),
		BootID: func() (string, error) { return "bootid:1", nil },
	})
	if rep.Failed["firmware:dell:WakeOnLan"] != "readback_unavailable" || rep.Failed["firmware:dell:DeepSleepCtrl"] != "readback_unavailable" {
		t.Fatalf("failed = %v", rep.Failed)
	}
}

// A firmware value is stored, not in effect, until a later boot: needs_reboot,
// never ready, until the boot identity changes.
func TestAfterWriteStateIsNeedsReboot(t *testing.T) {
	r := newFWRig(goodMachine(), newDellFirmware())
	rep := r.run(true, t0)
	if !slices.Contains(rep.Status.Pending, "firmware:dell:WakeOnLan") || !slices.Contains(rep.Status.Pending, "firmware:dell:DeepSleepCtrl") {
		t.Fatalf("pending = %v", rep.Status.Pending)
	}
	s := r.snapshot(rep)
	if s.ReadinessState != StateNeedsReboot || !hasReason(s, "reboot_pending") {
		t.Fatalf("after write: %s %v", s.ReadinessState, s.ReasonCodes)
	}
	// Same boot, a day later: still needs_reboot, nothing rewritten.
	rep = r.run(true, t0.Add(25*time.Hour))
	if s := r.snapshot(rep); s.ReadinessState != StateNeedsReboot || len(r.fw.calls()) != 2 {
		t.Fatalf("same boot: %s, writes %v", s.ReadinessState, r.fw.calls())
	}
	r.boot = "bootid:2"
	rep = r.run(true, t0.Add(26*time.Hour))
	if s := r.snapshot(rep); s.ReadinessState != StateReady || len(rep.Status.Pending) != 0 {
		t.Fatalf("after reboot: %s pending %v", s.ReadinessState, rep.Status.Pending)
	}
}

// A write that reported an error but landed anyway (a killed PowerShell) is
// still only stored: needs_reboot, not ready.
func TestFirmwareWriteErrorThatLandedIsNeedsReboot(t *testing.T) {
	fw := newDellFirmware()
	fw.applyErr = errors.New("dell write did not finish and may still take effect")
	fw.landsOnError = true
	r := newFWRig(goodMachine(), fw)
	rep := r.run(true, t0)
	if s := r.snapshot(rep); s.ReadinessState != StateNeedsReboot {
		t.Fatalf("got %s %v (pending %v)", s.ReadinessState, s.ReasonCodes, rep.Status.Pending)
	}
	if r.state.Limiter.failures("firmware:dell:WakeOnLan") != 0 {
		t.Fatal("a write that read back correct still counts as a failure")
	}
}

func TestFirmwareDriftClearsPendingAndReappliesWithinLimits(t *testing.T) {
	r := newFWRig(goodMachine(), newDellFirmware())
	r.run(true, t0)
	r.fw.set("DeepSleepCtrl", "S4AndS5") // a BIOS update reset it
	rep := r.run(true, t0.Add(time.Hour))
	if slices.Contains(rep.Status.Pending, "firmware:dell:DeepSleepCtrl") {
		t.Fatal("a drifted value is no longer pending")
	}
	if len(r.fw.calls()) != 2 {
		t.Fatalf("re-applied inside 24 h: %v", r.fw.calls())
	}
	if !slices.Contains(rep.Status.Deferred, "firmware:dell:DeepSleepCtrl") {
		t.Fatalf("deferred = %v", rep.Status.Deferred)
	}
	r.run(true, t0.Add(25*time.Hour))
	if got := r.fw.calls(); len(got) != 3 || got[2] != "DeepSleepCtrl=Disabled" {
		t.Fatalf("drift re-apply: %v", got)
	}
}

func TestFirmwareLimiterOnePer24hStopsAfterThree(t *testing.T) {
	fw := newDellFirmware()
	fw.applyErr = &biosconfig.DellStatusError{Code: 1}
	r := newFWRig(goodMachine(), fw)
	for i, at := range []time.Duration{0, time.Hour, 24 * time.Hour, 48 * time.Hour, 72 * time.Hour, 96 * time.Hour} {
		r.run(true, t0.Add(at))
		want := []int{2, 2, 4, 6, 6, 6}[i]
		if n := len(fw.calls()); n != want {
			t.Fatalf("after %v: %d writes, want %d", at, n, want)
		}
	}
	rep := r.run(true, t0.Add(120*time.Hour))
	s := r.snapshot(rep)
	if s.ReadinessState != StateApplyFailed || !hasReason(s, "apply_blocked") {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

func TestFirmwareRunsAfterWindowsWrites(t *testing.T) {
	seq := &seqLog{}
	m := badMachine()
	fw := newDellFirmware()
	fw.seq = seq
	r := newFWRig(m, fw)
	r.writer = &fakeWriter{machine: m}
	r.applyRig.writer = r.writer
	inner := r.writer
	rep := Apply(context.Background(), ApplyInputs{activated: true, Configure: true, PolicyFingerprint: "p1",
		Readings: m.read(), State: r.state, Persist: func(ApplyState) error { return nil }, Now: t0,
		Reread:   func(ctx context.Context) (*WindowsReadings, error) { return m.read(), nil },
		Writer:   seqWriter{inner: inner, seq: seq},
		BootID:   func() (string, error) { return "bootid:1", nil },
		Firmware: ReadFirmware(context.Background(), fw), FirmwareAdapter: fw, FirmwareWrites: true, BitLocker: r.bl.readers(),
	})
	got := seq.all()
	want := []string{"windows:fast_startup", "windows:magic_packet", "windows:eee", "windows:shutdown_wake", "firmware:WakeOnLan", "firmware:DeepSleepCtrl"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("order %v, want %v", got, want)
	}
	if rep.Status.LastApplyResult != "ok" || len(rep.Attempted) != 6 {
		t.Fatalf("result %s attempted %v failed %v", rep.Status.LastApplyResult, rep.Attempted, rep.Failed)
	}
}

type seqWriter struct {
	inner Writer
	seq   *seqLog
}

func (w seqWriter) Write(ctx context.Context, op Op) error {
	w.seq.add("windows:" + op.Kind.String())
	return w.inner.Write(ctx, op)
}

// The BitLocker guard runs only when a write would otherwise go ahead: not
// when firmware is already right, nor while the limiter defers.
func TestBitLockerReadOnlyWhenAWriteWouldHappen(t *testing.T) {
	fw := newDellFirmware()
	fw.set("WakeOnLan", "LanOnly")
	fw.set("DeepSleepCtrl", "Disabled")
	r := newFWRig(goodMachine(), fw)
	r.run(true, t0)
	if r.bl.stateN.Load() != 0 {
		t.Fatal("bitlocker read with nothing to write")
	}
	fw2 := newDellFirmware()
	fw2.applyErr = &biosconfig.DellStatusError{Code: 1}
	r2 := newFWRig(goodMachine(), fw2)
	r2.run(true, t0)
	r2.run(true, t0.Add(time.Hour)) // deferred
	if n := r2.bl.stateN.Load(); n != 1 {
		t.Fatalf("bitlocker read %d times, want 1 (not while deferred)", n)
	}
}

func TestFirmwareAttemptPersistedBeforeWriteAndSaveFailureBlocksIt(t *testing.T) {
	r := newFWRig(goodMachine(), newDellFirmware())
	r.saveErr = errors.New("disk full")
	r.run(true, t0)
	if n := len(r.fw.calls()); n != 0 {
		t.Fatalf("%d writes with an attempt that could not be recorded", n)
	}
	if len(r.state.Limiter.Entries) != 0 {
		t.Fatalf("unrecorded attempt left in the limiter: %v", r.state.Limiter.Entries)
	}
}

func TestFirmwareStopsWhenNoLongerAllowed(t *testing.T) {
	r := newFWRig(goodMachine(), newDellFirmware())
	var n atomic.Int32
	r.stillOK = func() bool { return n.Add(1) <= 1 } // allowed for the first check only
	r.run(true, t0)
	if got := r.fw.calls(); len(got) > 1 {
		t.Fatalf("writes continued after the grant lapsed: %v", got)
	}
	r2 := newFWRig(goodMachine(), newDellFirmware())
	r2.stillOK = func() bool { return false }
	r2.run(true, t0)
	if len(r2.fw.calls()) != 0 || r2.bl.stateN.Load() != 0 {
		t.Fatal("wrote or read bitlocker with the grant gone")
	}
}

// Firmware attempts and pending state survive an agent restart (they live in
// the persisted ApplyState).
func TestFirmwarePendingSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), StateFileName)
	r := newFWRig(goodMachine(), newDellFirmware())
	st := State{}
	r.state = &st.Apply
	r.run(true, t0)
	if err := saveState(path, st); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadStateAt(path, t0)
	if err != nil {
		t.Fatal(err)
	}
	r2 := newFWRig(goodMachine(), r.fw)
	r2.state = &loaded.Apply
	rep := r2.run(true, t0.Add(time.Hour))
	if s := r2.snapshot(rep); s.ReadinessState != StateNeedsReboot {
		t.Fatalf("after restart: %s %v", s.ReadinessState, s.ReasonCodes)
	}
	if len(r.fw.calls()) != 2 {
		t.Fatalf("rewritten after restart: %v", r.fw.calls())
	}
}

// With writes inactive, a firmware_writes grant changes nothing the server
// sees: the snapshot (state, reasons, details, fingerprint) is identical.
func TestInactiveSnapshotUnchangedByFirmwareGrant(t *testing.T) {
	snap := func(granted bool) Snapshot {
		r := newFWRig(goodMachine(), newDellFirmware())
		r.activated = false
		r.granted = granted
		return r.snapshot(r.run(true, t0))
	}
	a, b := snap(false), snap(true)
	if !reflect.DeepEqual(a.Details, b.Details) || a.Fingerprint != b.Fingerprint || a.ReadinessState != b.ReadinessState ||
		!reflect.DeepEqual(a.ReasonCodes, b.ReasonCodes) {
		t.Fatalf("snapshot moved:\n%+v\n%+v", a, b)
	}
	if _, ok := a.Details["apply"].(map[string]any)["firmwareProtected"]; ok {
		t.Fatal("firmwareProtected must be absent unless set")
	}
}
