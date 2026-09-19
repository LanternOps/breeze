package rollback

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeBackend struct {
	prepare, swap, restart, recover atomic.Int32
	healthy                         bool
	failAt                          string
}

func (f *fakeBackend) Prepare(context.Context, Directive) error {
	f.prepare.Add(1)
	if f.failAt == "prepare" {
		return errors.New("prepare")
	}
	return nil
}
func (f *fakeBackend) Swap(context.Context, Directive) error {
	f.swap.Add(1)
	if f.failAt == "swap" {
		return errors.New("swap")
	}
	return nil
}
func (f *fakeBackend) Restart(context.Context, Directive) error {
	f.restart.Add(1)
	if f.failAt == "restart" {
		return errors.New("restart")
	}
	return nil
}
func (f *fakeBackend) Healthy(context.Context, Directive) (bool, error) {
	if f.failAt == "health" {
		return false, errors.New("health")
	}
	return f.healthy, nil
}
func (f *fakeBackend) Finalize(context.Context, Directive) error { return nil }
func (f *fakeBackend) Recover(context.Context, Directive) error {
	f.recover.Add(1)
	if f.failAt == "recover" {
		return errors.New("recover")
	}
	return nil
}

func signedDirective(t *testing.T, now time.Time) (Directive, ed25519.PublicKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	platform := runtime.GOOS
	if platform == "darwin" {
		platform = "macos"
	}
	d := Directive{SchemaVersion: 1, RollbackID: "rollback-1", DeviceID: "device-1", OrgID: "org-1", Platform: platform, Architecture: runtime.GOARCH, CurrentVersion: "2.0.0", TargetVersion: "1.9.0", ComponentVersions: map[string]ComponentVersion{"agent": {Current: "2.0.0", Target: "1.9.0"}}, ReleaseManifest: "{}", ManifestSignature: "manifest", ManifestSigningKeyID: "manifest-key", Artifacts: []Artifact{{Component: "agent", CurrentVersion: "2.0.0", TargetVersion: "1.9.0", DownloadURL: "https://updates.example/agent", SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Size: 10}}, Reason: "regression", AuthorizedBy: "user-1", ApprovedAt: now.Add(-time.Minute).UTC().Format("2006-01-02T15:04:05Z"), ExpiresAt: now.Add(time.Minute).UTC().Format("2006-01-02T15:04:05Z"), DirectiveSigningKeyID: "key-1"}
	payload, err := CanonicalBytes(d)
	if err != nil {
		t.Fatal(err)
	}
	d.DirectiveSignature = base64.StdEncoding.EncodeToString(ed25519.Sign(private, payload))
	return d, public
}

func testEngine(t *testing.T, backend *fakeBackend) (*Engine, Directive) {
	t.Helper()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	d, key := signedDirective(t, now)
	engine := NewEngine(NewStore(t.TempDir()+"/state.json"), Environment{DeviceID: d.DeviceID, OrgID: d.OrgID, Platform: d.Platform, Architecture: d.Architecture, CurrentVersion: d.CurrentVersion, Now: func() time.Time { return now }, Backend: backend, VerifySignature: func(keyID string, payload, signature []byte) error {
		if keyID != "key-1" || !ed25519.Verify(key, payload, signature) {
			return errors.New("untrusted")
		}
		return nil
	}})
	return engine, d
}

func drainRollbackObservations(t *testing.T, engine *Engine) []Observation {
	t.Helper()
	var observations []Observation
	for {
		pending, err := engine.PendingObservation()
		if err != nil {
			t.Fatal(err)
		}
		if pending == nil {
			return observations
		}
		observations = append(observations, *pending)
		if err := engine.Acknowledge(pending.ObservationID); err != nil {
			t.Fatal(err)
		}
	}
}

func TestExecuteRejectsBeforeBackend(t *testing.T) {
	mutations := map[string]func(*Directive){"expired": func(d *Directive) { d.ExpiresAt = "2026-08-25T11:59:59Z" }, "device": func(d *Directive) { d.DeviceID = "wrong" }, "org": func(d *Directive) { d.OrgID = "wrong" }, "platform": func(d *Directive) { d.Platform = "wrong" }, "arch": func(d *Directive) { d.Architecture = "wrong" }, "current": func(d *Directive) { d.CurrentVersion = "wrong" }, "signature": func(d *Directive) { d.DirectiveSignature = base64.StdEncoding.EncodeToString(make([]byte, 64)) }, "key": func(d *Directive) { d.DirectiveSigningKeyID = "unknown" }, "binding": func(d *Directive) { d.Artifacts[0].TargetVersion = "1.8.0" }}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			backend := &fakeBackend{}
			engine, d := testEngine(t, backend)
			mutate(&d)
			if err := engine.Execute(context.Background(), d); err == nil {
				t.Fatal("invalid directive accepted")
			}
			if backend.prepare.Load()+backend.swap.Load()+backend.restart.Load() != 0 {
				t.Fatal("backend called before validation")
			}
		})
	}
}

func TestExecuteConcurrentDuplicatesAreIdempotentAndReplayBound(t *testing.T) {
	backend := &fakeBackend{}
	engine, d := testEngine(t, backend)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _ = engine.Execute(context.Background(), d) }()
	}
	wg.Wait()
	if backend.prepare.Load() != 1 || backend.swap.Load() != 1 || backend.restart.Load() != 1 {
		t.Fatalf("side effects = prepare %d swap %d restart %d", backend.prepare.Load(), backend.swap.Load(), backend.restart.Load())
	}
	changed := d
	changed.Reason = "changed"
	if err := engine.Execute(context.Background(), changed); err == nil {
		t.Fatal("changed content under same rollback id accepted")
	}
}

func TestRollbackObservationsPersistAndAcknowledgeInPhaseOrder(t *testing.T) {
	backend := &fakeBackend{healthy: true}
	engine, directive := testEngine(t, backend)
	if err := engine.Execute(context.Background(), directive); err != nil {
		t.Fatal(err)
	}
	restarted := NewEngine(engine.store, engine.env)
	want := []Phase{PhaseReceived, PhaseDownloaded, PhaseVerified, PhaseStaged, PhaseSwapped, PhaseRestartRequested}
	for index, phase := range want {
		pending, err := restarted.PendingObservation()
		if err != nil {
			t.Fatal(err)
		}
		if pending == nil || pending.Phase != phase {
			t.Fatalf("pending phase %d = %+v, want %s", index, pending, phase)
		}
		wantVersion := directive.ComponentVersions["agent"].Current
		if phase == PhaseSwapped || phase == PhaseRestartRequested {
			wantVersion = directive.ComponentVersions["agent"].Target
		}
		if pending.ComponentVersions["agent"] != wantVersion {
			t.Fatalf("pending phase %s component version = %q, want %q", phase, pending.ComponentVersions["agent"], wantVersion)
		}
		if err := restarted.Acknowledge(pending.ObservationID); err != nil {
			t.Fatal(err)
		}
	}
	if pending, err := restarted.PendingObservation(); err != nil || pending != nil {
		t.Fatalf("queue after acknowledgements = %+v, err=%v", pending, err)
	}
	if err := restarted.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	healthy, err := restarted.PendingObservation()
	if err != nil || healthy == nil || healthy.Phase != PhaseHealthy {
		t.Fatalf("terminal observation = %+v, err=%v", healthy, err)
	}
}

func TestEngineActiveTracksRollbackAcrossRestartBoundary(t *testing.T) {
	backend := &fakeBackend{healthy: true}
	engine, directive := testEngine(t, backend)
	if engine.Active() {
		t.Fatal("new engine reported an active rollback")
	}
	if err := engine.Execute(context.Background(), directive); err != nil {
		t.Fatal(err)
	}
	if !engine.Active() {
		t.Fatal("restart-requested rollback was not active")
	}
	if err := engine.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if engine.Active() {
		t.Fatal("terminal healthy rollback remained active")
	}
}

func TestReconcileProducesHealthyOrRecoveredTerminalTruth(t *testing.T) {
	for _, healthy := range []bool{true, false} {
		t.Run(map[bool]string{true: "healthy", false: "recovered"}[healthy], func(t *testing.T) {
			backend := &fakeBackend{healthy: healthy}
			engine, d := testEngine(t, backend)
			if err := engine.Execute(context.Background(), d); err != nil {
				t.Fatal(err)
			}
			restarted := NewEngine(engine.store, engine.env)
			if err := restarted.Reconcile(context.Background()); err != nil {
				t.Fatal(err)
			}
			observations := drainRollbackObservations(t, restarted)
			want := PhaseRecovered
			if healthy {
				want = PhaseHealthy
			}
			if len(observations) == 0 || observations[len(observations)-1].Phase != want {
				t.Fatalf("observations = %+v, want terminal %s", observations, want)
			}
			if !healthy && backend.recover.Load() != 1 {
				t.Fatal("unhealthy target was not recovered")
			}
			if !healthy && backend.restart.Load() != 2 {
				t.Fatal("recovered old set was not restarted")
			}
			if again, _ := restarted.PendingObservation(); again != nil {
				t.Fatal("acknowledged observation was resent")
			}
		})
	}
}

func TestExecutionFailuresNeverLeaveSilentMixedSuccess(t *testing.T) {
	for _, failAt := range []string{"prepare", "swap", "restart"} {
		t.Run(failAt, func(t *testing.T) {
			backend := &fakeBackend{failAt: failAt}
			engine, directive := testEngine(t, backend)
			if err := engine.Execute(context.Background(), directive); err == nil {
				t.Fatal("injected failure was ignored")
			}
			observations := drainRollbackObservations(t, engine)
			want := PhaseFailed
			if failAt == "swap" || failAt == "restart" {
				want = PhaseRecovered
			}
			if len(observations) == 0 || observations[len(observations)-1].Phase != want {
				t.Fatalf("observations = %+v, want terminal %s", observations, want)
			}
			if (failAt == "swap" || failAt == "restart") && backend.recover.Load() != 1 {
				t.Fatal("crossed boundary was not recovered")
			}
		})
	}
}
