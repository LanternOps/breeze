package sessionbroker

import "github.com/breeze-rmm/agent/internal/ipc"

type PamAction string

const (
	PamActionActuate     PamAction = "actuate"
	PamActionDeny        PamAction = "deny"
	PamActionAwaitRemote PamAction = "await_remote"
)

const (
	PamPolicyEndUserAllowed  = "end-user-allowed"
	PamPolicyRequireApproval = "require-approval"
)

func ComposePamDecision(policyVerdict string, dialog ipc.PamDialogResult, remoteApproved *bool) PamAction {
	if !dialog.Approved || dialog.DismissedByUser {
		return PamActionDeny
	}

	switch policyVerdict {
	case PamPolicyEndUserAllowed:
		return PamActionActuate
	case PamPolicyRequireApproval:
		if remoteApproved == nil {
			return PamActionAwaitRemote
		}
		if *remoteApproved {
			return PamActionActuate
		}
		return PamActionDeny
	default:
		return PamActionDeny
	}
}
