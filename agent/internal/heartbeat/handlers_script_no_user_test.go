package heartbeat

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// #6820: on an on-demand (RDS) host, a run-as-user script targeted at a
// session that can never host a user-role helper (nobody signed in, or the
// session is disconnected) must fail at once instead of sitting out the full
// 95 s helperReadyBudget. Same shape as #6812 on the desktop path.

const scriptNoUserTargetSession = 7

var scriptNoUserUserKey = sessionbroker.HelperKey{WindowsSessionID: scriptNoUserTargetSession, Role: ipc.HelperRoleUser}

func TestHandleScriptTargetSessionUserRoleAvailability(t *testing.T) {
	tests := []struct {
		name string
		f    *fakeLifecycle
		// wantErr is a substring the failure message must contain.
		wantErr string
		// wantLeaseAndWait: the pre-#6820 lease + bounded wait still runs.
		wantLeaseAndWait bool
	}{
		{
			name: "no signed-in user fails fast without a lease or wait",
			f: &fakeLifecycle{
				mode:        "on-demand",
				unavailable: map[sessionbroker.HelperKey]bool{scriptNoUserUserKey: true},
				// A real wait on a helper that can never start only ends when
				// its context does (95 s); the test budget below catches it.
				blockWait: true,
			},
			wantErr:          fmt.Sprintf("no user is signed in to session %d", scriptNoUserTargetSession),
			wantLeaseAndWait: false,
		},
		{
			name: "signed-in user keeps the lease and wait",
			f: &fakeLifecycle{
				mode: "on-demand",
				waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{
					scriptNoUserUserKey: {Status: sessionbroker.HelperWaitFatalCooldown, RetryAfter: 3 * time.Minute},
				},
			},
			wantErr:          "crash cooldown",
			wantLeaseAndWait: true,
		},
		{
			name: "failed availability check falls back to the lease and wait",
			f: &fakeLifecycle{
				mode:         "on-demand",
				availableErr: errors.New("WTSEnumerateSessions failed"),
				waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{
					scriptNoUserUserKey: {Status: sessionbroker.HelperWaitFatalCooldown, RetryAfter: 3 * time.Minute},
				},
			},
			wantErr:          "crash cooldown",
			wantLeaseAndWait: true,
		},
		{
			name: "unreadable username is not treated as nobody signed in",
			f: &fakeLifecycle{
				mode:         "on-demand",
				availableErr: sessionbroker.ErrSessionUsernameUnknown,
				waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{
					scriptNoUserUserKey: {Status: sessionbroker.HelperWaitFatalCooldown, RetryAfter: 3 * time.Minute},
				},
			},
			wantErr:          "crash cooldown",
			wantLeaseAndWait: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newTestHeartbeat(sessionbroker.New("/tmp/test-broker-script-nouser.sock", nil))
			h.helperLifecycle = tt.f

			done := make(chan tools.CommandResult, 1)
			go func() {
				done <- handleScript(h, Command{
					ID: "cmd-nouser",
					Payload: map[string]any{
						"content": "whoami", "language": "powershell", "runAs": "user",
						"targetSessionId": float64(scriptNoUserTargetSession),
					},
				})
			}()
			var res tools.CommandResult
			select {
			case res = <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("handleScript did not return within 5s (user-role helper wait not skipped?)")
			}

			if res.Status != "failed" || !strings.Contains(res.Error, tt.wantErr) {
				t.Fatalf("expected failure containing %q, got %+v", tt.wantErr, res)
			}

			tt.f.mu.Lock()
			checked := append([]sessionbroker.HelperKey(nil), tt.f.checked...)
			tt.f.mu.Unlock()
			if len(checked) != 1 || checked[0] != scriptNoUserUserKey {
				t.Fatalf("expected one user-role availability check for session %d, got %+v", scriptNoUserTargetSession, checked)
			}

			acquired, released, waited, _ := tt.f.snapshot()
			if tt.wantLeaseAndWait {
				if len(acquired) != 1 || acquired[0] != scriptNoUserUserKey {
					t.Errorf("expected the user-role lease, got %+v", acquired)
				}
				if len(waited) != 1 || waited[0] != scriptNoUserUserKey {
					t.Errorf("expected the user-role wait, got %+v", waited)
				}
				if len(released) != 1 {
					t.Errorf("lease must be released after the failed wait, got %+v", released)
				}
				return
			}
			if len(acquired) != 0 || len(waited) != 0 || len(released) != 0 {
				t.Errorf("no-user target must not lease or wait, got acquired=%v waited=%v released=%v", acquired, waited, released)
			}
		})
	}
}
