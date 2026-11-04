//go:build darwin

package isolation

import (
	"context"
	"net"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// The real Manager protocol over the real pf isolator and fakePF: activated
// through the test seam, with a positive probe that passes and a negative probe
// that the fake kernel counts as a drop on our rule.
func fakeDarwinManager(t *testing.T, f *fakePF) (*Manager, *fakeClock) {
	t.Helper()
	i := newTestDarwinIsolator(t, f)
	i.activated = true
	i.pfctlPresent = func() error { return nil }
	i.configureReadiness(func(context.Context) (string, error) { return "", nil }, func() (bool, string) { return true, "" })
	clock := newFakeClock()
	sched := newFakeScheduler(&callLog{})
	m := NewManager(ManagerDeps{
		DataDir: t.TempDir(), Isolator: i, Scheduler: sched, Clock: clock,
		Resolver: NewResolver(func(context.Context, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("198.51.100.7")}, nil
		}),
		Dialer:          darwinProbeDialer{f: f},
		VerifyRoundTrip: func(context.Context, string) (time.Time, error) { return clock.Now(), nil },
	})
	m.negativeTimeout = 40 * time.Millisecond
	return m, clock
}

type darwinProbeDialer struct{ f *fakePF }

func (d darwinProbeDialer) DialContext(ctx context.Context, network, _ string) (net.Conn, error) {
	if d.f.enabled && strings.Contains(d.f.anchorRules, pfDropLabel) {
		d.f.dropPackets++
	}
	<-ctx.Done()
	return nil, &net.OpError{Op: "dial", Net: network, Err: ctx.Err()}
}

func testDarwinIsolate(clock *fakeClock) Spec {
	return Spec{
		IsolationID: idA, Generation: 1, ExpiresAt: clock.Now().Add(72 * time.Hour),
		BreakGlassSecret: make([]byte, breakGlassSecretBytes),
		Allow:            []AllowEntry{{Kind: KindHost, Host: "control.example.test", Proto: ProtoTCP, Ports: []uint16{443}, Scope: ScopeBreeze}},
	}
}

func TestDarwinManagerIsolatesAndReleasesEndToEnd(t *testing.T) {
	f := newFakePF(t)
	m, clock := fakeDarwinManager(t, f)
	if out := m.isolate(context.Background(), testDarwinIsolate(clock)); out.Failed() || out.Result.State != StateVerified || out.Result.Mechanism != "pf" {
		t.Fatalf("isolate: %+v %+v", out, out.Result)
	}
	if out := m.HandleRelease(context.Background(), map[string]any{"isolationId": idA, "generation": float64(1)}); out.Failed() {
		t.Fatalf("release: %+v", out)
	}
	if f.anchorRules != "" || len(f.tokens) != 0 || f.count("-f -") != 1 {
		t.Fatalf("after release: rules %q tokens %v main loads %d", f.anchorRules, f.tokens, f.count("-f -"))
	}
}

// Spec §7 macOS row: Internet Sharing on, the apply refuses and nothing is
// destroyed. The console sees mechanism_unavailable with the reason.
func TestDarwinManagerInternetSharingRefusesAsMechanismUnavailable(t *testing.T) {
	f := newFakePF(t)
	f.useLive(pfFixtureLive(t, "internet-sharing.txt"))
	rules, anchors := strings.Join(f.rules, "\n"), strings.Join(f.anchors, "\n")
	m, clock := fakeDarwinManager(t, f)
	out := m.isolate(context.Background(), testDarwinIsolate(clock))
	if out.Result == nil || out.Result.FailureCode != FailMechanismUnavailable || out.Result.Rollback {
		t.Fatalf("outcome %+v (result %+v)", out, out.Result)
	}
	if !strings.Contains(out.Error, pfInternetSharingAnchor) {
		t.Fatalf("the reason must reach the console: %q", out.Error)
	}
	if strings.Join(f.rules, "\n") != rules || strings.Join(f.anchors, "\n") != anchors {
		t.Fatal("refused, but the ruleset changed")
	}
	for _, call := range f.calls {
		for _, write := range []string{"-f -", "-F", "-E", "-X", "-k"} {
			if strings.Contains(call, write) {
				t.Errorf("refused, but ran %q", call)
			}
		}
	}
}

// Spec §7 macOS row: an admin reloads the main ruleset, which silently detaches
// our anchor. Re-verify detects it and re-attaches through the fenced refresh.
func TestDarwinManagerDetachedHookIsReattachedAsDrift(t *testing.T) {
	f := newFakePF(t)
	m, clock := fakeDarwinManager(t, f)
	if out := m.isolate(context.Background(), testDarwinIsolate(clock)); out.Failed() {
		t.Fatalf("isolate: %+v", out)
	}
	f.rules = []string{`scrub-anchor "com.apple/*" all fragment reassemble`, `anchor "com.apple/*" all`}
	m.OnNetworkChange(context.Background())
	if present, _ := ParentHookPresent(f); !present {
		t.Fatalf("hook not re-attached:\n%v", f.calls)
	}
	if got := f.count("-f -"); got != 2 {
		t.Fatalf("want exactly one re-attach load, got %d loads in total", got)
	}
	if !journalHasEvent(t, m, "drift_reapplied") {
		t.Fatal("the re-attach must be journalled as drift")
	}
}

// The same reload, but with Internet Sharing now running: re-attaching would
// destroy its anchor, so the agent must not, and must say why.
func TestDarwinManagerDetachedHookOnIncompatibleRulesetIsReportedNotForced(t *testing.T) {
	f := newFakePF(t)
	m, clock := fakeDarwinManager(t, f)
	if out := m.isolate(context.Background(), testDarwinIsolate(clock)); out.Failed() {
		t.Fatalf("isolate: %+v", out)
	}
	f.useLive(pfFixtureLive(t, "internet-sharing.txt"))
	loads := f.count("-f -")
	m.OnNetworkChange(context.Background())
	if got := f.count("-f -"); got != loads {
		t.Fatal("re-attached over Internet Sharing")
	}
	if !journalHasEvent(t, m, "refresh_reverted") {
		t.Fatal("the failed re-attach must be journalled")
	}
	if report := m.Report(); report == nil || !strings.Contains(report.LastError, pfInternetSharingAnchor) {
		t.Fatalf("drift must reach the server with its reason: %+v", report)
	}
}

func TestDarwinManagerAdminDisablingPfIsReapplied(t *testing.T) {
	f := newFakePF(t)
	m, clock := fakeDarwinManager(t, f)
	if out := m.isolate(context.Background(), testDarwinIsolate(clock)); out.Failed() {
		t.Fatalf("isolate: %+v", out)
	}
	for token := range f.tokens {
		delete(f.tokens, token)
	}
	f.enabled = false
	m.OnNetworkChange(context.Background())
	if !f.enabled || len(f.tokens) != 1 {
		t.Fatalf("enabled %v tokens %v", f.enabled, f.tokens)
	}
}

func journalHasEvent(t *testing.T, m *Manager, typ string) bool {
	t.Helper()
	j, err := journal.Load(m.path())
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range j.Events {
		if e.Type == typ {
			return true
		}
	}
	return false
}
