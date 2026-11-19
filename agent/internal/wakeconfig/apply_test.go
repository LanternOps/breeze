package wakeconfig

import (
	"context"
	"errors"
	"maps"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeWriter records every write and, unless told to fail or to "not stick",
// mutates the fake machine so the next read sees the new value.
type fakeWriter struct {
	mu      sync.Mutex
	ops     []Op
	machine *fakeMachine
	fail    map[OpKind]error
	noStick map[OpKind]bool
}

func (w *fakeWriter) Write(ctx context.Context, op Op) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.ops = append(w.ops, op)
	if err := w.fail[op.Kind]; err != nil {
		return err
	}
	if w.noStick[op.Kind] {
		return nil
	}
	w.machine.set(op)
	return nil
}

func (w *fakeWriter) count() int { w.mu.Lock(); defer w.mu.Unlock(); return len(w.ops) }

// fakeMachine is the live Windows state the fake writer changes.
type fakeMachine struct {
	mu       sync.Mutex
	readings WindowsReadings
}

func (m *fakeMachine) set(op Op) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if op.Kind == OpFastStartupOff {
		m.readings.FastStartup = "disabled"
		return
	}
	for i := range m.readings.Adapters {
		a := &m.readings.Adapters[i]
		if a.MAC != op.MAC {
			continue
		}
		switch op.Kind {
		case OpMagicPacketOn:
			a.MagicPacket = "enabled"
		case OpEEEOff:
			a.EEE = "disabled"
		case OpShutdownWakeOn:
			a.ShutdownWake = "enabled"
		}
	}
}

func (m *fakeMachine) read() *WindowsReadings {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.readings
	r.Adapters = append([]AdapterReading(nil), m.readings.Adapters...)
	return &r
}

func badMachine() *fakeMachine {
	return &fakeMachine{readings: WindowsReadings{
		FastStartup: "enabled",
		Adapters: []AdapterReading{{
			MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "disabled", EEE: "enabled", ShutdownWake: "disabled",
		}},
	}}
}

type applyRig struct {
	machine *fakeMachine
	writer  *fakeWriter
	state   *ApplyState
	boot    string
	saves   int
	saveErr error
}

func newRig(m *fakeMachine) *applyRig {
	return &applyRig{machine: m, writer: &fakeWriter{machine: m}, state: &ApplyState{}, boot: "bootid:1"}
}

func (r *applyRig) run(configure bool, now time.Time, policyFP string) ApplyReport {
	return Apply(context.Background(), ApplyInputs{activated: true,
		Configure:         configure,
		PolicyFingerprint: policyFP,
		Readings:          r.machine.read(),
		Reread:            func(ctx context.Context) (*WindowsReadings, error) { return r.machine.read(), nil },
		Writer:            r.writer,
		State:             r.state,
		Persist: func(s ApplyState) error {
			r.saves++
			return r.saveErr
		},
		BootID: func() (string, error) { return r.boot, nil },
		Now:    now,
	})
}

func TestNoWriteWhenConfigureFalse(t *testing.T) {
	r := newRig(badMachine())
	rep := r.run(false, t0, "p1")
	if r.writer.count() != 0 || len(rep.Attempted) != 0 {
		t.Fatalf("configure=false wrote %v", r.writer.ops)
	}
}

func TestNoWriteWhenAlreadyCorrect(t *testing.T) {
	m := &fakeMachine{readings: WindowsReadings{FastStartup: "disabled", Adapters: []AdapterReading{
		{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "enabled", EEE: "disabled", ShutdownWake: "enabled"},
		{MAC: "aa:bb:cc:dd:ee:02", MagicPacket: "enabled", EEE: "absent", ShutdownWake: "absent"},
	}}}
	r := newRig(m)
	r.run(true, t0, "p1")
	if r.writer.count() != 0 {
		t.Fatalf("already-correct values were rewritten: %v", r.writer.ops)
	}
}

func TestNoWriteForUnknownUnsupportedOrAbsentValues(t *testing.T) {
	m := &fakeMachine{readings: WindowsReadings{FastStartup: "unknown", Adapters: []AdapterReading{
		{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "unknown", EEE: "unknown", ShutdownWake: "unknown"},
		{MAC: "aa:bb:cc:dd:ee:02", MagicPacket: "unsupported", EEE: "absent", ShutdownWake: "absent"},
	}}}
	r := newRig(m)
	r.run(true, t0, "p1")
	if r.writer.count() != 0 {
		t.Fatalf("only positively wrong values may be written, got %v", r.writer.ops)
	}
}

func TestNoWriteOnVirtualOrWithoutCmdletsOrWiredAdapter(t *testing.T) {
	for name, mutate := range map[string]func(in *ApplyInputs){
		"virtual":   func(in *ApplyInputs) { in.Virtual = true },
		"cmdlets":   func(in *ApplyInputs) { in.Readings.NetAdapterCmdletsUnavailable = true },
		"no_wired":  func(in *ApplyInputs) { in.Readings.Adapters = nil },
		"nil_reads": func(in *ApplyInputs) { in.Readings = nil },
	} {
		r := newRig(badMachine())
		in := ApplyInputs{
			activated: true, Configure: true, PolicyFingerprint: "p1", Readings: r.machine.read(),
			Reread: func(ctx context.Context) (*WindowsReadings, error) { return r.machine.read(), nil },
			Writer: r.writer, State: r.state, Persist: func(ApplyState) error { return nil }, Now: t0,
		}
		mutate(&in)
		Apply(context.Background(), in)
		if r.writer.count() != 0 {
			t.Fatalf("%s: wrote %v", name, r.writer.ops)
		}
	}
}

func TestFastStartupWrittenWhenOnlyARememberedAdapterExists(t *testing.T) {
	m := &fakeMachine{readings: WindowsReadings{FastStartup: "enabled"}}
	r := newRig(m)
	Apply(context.Background(), ApplyInputs{activated: true,
		Configure: true, PolicyFingerprint: "p1", Readings: m.read(),
		Memory: AdapterMemory{"aa:bb:cc:dd:ee:09": {LastSeenAt: t0.Add(-48 * time.Hour), MagicPacket: "enabled", EEE: "absent"}},
		Reread: func(ctx context.Context) (*WindowsReadings, error) { return m.read(), nil },
		Writer: r.writer, State: r.state, Persist: func(ApplyState) error { return nil }, Now: t0,
	})
	if r.writer.count() != 1 || r.writer.ops[0].Kind != OpFastStartupOff {
		t.Fatalf("undocked laptop: want fast startup only, got %v", r.writer.ops)
	}
}

func TestApplyOrderIsFastStartupMagicPacketEEEShutdownWake(t *testing.T) {
	m := badMachine()
	m.readings.Adapters = append(m.readings.Adapters, AdapterReading{
		MAC: "aa:bb:cc:dd:ee:02", MagicPacket: "disabled", EEE: "enabled", ShutdownWake: "absent",
	})
	r := newRig(m)
	r.run(true, t0, "p1")
	var got []string
	for _, op := range r.writer.ops {
		got = append(got, op.Key())
	}
	want := []string{
		"fast_startup",
		"nic:aa:bb:cc:dd:ee:01:magic_packet", "nic:aa:bb:cc:dd:ee:02:magic_packet",
		"nic:aa:bb:cc:dd:ee:01:eee", "nic:aa:bb:cc:dd:ee:02:eee",
		"nic:aa:bb:cc:dd:ee:01:shutdown_wake",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("order:\n got %v\nwant %v", got, want)
	}
}

func TestEveryNicWriteHasNoRestart(t *testing.T) {
	for _, kind := range []OpKind{OpMagicPacketOn, OpEEEOff, OpShutdownWakeOn} {
		s, err := writeScript(Op{Kind: kind, MAC: "aa:bb:cc:dd:ee:01"})
		if err != nil {
			t.Fatalf("%v: %v", kind, err)
		}
		sets := 0
		for line := range strings.SplitSeq(s, "\n") {
			if strings.Contains(strings.ToLower(line), "set-netadapter") {
				sets++
				if !strings.Contains(line, "-NoRestart") {
					t.Fatalf("%v: NIC write without -NoRestart: %q", kind, line)
				}
			}
		}
		if sets != 1 {
			t.Fatalf("%v: want exactly one Set-NetAdapter* call, got %d in %q", kind, sets, s)
		}
		ls := strings.ToLower(s)
		for _, bad := range []string{"restart-", "disable-netadapter", "enable-netadapter", "reset-", "remove-",
			"rename-", "invoke-", "displayname", "displayvalue"} {
			if strings.Contains(ls, bad) {
				t.Fatalf("%v: write script contains forbidden %q", kind, bad)
			}
		}
		if !strings.Contains(s, "'AA-BB-CC-DD-EE-01'") || !strings.Contains(s, "NdisPhysicalMedium -eq 14") ||
			!strings.Contains(s, "$n.Count -ne 1") {
			t.Fatalf("%v: adapter must be re-resolved by MAC on the wired filter with exactly one match: %q", kind, s)
		}
	}
	if _, err := writeScript(Op{Kind: OpFastStartupOff}); err == nil {
		t.Fatal("fast startup is a registry write, not a script")
	}
	for _, mac := range []string{"", "aa:bb", "zz:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:01'; Restart-Computer; '"} {
		if _, err := writeScript(Op{Kind: OpMagicPacketOn, MAC: mac}); err == nil {
			t.Fatalf("invalid MAC %q accepted", mac)
		}
	}
}

func TestReadbackMismatchIsApplyFailed(t *testing.T) {
	r := newRig(badMachine())
	r.writer.noStick = map[OpKind]bool{OpMagicPacketOn: true}
	rep := r.run(true, t0, "p1")
	if rep.Failed["nic:aa:bb:cc:dd:ee:01:magic_packet"] != "readback_mismatch" {
		t.Fatalf("want readback_mismatch, got %v", rep.Failed)
	}
	if rep.Status.LastApplyResult != "partial" {
		t.Fatalf("want partial, got %q", rep.Status.LastApplyResult)
	}
	in := winInputs("", rep.Readings.Adapters...)
	in.Windows = rep.Readings
	in.Apply = &rep.Status
	s := Compute(in)
	if s.ReadinessState != "apply_failed" || !hasReason(s, "apply_failed") {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
	if s.LastApplyResult == nil || *s.LastApplyResult != "partial" || s.LastApplyAt == nil {
		t.Fatalf("lastApply not reported: %v %v", s.LastApplyAt, s.LastApplyResult)
	}
}

func TestWriteErrorIsApplyFailed(t *testing.T) {
	r := newRig(badMachine())
	r.writer.fail = map[OpKind]error{OpFastStartupOff: errors.New("access denied")}
	rep := r.run(true, t0, "p1")
	if rep.Failed["fast_startup"] != "write_error" {
		t.Fatalf("got %v", rep.Failed)
	}
}

func TestRereadFailureCountsAttemptsAsFailed(t *testing.T) {
	r := newRig(badMachine())
	rep := Apply(context.Background(), ApplyInputs{activated: true,
		Configure: true, PolicyFingerprint: "p1", Readings: r.machine.read(),
		Reread: func(ctx context.Context) (*WindowsReadings, error) { return nil, errors.New("powershell exit 1") },
		Writer: r.writer, State: r.state, Persist: func(ApplyState) error { return nil }, Now: t0,
	})
	if len(rep.Failed) != len(rep.Attempted) || len(rep.Attempted) == 0 {
		t.Fatalf("unverifiable writes must count as failed: attempted %v failed %v", rep.Attempted, rep.Failed)
	}
}

func TestNeedsRebootClearsOnlyAfterLaterBoot(t *testing.T) {
	r := newRig(badMachine())
	rep := r.run(true, t0, "p1")
	if len(rep.Status.Pending) != 3 { // magic packet, EEE, shutdown wake; fast startup takes effect at next shutdown
		t.Fatalf("pending: %v", rep.Status.Pending)
	}
	s := computeWith(rep)
	if s.ReadinessState != "needs_reboot" || !hasReason(s, "reboot_pending") {
		t.Fatalf("after write: %s %v", s.ReadinessState, s.ReasonCodes)
	}
	// Same boot, later cycle: still pending, and nothing is rewritten.
	before := r.writer.count()
	rep = r.run(true, t0.Add(25*time.Hour), "p1")
	if computeWith(rep).ReadinessState != "needs_reboot" || r.writer.count() != before {
		t.Fatalf("same boot: %s, writes %d->%d", computeWith(rep).ReadinessState, before, r.writer.count())
	}
	// A boot later than the write clears it.
	r.boot = "bootid:2"
	rep = r.run(true, t0.Add(27*time.Hour), "p1")
	if len(rep.Status.Pending) != 0 || computeWith(rep).ReadinessState != "unproven" {
		t.Fatalf("after reboot: pending %v state %s", rep.Status.Pending, computeWith(rep).ReadinessState)
	}
}

func TestNeedsRebootStaysWhenBootTimeUnreadable(t *testing.T) {
	r := newRig(badMachine())
	r.run(true, t0, "p1")
	rep := Apply(context.Background(), ApplyInputs{activated: true,
		Configure: true, PolicyFingerprint: "p1", Readings: r.machine.read(),
		Reread: func(ctx context.Context) (*WindowsReadings, error) { return r.machine.read(), nil },
		Writer: r.writer, State: r.state, Persist: func(ApplyState) error { return nil },
		BootID: func() (string, error) { return "", errors.New("no boot id") },
		Now:    t0.Add(48 * time.Hour),
	})
	if len(rep.Status.Pending) != 3 {
		t.Fatalf("unknown boot time must keep pending, got %v", rep.Status.Pending)
	}
}

func TestPendingStateSurvivesAgentRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), StateFileName)
	m := badMachine()
	w := &fakeWriter{machine: m}
	boot := "bootid:1"
	runOnce := func(now time.Time) ApplyReport {
		st, err := loadStateAt(path, now) // a fresh process reads the file
		if err != nil {
			t.Fatal(err)
		}
		rep := Apply(context.Background(), ApplyInputs{activated: true,
			Configure: true, PolicyFingerprint: "p1", Readings: m.read(),
			Reread: func(ctx context.Context) (*WindowsReadings, error) { return m.read(), nil },
			Writer: w, State: &st.Apply,
			Persist: func(a ApplyState) error { st.Apply = a; return saveState(path, st) },
			BootID:  func() (string, error) { return boot, nil }, Now: now,
		})
		return rep
	}
	runOnce(t0)
	writes := w.count()
	rep := runOnce(t0.Add(time.Hour)) // agent restarted, machine did not
	if len(rep.Status.Pending) != 3 || w.count() != writes {
		t.Fatalf("restart lost pending (%v) or rewrote (%d->%d)", rep.Status.Pending, writes, w.count())
	}
	boot = "bootid:2"
	if rep := runOnce(t0.Add(3 * time.Hour)); len(rep.Status.Pending) != 0 {
		t.Fatalf("pending survived a later boot: %v", rep.Status.Pending)
	}
}

func TestLimiterOnePer24hStopsAfterThree(t *testing.T) {
	r := newRig(badMachine())
	r.writer.fail = map[OpKind]error{OpFastStartupOff: errors.New("denied")}
	fastWrites := func() int {
		n := 0
		for _, op := range r.writer.ops {
			if op.Kind == OpFastStartupOff {
				n++
			}
		}
		return n
	}
	now := t0
	r.run(true, now, "p1")
	r.run(true, now.Add(time.Hour), "p1")
	r.run(true, now.Add(23*time.Hour), "p1")
	if fastWrites() != 1 {
		t.Fatalf("more than one attempt in 24 h: %d", fastWrites())
	}
	r.run(true, now.Add(24*time.Hour), "p1")
	r.run(true, now.Add(48*time.Hour), "p1")
	if fastWrites() != 3 {
		t.Fatalf("want 3 attempts by 48 h, got %d", fastWrites())
	}
	rep := r.run(true, now.Add(30*24*time.Hour), "p1")
	if fastWrites() != 3 {
		t.Fatalf("attempt after 3 failures: %d", fastWrites())
	}
	if !contains(rep.Status.Blocked, "fast_startup") {
		t.Fatalf("blocked not reported: %+v", rep.Status)
	}
	if s := computeWith(rep); s.ReadinessState != "apply_failed" || !hasReason(s, "apply_blocked") {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

func TestPolicyFingerprintChangeResetsLimiter(t *testing.T) {
	r := newRig(badMachine())
	r.writer.fail = map[OpKind]error{OpFastStartupOff: errors.New("denied")}
	for i := range 3 {
		r.run(true, t0.Add(time.Duration(i)*24*time.Hour), "p1")
	}
	n := r.writer.count()
	r.run(true, t0.Add(4*24*time.Hour), "p1")
	if r.writer.count() != n {
		t.Fatal("blocked setting was retried under the same policy")
	}
	r.run(true, t0.Add(4*24*time.Hour+time.Minute), "p2")
	if r.writer.count() == n {
		t.Fatal("policy fingerprint change did not reset the limiter")
	}
}

func TestDriftTriggersReapplyWithinLimits(t *testing.T) {
	r := newRig(badMachine())
	r.run(true, t0, "p1")
	r.boot = "bootid:2" // rebooted; settings in effect
	r.run(true, t0.Add(2*time.Hour), "p1")
	n := r.writer.count()
	// A driver update resets magic packet.
	r.machine.mu.Lock()
	r.machine.readings.Adapters[0].MagicPacket = "disabled"
	r.machine.mu.Unlock()
	r.run(true, t0.Add(3*time.Hour), "p1") // inside 24 h of the last attempt: no write
	if r.writer.count() != n {
		t.Fatalf("drift re-applied inside the 24 h limit")
	}
	rep := r.run(true, t0.Add(24*time.Hour), "p1")
	if r.writer.count() != n+1 || r.writer.ops[n].Key() != "nic:aa:bb:cc:dd:ee:01:magic_packet" {
		t.Fatalf("drift not re-applied after 24 h: %v", r.writer.ops[n:])
	}
	if rep.Status.LastApplyResult != "ok" {
		t.Fatalf("got %q", rep.Status.LastApplyResult)
	}
}

func TestDeferredDriftIsNotConfigured(t *testing.T) {
	r := newRig(badMachine())
	r.run(true, t0, "p1")
	r.machine.mu.Lock()
	r.machine.readings.FastStartup = "enabled"
	r.machine.mu.Unlock()
	rep := r.run(true, t0.Add(time.Hour), "p1")
	s := computeWith(rep)
	if s.ReadinessState != "not_configured" || !hasReason(s, "apply_deferred") {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

func TestAttemptPersistedBeforeWriteAndSaveFailureBlocksWrite(t *testing.T) {
	r := newRig(badMachine())
	r.saveErr = errors.New("disk full")
	rep := r.run(true, t0, "p1")
	if r.writer.count() != 0 {
		t.Fatalf("wrote without a persisted attempt: %v", r.writer.ops)
	}
	if rep.Status.LastApplyResult != "" || len(rep.Attempted) != 0 {
		t.Fatalf("nothing was attempted: %+v", rep)
	}
	// With saving working, the attempt is persisted before the write runs.
	r.saveErr = nil
	var persistedBeforeWrite bool
	var persisted ApplyState
	r.writer.fail = nil
	w := &orderingWriter{inner: r.writer, check: func() {
		persistedBeforeWrite = persisted.Limiter.Entries["fast_startup"].Failures == 1
	}}
	Apply(context.Background(), ApplyInputs{activated: true,
		Configure: true, PolicyFingerprint: "p1", Readings: r.machine.read(),
		Reread: func(ctx context.Context) (*WindowsReadings, error) { return r.machine.read(), nil },
		Writer: w, State: r.state, Now: t0,
		Persist: func(a ApplyState) error {
			// A deep-enough copy: the limiter map is the part checked.
			a.Limiter.Entries = maps.Clone(a.Limiter.Entries)
			persisted = a
			return nil
		},
	})
	if !persistedBeforeWrite {
		t.Fatal("the attempt must be recorded (as a provisional failure) before the write")
	}
}

type orderingWriter struct {
	inner Writer
	check func()
	done  bool
}

func (o *orderingWriter) Write(ctx context.Context, op Op) error {
	if !o.done {
		o.check()
		o.done = true
	}
	return o.inner.Write(ctx, op)
}

func TestCorruptStateEmbargoesWritesFor24h(t *testing.T) {
	path := filepath.Join(t.TempDir(), StateFileName)
	if err := writeFile(path, "{not json"); err != nil {
		t.Fatal(err)
	}
	st, err := loadStateAt(path, t0)
	if err != nil {
		t.Fatal(err)
	}
	m := badMachine()
	w := &fakeWriter{machine: m}
	run := func(now time.Time) {
		Apply(context.Background(), ApplyInputs{activated: true,
			Configure: true, PolicyFingerprint: "p1", Readings: m.read(),
			Reread: func(ctx context.Context) (*WindowsReadings, error) { return m.read(), nil },
			Writer: w, State: &st.Apply, Persist: func(ApplyState) error { return nil }, Now: now,
		})
	}
	run(t0.Add(time.Hour))
	if w.count() != 0 {
		t.Fatal("a corrupt limiter must not hand out a fresh write budget")
	}
	// A policy change does not lift the embargo either.
	Apply(context.Background(), ApplyInputs{activated: true,
		Configure: true, PolicyFingerprint: "p2", Readings: m.read(),
		Reread: func(ctx context.Context) (*WindowsReadings, error) { return m.read(), nil },
		Writer: w, State: &st.Apply, Persist: func(ApplyState) error { return nil }, Now: t0.Add(2 * time.Hour),
	})
	if w.count() != 0 {
		t.Fatal("embargo lifted by a policy change")
	}
	run(t0.Add(25 * time.Hour))
	if w.count() == 0 {
		t.Fatal("embargo never lifted")
	}
}

func TestPolicyRemovedStopsAndRevertsNothing(t *testing.T) {
	m := badMachine()
	w := &fakeWriter{machine: m}
	h := newApplyHarness(t, m, w)
	h.m.ApplySettings(Settings{Enabled: true, ConfigureSettings: true})
	h.m.Start(context.Background())
	defer h.m.Stop()
	waitFor(t, "first cycle", func() bool { return h.uploads.Load() > 0 })
	n := w.count()
	if n == 0 {
		t.Fatal("no writes in the first cycle")
	}
	collects := h.collects.Load()
	h.m.ApplySettings(Settings{Enabled: false})
	// The machine drifts back; a disabled manager must neither collect nor
	// write, whatever settings traffic follows.
	m.mu.Lock()
	m.readings = badMachine().readings
	m.mu.Unlock()
	h.m.ApplySettings(Settings{Enabled: false, ConfigureSettings: true})
	h.m.ApplySettings(Settings{Enabled: false})
	time.Sleep(150 * time.Millisecond)
	if w.count() != n || h.collects.Load() != collects {
		t.Fatalf("after the policy was removed: writes %v, collects %d->%d", w.ops[n:], collects, h.collects.Load())
	}
	for _, op := range w.ops {
		if op.Kind != OpFastStartupOff && op.Kind != OpMagicPacketOn && op.Kind != OpEEEOff && op.Kind != OpShutdownWakeOn {
			t.Fatalf("unexpected op %v", op)
		}
	}
	for _, op := range w.ops[n:] {
		t.Fatalf("op after removal: %v", op) // nothing may run, revert or otherwise
	}
}

// sideEffectWriter runs hook before its first write.
type sideEffectWriter struct {
	inner *fakeWriter
	hook  func()
	once  sync.Once
}

func (s *sideEffectWriter) Write(ctx context.Context, op Op) error {
	s.once.Do(s.hook)
	return s.inner.Write(ctx, op)
}

// A policy removed (or configure turned off) while a cycle is writing stops
// the writes that have not started yet.
func TestPolicyChangeMidCycleStopsRemainingWrites(t *testing.T) {
	for name, next := range map[string]Settings{
		"removed":       {Enabled: false},
		"configure_off": {Enabled: true},
	} {
		m := badMachine()
		inner := &fakeWriter{machine: m}
		var h *applyHarness
		w := &sideEffectWriter{inner: inner, hook: func() { h.m.ApplySettings(next) }}
		h = newApplyHarness(t, m, w)
		h.m.ApplySettings(Settings{Enabled: true, ConfigureSettings: true})
		h.m.Start(context.Background())
		waitFor(t, "first cycle", func() bool { return h.uploads.Load() > 0 })
		h.m.Stop()
		<-h.m.Done()
		if inner.count() != 1 {
			t.Fatalf("%s: want only the write already started, got %v", name, inner.ops)
		}
	}
}

// The production gate: until activation (W06) a delivered configure_settings
// true must not reach the writer.
func TestWritesInactiveUntilActivation(t *testing.T) {
	if writesActivated {
		t.Fatal("wake setting writes must stay inactive until the activation wave")
	}
	m := badMachine()
	w := &fakeWriter{machine: m}
	h := newApplyHarness(t, m, w)
	h.m.opts.testAllowWrites = false
	h.m.ApplySettings(Settings{Enabled: true, ConfigureSettings: true})
	h.m.Start(context.Background())
	defer h.m.Stop()
	waitFor(t, "collection", func() bool { return h.uploads.Load() > 0 })
	if w.count() != 0 {
		t.Fatalf("inactive build wrote %v", w.ops)
	}
}

func TestConfigureChangeWhileEnabledTriggersCycle(t *testing.T) {
	m := badMachine()
	w := &fakeWriter{machine: m}
	h := newApplyHarness(t, m, w)
	h.m.ApplySettings(Settings{Enabled: true})
	h.m.Start(context.Background())
	defer h.m.Stop()
	waitFor(t, "first collect", func() bool { return h.collects.Load() == 1 })
	if w.count() != 0 {
		t.Fatal("wrote with configure off")
	}
	h.m.ApplySettings(Settings{Enabled: true, ConfigureSettings: true})
	waitFor(t, "apply after configure turned on", func() bool { return w.count() > 0 })
}

func computeWith(rep ApplyReport) Snapshot {
	in := winInputs("")
	in.Windows = rep.Readings
	st := rep.Status
	in.Apply = &st
	return Compute(in)
}

func contains(xs []string, x string) bool { return slices.Contains(xs, x) }
