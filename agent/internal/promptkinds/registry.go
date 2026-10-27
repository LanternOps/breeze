// Package promptkinds holds the typed constructors for every prompt kind the
// agent build speaks (#10190, spec §3.1 "Kind registry"). Breeze-class kinds
// are built here and only here, from catalog keys and typed parameters, so no
// free string from a server payload can reach a slot, a label or a fact.
//
// Each kind keeps its own file (notice.go, later restart.go, remote.go,
// elevation.go); this registry is the only shared list and is append-only.
package promptkinds

import (
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/prompthost"
)

// NoticeInfo is notice.info@1 (W04): a Breeze-owned card plus a list entry.
// ok acknowledges it (terminal, so the list keeps the outcome); the macOS
// permission notice adds open_settings, which leaves it pending.
var NoticeInfo = prompthost.KindSpec{
	Name:    "notice.info",
	Version: 1,
	Transitions: map[ipc.PromptState]map[string]ipc.PromptState{
		ipc.PromptStatePending: {
			actionOK:           ipc.PromptStateApproved,
			actionOpenSettings: ipc.PromptStatePending,
		},
	},
}

// Specs lists every kind this build constructs.
func Specs() []prompthost.KindSpec {
	return []prompthost.KindSpec{NoticeInfo, RemoteConsentKind, RemoteSessionKind}
}

// Register tells the prompt host which kinds this build speaks (the first
// of the three switches, compatibility order step 2).
func Register(h *prompthost.Host) {
	for _, s := range Specs() {
		h.RegisterKind(s)
	}
}
