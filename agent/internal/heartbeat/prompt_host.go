package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// Prompt host heartbeat plumbing (#10190 W02).
//
// Response: promptHost.enabledKinds is the server kill switch (spec §3.1
// rule 2, plan P4). An absent block means an empty list — every prompt takes
// its legacy path — so an older server, or a short-form heartbeat, never
// turns a kind on.
//
// Request: helperCapabilities.promptHost describes what the active console
// session's Breeze Assist advertised at its live authentication (protocol,
// kinds, build version), so the technician can see which renderer a device
// can use. Omitted when no Assist is in the console session.

// promptInboxFile holds prompt list entries and tombstones (data dir).
const promptInboxFile = "prompt_inbox.json"

// PromptHostSettings is the heartbeat response's promptHost block.
type PromptHostSettings struct {
	EnabledKinds []string `json:"enabledKinds"`
}

// promptHostTelemetry is helperCapabilities.promptHost. Kinds is always
// present (possibly []): a renderer that speaks the protocol but advertises
// no kind is a real, reportable state.
type promptHostTelemetry struct {
	ProtocolVersion int      `json:"protocolVersion"`
	Kinds           []string `json:"kinds"`
	RendererVersion string   `json:"rendererVersion"`
}

type promptRendererInfo interface {
	PromptProtocol() int
	PromptKindAds() []string
	RendererVersion() string
}

var _ promptRendererInfo = (*sessionbroker.Session)(nil)

func promptTelemetryFrom(r promptRendererInfo) *promptHostTelemetry {
	kinds := r.PromptKindAds()
	if kinds == nil {
		kinds = []string{}
	}
	return &promptHostTelemetry{ProtocolVersion: r.PromptProtocol(), Kinds: kinds, RendererVersion: r.RendererVersion()}
}

// promptHostTelemetry reports the console session's Assist, or nil.
func (h *Heartbeat) promptHostTelemetry() *promptHostTelemetry {
	b := h.sessionBroker
	if b == nil {
		return nil
	}
	s := b.PreferredSessionWithScopeMatching(ipc.ScopeAssist, func(s *sessionbroker.Session) bool {
		return s.HelperRole == ipc.HelperRoleAssist && b.SessionInConsoleSession(s)
	})
	if s == nil {
		return nil
	}
	return promptTelemetryFrom(s)
}

// enabledPromptKinds is the response's kill-switch list; absent = empty.
func enabledPromptKinds(resp *HeartbeatResponse) []string {
	if resp == nil || resp.PromptHost == nil {
		return []string{}
	}
	return append([]string{}, resp.PromptHost.EnabledKinds...)
}

// applyPromptHostSettings hands the kill switch to the prompt host. A kind
// switched off affects new prompts only (plan P15).
func (h *Heartbeat) applyPromptHostSettings(resp *HeartbeatResponse) {
	if h.promptHost == nil {
		return
	}
	h.promptHost.SetEnabledKinds(enabledPromptKinds(resp))
}
