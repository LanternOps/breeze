package heartbeat

import (
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/health"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/tunnel"
	"github.com/breeze-rmm/agent/pkg/api"
)

const rebindSecondIntent = "00000000-0000-4000-8000-0000000000b2"

func hashesOf(s *config.RebindStagedSet) rebindStageRequest { return rebindStageBody(s) }

// The whole protocol: every call is preceded by the write it relies on,
// phase 1 carries the source's credentials and certificate and only hashes,
// confirm carries the confirm-only token and the staged certificate, and the
// swap writes the target identity with the staged set and restarts once.
func TestRebindStagesConfirmsSwapsAndRestarts(t *testing.T) {
	r := newRebindHarness(t)
	r.drive(r.directive(rebindGoldenIntent))
	r.waitRestarts(1)

	wantOrder := []string{"persist:generated", "call:rebind", "persist:staged", "call:rebind-confirm", "persist:confirmed", "swap"}
	if got := r.eventLog(); !reflect.DeepEqual(got, wantOrder) {
		t.Fatalf("event order = %v, want %v", got, wantOrder)
	}
	set := r.lastWritten()
	stage := r.fake.callsTo("/rebind")[0]
	if stage.auth != "Bearer "+rebindTestSourceToken || stage.cert != "source" {
		t.Fatalf("phase 1 auth/cert = %q/%q, want the source's token and active certificate", stage.auth, stage.cert)
	}
	if *stage.stage != hashesOf(set) {
		t.Fatal("phase 1 hashes are not the persisted set's")
	}
	if len(stage.body) != 5 {
		t.Fatalf("phase 1 body has %d fields, want the five of the hand-off", len(stage.body))
	}
	for _, v := range stage.body {
		if s, _ := v.(string); strings.HasPrefix(s, "brz_") {
			t.Fatal("phase 1 sent a token instead of its hash")
		}
	}
	for _, h := range []string{stage.stage.StagedTokenHash, stage.stage.ConfirmationTokenHash} {
		if len(h) != 64 || strings.ToLower(h) != h {
			t.Fatalf("hash %q is not lowercase SHA-256 hex", h)
		}
	}
	confirm := r.fake.callsTo("/rebind-confirm")[0]
	if confirm.auth != "Bearer "+set.ConfirmationToken || confirm.cert != "staged-cert-1" {
		t.Fatalf("confirm cert = %q, want the staged certificate; bearer must be the confirmation token", confirm.cert)
	}
	if !strings.HasPrefix(set.ConfirmationToken, "brz_rbc_") || len(set.ConfirmationToken) != len("brz_rbc_")+64 {
		t.Fatal("the confirmation token is not brz_rbc_ + 64 hex")
	}
	r.assertSwapped(set)
	if !r.h.rebindOwnsIdentity() || r.h.beatSkipReason() == "" {
		t.Fatal("the process keeps beating on the retired source credentials after the swap")
	}
	if !r.h.tokenRotating.Load() {
		t.Fatal("token rotation is not blocked after the swap")
	}
	// The restart is not repeated before the retry interval.
	r.drive(nil)
	if r.restarts.Load() != 1 {
		t.Fatalf("restarts = %d, want 1", r.restarts.Load())
	}
	r.advance(rebindRestartRetry)
	r.drive(nil)
	r.waitRestarts(2)
}

// lastWritten is the last set this process persisted.
func (r *rebindHarness) lastWritten() *config.RebindStagedSet {
	r.t.Helper()
	r.eventsMu.Lock()
	defer r.eventsMu.Unlock()
	if len(r.written) == 0 {
		r.t.Fatal("nothing was persisted")
	}
	s := r.written[len(r.written)-1]
	return &s
}

// One set per intent (§6.3): retries, a re-delivered directive and a restart
// all resend the same hashes.
func TestRebindKeepsOneSetPerIntent(t *testing.T) {
	r := newRebindHarness(t)
	r.fake.queue(&r.fake.stageQueue,
		rebindInjection{status: http.StatusServiceUnavailable, body: map[string]any{"code": "certificate_unavailable"}},
		rebindInjection{status: http.StatusInternalServerError},
	)
	r.drive(r.directive(rebindGoldenIntent))
	first := r.staged()
	r.drive(r.directive(rebindGoldenIntent)) // re-delivered
	r.restart()
	r.drive(nil) // a new process resumes

	calls := r.fake.callsTo("/rebind")
	if len(calls) != 3 {
		t.Fatalf("phase 1 calls = %d, want 3", len(calls))
	}
	for i, c := range calls {
		if *c.stage != hashesOf(first) {
			t.Fatalf("phase 1 call %d sent a different set", i)
		}
	}
	r.waitRestarts(1)
	r.assertSwapped(first)
}

// A directive for a NEW intent gets a fresh set; the server refuses a reused
// confirmation hash, and the old set can never be activated.
func TestRebindNewIntentGetsAFreshSet(t *testing.T) {
	r := newRebindHarness(t)
	r.fake.queue(&r.fake.stageQueue, rebindInjection{status: http.StatusConflict,
		body: map[string]any{"code": "cancelled", "state": "cancelled", "cancelReason": "admin"}})
	r.drive(r.directive(rebindGoldenIntent))
	old := r.staged()
	if old.Phase != config.RebindPhaseEnded {
		t.Fatalf("phase = %s, want ended", old.Phase)
	}

	// A human requests again: a new intent.
	r.fake.mu.Lock()
	r.fake.intentID, r.fake.state = rebindSecondIntent, "requested"
	r.fake.mu.Unlock()
	r.drive(r.directive(rebindSecondIntent))
	r.waitRestarts(1)
	calls := r.fake.callsTo("/rebind")
	last := *calls[len(calls)-1].stage
	if last.IntentID != rebindSecondIntent {
		t.Fatal("phase 1 did not stage the new intent")
	}
	oldHashes := hashesOf(old)
	for _, pair := range [][2]string{
		{last.StagedTokenHash, oldHashes.StagedTokenHash},
		{last.StagedWatchdogTokenHash, oldHashes.StagedWatchdogTokenHash},
		{last.StagedHelperTokenHash, oldHashes.StagedHelperTokenHash},
		{last.ConfirmationTokenHash, oldHashes.ConfirmationTokenHash},
	} {
		if pair[0] == pair[1] {
			t.Fatal("a secret of the ended intent's set was reused for the new intent")
		}
	}
}

// Every phase 1 answer of the hand-off's table.
func TestRebindPhase1Answers(t *testing.T) {
	cancelled := func(code string) rebindInjection {
		return rebindInjection{status: http.StatusConflict, body: map[string]any{"code": code, "state": "cancelled", "cancelReason": code}}
	}
	cases := []struct {
		name         string
		inj          rebindInjection
		wantPhase    string // after the drive; "" = swapped (no file)
		wantCalls    int    // phase 1 calls
		regenerated  bool   // a fresh set replaced the first
		wantRetryMin time.Duration
	}{
		{name: "400 invalid_staged_set", inj: rebindInjection{status: 400, body: map[string]any{"code": "invalid_staged_set"}},
			wantPhase: config.RebindPhaseGenerated, wantCalls: 1, regenerated: true, wantRetryMin: rebindRetryMin},
		{name: "400 zod", inj: rebindInjection{status: 400, body: map[string]any{"error": "intentId: Invalid uuid",
			"details": map[string]any{"formErrors": []any{}, "fieldErrors": map[string]any{"intentId": []any{"Invalid uuid"}}}}},
			wantPhase: config.RebindPhaseGenerated, wantCalls: 1, regenerated: true, wantRetryMin: rebindRetryMin},
		{name: "400 from a proxy", inj: rebindInjection{status: 400},
			wantPhase: config.RebindPhaseGenerated, wantCalls: 1, wantRetryMin: rebindRetryMin},
		{name: "409 confirmation_token_reused", inj: rebindInjection{status: 409, body: map[string]any{"code": "confirmation_token_reused"}},
			wantPhase: "", wantCalls: 2, regenerated: true},
		{name: "409 staged_credential_reused", inj: cancelled("staged_credential_reused"), wantPhase: config.RebindPhaseEnded, wantCalls: 1},
		{name: "401", inj: rebindInjection{status: 401, body: map[string]any{"error": "Invalid agent credentials"}},
			wantPhase: config.RebindPhaseGenerated, wantCalls: 1, wantRetryMin: rebindRetryMin},
		{name: "403 agent_role_required", inj: rebindInjection{status: 403, body: map[string]any{"code": "agent_role_required"}},
			wantPhase: config.RebindPhaseGenerated, wantCalls: 1, wantRetryMin: rebindRetryMin},
		{name: "404 intent_not_found", inj: rebindInjection{status: 404, body: map[string]any{"code": "intent_not_found"}},
			wantPhase: config.RebindPhaseEnded, wantCalls: 1},
		{name: "404 from a proxy", inj: rebindInjection{status: 404},
			wantPhase: config.RebindPhaseGenerated, wantCalls: 1, wantRetryMin: rebindRetryMin},
		{name: "409 restage_refused", inj: cancelled("restage_refused"), wantPhase: config.RebindPhaseEnded, wantCalls: 1},
		{name: "409 partner_mismatch", inj: cancelled("partner_mismatch"), wantPhase: config.RebindPhaseEnded, wantCalls: 1},
		{name: "409 org_draining", inj: cancelled("org_draining"), wantPhase: config.RebindPhaseEnded, wantCalls: 1},
		{name: "409 requester_revoked", inj: cancelled("requester_revoked"), wantPhase: config.RebindPhaseEnded, wantCalls: 1},
		{name: "409 source_changed", inj: cancelled("source_changed"), wantPhase: config.RebindPhaseEnded, wantCalls: 1},
		{name: "409 target_changed", inj: cancelled("target_changed"), wantPhase: config.RebindPhaseEnded, wantCalls: 1},
		{name: "409 cancelled", inj: rebindInjection{status: 409, body: map[string]any{"code": "cancelled", "state": "cancelled", "cancelReason": "admin"}},
			wantPhase: config.RebindPhaseEnded, wantCalls: 1},
		{name: "409 expired", inj: rebindInjection{status: 409, body: map[string]any{"code": "expired", "state": "expired", "cancelReason": nil}},
			wantPhase: config.RebindPhaseEnded, wantCalls: 1},
		{name: "429 rate_limited", inj: rebindInjection{status: 429, body: map[string]any{"code": "rate_limited"}, retryAfter: "120"},
			wantPhase: config.RebindPhaseGenerated, wantCalls: 1, wantRetryMin: 120 * time.Second},
		{name: "503 certificate_unavailable", inj: rebindInjection{status: 503, body: map[string]any{"code": "certificate_unavailable"}},
			wantPhase: config.RebindPhaseGenerated, wantCalls: 1, wantRetryMin: rebindRetryMin},
		{name: "500", inj: rebindInjection{status: 500}, wantPhase: config.RebindPhaseGenerated, wantCalls: 1, wantRetryMin: rebindRetryMin},
		{name: "lost response", inj: rebindInjection{drop: true}, wantPhase: config.RebindPhaseGenerated, wantCalls: 1, wantRetryMin: rebindRetryMin},
		{name: "unknown 409 without state", inj: rebindInjection{status: 409, body: map[string]any{"code": "something_new"}},
			wantPhase: config.RebindPhaseGenerated, wantCalls: 1, wantRetryMin: rebindRetryMin},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newRebindHarness(t)
			r.fake.queue(&r.fake.stageQueue, tc.inj)
			r.drive(r.directive(rebindGoldenIntent))
			first := r.firstWritten()

			calls := r.fake.callsTo("/rebind")
			if len(calls) != tc.wantCalls {
				t.Fatalf("phase 1 calls = %d, want %d", len(calls), tc.wantCalls)
			}
			if *calls[0].stage != hashesOf(first) {
				t.Fatal("the first phase 1 call did not send the first persisted set")
			}
			got := r.staged()
			if tc.wantPhase == "" {
				r.waitRestarts(1)
				if got != nil {
					t.Fatal("the staged set survived the swap")
				}
			} else {
				if got == nil || got.Phase != tc.wantPhase {
					t.Fatalf("staged set = %+v, want phase %s", got, tc.wantPhase)
				}
				changed := hashesOf(got) != hashesOf(first)
				if changed != tc.regenerated {
					t.Fatalf("set regenerated = %v, want %v", changed, tc.regenerated)
				}
			}
			if tc.regenerated && tc.wantCalls == 2 && *calls[1].stage == hashesOf(first) {
				t.Fatal("the resend after confirmation_token_reused reused the refused set")
			}
			if tc.wantRetryMin > 0 {
				at := r.h.rebind.retryAt.Load()
				if at == nil || at.Sub(r.now()) < tc.wantRetryMin {
					t.Fatalf("next attempt at %v, want at least %v later", at, tc.wantRetryMin)
				}
			}
			if tc.wantPhase == config.RebindPhaseEnded {
				if _, over := r.h.rebind.ended.Load(rebindGoldenIntent); !over {
					t.Fatal("the ended intent is not remembered")
				}
				// Never staged again for that intent.
				r.drive(r.directive(rebindGoldenIntent))
				if n := len(r.fake.callsTo("/rebind")); n != tc.wantCalls {
					t.Fatalf("phase 1 sent again for an ended intent (%d calls)", n)
				}
			}
			if tc.name == "401" && !r.h.rebind.sourceRejected.Load() {
				t.Fatal("a phase 1 401 did not mark the source credentials rejected")
			}
		})
	}
}

// firstWritten is the first set this process persisted.
func (r *rebindHarness) firstWritten() *config.RebindStagedSet {
	r.t.Helper()
	r.eventsMu.Lock()
	defer r.eventsMu.Unlock()
	if len(r.written) == 0 {
		r.t.Fatal("nothing was persisted")
	}
	s := r.written[0]
	return &s
}

// After phase 1 says the intent is already confirmed, confirm with the token.
//
// Without an mTLS provider: in enforce mode a confirmed intent accepts only
// the staged certificate, which a phase 1 whose answer was lost never
// delivered (the server answers 403 certificate_binding_failed, retried).
func TestRebindPhase1ConfirmedGoesToConfirm(t *testing.T) {
	r := newRebindHarness(t)
	r.fake.with(func(f *rebindFake) { f.noMTLS = true })
	// Phase 1 commits and its answer is lost; then the intent is confirmed
	// by this set's token (a confirm whose answer was also lost).
	r.fake.queue(&r.fake.stageQueue, rebindInjection{commitThenDrop: true})
	r.drive(r.directive(rebindGoldenIntent))
	r.fake.setState("confirmed", "")
	r.drive(r.directive(rebindGoldenIntent))
	r.waitRestarts(1)
	if n := len(r.fake.callsTo("/rebind-confirm")); n != 1 {
		t.Fatalf("confirm calls = %d, want 1", n)
	}
	cfg := r.onDisk()
	if cfg.AgentID != rebindTestStagedAgentID || cfg.DeviceID != rebindGoldenDevice {
		t.Fatal("the identity from confirm was not swapped in")
	}
}

// Every confirm answer of the hand-off's table.
func TestRebindConfirmAnswers(t *testing.T) {
	cancelled := func(code string) rebindInjection {
		return rebindInjection{status: http.StatusConflict, body: map[string]any{"code": code, "state": "cancelled", "cancelReason": code}}
	}
	cases := []struct {
		name      string
		inj       rebindInjection
		wantPhase string // "" = swapped
		phase1    int    // phase 1 calls in total
	}{
		{name: "200", wantPhase: "", phase1: 1},
		{name: "401 invalid_confirmation", inj: rebindInjection{status: 401, body: map[string]any{"code": "invalid_confirmation"}}, wantPhase: config.RebindPhaseStaged, phase1: 1},
		{name: "403 certificate_binding_failed", inj: rebindInjection{status: 403, body: map[string]any{"code": "certificate_binding_failed"}}, wantPhase: config.RebindPhaseStaged, phase1: 1},
		{name: "409 not_staged", inj: rebindInjection{status: 409, body: map[string]any{"code": "not_staged", "state": "requested"}}, wantPhase: "", phase1: 2},
		{name: "409 target_alive", inj: cancelled("target_alive"), wantPhase: config.RebindPhaseEnded, phase1: 1},
		{name: "409 liveness_unknown", inj: cancelled("liveness_unknown"), wantPhase: config.RebindPhaseEnded, phase1: 1},
		{name: "409 partner_mismatch", inj: cancelled("partner_mismatch"), wantPhase: config.RebindPhaseEnded, phase1: 1},
		{name: "409 org_draining", inj: cancelled("org_draining"), wantPhase: config.RebindPhaseEnded, phase1: 1},
		{name: "409 requester_revoked", inj: cancelled("requester_revoked"), wantPhase: config.RebindPhaseEnded, phase1: 1},
		{name: "409 source_changed", inj: cancelled("source_changed"), wantPhase: config.RebindPhaseEnded, phase1: 1},
		{name: "409 target_changed", inj: cancelled("target_changed"), wantPhase: config.RebindPhaseEnded, phase1: 1},
		{name: "409 device_limit_reached", inj: cancelled("device_limit_reached"), wantPhase: config.RebindPhaseEnded, phase1: 1},
		{name: "409 cancelled", inj: rebindInjection{status: 409, body: map[string]any{"code": "cancelled", "state": "cancelled", "cancelReason": "restage_refused"}}, wantPhase: config.RebindPhaseEnded, phase1: 1},
		{name: "409 expired", inj: rebindInjection{status: 409, body: map[string]any{"code": "expired", "state": "expired"}}, wantPhase: config.RebindPhaseEnded, phase1: 1},
		{name: "429 rate_limited", inj: rebindInjection{status: 429, body: map[string]any{"code": "rate_limited"}, retryAfter: "90"}, wantPhase: config.RebindPhaseStaged, phase1: 1},
		{name: "500", inj: rebindInjection{status: 500}, wantPhase: config.RebindPhaseStaged, phase1: 1},
		{name: "lost response", inj: rebindInjection{drop: true}, wantPhase: config.RebindPhaseStaged, phase1: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newRebindHarness(t)
			if tc.name == "409 not_staged" {
				// The server lost the staging: phase 1 again, same hashes.
				r.fake.queue(&r.fake.confirmQueue, tc.inj)
				r.fake.queue(&r.fake.stageQueue, rebindInjection{})
			} else if tc.inj.status != 0 || tc.inj.drop || tc.inj.commitThenDrop {
				r.fake.queue(&r.fake.confirmQueue, tc.inj)
			}
			r.drive(r.directive(rebindGoldenIntent))
			got := r.staged()
			if tc.wantPhase == "" {
				r.waitRestarts(1)
				if got != nil {
					t.Fatal("the staged set survived the swap")
				}
			} else if got == nil || got.Phase != tc.wantPhase {
				t.Fatalf("staged set = %+v, want phase %s", got, tc.wantPhase)
			}
			stage := r.fake.callsTo("/rebind")
			if len(stage) != tc.phase1 {
				t.Fatalf("phase 1 calls = %d, want %d", len(stage), tc.phase1)
			}
			for _, c := range stage[1:] {
				if *c.stage != *stage[0].stage {
					t.Fatal("phase 1 after not_staged sent a different set")
				}
			}
			if tc.name == "429 rate_limited" {
				if at := r.h.rebind.retryAt.Load(); at == nil || at.Sub(r.now()) < 90*time.Second {
					t.Fatal("the confirm Retry-After was not honoured")
				}
			}
			if tc.wantPhase == config.RebindPhaseStaged {
				// Never discarded on a bare rejection, even with the source
				// credentials proven current.
				r.h.noteSourceCredentialsCurrent()
				if s := r.staged(); s == nil || s.Phase != config.RebindPhaseStaged {
					t.Fatal("a staged set was discarded on a bare rejection")
				}
			}
		})
	}
}

// An ended set is kept through rejections and deleted only after a 2xx on
// the source credentials (§6.6).
func TestRebindEndedSetIsDiscardedOnlyOnceTheSourceIsProvenCurrent(t *testing.T) {
	r := newRebindHarness(t)
	r.fake.queue(&r.fake.confirmQueue, rebindInjection{status: 409, body: map[string]any{"code": "target_alive", "state": "cancelled", "cancelReason": "target_alive"}})
	r.drive(r.directive(rebindGoldenIntent))
	if s := r.staged(); s == nil || s.Phase != config.RebindPhaseEnded || s.EndedCode != "target_alive" {
		t.Fatalf("staged set = %+v, want ended (target_alive)", s)
	}
	r.h.noteSourceCredentialsRejected()
	r.settle()
	r.drive(nil)
	if r.staged() == nil {
		t.Fatal("an ended set was discarded without proof that the source credentials are current")
	}

	// The real path: an authenticated 2xx heartbeat.
	r.h.healthMon = health.NewMonitor()
	r.h.retryCfg = httputil.RetryConfig{MaxRetries: 0}
	if _, ok := r.h.doHeartbeatPost(r.fake.srv.URL, &HeartbeatPayload{Status: "ok", AgentVersion: "1.2.3"}); !ok {
		t.Fatal("source heartbeat failed")
	}
	if r.staged() != nil || r.h.rebind.pendingOnDisk.Load() {
		t.Fatal("the ended set was kept after the source credentials were proven current")
	}
}

// A generated or staged set that outlived any intent is discarded once the
// source is proven current; a confirmed one never is.
func TestRebindStaleSetIsDiscardedOnlyWhenNotConfirmed(t *testing.T) {
	r := newRebindHarness(t)
	r.fake.queue(&r.fake.confirmQueue, rebindInjection{status: 401, body: map[string]any{"code": "invalid_confirmation"}})
	r.drive(r.directive(rebindGoldenIntent))
	r.h.noteSourceCredentialsCurrent()
	if r.staged() == nil {
		t.Fatal("a fresh staged set was discarded")
	}
	r.advance(rebindStaleAfter + time.Minute)
	r.h.noteSourceCredentialsCurrent()
	if r.staged() != nil {
		t.Fatal("a staged set older than any intent was kept with the source proven current")
	}

	r2 := newRebindHarness(t)
	r2.killAfter = config.RebindPhaseConfirmed
	r2.drive(r2.directive(rebindGoldenIntent))
	r2.advance(48 * time.Hour)
	r2.h.noteSourceCredentialsCurrent()
	if s := r2.staged(); s == nil || s.Phase != config.RebindPhaseConfirmed {
		t.Fatal("a confirmed set was discarded")
	}
}

// Directives the agent must not act on: unverified, for another install,
// on a Quick Support client, while an identity restart or a rollback is
// pending, or for an intent this process saw end.
func TestRebindIgnoresDirectivesItMustNotActOn(t *testing.T) {
	cases := map[string]func(r *rebindHarness) (*RebindDirective, bool){
		"bad signature": func(r *rebindHarness) (*RebindDirective, bool) {
			d := r.directive(rebindGoldenIntent)
			d.TargetSiteID = "00000000-0000-4000-8000-0000000000ee"
			return d, false
		},
		"another install": func(r *rebindHarness) (*RebindDirective, bool) {
			d := goldenRebindDirective()
			d.ExpiresAt = r.now().Add(time.Minute).UTC().Format("2006-01-02T15:04:05Z")
			return signRebindTestDirective(r.t, d, strings.Repeat("d", 64)), false
		},
		"expired": func(r *rebindHarness) (*RebindDirective, bool) {
			d := r.directive(rebindGoldenIntent)
			r.advance(16 * time.Minute)
			return d, false
		},
		"support mode": func(r *rebindHarness) (*RebindDirective, bool) {
			r.h.config.SupportMode = true
			return r.directive(rebindGoldenIntent), false
		},
		"identity restart pending": func(r *rebindHarness) (*RebindDirective, bool) {
			return r.directive(rebindGoldenIntent), true
		},
		"ended intent": func(r *rebindHarness) (*RebindDirective, bool) {
			r.h.rebind.ended.Store(rebindGoldenIntent, struct{}{})
			return r.directive(rebindGoldenIntent), false
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			r := newRebindHarness(t)
			d, hold := setup(r)
			r.h.handleRebindDirective(d, hold)
			time.Sleep(50 * time.Millisecond)
			if len(r.fake.callsTo("/rebind")) != 0 || r.staged() != nil {
				t.Fatal("acted on a directive it must ignore")
			}
		})
	}
}

// Phase 1 naming a target other than the signed directive's is never
// confirmed.
func TestRebindRefusesAPhase1TargetOtherThanTheSignedOne(t *testing.T) {
	r := newRebindHarness(t)
	r.fake.with(func(f *rebindFake) { f.target.DeviceID = "00000000-0000-4000-8000-0000000000dd" })
	r.drive(r.directive(rebindGoldenIntent))
	if n := len(r.fake.callsTo("/rebind-confirm")); n != 0 {
		t.Fatalf("confirm calls = %d, want 0", n)
	}
	if s := r.staged(); s == nil || s.Phase != config.RebindPhaseGenerated {
		t.Fatal("the staged state advanced on a mismatched target")
	}
}

// Without an mTLS provider phase 1 returns no certificate: confirm uses the
// source's client and the swap clears the source's certificate.
func TestRebindWithoutCertificate(t *testing.T) {
	r := newRebindHarness(t)
	r.fake.with(func(f *rebindFake) { f.noMTLS = true })
	r.drive(r.directive(rebindGoldenIntent))
	r.waitRestarts(1)
	if c := r.fake.callsTo("/rebind-confirm")[0]; c.cert != "source" {
		t.Fatalf("confirm cert = %q, want the source client without a staged certificate", c.cert)
	}
	if cfg := r.onDisk(); cfg.MtlsCertPEM != "" {
		t.Fatal("a certificate survived a swap without a staged one")
	}
}

// Refusals of the set itself regenerate at most rebindMaxRegenerations times.
func TestRebindRegenerationIsBounded(t *testing.T) {
	r := newRebindHarness(t)
	for range 10 {
		r.fake.queue(&r.fake.stageQueue, rebindInjection{status: 409, body: map[string]any{"code": "confirmation_token_reused"}})
	}
	r.drive(r.directive(rebindGoldenIntent))
	if n := len(r.fake.callsTo("/rebind")); n != rebindMaxRegenerations+1 {
		t.Fatalf("phase 1 calls = %d, want %d", n, rebindMaxRegenerations+1)
	}
	if r.h.rebind.retryAt.Load() == nil {
		t.Fatal("no backoff after the regeneration cap")
	}
}

// Nothing is sent before the set is on disk.
func TestRebindSendsNothingUntilTheSetIsOnDisk(t *testing.T) {
	r := newRebindHarness(t)
	r.failWrites = true
	r.drive(r.directive(rebindGoldenIntent))
	if len(r.fake.callsTo("/rebind")) != 0 {
		t.Fatal("phase 1 was sent with no staged set on disk")
	}
	r.failWrites = false
	r.drive(r.directive(rebindGoldenIntent))
	r.waitRestarts(1)
}

// The real heartbeat path end to end: the directive arrives on the source's
// beat (main or parked: the same response), the flow runs, and a 401 after a
// committed confirm whose answer was lost replays it.
func TestRebindRunsFromTheHeartbeatResponse(t *testing.T) {
	r := newRebindHarness(t)
	r.h.healthMon = health.NewMonitor()
	r.h.retryCfg = httputil.RetryConfig{MaxRetries: 0}
	r.h.tunnelMgr = &tunnel.Manager{}
	d := r.directive(rebindGoldenIntent)
	r.fake.with(func(f *rebindFake) { f.directive = d })
	r.fake.queue(&r.fake.confirmQueue, rebindInjection{commitThenDrop: true})

	if !r.h.postHeartbeat(r.fake.srv.URL, &HeartbeatPayload{Status: "ok", AgentVersion: "1.2.3"}) {
		t.Fatal("source heartbeat failed")
	}
	waitForIdentityCondition(t, "the confirm was sent", func() bool { return len(r.fake.callsTo("/rebind-confirm")) == 1 })
	waitForIdentityCondition(t, "the flow settled", func() bool { return r.h.rebind.mu.TryLock() })
	r.h.rebind.mu.Unlock()
	if s := r.staged(); s == nil || s.Phase != config.RebindPhaseStaged {
		t.Fatalf("after a lost confirm answer the set = %+v, want staged", s)
	}

	// The source's credentials were retired by the commit: the next beat
	// gets 401, which replays confirm.
	r.h.rebind.retryAt.Store(nil)
	if r.h.postHeartbeat(r.fake.srv.URL, &HeartbeatPayload{Status: "ok", AgentVersion: "1.2.3"}) {
		t.Fatal("the retired source credentials still authenticate")
	}
	r.waitRestarts(1)
	set := &config.RebindStagedSet{AuthToken: r.onDisk().AuthToken}
	if set.AuthToken == rebindTestSourceToken {
		t.Fatal("the swap did not happen")
	}
	if n := len(r.fake.callsTo("/rebind-confirm")); n != 2 {
		t.Fatalf("confirm calls = %d, want 2 (the replay)", n)
	}
}

// When the source is refused and confirm cannot answer, the staged set probes
// as the target; a 401 there is retried (the agent-auth negative cache).
func TestRebindProbesAsTheTargetWhenTheSourceIsRefused(t *testing.T) {
	r := newRebindHarness(t)
	r.fake.queue(&r.fake.confirmQueue, rebindInjection{commitThenDrop: true},
		rebindInjection{status: 503}, rebindInjection{status: 503}, rebindInjection{status: 503})
	r.fake.queue(&r.fake.heartbeatQueue, rebindInjection{status: 401, body: map[string]any{"error": "cached"}})
	r.drive(r.directive(rebindGoldenIntent))
	set := r.staged()
	if set == nil || set.Phase != config.RebindPhaseStaged {
		t.Fatal("expected a staged set after the lost confirm answer")
	}

	// Without a source rejection there is no probe.
	r.drive(nil)
	if n := len(r.fake.callsTo("/heartbeat")); n != 0 {
		t.Fatalf("probed without a source rejection (%d calls)", n)
	}
	r.h.rebind.sourceRejected.Store(true)
	r.drive(nil) // confirm 503, probe 401 (cached)
	if s := r.staged(); s == nil || s.Phase != config.RebindPhaseStaged {
		t.Fatal("a 401 on the probe was treated as final")
	}
	r.drive(nil) // confirm 503, probe 200
	r.waitRestarts(1)

	probes := r.fake.callsTo("/heartbeat")
	if len(probes) != 2 {
		t.Fatalf("probe calls = %d, want 2", len(probes))
	}
	p := probes[1]
	if !strings.HasSuffix(p.path, "/"+rebindTestStagedAgentID+"/heartbeat") || p.auth != "Bearer "+set.AuthToken || p.cert != set.Certificate.SerialNumber {
		t.Fatalf("probe %s cert %q: want the staged agent id, staged token and staged certificate", p.path, p.cert)
	}
	if p.body["status"] != "ok" || p.body["agentVersion"] != "1.2.3" || p.body["securityCapabilities"] == nil || len(p.body) != 3 {
		t.Fatalf("probe body = %v, want only status, agentVersion and securityCapabilities", p.body)
	}
	r.assertSwapped(set)
}

// After the swap no SaveTo from this process may write the retired source's
// ids or certificate back over the reattached identity.
func TestRebindSwapBlocksStaleConfigSaves(t *testing.T) {
	r := newRebindHarness(t)
	r.drive(r.directive(rebindGoldenIntent))
	r.waitRestarts(1)
	before := r.onDisk()

	r.h.config.PendingMTLSCertificate, r.h.config.PendingMTLSPrivateKey = "P", "K"
	r.h.clearPendingMTLSCert()
	cert := newRebindTestCert(t, "source-renewed")
	r.h.promoteLegacyCertImmediately(&api.MtlsCertData{Certificate: cert.Certificate, PrivateKey: cert.PrivateKey, ExpiresAt: cert.ExpiresAt})

	after := r.onDisk()
	if after.AgentID != before.AgentID || after.DeviceID != before.DeviceID || after.MtlsCertPEM != before.MtlsCertPEM {
		t.Fatal("a stale SaveTo overwrote the reattached identity")
	}
}

// A NEW token rotation waits while a reattach is in flight.
func TestRebindHoldsNewTokenRotation(t *testing.T) {
	r := newRebindHarness(t)
	if r.h.rebindInProgress() {
		t.Fatal("in progress with nothing staged")
	}
	r.fake.queue(&r.fake.confirmQueue, rebindInjection{status: 503})
	r.drive(r.directive(rebindGoldenIntent))
	if !r.h.rebindInProgress() {
		t.Fatal("a staged reattach does not hold token rotation")
	}
	r.h.tunnelMgr = &tunnel.Manager{}
	r.fake.mu.Lock()
	srvCalls := len(r.fake.calls)
	r.fake.mu.Unlock()
	r.h.processHeartbeatResponse(&HeartbeatResponse{RotateToken: true})
	time.Sleep(50 * time.Millisecond)
	r.fake.mu.Lock()
	n := len(r.fake.calls)
	r.fake.mu.Unlock()
	if n != srvCalls {
		t.Fatal("a token rotation started while a reattach was in flight")
	}
}

// The response that carries the FIRST directive holds rotation too: the flow
// starts on its own goroutine and has nothing on disk yet.
func TestRebindHoldsTokenRotationInTheDirectivesOwnResponse(t *testing.T) {
	r := newRebindHarness(t)
	r.h.tunnelMgr = &tunnel.Manager{}
	r.h.processHeartbeatResponse(&HeartbeatResponse{RotateToken: true, Rebind: r.directive(rebindGoldenIntent)})
	r.waitRestarts(1)
	if n := len(r.fake.callsTo("/rotate-token")); n != 0 {
		t.Fatalf("rotate-token calls = %d, want 0 beside a directive", n)
	}
}

func TestRebindCapabilityIsNeverDeclaredInSupportMode(t *testing.T) {
	r := newRebindHarness(t)
	r.h.config.SupportMode = true
	if r.h.securityCapabilitiesForBeat().RebindProtocolVersion != 0 {
		t.Fatal("a Quick Support client declares the rebind protocol")
	}
}
