package ipc

// Prompt host contract (#10190, spec §3.1). One additive IPC contract between
// the agent's prompt host and every renderer (Breeze Assist, the native
// user-helper, and for elevation the SYSTEM helper). The wire is pinned by the
// golden fixtures in packages/shared/src/fixtures/prompt-host, which
// prompt_contract_test.go decodes and re-encodes; packages/shared/src/promptHost
// holds the reference schema.
//
// Compatibility: ProtocolVersion stays 1. A renderer opts in with
// AuthRequest.PromptProtocolVersion + PromptKinds, the broker grants the
// prompt / prompt_operator scopes only for advertised kinds, and the agent
// sends prompt_* only to a session holding the kind (Broker.SendPrompt).
// Every new field is optional; decoders ignore unknown keys.
//
// Encoding rules shared with TS and Rust: optional strings and slices use
// omitempty (absent == empty); two values are always emitted —
// PromptExpiry.ActionID (null = the expiry is not an action) and
// PromptUpdate.Actions when non-nil ([] = "no actions now"). String limits
// count Unicode code points.

// Prompt message types.
const (
	// agent -> renderer
	TypePromptShow         = "prompt_show"
	TypePromptUpdate       = "prompt_update"
	TypePromptClose        = "prompt_close"
	TypePromptActionResult = "prompt_action_result" // reply on the prompt_action envelope
	TypePromptBrandingSync = "prompt_branding_sync"

	// renderer -> agent
	TypePromptPresented = "prompt_presented"
	TypePromptAction    = "prompt_action"
	TypePromptClosed    = "prompt_closed"
)

// Prompt scopes, granted per session only for kinds the renderer advertised.
const (
	// ScopePrompt carries Breeze-owned kinds only (notice.info, remote.*,
	// elevation.request). Same rule as ScopeConsentUI: never operator text.
	ScopePrompt = "prompt"
	// ScopePromptOperator carries kinds whose copy may include MSP text
	// verbatim (restart.prompt, restart.final).
	ScopePromptOperator = "prompt_operator"
)

// PromptProtocolVersion is the envelope / common-field version of the prompt
// contract. Kinds version independently ("<kind>@<n>"); a change to the
// common fields bumps this, never ipc.ProtocolVersion.
const PromptProtocolVersion = 1

// MaxAdvertisedPromptKinds caps AuthRequest.PromptKinds entries the broker reads.
const MaxAdvertisedPromptKinds = 16

// PromptState is a prompt's state: pending -> waiting -> one terminal state.
type PromptState string

const (
	PromptStatePending   PromptState = "pending"
	PromptStateWaiting   PromptState = "waiting"
	PromptStateApproved  PromptState = "approved"
	PromptStateDenied    PromptState = "denied"
	PromptStateExpired   PromptState = "expired"
	PromptStateCancelled PromptState = "cancelled"
	PromptStateFailed    PromptState = "failed"
)

// Terminal reports whether s is a terminal state.
func (s PromptState) Terminal() bool {
	switch s {
	case PromptStateApproved, PromptStateDenied, PromptStateExpired, PromptStateCancelled, PromptStateFailed:
		return true
	}
	return false
}

func (s PromptState) valid() bool {
	return s == PromptStatePending || s == PromptStateWaiting || s.Terminal()
}

// PromptPresentation is how a renderer draws the prompt.
type PromptPresentation string

const (
	PromptPresentationModal     PromptPresentation = "modal"
	PromptPresentationCard      PromptPresentation = "card"
	PromptPresentationIndicator PromptPresentation = "indicator"
	PromptPresentationListOnly  PromptPresentation = "list_only"
)

func (p PromptPresentation) valid() bool {
	switch p {
	case PromptPresentationModal, PromptPresentationCard, PromptPresentationIndicator, PromptPresentationListOnly:
		return true
	}
	return false
}

// PromptActionRole is an action's role. A decision has exactly one safe action.
type PromptActionRole string

const (
	PromptRoleSafe    PromptActionRole = "safe"
	PromptRoleProceed PromptActionRole = "proceed"
	PromptRoleNeutral PromptActionRole = "neutral"
)

// PromptFocus says whether a renderer may take focus.
type PromptFocus string

const (
	PromptFocusSteal      PromptFocus = "steal"
	PromptFocusNoActivate PromptFocus = "no_activate"
)

// PromptCloseReason is why the agent closed a prompt (prompt_close).
type PromptCloseReason string

const (
	PromptCloseResolved   PromptCloseReason = "resolved"
	PromptCloseSuperseded PromptCloseReason = "superseded"
	PromptCloseWithdrawn  PromptCloseReason = "withdrawn"
	PromptCloseExpired    PromptCloseReason = "expired"
	// PromptCloseFenced tells a renderer that no longer holds the lease to
	// take its window down; its clicks are rejected either way.
	PromptCloseFenced PromptCloseReason = "fenced"
)

// PromptClosedReason is why a renderer reports a window gone (prompt_closed).
// Hiding is never a domain action.
type PromptClosedReason string

const (
	PromptClosedHidden       PromptClosedReason = "hidden"
	PromptClosedRenderFailed PromptClosedReason = "render_failed"
	PromptClosedReplaced     PromptClosedReason = "replaced"
)

// PromptActionOutcome is the agent's answer to a prompt_action.
type PromptActionOutcome string

const (
	PromptActionAccepted        PromptActionOutcome = "accepted"
	PromptActionRejectedStale   PromptActionOutcome = "rejected_stale"
	PromptActionRejectedInvalid PromptActionOutcome = "rejected_invalid"
)

// PromptActionVia is how the person took an action.
type PromptActionVia string

const (
	PromptViaClick    PromptActionVia = "click"
	PromptViaKeyboard PromptActionVia = "keyboard"
	PromptViaList     PromptActionVia = "list"
)

// PromptLease names the renderer the agent assigned a prompt to.
// RendererSession is the broker session id (Session.SessionID), never the IPC
// HMAC session key. Epoch is bumped every time the prompt moves renderer.
type PromptLease struct {
	RendererSession string `json:"rendererSession"`
	Epoch           uint32 `json:"epoch"`
}

// PromptAction is one button.
type PromptAction struct {
	ID    string           `json:"id"`
	Label string           `json:"label"`
	Role  PromptActionRole `json:"role"`
}

// PromptCopy holds the agent-rendered plain-text slots. The only renderer
// placeholders are {remaining} and {time:<unixMs>}.
type PromptCopy struct {
	Title        string `json:"title"`
	Body         string `json:"body,omitempty"`
	Consequence  string `json:"consequence,omitempty"`
	OperatorNote string `json:"operatorNote,omitempty"`
	StateDetail  string `json:"stateDetail,omitempty"`
}

// PromptFact is one label/value row.
type PromptFact struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

// PromptExpiry states what happens when the response budget runs out.
// ActionID is always emitted: nil (null) means the expiry is a stated
// consequence, not an action.
type PromptExpiry struct {
	ActionID *string `json:"actionId"`
	Text     string  `json:"text"`
}

// PromptTiming holds the two separate budgets. Expiry is decided by the
// agent's timer, never by a renderer.
type PromptTiming struct {
	PresentWithinMs int64         `json:"presentWithinMs"`
	DeadlineUnixMs  int64         `json:"deadlineUnixMs,omitempty"`
	ResponseMs      int64         `json:"responseMs,omitempty"`
	Expiry          *PromptExpiry `json:"expiry,omitempty"`
}

// PromptListEntry says whether the prompt also lives in the notification list.
type PromptListEntry struct {
	Persistent      bool  `json:"persistent"`
	ExpiresAtUnixMs int64 `json:"expiresAtUnixMs,omitempty"`
}

// PromptIdentityRef pins the MSP identity a prompt was created with.
type PromptIdentityRef struct {
	ScopeID    string `json:"scopeId"`
	LogoSha256 string `json:"logoSha256,omitempty"`
}

// PromptShow (prompt_show) is the full current state of one prompt.
type PromptShow struct {
	PromptID        string             `json:"promptId"`
	Rev             uint64             `json:"rev"`
	Lease           PromptLease        `json:"lease"`
	Kind            string             `json:"kind"`
	KindVersion     int                `json:"kindVersion"`
	State           PromptState        `json:"state"`
	Presentation    PromptPresentation `json:"presentation"`
	Copy            PromptCopy         `json:"copy"`
	Facts           []PromptFact       `json:"facts,omitempty"`
	Actions         []PromptAction     `json:"actions"`
	DefaultActionID string             `json:"defaultActionId,omitempty"`
	Timing          PromptTiming       `json:"timing"`
	Focus           PromptFocus        `json:"focus"`
	ListEntry       PromptListEntry    `json:"listEntry"`
	Locale          string             `json:"locale"`
	Direction       string             `json:"direction"`
	IdentityRef     *PromptIdentityRef `json:"identityRef,omitempty"`
}

// PromptUpdate (prompt_update): a non-nil field replaces the old one. Actions
// and DefaultActionID travel together — when Actions is non-nil it replaces
// the actions AND the default (empty default = none).
type PromptUpdate struct {
	PromptID        string          `json:"promptId"`
	Rev             uint64          `json:"rev"`
	Lease           PromptLease     `json:"lease"`
	State           *PromptState    `json:"state,omitempty"`
	Copy            *PromptCopy     `json:"copy,omitempty"`
	Facts           *[]PromptFact   `json:"facts,omitempty"`
	Actions         *[]PromptAction `json:"actions,omitempty"`
	DefaultActionID string          `json:"defaultActionId,omitempty"`
	Timing          *PromptTiming   `json:"timing,omitempty"`
}

// PromptClose (prompt_close) tells a renderer to take a prompt down.
type PromptClose struct {
	PromptID string            `json:"promptId"`
	Rev      uint64            `json:"rev"`
	Lease    PromptLease       `json:"lease"`
	Reason   PromptCloseReason `json:"reason"`
}

// PromptPresented (prompt_presented): a window was created. Visible is the
// renderer's honest answer (drawable desktop, not behind a detectable lock).
type PromptPresented struct {
	PromptID string      `json:"promptId"`
	Rev      uint64      `json:"rev"`
	Lease    PromptLease `json:"lease"`
	Visible  bool        `json:"visible"`
}

// PromptActionRequest (wire type prompt_action) reports what the person did.
type PromptActionRequest struct {
	PromptID string          `json:"promptId"`
	Rev      uint64          `json:"rev"`
	Lease    PromptLease     `json:"lease"`
	ActionID string          `json:"actionId"`
	Via      PromptActionVia `json:"via"`
}

// PromptActionResult (prompt_action_result) answers a prompt_action on its
// envelope. Rev is the prompt's rev after the action (or the current rev).
type PromptActionResult struct {
	PromptID string              `json:"promptId"`
	ActionID string              `json:"actionId"`
	Result   PromptActionOutcome `json:"result"`
	Rev      uint64              `json:"rev"`
}

// PromptClosed (prompt_closed) reports a renderer's window gone. Detail is an
// optional short token (e.g. "unadvertised_kind") for the agent log.
type PromptClosed struct {
	PromptID string             `json:"promptId"`
	Rev      uint64             `json:"rev"`
	Lease    PromptLease        `json:"lease"`
	Reason   PromptClosedReason `json:"reason"`
	Detail   string             `json:"detail,omitempty"`
}

// PromptLogo is the MSP logo as bytes (padded base64), never a URL.
type PromptLogo struct {
	Sha256 string `json:"sha256"`
	Mime   string `json:"mime"`
	Bytes  int    `json:"bytes"`
	Data   string `json:"data"`
}

// PromptBrandingSync (prompt_branding_sync) carries the effective MSP
// identity, or Cleared=true. Cleared is always emitted.
type PromptBrandingSync struct {
	Cleared      bool        `json:"cleared"`
	ScopeID      string      `json:"scopeId,omitempty"`
	PartnerName  string      `json:"partnerName,omitempty"`
	PrimaryColor string      `json:"primaryColor,omitempty"`
	Logo         *PromptLogo `json:"logo,omitempty"`
	Locale       string      `json:"locale"`
}
