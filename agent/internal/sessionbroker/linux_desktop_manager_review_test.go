package sessionbroker

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// A helper that never connects must exhaust its budget, not be respawned
// for as long as the session stays active.
func TestLinuxDesktopManager_NeverConnectingHelperExhausts(t *testing.T) {
	r := newLDRig(t)
	if err := r.m.Ensure(context.Background(), ldSession); err != nil {
		t.Fatal(err)
	}
	// Two 20 s connect timeouts outrun the 30 s chain: exhausted by ~45 s.
	for i := 0; i < 50; i++ {
		r.clock.advance(time.Second)
		r.tick()
	}
	if err := r.m.Ensure(context.Background(), ldSession); err == nil {
		t.Fatal("Ensure succeeded inside the exhaustion cool-down")
	}
	spawned := r.sp.startCount()
	if spawned > linuxDesktopMaxAttempts {
		t.Fatalf("spawned %d times, budget is %d", spawned, linuxDesktopMaxAttempts)
	}
	// Nothing respawns on its own afterwards, however long the session lives.
	for i := 0; i < 300; i++ {
		r.clock.advance(time.Second)
		r.tick()
	}
	if n := r.sp.startCount(); n != spawned {
		t.Fatalf("a never-connecting helper kept being respawned: %d then %d", spawned, n)
	}
}

// Stop racing a spawn still in its pre-spawn checks must not leave the
// per-uid endpoint open, nor a ticket or unit behind.
func TestLinuxDesktopManager_StopDuringSpawnClosesEndpoint(t *testing.T) {
	r := newLDRig(t)
	gate, entered := make(chan struct{}), make(chan struct{})
	r.m.waylandDisplay = func(context.Context, string, uint32) (string, error) {
		close(entered)
		<-gate
		return "wayland-0", nil
	}
	done := make(chan error, 1)
	go func() { done <- r.m.Ensure(context.Background(), ldSession) }()
	<-entered
	r.m.Stop(context.Background(), ldSession, "logout")
	close(gate)
	err := <-done
	if err == nil {
		t.Fatal("a spawn cancelled by Stop reported success")
	}
	if errors.Is(err, ErrLinuxDesktopSessionNotEligible) {
		t.Fatalf("cancelled spawn reported as not eligible: %v", err)
	}
	r.ops.mu.Lock()
	ensured, closed := len(r.ops.ensured), len(r.ops.closed)
	r.ops.mu.Unlock()
	if ensured > 0 && closed < 2 {
		t.Fatalf("endpoint opened %d time(s) by the cancelled spawn but closed only %d time(s)", ensured, closed)
	}
	r.ops.tickets.mu.Lock()
	live := len(r.ops.tickets.byNonce)
	r.ops.tickets.mu.Unlock()
	if live != 0 {
		t.Fatalf("%d ticket(s) left redeemable", live)
	}
	if r.sp.startCount() > 0 && r.sp.stopCount() == 0 {
		t.Fatal("unit started by the cancelled spawn was not stopped")
	}
}

// A session that closed before the authenticated callback bound it is a
// crash, never a live binding.
func TestLinuxDesktopManager_SessionClosedBeforeBindIsACrash(t *testing.T) {
	r := newLDRig(t)
	if err := r.m.Ensure(context.Background(), ldSession); err != nil {
		t.Fatal(err)
	}
	spec := r.sp.lastStart()
	b := spec.Binding
	a, _ := net.Pipe()
	t.Cleanup(func() { _ = a.Close() })
	s := NewSession(ipc.NewConn(a), b.UID, "1000", b.Username, "", "closed-early", []string{"desktop"})
	s.LinuxDesktop = &b
	s.PID = 4321
	_ = s.closeTransport()
	r.ops.onClosed(s) // close fires first: the session was not bound yet
	r.ops.onAuth(s)
	if got := r.m.BoundSession(ldSession); got != nil {
		t.Fatal("a closed session was bound as the live helper")
	}
	r.clock.advance(time.Second)
	r.tick()
	if r.sp.startCount() != 2 {
		t.Fatalf("starts = %d, want a respawn for the still-pending start", r.sp.startCount())
	}
}

// systemd-run can fail after the helper already connected; root keeps the
// connected helper rather than losing track of it.
func TestLinuxDesktopManager_LateStartErrorKeepsConnectedHelper(t *testing.T) {
	r := newLDRig(t)
	var s *Session
	r.sp.onStart = func(LinuxDesktopSpawnSpec) { s = r.connect(t) }
	r.sp.startErr = errors.New("systemd-run: signal: killed (context deadline exceeded)")
	r.sp.errUnit = "breeze-desktop-helper-3-g1-0000000a.service"
	_ = r.m.Ensure(context.Background(), ldSession)
	if got := r.m.BoundSession(ldSession); got != s || s == nil {
		t.Fatalf("connected helper lost after a late Start error: bound %v", got)
	}
	r.m.Stop(context.Background(), ldSession, "operator")
	if stops := r.sp.stopsList(); len(stops) != 1 || !strings.HasSuffix(stops[0], r.sp.errUnit) {
		t.Fatalf("stops %v, want the reported unit stopped with the helper", stops)
	}
}

// A unit that may exist although systemd-run failed is stopped.
func TestLinuxDesktopManager_StartErrorStopsReportedUnit(t *testing.T) {
	r := newLDRig(t)
	r.sp.startErr = errors.New("systemd-run failed")
	r.sp.errUnit = "breeze-desktop-helper-3-g1-0000000b.service"
	if err := r.m.Ensure(context.Background(), ldSession); err == nil {
		t.Fatal("Ensure succeeded")
	}
	if stops := r.sp.stopsList(); len(stops) != 1 || !strings.HasSuffix(stops[0], r.sp.errUnit) {
		t.Fatalf("stops %v, want the reported unit", stops)
	}
}

func TestLinuxDesktopManager_ShutdownThenCloseDoesNotRespawn(t *testing.T) {
	r := newLDRig(t)
	if err := r.m.Ensure(context.Background(), ldSession); err != nil {
		t.Fatal(err)
	}
	s := r.connect(t)
	r.m.NoteDesktopStarted(ldSession)
	r.m.Shutdown()
	if !s.IsClosed() {
		t.Fatal("Shutdown left the helper session open")
	}
	r.ops.onClosed(s)
	for i := 0; i < 10; i++ {
		r.clock.advance(time.Second)
		r.tick()
	}
	if r.sp.startCount() != 1 {
		t.Fatalf("respawned after shutdown: starts %d", r.sp.startCount())
	}
	if !errors.Is(r.m.Ensure(context.Background(), ldSession), ErrLinuxDesktopManagerClosed) {
		t.Fatal("Ensure after Shutdown not refused")
	}
	r.m.Shutdown() // idempotent
}

// The startup sweep never stops the unit of a spawn in flight.
func TestLinuxDesktopManager_SweepSkipsInFlightSpawn(t *testing.T) {
	r := newLDRig(t)
	r.sp.started = make(chan struct{}, 1)
	r.sp.gate = make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- r.m.Ensure(context.Background(), ldSession) }()
	<-r.sp.started
	r.ops.mu.Lock()
	gen := r.ops.issued[len(r.ops.issued)-1].Generation
	r.ops.mu.Unlock()
	current := linuxDesktopUnitName(ldSession, gen, [4]byte{1, 2, 3, 4})
	stale := linuxDesktopUnitName(ldSession, gen-1, [4]byte{5, 6, 7, 8})
	r.sp.mu.Lock()
	r.sp.units = map[string][]string{"alice": {current, stale}}
	r.sp.mu.Unlock()
	r.m.sweepOrphans(context.Background())
	close(r.sp.gate)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	stops := r.sp.stopsList()
	if len(stops) != 1 || !strings.HasSuffix(stops[0], stale) {
		t.Fatalf("stops %v, want only the stale unit", stops)
	}
}

// A helper whose process uid does not match its binding is not bound.
func TestLinuxDesktopManager_PeerUIDMismatchNotBound(t *testing.T) {
	r := newLDRig(t)
	r.m.peerIdentity = func(int) (uint64, uint32, bool) { return 42, 1001, true }
	if err := r.m.Ensure(context.Background(), ldSession); err != nil {
		t.Fatal(err)
	}
	s := r.connect(t)
	if r.m.BoundSession(ldSession) != nil || !s.IsClosed() {
		t.Fatal("a helper whose process uid differs from its binding was bound")
	}
}

func TestLinuxDesktopManager_UnknownRunningBuildIsNotUpdatePending(t *testing.T) {
	r := newLDRig(t)
	r.ops.buildHash = ""
	err := r.m.Ensure(context.Background(), ldSession)
	if err == nil || errors.Is(err, ErrLinuxDesktopAgentUpdatePending) {
		t.Fatalf("err = %v, want a distinct running-build error", err)
	}
}

func TestSystemdVersionProbe(t *testing.T) {
	calls := 0
	out, outErr := "", errors.New("fork: resource temporarily unavailable")
	p := &systemdVersionProbe{run: func(context.Context) (string, error) { calls++; return out, outErr }}
	if err := p.check(context.Background()); err == nil || errors.Is(err, ErrLinuxDesktopSpawnUnsupported) {
		t.Fatalf("transient failure = %v; want a non-sticky, non-unsupported error", err)
	}
	out, outErr = "systemd 255 (255.4)", nil
	if err := p.check(context.Background()); err != nil {
		t.Fatalf("after recovery: %v", err)
	}
	if err := p.check(context.Background()); err != nil || calls != 2 {
		t.Fatalf("definitive answer not cached: %v calls=%d", err, calls)
	}
	old := &systemdVersionProbe{run: func(context.Context) (string, error) { return "systemd 245 (245.4)", nil }}
	if err := old.check(context.Background()); !errors.Is(err, ErrLinuxDesktopSpawnUnsupported) {
		t.Fatalf("systemd 245: %v", err)
	}
	missing := &systemdVersionProbe{run: func(context.Context) (string, error) { return "", errSystemdRunMissing }}
	if err := missing.check(context.Background()); !errors.Is(err, ErrLinuxDesktopSpawnUnsupported) {
		t.Fatalf("missing binary: %v", err)
	}
}

func TestParseLinuxDesktopUnitName(t *testing.T) {
	id, gen, ok := parseLinuxDesktopUnitName("breeze-desktop-helper-c12-g42-deadbeef.service")
	if !ok || id != "c12" || gen != 42 {
		t.Fatalf("parsed %q %d %v", id, gen, ok)
	}
	if _, _, ok := parseLinuxDesktopUnitName("other.service"); ok {
		t.Fatal("parsed a foreign unit")
	}
}
