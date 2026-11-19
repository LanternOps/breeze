package wakeconfig

import (
	"context"
	"errors"
	"testing"
	"time"
)

// A clock step forward (NTP fixing a slow clock) is not a reboot.
func TestClockStepDoesNotClearPending(t *testing.T) {
	r := newRig(badMachine())
	r.run(true, t0, "p1")
	rep := r.run(true, t0.Add(30*24*time.Hour), "p1") // same boot id, clock far ahead
	if len(rep.Status.Pending) != 3 || computeWith(rep).ReadinessState != "needs_reboot" {
		t.Fatalf("clock step cleared pending: %v %s", rep.Status.Pending, computeWith(rep).ReadinessState)
	}
}

// A boot taken while Fast Startup was still on resumes the kernel and does
// not reload the NIC driver, so it does not put a -NoRestart write in effect.
func TestBootWithFastStartupOnKeepsPending(t *testing.T) {
	r := newRig(badMachine())
	r.writer.fail = map[OpKind]error{OpFastStartupOff: errors.New("denied")}
	r.run(true, t0, "p1")
	r.boot = "bootid:2"
	rep := r.run(true, t0.Add(time.Hour), "p1")
	if len(rep.Status.Pending) != 3 {
		t.Fatalf("pending cleared by a boot with Fast Startup on: %v", rep.Status.Pending)
	}
}

// The re-read failed, so the write was counted as failed, but the value stuck.
// With no reboot since, the next pass must report needs_reboot, not unproven.
func TestUnconfirmedWriteThatStuckIsNeedsReboot(t *testing.T) {
	for name, tc := range map[string]struct {
		boot        string
		wantPending int
		wantState   string
	}{
		"same_boot":    {"bootid:1", 3, "needs_reboot"},
		"rebooted":     {"bootid:2", 0, "unproven"},
		"boot_unknown": {"", 3, "needs_reboot"},
	} {
		r := newRig(badMachine())
		Apply(context.Background(), ApplyInputs{activated: true,
			Configure: true, PolicyFingerprint: "p1", Readings: r.machine.read(),
			Reread: func(ctx context.Context) (*WindowsReadings, error) { return nil, errors.New("timeout") },
			Writer: r.writer, State: r.state, Persist: func(ApplyState) error { return nil },
			BootID: func() (string, error) { return "bootid:1", nil }, Now: t0,
		})
		r.boot = tc.boot
		rep := Apply(context.Background(), ApplyInputs{activated: true,
			Configure: true, PolicyFingerprint: "p1", Readings: r.machine.read(),
			Reread: func(ctx context.Context) (*WindowsReadings, error) { return r.machine.read(), nil },
			Writer: r.writer, State: r.state, Persist: func(ApplyState) error { return nil },
			BootID: func() (string, error) {
				if r.boot == "" {
					return "", errors.New("unreadable")
				}
				return r.boot, nil
			},
			Now: t0.Add(time.Hour),
		})
		if len(rep.Status.Pending) != tc.wantPending || len(rep.Status.Failed) != 0 {
			t.Fatalf("%s: pending %v failed %v", name, rep.Status.Pending, rep.Status.Failed)
		}
		if s := computeWith(rep); s.ReadinessState != tc.wantState {
			t.Fatalf("%s: got %s %v", name, s.ReadinessState, s.ReasonCodes)
		}
	}
}

// A second adapter that cannot wake must not hide that the written adapter
// will be ready after a reboot.
func TestPendingAdapterNotHiddenByAnotherWrongAdapter(t *testing.T) {
	in := winInputs("disabled",
		AdapterReading{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "enabled", EEE: "disabled", ShutdownWake: "absent"},
		AdapterReading{MAC: "aa:bb:cc:dd:ee:02", MagicPacket: "unsupported", EEE: "enabled", ShutdownWake: "absent"},
	)
	in.Apply = &ApplyStatus{Configure: true, Pending: []string{"nic:aa:bb:cc:dd:ee:01:magic_packet"}}
	if s := Compute(in); s.ReadinessState != "needs_reboot" {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

// Flapping the policy resets the failure count, never the 24 h limit.
func TestPolicyFlapDoesNotBuyAttempts(t *testing.T) {
	r := newRig(badMachine())
	r.writer.fail = map[OpKind]error{OpFastStartupOff: errors.New("denied")}
	r.run(true, t0, "p1")
	r.run(true, t0.Add(time.Minute), "p2")
	r.run(true, t0.Add(2*time.Minute), "p1")
	n := 0
	for _, op := range r.writer.ops {
		if op.Kind == OpFastStartupOff {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("policy flapping bought %d attempts inside 24 h", n)
	}
}

// Apply is exported; it must not write unless the manager activated it.
func TestApplyRefusesWithoutActivation(t *testing.T) {
	r := newRig(badMachine())
	Apply(context.Background(), ApplyInputs{
		Configure: true, PolicyFingerprint: "p1", Readings: r.machine.read(),
		Reread: func(ctx context.Context) (*WindowsReadings, error) { return r.machine.read(), nil },
		Writer: r.writer, State: r.state, Persist: func(ApplyState) error { return nil }, Now: t0,
	})
	if r.writer.count() != 0 {
		t.Fatalf("unactivated Apply wrote %v", r.writer.ops)
	}
}

// An embargo recorded while the clock ran fast lasts at most 24 h of real time.
func TestEmbargoFromAFastClockIsClamped(t *testing.T) {
	r := newRig(badMachine())
	r.state.Limiter.EmbargoUntil = t0.Add(365 * 24 * time.Hour)
	r.run(true, t0, "p1")
	if r.writer.count() != 0 {
		t.Fatal("wrote during the embargo")
	}
	r.run(true, t0.Add(25*time.Hour), "p1")
	if r.writer.count() == 0 {
		t.Fatal("an embargo from a fast clock outlived 24 h")
	}
}
