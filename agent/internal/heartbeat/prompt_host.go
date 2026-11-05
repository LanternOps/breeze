package heartbeat

import (
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/inbox"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/prompthost"
	"github.com/breeze-rmm/agent/internal/promptkinds"
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

// startPromptHost builds the prompt host over the session broker and wires
// it in. The prompt list and its 24 h tombstones persist next to the
// endpoint messages (P5: one inbox, two files). It registers the kinds this
// build constructs (W04: notice.info@1) and installs the macOS permission
// notice's skew rule: a helper is told the agent shows the notice only while
// notice.info is live (sessionbroker/tcc_notice.go), and the agent builds the
// notice from that helper's tcc_status.
func (h *Heartbeat) startPromptHost(dataDir string) {
	promptStore, err := inbox.Open(filepath.Join(dataDir, promptInboxFile), inbox.PromptOptions())
	if err != nil {
		log.Warn("prompt inbox unreadable; starting empty", "error", err.Error())
	}
	h.promptListStore = promptStore
	h.promptHost = prompthost.New(prompthost.Deps{
		Broker:   prompthost.NewBrokerDirectory(h.sessionBroker),
		Inbox:    &inbox.PromptInbox{Store: promptStore},
		Identity: h.promptIdentity,
		OSLocale: osUILocale,
	})
	h.sessionBroker.SetPromptSink(h.promptHost)
	promptkinds.Register(h.promptHost)
	h.sessionBroker.SetTCCNoticeGate(h.tccNoticeLive)
	h.sessionBroker.SetTCCStatusHandler(h.handleTCCNotice)
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
