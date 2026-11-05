//go:build linux

package isolation

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/cgroup"
)

// The tripwire: flipping the switch must visibly update this test. Activation
// is a Todd gate, after the L2 lab leg.
func TestLinuxShippedActivationSwitchRemainsOff(t *testing.T) {
	if linuxIsolationActivated {
		t.Fatal("activation PR must visibly update this fail-closed test")
	}
	i := newLinuxIsolator()
	probed := false
	i.setupCgroup = func() (cgroup.Layout, error) { probed = true; return cgroup.Layout{}, nil }
	i.lookPath = func(string) (string, error) { probed = true; return "/usr/sbin/nft", nil }
	i.configureReadiness(func(context.Context) (string, error) { probed = true; return "r", nil }, func() (bool, string) { probed = true; return true, "" })
	i.RefreshReadiness(context.Background())
	i.refreshCachedReadiness(context.Background())
	if probed {
		t.Fatal("a not-activated agent must not touch cgroups, nft or systemd: every shipped Linux host runs this")
	}
	got := i.Capability()
	if got != (Capability{Mechanism: "nft", UnsupportedReason: "not_activated"}) {
		t.Fatalf("shipped capability = %+v", got)
	}
	if got.Version != 0 || got.Ready {
		t.Fatalf("shipped capability must be {Version:0, Ready:false}: %+v", got)
	}
}

// Even with every prerequisite passing, the shipped switch reports capability 0.
func TestLinuxShippedSwitchMasksAllFiveInputsPassing(t *testing.T) {
	i := activatedLinuxIsolator(t, linuxReadinessFixture{})
	i.activated = linuxIsolationActivated // the value this build ships
	i.RefreshReadiness(context.Background())
	got := i.Capability()
	if got.Version != 0 || got.Ready || got.UnsupportedReason != "not_activated" {
		t.Fatalf("capability = %+v, want {Version:0, Ready:false, UnsupportedReason:not_activated}", got)
	}
}

type linuxReadinessFixture struct {
	nftMissing bool
	cgroupErr  error
	// noSocketCgroupv2 is a kernel older than 5.13: nft's dry run refuses
	// `socket cgroupv2`.
	noSocketCgroupv2 bool
	recovery         error
	schedOK          *bool
	probes           *[]string
}

func activatedLinuxIsolator(t *testing.T, fx linuxReadinessFixture) *linuxIsolator {
	t.Helper()
	i := newLinuxIsolator()
	i.activated = true // test seam: the shipped value is pinned by the tripwire above
	i.lookPath = func(name string) (string, error) {
		if fx.nftMissing && name == "nft" {
			return "", errors.New("not found")
		}
		return "/usr/sbin/" + name, nil
	}
	i.setupCgroup = func() (cgroup.Layout, error) {
		if fx.cgroupErr != nil {
			return cgroup.Layout{}, fx.cgroupErr
		}
		return cgroup.Layout{AgentPath: "system.slice/breeze-agent.service/agent", ChildrenPath: "system.slice/breeze-agent.service/children", Level: 3, ChildrenFD: 9}, nil
	}
	i.nft = func(_ context.Context, stdin []byte, args ...string) ([]byte, error) {
		if fx.probes != nil {
			*fx.probes = append(*fx.probes, strings.Join(args, " ")+"\n"+string(stdin))
		}
		if len(args) > 0 && args[0] == "-c" && fx.noSocketCgroupv2 {
			return nil, errors.New("Error: Could not process rule: Operation not supported")
		}
		if len(args) > 0 && args[0] != "-c" {
			t.Errorf("readiness ran a non-dry-run nft command: %v", args)
		}
		return nil, nil
	}
	ok := true
	if fx.schedOK != nil {
		ok = *fx.schedOK
	}
	i.configureReadiness(func(context.Context) (string, error) { return "/r", fx.recovery }, func() (bool, string) { return ok, "details" })
	return i
}

func TestLinuxCapabilityNamesEachFailedInput(t *testing.T) {
	no := false
	failure := errors.New("failed")
	for _, tc := range []struct {
		name string
		fx   linuxReadinessFixture
		want string
	}{
		{"nft missing", linuxReadinessFixture{nftMissing: true}, "nft_missing"},
		{"cgroup v1", linuxReadinessFixture{cgroupErr: &cgroup.Error{Reason: cgroup.ReasonV1, Detail: "x"}}, "cgroup_v1"},
		{"no delegate", linuxReadinessFixture{cgroupErr: &cgroup.Error{Reason: cgroup.ReasonNotDelegated, Detail: "x"}}, "cgroup_not_delegated"},
		{"cgroup other", linuxReadinessFixture{cgroupErr: &cgroup.Error{Reason: cgroup.ReasonUnavailable, Detail: "x"}}, "cgroup_unavailable"},
		{"cgroup untyped", linuxReadinessFixture{cgroupErr: failure}, "cgroup_unavailable"},
		{"placement refused", linuxReadinessFixture{cgroupErr: &cgroup.Error{Reason: cgroup.ReasonSpawnUnavailable, Detail: "x"}}, "cgroup_spawn_unavailable"},
		{"kernel without socket cgroupv2", linuxReadinessFixture{noSocketCgroupv2: true}, "nft_cgroupv2_unsupported"},
		{"recovery missing", linuxReadinessFixture{recovery: failure}, "recovery_unavailable"},
		{"scheduler not ready", linuxReadinessFixture{schedOK: &no}, "scheduler_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			i := activatedLinuxIsolator(t, tc.fx)
			i.RefreshReadiness(context.Background())
			got := i.Capability()
			if got.Version != 0 || got.Ready || got.UnsupportedReason != tc.want || got.Mechanism != "nft" {
				t.Fatalf("capability = %+v, want reason %s", got, tc.want)
			}
		})
	}
}

func TestLinuxCapabilityIsOneOnlyWhenAllPass(t *testing.T) {
	i := activatedLinuxIsolator(t, linuxReadinessFixture{})
	if got := i.Capability(); got.Ready || got.Version != 0 {
		t.Fatalf("before the first probe: %+v", got)
	}
	i.RefreshReadiness(context.Background())
	got := i.Capability()
	if got != (Capability{Version: 1, Mechanism: "nft", Ready: true}) {
		t.Fatalf("capability = %+v", got)
	}
}

func TestLinuxCapabilityOrderIsNftThenCgroupThenRecoveryThenScheduler(t *testing.T) {
	no := false
	failure := errors.New("failed")
	i := activatedLinuxIsolator(t, linuxReadinessFixture{
		nftMissing: true,
		cgroupErr:  &cgroup.Error{Reason: cgroup.ReasonV1, Detail: "x"},
		recovery:   failure,
		schedOK:    &no,
	})
	i.RefreshReadiness(context.Background())
	if got := i.Capability().UnsupportedReason; got != "nft_missing" {
		t.Fatalf("reason = %q", got)
	}
}

// The split runs once: another children fd per refresh would leak, and Apply's
// layout is the one the split produced.
func TestLinuxReadinessSplitsOnce(t *testing.T) {
	i := activatedLinuxIsolator(t, linuxReadinessFixture{})
	splits := 0
	i.setupCgroup = func() (cgroup.Layout, error) {
		splits++
		return cgroup.Layout{AgentPath: "a/agent", ChildrenPath: "a/children", Level: 2, ChildrenFD: 9}, nil
	}
	i.RefreshReadiness(context.Background())
	i.RefreshReadiness(context.Background())
	if splits != 1 {
		t.Fatalf("splits = %d", splits)
	}
	layout, err := i.layout()
	if err != nil || layout.AgentPath != "a/agent" {
		t.Fatalf("layout = %+v, %v", layout, err)
	}
}

// A refused split is retried by the next refresh: readiness can recover once
// the unit gains Delegate=yes and the agent restarts into it.
func TestLinuxReadinessRetriesARefusedSplit(t *testing.T) {
	i := activatedLinuxIsolator(t, linuxReadinessFixture{})
	calls := 0
	i.setupCgroup = func() (cgroup.Layout, error) {
		calls++
		if calls == 1 {
			return cgroup.Layout{}, &cgroup.Error{Reason: cgroup.ReasonNotDelegated, Detail: "x"}
		}
		return cgroup.Layout{AgentPath: "a/agent", Level: 2}, nil
	}
	i.RefreshReadiness(context.Background())
	if got := i.Capability(); got.Ready || got.UnsupportedReason != "cgroup_not_delegated" {
		t.Fatalf("capability = %+v", got)
	}
	i.RefreshReadiness(context.Background())
	if got := i.Capability(); !got.Ready {
		t.Fatalf("capability = %+v", got)
	}
}

func TestLinuxLayoutUnavailableUntilTheSplitSucceeds(t *testing.T) {
	i := activatedLinuxIsolator(t, linuxReadinessFixture{cgroupErr: &cgroup.Error{Reason: cgroup.ReasonNotDelegated, Detail: "x"}})
	if _, err := i.layout(); err == nil {
		t.Fatal("layout before any probe")
	}
	i.RefreshReadiness(context.Background())
	if _, err := i.layout(); err == nil {
		t.Fatal("layout after a refused split")
	}
}

func TestLinuxReadinessIsCachedAndExpires(t *testing.T) {
	i := activatedLinuxIsolator(t, linuxReadinessFixture{})
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	i.readiness.now = func() time.Time { return now }
	calls := 0
	i.configureReadiness(func(context.Context) (string, error) { calls++; return "/r", nil }, func() (bool, string) { return true, "" })
	i.RefreshReadiness(context.Background())
	_ = i.Capability()
	_ = i.Capability()
	if calls != 1 {
		t.Fatalf("a heartbeat must not re-probe: %d calls", calls)
	}
	i.refreshCachedReadiness(context.Background())
	if calls != 1 {
		t.Fatalf("a fresh result must not be re-probed: %d calls", calls)
	}
	now = now.Add(readinessRefreshAge)
	i.refreshCachedReadiness(context.Background())
	if calls != 2 {
		t.Fatalf("a stale result must be re-probed: %d calls", calls)
	}
	now = now.Add(readinessMaxAge)
	if got := i.Capability(); got.Ready {
		t.Fatalf("an expired result must not advertise readiness: %+v", got)
	}
}

// ConfigureRecoveryReadiness is what the heartbeat calls at startup.
func TestLinuxConfigureRecoveryReadinessFailsClosedOnAShippedAgent(t *testing.T) {
	i := activatedLinuxIsolator(t, linuxReadinessFixture{})
	sched := unsupportedScheduler{}
	ConfigureRecoveryReadiness(context.Background(), i, sched, "1.2.3")
	got := i.Capability()
	if got.Ready || got.UnsupportedReason != "recovery_unavailable" {
		t.Fatalf("no recovery distribution yet, so readiness must fail closed: %+v", got)
	}
}

// A 5.7-5.12 kernel passes the cgroup split and clone3 placement, but nft
// cannot load `socket cgroupv2` (5.13). Readiness must say so instead of
// advertising Ready and failing every apply.
func TestLinuxReadinessDryRunsTheCgroupPermit(t *testing.T) {
	var probes []string
	i := activatedLinuxIsolator(t, linuxReadinessFixture{probes: &probes})
	i.RefreshReadiness(context.Background())
	if len(probes) != 1 || !strings.HasPrefix(probes[0], "-c -f -\n") {
		t.Fatalf("probes = %q", probes)
	}
	if !strings.Contains(probes[0], `socket cgroupv2 level 3 "system.slice/breeze-agent.service/agent"`) {
		t.Fatalf("the probe must use the real agent cgroup: %q", probes[0])
	}
	if strings.Contains(probes[0], "table inet breeze_isolation ") || strings.Contains(probes[0], "policy drop") {
		t.Fatalf("the probe must not name our table or drop anything: %q", probes[0])
	}
	if got := i.Capability(); !got.Ready {
		t.Fatalf("capability = %+v", got)
	}
}

func TestLinuxReadinessCancelledIsNotNftMissing(t *testing.T) {
	i := activatedLinuxIsolator(t, linuxReadinessFixture{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	i.RefreshReadiness(ctx)
	if got := i.Capability(); got.Ready || got.UnsupportedReason != "readiness_cancelled" {
		t.Fatalf("capability = %+v", got)
	}
}

// Any engine error, typed or not, means not ready.
func TestLinuxCapabilityRefusesAnUntypedEngineError(t *testing.T) {
	i := activatedLinuxIsolator(t, linuxReadinessFixture{})
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	i.readiness.now = func() time.Time { return now }
	i.readiness.checkedAt = now
	i.readiness.in.engineErr = errors.New("some other failure")
	i.readiness.in.schedulerReady = true
	if got := i.Capability(); got.Ready || got.Version != 0 || got.UnsupportedReason == "" {
		t.Fatalf("capability = %+v", got)
	}
}
