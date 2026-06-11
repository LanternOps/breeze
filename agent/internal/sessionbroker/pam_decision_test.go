package sessionbroker

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestComposePamDecision(t *testing.T) {
	t.Parallel()

	approvedRemote := true
	deniedRemote := false

	tests := []struct {
		name           string
		policyVerdict  string
		dialog         ipc.PamDialogResult
		remoteApproved *bool
		want           PamAction
	}{
		{
			name:          "end user allowed and local approve actuates",
			policyVerdict: PamPolicyEndUserAllowed,
			dialog:        ipc.PamDialogResult{Approved: true},
			want:          PamActionActuate,
		},
		{
			name:          "end user allowed and local deny denies",
			policyVerdict: PamPolicyEndUserAllowed,
			dialog:        ipc.PamDialogResult{Approved: false},
			want:          PamActionDeny,
		},
		{
			name:          "dismiss denies",
			policyVerdict: PamPolicyEndUserAllowed,
			dialog:        ipc.PamDialogResult{Approved: true, DismissedByUser: true},
			want:          PamActionDeny,
		},
		{
			name:          "require approval awaits remote decision",
			policyVerdict: PamPolicyRequireApproval,
			dialog:        ipc.PamDialogResult{Approved: true},
			want:          PamActionAwaitRemote,
		},
		{
			name:           "require approval with remote approve actuates",
			policyVerdict:  PamPolicyRequireApproval,
			dialog:         ipc.PamDialogResult{Approved: true},
			remoteApproved: &approvedRemote,
			want:           PamActionActuate,
		},
		{
			name:           "require approval with remote deny denies",
			policyVerdict:  PamPolicyRequireApproval,
			dialog:         ipc.PamDialogResult{Approved: true},
			remoteApproved: &deniedRemote,
			want:           PamActionDeny,
		},
		{
			name:          "unknown policy denies",
			policyVerdict: "unknown",
			dialog:        ipc.PamDialogResult{Approved: true},
			want:          PamActionDeny,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := ComposePamDecision(tt.policyVerdict, tt.dialog, tt.remoteApproved)
			if got != tt.want {
				t.Fatalf("ComposePamDecision() = %q, want %q", got, tt.want)
			}
		})
	}
}
