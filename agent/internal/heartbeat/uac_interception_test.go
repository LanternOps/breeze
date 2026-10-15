package heartbeat

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/pamlifetime"
)

func boolPtr(b bool) *bool { return &b }

func TestPolicyRevocationBetweenFinalApplyAndUnlockIsNotLost(t *testing.T) {
	manager := &fakePamLifetimeManager{available: true}
	h := readyPamApplyTestHeartbeat(manager, nil)
	h.handleUACInterception(boolPtr(true))
	h.pamPolicyMu.Lock()
	h.applyLatestPAMPolicyLocked()
	// Deterministically place a new heartbeat in the final-check/unlock gap.
	h.handleUACInterception(boolPtr(false))
	if h.IsUACInterceptionEnabled() {
		t.Fatal("revocation did not immediately close capture and apply admission")
	}
	h.finishPAMPolicyOperation()
	calls := manager.setEnabledCalls
	if len(calls) == 0 || calls[len(calls)-1] {
		t.Fatalf("operation returned with manager enabled after revocation: %v", calls)
	}
	if !h.pamPolicyMu.TryLock() {
		t.Fatal("operation lock was not released")
	}
	h.pamPolicyMu.Unlock()
}

func TestPolicyUpdatesDoNotWaitForPAMOperationsAndKeepNewestValue(t *testing.T) {
	for _, operation := range []string{"provision", "reset"} {
		for _, updates := range []struct {
			name   string
			values []*bool
			want   bool
		}{
			{"disable wins", []*bool{boolPtr(true), boolPtr(false)}, false},
			{"enable wins", []*bool{boolPtr(false), boolPtr(true)}, true},
			{"absent field disables", []*bool{boolPtr(true), nil}, false},
		} {
			t.Run(operation+"/"+updates.name, func(t *testing.T) {
				started, release := make(chan struct{}), make(chan struct{})
				var releaseOnce sync.Once
				unblock := func() { releaseOnce.Do(func() { close(release) }) }
				defer unblock()
				manager := &blockingPamReconcileManager{
					fakePamLifetimeManager: fakePamLifetimeManager{available: true},
					entered:                make(chan struct{}, 1), release: release,
				}
				h := readyPamApplyTestHeartbeat(manager, nil)
				h.uacInterceptionEnabled.Store(false)
				h.pamProvisionAccountFn = func() error {
					if operation == "provision" {
						close(started)
						<-release
					}
					return nil
				}
				if operation == "reset" {
					h.handleUACInterception(boolPtr(true))
				}
				done := make(chan struct{})
				go func() {
					defer close(done)
					if operation == "provision" {
						h.handleUACInterception(boolPtr(true))
					} else {
						h.reconcileAndReapplyPAMPolicy(context.Background())
					}
				}()
				var entered <-chan struct{} = started
				if operation == "reset" {
					entered = manager.entered
				}
				select {
				case <-entered:
				case <-time.After(time.Second):
					t.Fatal("PAM operation did not start")
				}
				for _, value := range updates.values {
					updated := make(chan struct{})
					go func() { h.handleUACInterception(value); close(updated) }()
					select {
					case <-updated:
					case <-time.After(time.Second):
						t.Fatal("heartbeat waited for PAM operation")
					}
					if value == nil || !*value {
						if h.IsUACInterceptionEnabled() {
							t.Fatal("disable left capture enabled")
						}
						if got := handlePamApplyV2(h, pamApplyV2TestCommand("blocked")); got.Status != "failed" {
							t.Fatalf("disable admitted an apply command: %+v", got)
						}
					}
				}
				unblock()
				select {
				case <-done:
				case <-time.After(time.Second):
					t.Fatal("PAM operation failed to finish")
				}
				if h.IsUACInterceptionEnabled() != updates.want {
					t.Fatal("stale policy overwrote newest desired value")
				}
				calls := manager.setEnabledCalls
				if len(calls) == 0 || calls[len(calls)-1] != updates.want {
					t.Fatalf("manager retained stale policy: %v, want %v", calls, updates.want)
				}
			})
		}
	}
}

type accountAbsencePamManager struct {
	fakePamLifetimeManager
	missing bool
}

func (m *accountAbsencePamManager) AccountProvisioningRequired() bool {
	return m.available && m.missing
}

func TestReconciliationReprovisionsDeletedAccountBeforePolicyAdmission(t *testing.T) {
	for _, state := range []string{"verified absence", "unknown cleanup", "retained active"} {
		t.Run(state, func(t *testing.T) {
			manager := &accountAbsencePamManager{fakePamLifetimeManager: fakePamLifetimeManager{available: true}}
			h := readyPamApplyTestHeartbeat(manager, nil)
			provisions := 0
			h.pamProvisionAccountFn = func() error {
				if h.IsUACInterceptionEnabled() {
					t.Fatal("account provisioned while UAC admission was open")
				}
				provisions++
				return nil
			}
			h.uacInterceptionEnabled.Store(false)
			h.handleUACInterception(boolPtr(true))
			if provisions != 1 {
				t.Fatalf("initial provisions = %d", provisions)
			}
			manager.missing = true
			switch state {
			case "unknown cleanup":
				manager.available = false
			case "retained active":
				manager.reconcileResults = []pamlifetime.Result{{State: pamlifetime.ResultVerifiedActive}}
			}
			h.reconcileAndReapplyPAMPolicy(context.Background())
			want := 1
			if state == "verified absence" {
				want = 2
			}
			if provisions != want {
				t.Fatalf("provisions after reset = %d, want %d", provisions, want)
			}
			if state == "unknown cleanup" && h.IsUACInterceptionEnabled() {
				t.Fatal("unknown cleanup reopened admission")
			}
			if state == "verified absence" && !h.IsUACInterceptionEnabled() {
				t.Fatal("verified recovery did not reopen admission after reprovisioning")
			}
		})
	}
}

func TestUACInterceptionFlag(t *testing.T) {
	tests := []struct {
		name        string
		sequence    []*bool // values passed to handleUACInterception in order
		wantEnabled bool
	}{
		{"default before any heartbeat is off (opt-in)", nil, false},
		{"nil from old server stays off (opt-in)", []*bool{nil}, false},
		{"explicit true enables", []*bool{boolPtr(true)}, true},
		{"explicit false stays off", []*bool{boolPtr(false)}, false},
		{"true then false disables", []*bool{boolPtr(true), boolPtr(false)}, false},
		{"true then nil disables (policy unassigned or old server)", []*bool{boolPtr(true), nil}, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &Heartbeat{pamLifetimeManager: &fakePamLifetimeManager{available: true}}
			h.pamReconciled.Store(true)
			h.pamReceivedObservationReady.Store(true)
			h.pamVerificationAvailable.Store(true)
			for _, v := range tt.sequence {
				h.handleUACInterception(v)
			}
			if got := h.IsUACInterceptionEnabled(); got != tt.wantEnabled {
				t.Fatalf("IsUACInterceptionEnabled() = %v, want %v", got, tt.wantEnabled)
			}
		})
	}
}

func TestUACDisableStopsCaptureButDoesNotReportDisabledUntilCleanupProof(t *testing.T) {
	manager := &fakePamLifetimeManager{setEnabledErr: errors.New("helper loss"), available: true}
	h := &Heartbeat{pamLifetimeManager: manager}
	h.pamReconciled.Store(true)
	h.pamReceivedObservationReady.Store(true)
	h.uacInterceptionEnabled.Store(true)

	h.handleUACInterception(boolPtr(false))

	if h.IsUACInterceptionEnabled() {
		t.Fatal("capture remained enabled after disable request")
	}
	if len(manager.setEnabledCalls) != 1 || manager.setEnabledCalls[0] {
		t.Fatalf("manager disable calls = %v", manager.setEnabledCalls)
	}
	if got := h.pamLifetimeProtocolVersion(); got != 0 {
		t.Fatalf("capability after unverifiable disable = %d, want 0", got)
	}
}

func TestUACEnableWaitsForManagerProof(t *testing.T) {
	manager := &fakePamLifetimeManager{setEnabledErr: errors.New("ledger unresolved"), available: true}
	h := &Heartbeat{pamLifetimeManager: manager}
	h.pamReconciled.Store(true)
	h.pamReceivedObservationReady.Store(true)

	h.handleUACInterception(boolPtr(true))

	if h.IsUACInterceptionEnabled() {
		t.Fatal("capture reported enabled after manager rejected enable")
	}
}

func TestUACDisableRetryRestoresCapabilityOnlyAfterCleanupProof(t *testing.T) {
	manager := &fakePamLifetimeManager{setEnabledErr: errors.New("helper loss"), available: true}
	h := &Heartbeat{pamLifetimeManager: manager}
	h.pamReconciled.Store(true)
	h.pamReceivedObservationReady.Store(true)
	h.pamVerificationAvailable.Store(true)
	h.uacInterceptionEnabled.Store(true)

	h.handleUACInterception(boolPtr(false))
	if got := h.pamLifetimeProtocolVersion(); got != 0 {
		t.Fatalf("capability after failed cleanup = %d, want 0", got)
	}
	manager.setEnabledErr = nil
	h.handleUACInterception(boolPtr(false))

	if got := h.pamLifetimeProtocolVersion(); got != 2 {
		t.Fatalf("capability after verified cleanup retry = %d, want 2", got)
	}
}

func TestPolicyOnlyPAMProvisionsBeforeFirstApply(t *testing.T) {
	manager := &fakePamLifetimeManager{available: true, applyResult: pamlifetime.Result{State: pamlifetime.ResultVerifiedActive}}
	h := readyPamApplyTestHeartbeat(manager, nil)
	h.uacInterceptionEnabled.Store(false)
	if h.config.PAMEnabled {
		t.Fatal("test requires PAM disabled in agent config")
	}
	provisionCalls := 0
	h.pamProvisionAccountFn = func() error {
		provisionCalls++
		if len(manager.setEnabledCalls) != 0 || manager.receivedCalls != 0 {
			t.Fatal("admission or apply ran before provisioning")
		}
		return nil
	}
	h.handleUACInterception(boolPtr(true))
	result := handlePamApplyV2(h, pamApplyV2TestCommand("60000000-0000-4000-8000-000000000001"))
	if result.Status != "completed" || manager.receivedCalls != 1 || provisionCalls != 1 {
		t.Fatalf("result=%+v, apply calls=%d, provision calls=%d", result, manager.receivedCalls, provisionCalls)
	}
	// Heartbeats and later policy toggles must not reset credentials for an
	// account that may have been used by an active elevation.
	h.handleUACInterception(boolPtr(true))
	h.handleUACInterception(boolPtr(false))
	h.handleUACInterception(boolPtr(true))
	if provisionCalls != 1 {
		t.Fatalf("provision calls = %d, want 1", provisionCalls)
	}
}

func TestPolicyPAMProvisioningFailureRetriesWithoutOpeningAdmission(t *testing.T) {
	manager := &fakePamLifetimeManager{available: true}
	h := readyPamApplyTestHeartbeat(manager, nil)
	h.uacInterceptionEnabled.Store(false)
	provisionCalls := 0
	h.pamProvisionAccountFn = func() error {
		provisionCalls++
		if provisionCalls == 1 {
			return errors.New("account creation failed")
		}
		return nil
	}
	h.handleUACInterception(boolPtr(true))
	if h.IsUACInterceptionEnabled() || len(manager.setEnabledCalls) != 0 {
		t.Fatal("failed provisioning opened PAM admission")
	}
	h.handleUACInterception(boolPtr(true))
	if !h.IsUACInterceptionEnabled() || provisionCalls != 2 {
		t.Fatal("provisioning did not recover on the next policy heartbeat")
	}
}

func TestPolicyPAMProvisioningRequiresReconciliationAndInstalledMode(t *testing.T) {
	for _, test := range []struct {
		name        string
		reconciled  bool
		available   bool
		supportMode bool
	}{
		{"startup reconciliation pending", false, true, false},
		{"unverified cleanup", true, false, false},
		{"support mode", true, true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			manager := &fakePamLifetimeManager{available: true}
			h := &Heartbeat{pamLifetimeManager: manager, supportMode: test.supportMode}
			h.pamReconciled.Store(test.reconciled)
			h.pamVerificationAvailable.Store(test.available)
			h.pamProvisionAccountFn = func() error {
				t.Fatal("unsafe state attempted account provisioning")
				return nil
			}
			h.handleUACInterception(boolPtr(true))
			if h.IsUACInterceptionEnabled() || len(manager.setEnabledCalls) != 0 {
				t.Fatal("unsafe state opened PAM admission")
			}
		})
	}
}

func TestConcurrentPolicyEnableProvisionsAccountOnce(t *testing.T) {
	manager := &fakePamLifetimeManager{available: true}
	h := readyPamApplyTestHeartbeat(manager, nil)
	h.uacInterceptionEnabled.Store(false)
	provisionCalls := 0
	h.pamProvisionAccountFn = func() error { provisionCalls++; return nil }
	var workers sync.WaitGroup
	for i := 0; i < 16; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			h.handleUACInterception(boolPtr(true))
		}()
	}
	workers.Wait()
	if provisionCalls != 1 || !h.IsUACInterceptionEnabled() {
		t.Fatalf("provision calls=%d, capture enabled=%v", provisionCalls, h.IsUACInterceptionEnabled())
	}
}

func TestReconcileReappliesDesiredPolicyAfterVerifiedCleanup(t *testing.T) {
	manager := &fakePamLifetimeManager{available: true}
	h := readyPamApplyTestHeartbeat(manager, nil)
	h.uacInterceptionEnabled.Store(false)
	provisionCalls := 0
	h.pamProvisionAccountFn = func() error { provisionCalls++; return nil }
	h.handleUACInterception(boolPtr(true))
	h.pamVerificationAvailable.Store(false)
	h.reconcileAndReapplyPAMPolicy(context.Background())
	if !h.IsUACInterceptionEnabled() || !h.pamReconciled.Load() || !h.pamReceivedObservationReady.Load() {
		t.Fatal("verified reconciliation did not restore policy admission")
	}
	if provisionCalls != 1 {
		t.Fatal("reconciliation reset reprovisioned the account")
	}
	if compiledSecurityCapabilities().PamReconciliationResetProtocolVersion != 1 {
		t.Fatal("recovery command capability missing")
	}
}

func TestPolicyOnlyRestartPreservesReconciledActiveAccount(t *testing.T) {
	active := pamReceivedTestObservation()
	active.State = pamlifetime.ResultVerifiedActive
	active.Evidence.BootID = "test-boot"
	manager := &fakePamLifetimeManager{available: true, reconcileResults: []pamlifetime.Result{active}}
	h := readyPamApplyTestHeartbeat(manager, nil)
	h.uacInterceptionEnabled.Store(false)
	h.pamResolveBindingsFn = func(_ context.Context, candidates []pamBindingCandidate) ([]pamBindingDisposition, error) {
		return []pamBindingDisposition{{Status: pamBindingStatusStale}}, nil
	}
	h.pamProvisionAccountFn = func() error {
		t.Fatal("policy enable reset a live account adopted by reconciliation")
		return nil
	}
	h.ReconcilePAMLifetime(context.Background())
	h.handleUACInterception(boolPtr(true))
	if !h.IsUACInterceptionEnabled() || !h.pamAccountProvisioned.Load() {
		t.Fatal("policy-only restart did not retain the verified active account")
	}
}
