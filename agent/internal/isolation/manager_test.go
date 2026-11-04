package isolation

import (
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/wire"
)

// from returns the calls starting at the first one with the given prefix.
func from(calls []string, prefix string) []string {
	for i, c := range calls {
		if strings.HasPrefix(c, prefix) {
			return calls[i:]
		}
	}
	return nil
}

func TestManagerApplyOrder(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)

	got := from(h.log.all(), "journal:provisional")
	want := []string{
		"journal:provisional",     // 4. journal provisional{attempt, deadline, expiresAt, secret}, fsync
		"sched:ArmProvisional",    // 5. arm the one-shot rollback (read back inside)
		"sched:ArmExpiry 1",       //    then the expiry task
		"sched:EnsurePoll",        //    and the poll
		"iso:Apply " + idA,        // 7. apply (after the deadline re-check)
		"iso:Mark",                //    negative probe: mark,
		"dial 192.0.2.10:80",      //    SYN to a non-permitted port,
		"iso:DropObserved",        //    attribution
		"verify " + idA,           //    positive probe: fresh round trip
		"iso:Verify",              // 8. retake the lock: attempt, deadline, digest
		"journal:committed",       // 9. journal committed, fsync,
		"sched:DisarmProvisional", //    disarm,
	}
	if len(got) < len(want) {
		t.Fatalf("calls %v", h.log.all())
	}
	for i := range want {
		if !strings.HasPrefix(got[i], want[i]) {
			t.Fatalf("call %d = %q, want %q\nall from provisional: %v", i, got[i], want[i], got)
		}
	}
	// Preflight ran before anything was journalled or armed.
	before := h.log.all()[:len(h.log.all())-len(got)]
	for _, needed := range []string{"iso:Capability", "sched:Ready"} {
		if !containsStr(before, needed) {
			t.Fatalf("preflight %q missing before the provisional journal: %v", needed, before)
		}
	}
	j := h.journal()
	if j.Phase != journal.PhaseCommitted || j.Episode.State != StateVerified || j.AttemptID != "" {
		t.Fatalf("journal %+v", j)
	}
	if string(j.Episode.BreakGlassSecret) != string(h.secret) {
		t.Fatal("secret not journalled")
	}
	if h.sched.armedProvisional() != 0 {
		t.Fatal("provisional rollback still armed after commit")
	}
}

func TestManagerResultBody(t *testing.T) {
	h := newHarness(t)
	out := h.isolate(idA, 1)
	if out.Status != "completed" || out.ErrorCode != "" || out.Result == nil {
		t.Fatalf("outcome %+v", out)
	}
	r := out.Result
	if r.IsolationID != idA || r.Generation != 1 || r.State != StateVerified || r.Mechanism != "wfp" || r.Rollback || r.JournalSeq <= 0 || r.AppliedAt == nil || r.VerifiedAt == nil {
		t.Fatalf("result body %+v", r)
	}
	if r.JournalSeq != h.journal().LastSeq() {
		t.Fatalf("result journalSeq %d, journal last %d", r.JournalSeq, h.journal().LastSeq())
	}
}

func TestManagerCapabilityZeroTouchesNothing(t *testing.T) {
	h := newHarness(t)
	h.iso.set(func(f *fakeIsolator) { f.cap = Capability{Version: 0, UnsupportedReason: "not here"} })
	out := h.isolate(idA, 1)
	if out.ErrorCode != wire.ErrCodeIsolationUnsupportedPlatform || out.Result == nil || out.Result.FailureCode != FailUnsupportedPlatform {
		t.Fatalf("outcome %+v", out)
	}
	if calls := h.log.all(); !reflect.DeepEqual(calls, []string{"iso:Capability"}) {
		t.Fatalf("touched more than the capability: %v", calls)
	}
	entries, _ := os.ReadDir(h.dir)
	if len(entries) != 0 {
		t.Fatalf("data dir not empty: %v", entries)
	}
}

func TestManagerPreflightRefusals(t *testing.T) {
	cases := []struct {
		name  string
		setup func(h *harness)
		code  wire.CommandErrorCode
	}{
		{"capability not ready", func(h *harness) {
			h.iso.set(func(f *fakeIsolator) { f.cap.Ready = false })
		}, wire.ErrCodeIsolationMechanismUnavailable},
		{"recovery not ready", func(h *harness) {
			h.sched.set(func(s *fakeScheduler) { s.ready, s.readyReason = false, "self-test failed" })
		}, wire.ErrCodeIsolationMechanismUnavailable},
		{"host does not resolve", func(h *harness) {
			h.lookup.setFail(relayHost, true)
		}, wire.ErrCodeIsolationMechanismUnavailable},
		{"proxy does not resolve", func(h *harness) {
			h.proxy = &url.URL{Scheme: "http", Host: "unknown-proxy.example.test:3128"}
		}, wire.ErrCodeIsolationMechanismUnavailable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			tc.setup(h)
			out := h.isolate(idA, 1)
			if out.ErrorCode != tc.code {
				t.Fatalf("code %q, want %q (%s)", out.ErrorCode, tc.code, out.Error)
			}
			if h.iso.applies != 0 || h.log.count("sched:Arm") != 0 || h.log.count("journal:provisional") != 0 {
				t.Fatalf("preflight refusal still armed/journalled/applied: %v", h.log.all())
			}
			if h.m.Active() {
				t.Fatal("Active after a preflight refusal")
			}
		})
	}
}

func TestManagerArmingFailureNeverApplies(t *testing.T) {
	for _, which := range []string{"provisional", "expiry"} {
		t.Run(which, func(t *testing.T) {
			h := newHarness(t)
			h.sched.set(func(s *fakeScheduler) {
				if which == "provisional" {
					s.armProvisionalErr = errors.New("task scheduler refused")
				} else {
					s.armExpiryErr = errors.New("task scheduler refused")
				}
			})
			out := h.isolate(idA, 1)
			if out.ErrorCode != wire.ErrCodeIsolationMechanismUnavailable {
				t.Fatalf("code %q (%s)", out.ErrorCode, out.Error)
			}
			if h.iso.applies != 0 {
				t.Fatal("Apply ran although arming failed")
			}
			j := h.journal()
			if j.Phase != journal.PhaseRolledBack || j.Episode.State != StateFailed || j.Episode.FailureCode != FailMechanismUnavailable {
				t.Fatalf("journal %s %+v", j.Phase, j.Episode)
			}
		})
	}
}

func TestManagerApplyAndProbeFailuresRollBack(t *testing.T) {
	cases := []struct {
		name  string
		setup func(h *harness)
		code  string
	}{
		{"apply error", func(h *harness) { h.iso.set(func(f *fakeIsolator) { f.applyErr = errors.New("BFE refused") }) }, FailApplyError},
		{"positive probe", func(h *harness) { h.verify.set(func(v *fakeVerify) { v.err = errors.New("connection timed out") }) }, FailControlPlaneUnreachable},
		{"negative probe connects", func(h *harness) { h.dialer.setMode(dialConnect) }, FailEnforcementNotObserved},
		{"negative probe unattributed", func(h *harness) { h.dialer.setMode(dialDropUnattributed) }, FailEnforcementNotObserved},
		{"rules changed before commit", func(h *harness) { h.iso.set(func(f *fakeIsolator) { f.tamperDigest = "someone-else" }) }, FailApplyError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			tc.setup(h)
			out := h.isolate(idA, 1)
			if !out.Failed() || out.ErrorCode != failureErrorCode(tc.code) || out.Result == nil || out.Result.FailureCode != tc.code || out.Result.State != StateFailed {
				t.Fatalf("outcome %+v result %+v", out, out.Result)
			}
			if tc.code != FailApplyError || tc.name != "apply error" {
				if !out.Result.Rollback {
					t.Fatal("rollback flag not set")
				}
			}
			if installed, _, _ := h.iso.state(); installed {
				t.Fatal("rules left installed")
			}
			j := h.journal()
			if j.Phase != journal.PhaseRolledBack {
				t.Fatalf("phase %s", j.Phase)
			}
			if !containsStr(eventTypes(j), "failed_"+tc.code) {
				t.Fatalf("no failed_%s event: %v", tc.code, eventTypes(j))
			}
			if h.log.count("sched:RemoveAll") == 0 {
				t.Fatal("recovery tasks not removed after a confirmed rollback")
			}
		})
	}
}

func TestManagerCleanupFailureStaysUnresolved(t *testing.T) {
	h := newHarness(t)
	h.verify.set(func(v *fakeVerify) { v.err = errors.New("unreachable") })
	h.iso.set(func(f *fakeIsolator) { f.releaseErr = errors.New("engine busy") })
	out := h.isolate(idA, 1)
	if !out.Failed() {
		t.Fatal("cleanup failure reported success")
	}
	j := h.journal()
	if j.Phase != journal.PhaseReleasing || !h.m.Active() {
		t.Fatalf("phase %s active=%v", j.Phase, h.m.Active())
	}
	if h.sched.armedProvisional() != 1 || h.log.count("sched:RemoveAll") != 0 {
		t.Fatal("recovery was disarmed although cleanup failed")
	}
	if containsStr(eventTypes(j), "failed_"+FailControlPlaneUnreachable) {
		t.Fatal("reported failed before absence was confirmed")
	}
	// The engine recovers; the next tick finishes the rollback.
	h.iso.set(func(f *fakeIsolator) { f.releaseErr = nil })
	h.m.Tick(context.Background())
	j = h.journal()
	if j.Phase != journal.PhaseRolledBack || h.m.Active() {
		t.Fatalf("after tick: phase %s", j.Phase)
	}
}

func TestManagerStillOwnedAfterReleaseIsNotReleased(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	h.iso.set(func(f *fakeIsolator) { f.stickyOwned = true })
	out := h.m.HandleRelease(context.Background(), map[string]any{"isolationId": idA, "generation": float64(2), "reason": "done"})
	if !out.Failed() {
		t.Fatalf("release reported success while rules are still owned: %+v", out)
	}
	if j := h.journal(); j.Phase != journal.PhaseReleasing {
		t.Fatalf("phase %s", j.Phase)
	}
}

func TestManagerProxyPermit(t *testing.T) {
	h := newHarness(t)
	h.proxy = &url.URL{Scheme: "http", Host: proxyHost + ":3128"}
	h.mustIsolate(idA, 1)
	_, spec, _ := h.iso.state()
	var proxy, control *ResolvedEntry
	for i := range spec.Entries {
		e := &spec.Entries[i]
		if e.Proxy {
			proxy = e
		}
		if e.Host == controlHost {
			control = e
		}
	}
	if control == nil {
		t.Fatal("control-plane permit dropped when a proxy is configured")
	}
	if proxy == nil || proxy.Host != proxyHost || proxy.Scope != ScopeBreeze || proxy.Proto != ProtoTCP || !reflect.DeepEqual(proxy.Ports, []uint16{3128}) {
		t.Fatalf("proxy entry %+v", proxy)
	}
	if len(proxy.Addrs) != 1 || proxy.Addrs[0] != netip.MustParsePrefix("203.0.113.7/32") {
		t.Fatalf("proxy addrs %v", proxy.Addrs)
	}
}

func TestManagerProxyLiteralAndDefaultPort(t *testing.T) {
	h := newHarness(t)
	h.proxy = &url.URL{Scheme: "https", Host: "[2001:db8::99]"}
	h.mustIsolate(idA, 1)
	_, spec, _ := h.iso.state()
	for _, e := range spec.Entries {
		if e.Proxy {
			if e.Kind != KindCIDR || e.CIDR != "2001:db8::99/128" || !reflect.DeepEqual(e.Ports, []uint16{443}) {
				t.Fatalf("literal proxy entry %+v", e)
			}
			return
		}
	}
	t.Fatal("no proxy entry")
}

func TestManagerHighWaterFromServerTime(t *testing.T) {
	h := newHarness(t)
	h.verify.set(func(v *fakeVerify) { v.serverSkew = 2 * time.Hour })
	h.mustIsolate(idA, 1)
	j := h.journal()
	if !j.HighWaterWall.Equal(h.clock.Now().Add(2 * time.Hour)) {
		t.Fatalf("highWaterWall %v, want the server's time", j.HighWaterWall)
	}
}

func TestManagerHandleIsolateValidation(t *testing.T) {
	h := newHarness(t)
	mutate := map[string]func(p map[string]any){
		"no secret":    func(p map[string]any) { delete(p, "breakGlassSecret") },
		"short secret": func(p map[string]any) { p["breakGlassSecret"] = "c2hvcnQ=" },
		"bad uuid":     func(p map[string]any) { params(p)["isolationId"] = "nope" },
		"generation 0": func(p map[string]any) { params(p)["generation"] = float64(0) },
		"expired":      func(p map[string]any) { params(p)["expiresAt"] = h.clock.Now().Add(-time.Minute).Format(time.RFC3339) },
		"beyond 720h": func(p map[string]any) {
			params(p)["expiresAt"] = h.clock.Now().Add(721 * time.Hour).Format(time.RFC3339)
		},
		"empty allow":    func(p map[string]any) { params(p)["allow"] = []any{} },
		"dead man set":   func(p map[string]any) { params(p)["deadManSeconds"] = float64(1800) },
		"bad proto":      func(p map[string]any) { allow0(p)["proto"] = "icmp" },
		"no ports":       func(p map[string]any) { allow0(p)["ports"] = []any{} },
		"bad cidr":       func(p map[string]any) { allow0(p)["kind"] = "cidr"; allow0(p)["cidr"] = "0.0.0.0/0" },
		"wrong action":   func(p map[string]any) { p["actionType"] = "usb_block" },
		"no parameters":  func(p map[string]any) { delete(p, "parameters") },
		"bad scope":      func(p map[string]any) { allow0(p)["scope"] = "everyone" },
		"host with cidr": func(p map[string]any) { allow0(p)["cidr"] = "192.0.2.0/24" },
		"port 0":         func(p map[string]any) { allow0(p)["ports"] = []any{float64(0)} },
	}
	for name, fn := range mutate {
		t.Run(name, func(t *testing.T) {
			p := h.payload(idA, 1, 72*time.Hour)
			fn(p)
			out := h.m.HandleIsolate(context.Background(), p)
			if out.ErrorCode != wire.ErrCodeIsolationInvalidSpec {
				t.Fatalf("code %q (%s)", out.ErrorCode, out.Error)
			}
		})
	}
	if h.iso.applies != 0 {
		t.Fatal("an invalid spec was applied")
	}
}

func params(p map[string]any) map[string]any { return p["parameters"].(map[string]any) }
func allow0(p map[string]any) map[string]any {
	return params(p)["allow"].([]any)[0].(map[string]any)
}

func TestManagerIdempotentAndStale(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 2)
	h.mustIsolate(idA, 2) // retransmission
	if h.iso.applies != 1 {
		t.Fatalf("retransmission re-applied (%d applies)", h.iso.applies)
	}
	if out := h.isolate(idA, 1); out.ErrorCode != wire.ErrCodeIsolationStaleGeneration {
		t.Fatalf("older generation: %q", out.ErrorCode)
	}
}

func TestManagerExtend(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	out := h.m.HandleIsolate(context.Background(), h.payload(idA, 2, 200*time.Hour))
	if out.Failed() || out.Result.Generation != 2 {
		t.Fatalf("extend %+v", out)
	}
	if h.iso.applies != 1 {
		t.Fatal("extend re-applied the rules")
	}
	j := h.journal()
	if j.Episode.Generation != 2 || !j.Episode.ExpiresAt.Equal(h.clock.Now().Add(200*time.Hour)) {
		t.Fatalf("journal episode %+v", j.Episode)
	}
	if !containsStr(eventTypes(j), "extended") {
		t.Fatalf("events %v", eventTypes(j))
	}
	if h.log.count("sched:ArmExpiry 2") != 1 {
		t.Fatalf("expiry not re-armed for generation 2: %v", h.log.all())
	}
}

func TestManagerReleaseCommand(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	out := h.m.HandleRelease(context.Background(), map[string]any{"isolationId": idA, "generation": float64(2), "reason": "contained"})
	if out.Failed() || out.Result == nil || out.Result.State != StateReleased || out.Result.Generation != 2 {
		t.Fatalf("release %+v %+v", out, out.Result)
	}
	if installed, _, _ := h.iso.state(); installed || h.m.Active() {
		t.Fatal("rules still installed")
	}
	j := h.journal()
	if j.Phase != journal.PhaseReleased || j.PendingReport == nil || j.PendingReport.State != StateReleased || j.PendingReport.Generation != 2 {
		t.Fatalf("journal %s pending %+v", j.Phase, j.PendingReport)
	}
	if !containsStr(eventTypes(j), "released_console") {
		t.Fatalf("events %v", eventTypes(j))
	}
	if h.log.count("sched:RemoveAll") == 0 {
		t.Fatal("recovery tasks not removed")
	}
	// Mismatched episode.
	out = h.m.HandleRelease(context.Background(), map[string]any{"isolationId": idB, "generation": float64(2)})
	if out.ErrorCode != wire.ErrCodeIsolationEpisodeMismatch {
		t.Fatalf("mismatch: %q", out.ErrorCode)
	}
	out = h.m.HandleRelease(context.Background(), map[string]any{"isolationId": "nope", "generation": float64(2)})
	if out.ErrorCode != wire.ErrCodeIsolationInvalidSpec {
		t.Fatalf("bad id: %q", out.ErrorCode)
	}
}

func TestManagerReconcileGenerations(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 3)
	ctx := context.Background()

	h.m.Reconcile(ctx, h.desired(idA, 2, DesiredReleased, time.Hour, false))
	if !h.m.Active() {
		t.Fatal("an older released generation released the episode")
	}
	h.m.Reconcile(ctx, h.desired(idA, 2, DesiredIsolated, time.Hour, false))
	if j := h.journal(); j.Episode.Generation != 3 {
		t.Fatalf("an older isolated generation changed the episode: gen %d", j.Episode.Generation)
	}
	h.m.Reconcile(ctx, h.desired(idA, 4, DesiredReleased, time.Hour, false))
	if h.m.Active() {
		t.Fatal("a newer released generation did not release")
	}
	if j := h.journal(); j.Phase != journal.PhaseReleased || j.Episode.Generation != 4 {
		t.Fatalf("journal %s gen %d", j.Phase, j.Episode.Generation)
	}
}

func TestManagerReconcileNoChange(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	h.m.Reconcile(ctx, nil) // old API: no containment key
	h.m.Reconcile(ctx, &DesiredBlock{})
	if _, err := os.Stat(filepath.Join(h.dir, journal.FileName)); !os.IsNotExist(err) {
		t.Fatalf("a no-op reconcile wrote a journal: %v", err)
	}
	if r := h.m.Report(); r.Phase != journal.PhaseNone || r.IsolationID != "" {
		t.Fatalf("report %+v", r)
	}
	h.mustIsolate(idA, 1)
	h.m.Reconcile(ctx, nil)
	h.m.Reconcile(ctx, &DesiredBlock{NetworkIsolation: nil})
	if !h.m.Active() {
		t.Fatal("a bare null released the episode")
	}
}

func TestManagerReconcileAppliesFromHeartbeatAndAcksSecret(t *testing.T) {
	h := newHarness(t)
	h.m.Reconcile(context.Background(), h.desired(idA, 1, DesiredIsolated, 72*time.Hour, true))
	j := h.journal()
	if j.Phase != journal.PhaseCommitted || string(j.Episode.BreakGlassSecret) != string(h.secret) {
		t.Fatalf("journal %s secret %v", j.Phase, j.Episode.BreakGlassSecret != nil)
	}
	var secretSeq int64
	for _, e := range j.Events {
		if e.Type == "secret_received" {
			secretSeq = e.Seq
		}
	}
	if secretSeq == 0 || j.SecretAckSeq != secretSeq {
		t.Fatalf("secretAckSeq %d, secret_received seq %d", j.SecretAckSeq, secretSeq)
	}
	r := h.m.Report()
	if r.SecretAckSeq == nil || *r.SecretAckSeq != secretSeq {
		t.Fatalf("report secretAckSeq %v", r.SecretAckSeq)
	}
}

func TestManagerReconcileStoresLateSecret(t *testing.T) {
	h := newHarness(t)
	h.m.Reconcile(context.Background(), h.desired(idA, 1, DesiredIsolated, 72*time.Hour, false))
	if h.journal().SecretAckSeq != 0 {
		t.Fatal("acked a secret that never arrived")
	}
	h.m.Reconcile(context.Background(), h.desired(idA, 1, DesiredIsolated, 72*time.Hour, true))
	j := h.journal()
	if string(j.Episode.BreakGlassSecret) != string(h.secret) || j.SecretAckSeq == 0 {
		t.Fatal("late secret not stored/acked")
	}
	if h.iso.applies != 1 {
		t.Fatal("storing the secret re-applied the rules")
	}
}

func TestManagerDesiredDiffersReleasesJournalledFirst(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	h.log.reset()
	h.m.Reconcile(context.Background(), h.desired(idB, 1, DesiredIsolated, 72*time.Hour, true))
	calls := h.log.all()
	rel, app := -1, -1
	for i, c := range calls {
		if c == "iso:Release" && rel < 0 {
			rel = i
		}
		if c == "iso:Apply "+idB {
			app = i
		}
	}
	if rel < 0 || app < 0 || rel > app {
		t.Fatalf("expected release of A before apply of B: %v", calls)
	}
	j := h.journal()
	if j.Episode.IsolationID != idB || j.Phase != journal.PhaseCommitted {
		t.Fatalf("journal %s %+v", j.Phase, j.Episode)
	}
	found := false
	for _, e := range j.Events {
		if e.Type == "released_system" && e.IsolationID == idA {
			found = true
		}
	}
	if !found {
		t.Fatalf("no released_system event for A: %v", eventTypes(j))
	}
}

func TestManagerCorruptJournalDeletesOwnedRules(t *testing.T) {
	cases := map[string][]byte{
		"garbage":        []byte("{{{{"),
		"truncated":      []byte(`{"schemaVersion":1,"phase":"committed","episode":{"isolationId":"`),
		"unknown schema": []byte(`{"schemaVersion":9,"phase":"committed"}`),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			h.mustIsolate(idA, 1)
			if err := os.WriteFile(filepath.Join(h.dir, journal.FileName), data, 0o600); err != nil {
				t.Fatal(err)
			}
			h.m = h.newManager()
			h.m.Startup(context.Background())
			if installed, _, _ := h.iso.state(); installed {
				t.Fatal("owned rules survived a corrupt journal")
			}
			j := h.journal()
			if j.Phase != journal.PhaseNone || !containsStr(eventTypes(j), "journal_reset") || !containsStr(eventTypes(j), "released_system") {
				t.Fatalf("journal %s events %v", j.Phase, eventTypes(j))
			}
			if h.m.Active() {
				t.Fatal("still active")
			}
		})
	}
}

func TestManagerMissingJournalWithOwnedRules(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	if err := os.Remove(filepath.Join(h.dir, journal.FileName)); err != nil {
		t.Fatal(err)
	}
	h.m = h.newManager()
	h.m.Startup(context.Background())
	if installed, _, _ := h.iso.state(); installed {
		t.Fatal("orphan rules not deleted")
	}
}

func TestManagerReportShape(t *testing.T) {
	h := newHarness(t)
	r := h.m.Report()
	data, _ := json.Marshal(r)
	if string(data) != `{"journalSeq":0,"phase":"none"}` {
		t.Fatalf("empty report %s", data)
	}
	h.mustIsolate(idA, 1)
	r = h.m.Report()
	if r.IsolationID != idA || r.Generation != 1 || r.State != StateVerified || r.Phase != journal.PhaseCommitted || r.Mechanism != "wfp" || r.RuleDigest == "" || r.AppliedAt == nil || r.JournalSeq != h.journal().LastSeq() {
		t.Fatalf("report %+v", r)
	}
	var m map[string]any
	data, _ = json.Marshal(r)
	_ = json.Unmarshal(data, &m)
	for _, k := range []string{"isolationId", "generation", "journalSeq", "state", "phase", "mechanism", "appliedAt", "ruleDigest", "events", "secretAckSeq"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("report JSON lacks %q: %s", k, data)
		}
	}
	for _, k := range m {
		_ = k
	}
	if strings.Contains(string(data), "breakGlass") || strings.Contains(string(data), "MDEyMzQ1") {
		t.Fatal("the report leaks the break-glass secret")
	}
}

func TestManagerTickExpires(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	h.clock.Advance(72 * time.Hour)
	h.m.Tick(context.Background())
	j := h.journal()
	if j.Phase != journal.PhaseReleased || j.Episode.State != StateExpired || !containsStr(eventTypes(j), "released_expired") {
		t.Fatalf("journal %s %+v", j.Phase, j.Episode)
	}
	if installed, _, _ := h.iso.state(); installed {
		t.Fatal("rules survived expiry")
	}
}

func TestManagerReverifyDriftReapplies(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	// An admin flushed our rules.
	h.iso.set(func(f *fakeIsolator) { f.installed, f.digest = false, "" })
	h.clock.Advance(ReverifyInterval)
	h.m.Tick(context.Background())
	if h.iso.applies != 2 {
		t.Fatalf("drift not re-applied (%d applies)", h.iso.applies)
	}
	j := h.journal()
	if !containsStr(eventTypes(j), "drift_reapplied") || j.Phase != journal.PhaseCommitted {
		t.Fatalf("journal %s events %v", j.Phase, eventTypes(j))
	}
	if installed, _, _ := h.iso.state(); !installed {
		t.Fatal("rules not back")
	}
}

func TestManagerReverifyNotDueDoesNothing(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	h.log.reset()
	h.clock.Advance(time.Minute)
	h.m.Tick(context.Background())
	if h.log.count("iso:Verify") != 0 || h.log.count("dial") != 0 {
		t.Fatalf("re-verified before the interval: %v", h.log.all())
	}
	h.m.OnNetworkChange(context.Background())
	if h.log.count("iso:Verify") == 0 {
		t.Fatal("a network change did not force a re-verify")
	}
}

func TestManagerRefreshOnAddressChange(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	h.lookup.set(controlHost, "192.0.2.77")
	h.clock.Advance(ReverifyInterval)
	h.m.Tick(context.Background())
	_, spec, _ := h.iso.state()
	var control []netip.Prefix
	for _, e := range spec.Entries {
		if e.Host == controlHost {
			control = e.Addrs
		}
	}
	want := []netip.Prefix{netip.MustParsePrefix("192.0.2.77/32"), netip.MustParsePrefix("192.0.2.10/32"), netip.MustParsePrefix("2001:db8::10/128")}
	if !reflect.DeepEqual(control, want) {
		t.Fatalf("control permits %v, want %v (new first, old kept)", control, want)
	}
	j := h.journal()
	if !reflect.DeepEqual(j.Episode.Resolved[controlHost], []string{"192.0.2.77", "192.0.2.10", "2001:db8::10"}) {
		t.Fatalf("journal resolved %v", j.Episode.Resolved)
	}
	if j.Episode.RuleDigest != string(spec.Digest()) {
		t.Fatal("journal digest not updated after refresh")
	}
}

func TestManagerRefreshFailureRestoresPrior(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	_, prior, priorDigest := h.iso.state()
	h.lookup.set(controlHost, "192.0.2.77")
	h.verify.set(func(v *fakeVerify) { v.err = errors.New("unreachable") })
	h.clock.Advance(ReverifyInterval)
	h.m.Tick(context.Background())
	installed, spec, digest := h.iso.state()
	if !installed || digest != priorDigest || !reflect.DeepEqual(spec, prior) {
		t.Fatalf("prior rules not restored: installed=%v digest %s want %s", installed, digest, priorDigest)
	}
	j := h.journal()
	if j.Phase != journal.PhaseCommitted || j.Episode.RuleDigest != string(priorDigest) || !containsStr(eventTypes(j), "refresh_reverted") {
		t.Fatalf("journal %s digest %s events %v", j.Phase, j.Episode.RuleDigest, eventTypes(j))
	}
}

func TestManagerBusyWhileProbing(t *testing.T) {
	h := newHarness(t)
	gate := make(chan struct{})
	entered := make(chan struct{}, 1)
	h.verify.set(func(v *fakeVerify) { v.gate, v.entered = gate, entered })
	done := make(chan CommandOutcome, 1)
	go func() { done <- h.isolate(idA, 1) }()
	<-entered
	if out := h.isolate(idA, 2); out.ErrorCode != wire.ErrCodeIsolationBusy {
		t.Fatalf("concurrent isolate: %q (%s)", out.ErrorCode, out.Error)
	}
	if r := h.m.Report(); r.Phase != journal.PhaseProvisional || r.State != StateApplying {
		t.Fatalf("report while probing %+v", r)
	}
	close(gate)
	if out := <-done; out.Failed() {
		t.Fatalf("first isolate %+v", out)
	}
}

func TestManagerStartupRearmsAndReverifies(t *testing.T) {
	h := newHarness(t)
	h.mustIsolate(idA, 1)
	h.sched.set(func(s *fakeScheduler) { s.expiry, s.polling = nil, false })
	h.m = h.newManager()
	h.log.reset()
	h.m.Startup(context.Background())
	if h.log.count("sched:ArmExpiry 1") != 1 || h.log.count("sched:EnsurePoll") == 0 || h.log.count("iso:Verify") == 0 {
		t.Fatalf("startup did not re-arm and re-verify: %v", h.log.all())
	}
	if !h.m.Active() {
		t.Fatal("not active after startup")
	}
}

func TestManagerReportsUnsupportedReasonViaCapability(t *testing.T) {
	iso := NewPlatformIsolator()
	c := iso.Capability()
	if c.Version != 0 || c.Ready || c.UnsupportedReason == "" {
		t.Fatalf("platform isolator capability %+v, want 0 with a reason in this wave", c)
	}
	if _, err := iso.Apply(context.Background(), ResolvedSpec{}); err == nil {
		t.Fatal("unsupported isolator applied")
	}
	// It cannot see the engine, so it must never confirm absence (a build
	// without an isolator may inherit rules a capable build installed).
	if owned, err := iso.Owned(context.Background()); owned || err == nil {
		t.Fatalf("unsupported isolator Owned = %v, %v; want an error", owned, err)
	}
	if err := iso.Release(context.Background()); err == nil {
		t.Fatal("unsupported isolator claimed to release rules it cannot see")
	}
	if ok, why := NewPlatformScheduler(t.TempDir()).Ready(); ok || why == "" {
		t.Fatalf("platform scheduler Ready = %v %q", ok, why)
	}
}
