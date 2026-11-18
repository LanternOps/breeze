package heartbeat

import (
	"encoding/json"
	"testing"

	"github.com/breeze-rmm/agent/internal/cis"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// #9604: a remediation the agent could not apply (unimplemented check, failed
// registry/sysctl write) must surface as a FAILED command carrying the error,
// not a "completed" one whose only failure signal is buried in stdout JSON.
func TestHandleApplyCisRemediation_StatusFollowsRemediationOutcome(t *testing.T) {
	tests := []struct {
		name         string
		result       cis.RemediationResult
		wantStatus   string
		wantExitCode int
		wantError    string
	}{
		{
			name: "applied remediation completes",
			result: cis.RemediationResult{
				CheckID:     "1.5.3",
				Action:      "apply",
				Success:     true,
				BeforeState: map[string]any{"value": "0"},
				AfterState:  map[string]any{"value": "2"},
			},
			wantStatus:   "completed",
			wantExitCode: 0,
			wantError:    "",
		},
		{
			name: "unimplemented check fails with its error",
			result: cis.RemediationResult{
				CheckID: "2.3.7",
				Action:  "apply",
				Success: false,
				Error:   "no Windows remediation implemented for check 2.3.7",
			},
			wantStatus:   "failed",
			wantExitCode: 1,
			wantError:    "no Windows remediation implemented for check 2.3.7",
		},
		{
			name: "failed write keeps before state and error",
			result: cis.RemediationResult{
				CheckID:     "1.1.1.1",
				Action:      "disable_kernel_module",
				Success:     false,
				BeforeState: map[string]any{"moduleLoaded": true},
				Error:       "failed to write /etc/modprobe.d/cis-cramfs.conf: permission denied",
			},
			wantStatus:   "failed",
			wantExitCode: 1,
			wantError:    "failed to write /etc/modprobe.d/cis-cramfs.conf: permission denied",
		},
		{
			name: "failure without an error message still fails with a reason",
			result: cis.RemediationResult{
				CheckID: "9.9.9",
				Action:  "apply",
				Success: false,
			},
			wantStatus:   "failed",
			wantExitCode: 1,
			wantError:    "CIS remediation for check 9.9.9 did not succeed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			prev := cisRemediate
			cisRemediate = func(checkID, action string, _ map[string]any) cis.RemediationResult {
				return tt.result
			}
			t.Cleanup(func() { cisRemediate = prev })

			got := handleApplyCisRemediation(nil, Command{
				ID:      "cmd-1",
				Type:    tools.CmdApplyCisRemediation,
				Payload: map[string]any{"checkId": tt.result.CheckID, "action": tt.result.Action},
			})

			if got.Status != tt.wantStatus {
				t.Fatalf("Status = %q, want %q", got.Status, tt.wantStatus)
			}
			if got.ExitCode != tt.wantExitCode {
				t.Fatalf("ExitCode = %d, want %d", got.ExitCode, tt.wantExitCode)
			}
			if got.Error != tt.wantError {
				t.Fatalf("Error = %q, want %q", got.Error, tt.wantError)
			}

			// The remediation JSON must still ride on Stdout in BOTH branches:
			// the API reads beforeState/afterState/details from it, and an
			// auditor needs the before-state of a half-applied change.
			var decoded cis.RemediationResult
			if err := json.Unmarshal([]byte(got.Stdout), &decoded); err != nil {
				t.Fatalf("Stdout is not the remediation JSON: %v (stdout=%q)", err, got.Stdout)
			}
			if decoded.CheckID != tt.result.CheckID || decoded.Success != tt.result.Success {
				t.Fatalf("Stdout = %+v, want checkId %q success %v", decoded, tt.result.CheckID, tt.result.Success)
			}
			if len(tt.result.BeforeState) > 0 && len(decoded.BeforeState) == 0 {
				t.Fatalf("Stdout dropped beforeState: %q", got.Stdout)
			}
		})
	}
}

func TestHandleApplyCisRemediation_MissingCheckIDFails(t *testing.T) {
	called := false
	prev := cisRemediate
	cisRemediate = func(string, string, map[string]any) cis.RemediationResult {
		called = true
		return cis.RemediationResult{Success: true}
	}
	t.Cleanup(func() { cisRemediate = prev })

	got := handleApplyCisRemediation(nil, Command{ID: "cmd-2", Type: tools.CmdApplyCisRemediation, Payload: map[string]any{}})
	if got.Status != "failed" {
		t.Fatalf("Status = %q, want failed", got.Status)
	}
	if called {
		t.Fatal("remediation ran without a checkId")
	}
}
