// Package prompthost owns every prompt the agent shows the person at the
// keyboard (#10190, spec §3.1/§3.2/§3.7). It decides per prompt and per
// session which renderer draws it (Breeze Assist, the native user-helper,
// the SYSTEM helper for elevation, or the legacy path), fences stale
// renderers with leases, applies actions once, keeps deadlines on the
// agent's own clock, and replays open prompts into a reconnecting renderer
// without activating anything.
//
// W02 shipped the host dormant. W04 registers the first kind, notice.info@1
// (agent/internal/promptkinds), and the native user-helper advertises it;
// the server still enables none by default, so every prompt keeps its legacy
// path until promptHost.enabledKinds lists the kind. W06 adds remote.consent@1
// (never re-asked: KindSpec.NeverReask) and remote.session@1.
package prompthost

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
)

// Contract timings (plan "Global Constraints"; fixed, not policy).
const (
	defaultPresentWithin  = 10 * time.Second
	defaultLinger         = 8 * time.Second
	promptTombstoneTTL    = 24 * time.Hour
	assistDisconnectGrace = 10 * time.Second
	listEntryTTL          = 7 * 24 * time.Hour
	cardsPerWindow        = 10
	cardWindow            = 10 * time.Minute
	tickInterval          = time.Second
)

// KindSpec describes one kind the agent build speaks.
type KindSpec struct {
	Name    string
	Version int
	// Transitions lists, per state, the actions valid in it and the state
	// each moves to when the domain accepts it without its own patch. An
	// action absent from the current state's map is rejected_invalid. Nil
	// means "any current action is valid; the domain decides the outcome".
	Transitions map[ipc.PromptState]map[string]ipc.PromptState
	// Linger is how long a terminal state stays on screen (default 8 s).
	Linger time.Duration
	// ShowWhileLocked draws the prompt even while its session is locked
	// (remote consent is never deferred). Default: held until unlock.
	ShowWhileLocked bool
	// NeverReask says a prompt of this kind is never moved to another
	// renderer (remote consent, spec §3.7: a lost prompt must never become
	// a second chance to allow). When its renderer is lost — gone, refused
	// it, missed its present budget, or a send failed — the host fences it,
	// withdraws the whole prompt, and calls Prompt.OnRendererLost; there is
	// no disconnect grace, no fallback and no replay. Default: moved.
	NeverReask bool
}

// Owner is the session and user principal a prompt (and its list entry) is
// bound to. Windows: session id + user SID (+ logon id when known). Unix:
// uid (+ session id).
type Owner struct {
	WinSessionID uint32
	UserSID      string
	LogonID      string
	UID          int
	UnixSession  string
}

// Key identifies the owner for routing and for the notification list. It
// leaves out the logon id: the broker cannot observe it for a connected
// renderer. Matches compares it when both sides know it.
func (o Owner) Key() string {
	if o.WinSessionID != 0 || o.UserSID != "" {
		return fmt.Sprintf("win:%d:%s", o.WinSessionID, o.UserSID)
	}
	return fmt.Sprintf("unix:%d:%s", o.UID, o.UnixSession)
}

// PrincipalKey identifies the user principal alone (Windows SID, Unix uid).
// It owns notification-list entries: stable across sign-ins (an
// after-the-fact entry reaches the same person in their next session) and
// never shared between two users.
func (o Owner) PrincipalKey() string {
	if o.WinSessionID != 0 || o.UserSID != "" {
		return "win:" + o.UserSID
	}
	return fmt.Sprintf("unix:%d", o.UID)
}

// Matches reports whether two owners are the same principal in the same
// session; a logon id is compared only when both carry one.
func (o Owner) Matches(other Owner) bool {
	if o.Key() != other.Key() {
		return false
	}
	return o.LogonID == "" || other.LogonID == "" || o.LogonID == other.LogonID
}

// Patch changes a live prompt (a non-nil field replaces; Actions and
// DefaultActionID travel together, as in ipc.PromptUpdate).
type Patch struct {
	State           *ipc.PromptState
	Copy            *ipc.PromptCopy
	Facts           *[]ipc.PromptFact
	Actions         *[]ipc.PromptAction
	DefaultActionID string
	Timing          *ipc.PromptTiming
	// Relocalize renders the patched Copy, Facts and action labels through
	// Prompt.Localize for each renderer's locale (a confirm step whose copy
	// is catalog copy). Default: the patch is sent as given.
	Relocalize bool
	// Presentation, Focus and Roles cannot change in place (prompt_update
	// carries none of them). When any is set the prompt is placed again:
	// every renderer copy is fenced and the selector picks again under the
	// prompt's (new) roles, with a new lease and a full prompt_show (the
	// elevation first question becoming the waiting card, #10190 W07).
	Presentation *ipc.PromptPresentation
	Focus        *ipc.PromptFocus
	Roles        *[]ipc.HelperRole
	// NeverReask replaces the prompt's own NeverReask (Prompt.NeverReask).
	NeverReask *bool
}

// ActionOutcome is the domain's answer to an action.
type ActionOutcome struct {
	// Accepted false answers rejected_invalid (the domain refused it, e.g.
	// the request was decided meanwhile).
	Accepted bool
	// Patch, when set, is applied to the prompt (rev bumped, every renderer
	// updated). When nil, the kind's transition table supplies the state.
	Patch *Patch
	// Close, when set, closes the prompt with this reason after the patch.
	Close *ipc.PromptCloseReason
}

// Prompt is one prompt the domain asks the host to show.
type Prompt struct {
	// ID is the stable, domain-derived prompt id (elevation:<id>, ...).
	ID     string
	Kind   KindSpec
	Owners []Owner
	// Show is the content; the host sets promptId, rev, lease, kind and
	// kindVersion per renderer.
	Show ipc.PromptShow
	// Legacy sends today's message type to the owner's session (nil = no
	// legacy path for this kind).
	Legacy func(Owner) error
	// Headless is the Linux daemon-drawn fallback (nil = none).
	Headless func() error
	// OnAction applies an action to the domain. It runs outside the host's
	// state lock (it may call Update/Close) but serialized with every other
	// action, so two sessions answering at once apply exactly one decision.
	OnAction func(actionID string, from Owner) (ActionOutcome, error)
	// OnActionRenderer is OnAction for a domain that records which renderer
	// carried the decision (the restart audit's assist | native): role is
	// the helper role of the renderer whose lease the action quoted. Used
	// only when OnAction is nil; same locking contract.
	OnActionRenderer func(actionID string, from Owner, role ipc.HelperRole) (ActionOutcome, error)
	// OnExpire runs once when the response budget runs out. If the prompt is
	// still open (not terminal) afterwards, the host closes it as expired.
	OnExpire func()
	// Localize renders the prompt's locale-dependent content in one
	// session's catalog locale (spec §3.1 "Who renders copy": the session's
	// UI language, then the machine's, then en). Optional: nil means Show is
	// sent as built. The host calls it under its state lock for every
	// renderer and every list entry, so it must be pure — catalog lookups
	// only, no host calls. A copy replaced later by a Patch is sent as given.
	Localize func(loc promptcatalog.Locale) (Localized, error)
	// OnRendererLost runs once, outside the host's locks, when a NeverReask
	// prompt lost its renderer and was withdrawn. info is where the prompt
	// was (Presented says whether it had been on screen); reason is
	// renderer_gone, render_failed, present_budget or send_failed.
	OnRendererLost func(info PlacementInfo, reason string)
	// Roles, when set, are the only renderer roles that may draw this
	// prompt, in preference order (default: Assist, then the kind's native
	// role). The elevation first question uses it: with UAC on the secure
	// desktop only the SYSTEM helper can be seen, so only it may draw.
	Roles []ipc.HelperRole
	// NeverReask is KindSpec.NeverReask for this prompt alone (either one
	// set makes it never re-asked). A Patch can clear it: the elevation
	// first question is never re-asked, its waiting card is replayed.
	NeverReask bool
	// Reshowable says the condition the prompt reports can come back (the
	// macOS permission notice): only a resolved close tombstones it. Closed
	// undecided — expired, withdrawn, superseded — the domain may show the
	// same id again at once. Default: every close tombstones for 24 h.
	Reshowable bool
}

// Localized is the locale-dependent content of a prompt: the copy, the
// facts, and the label of each action (by id; an action whose id is absent
// keeps its label).
type Localized struct {
	Copy         ipc.PromptCopy
	Facts        []ipc.PromptFact
	ActionLabels map[string]string
	// ExpiryText, when set, replaces timing.expiry.text (the consequence
	// sentence) on a prompt that carries an expiry.
	ExpiryText string
}

// PlacementInfo is where one owner's copy of an open prompt is.
type PlacementInfo struct {
	Path        Path
	RendererKey string // broker session id while on the prompt path
	Role        ipc.HelperRole
	Presented   bool // the renderer confirmed it on screen (prompt_presented)
}

// RendererSession is a live, authenticated renderer as the broker sees it.
type RendererSession struct {
	Key         string // broker session id; the lease's rendererSession
	Role        ipc.HelperRole
	Owner       Owner
	Protocol    int      // clamped prompt protocol; 0 = predates the contract
	KindAds     []string // granted "<kind>@<n>"
	Version     string
	ConnectedAt time.Time
	// UILocale is the UI language the renderer reported at auth ("" = unknown).
	UILocale string
}

// RendererDirectory is the host's view of the broker.
type RendererDirectory interface {
	// Renderers returns the live renderers in the owner's session, including
	// ones that advertised nothing (Protocol 0).
	Renderers(o Owner) []RendererSession
	// Send delivers an agent -> renderer prompt message (Broker.SendPrompt).
	Send(sessionKey, msgType, kind string, payload any) error
}

// ListEntry is one notification-list entry: a prompt as shown to one owner.
type ListEntry struct {
	ID        string // promptId + "#" + owner principal key
	PromptID  string
	OwnerKey  string // Owner.PrincipalKey
	ScopeID   string
	ExpiresAt time.Time
	Show      ipc.PromptShow
}

// PromptInbox persists list entries and prompt tombstones (implemented over
// the agent's inbox store). Nil means nothing persists across restarts. The
// host calls the writes after releasing its state lock, in order.
type PromptInbox interface {
	PutPrompt(e ListEntry) error
	RetractPrompt(id string) error
	TombstonePrompt(promptID string) error
	PromptTombstoned(promptID string) bool
	PromptEntries(ownerKey string) []ListEntry
}

// Clock is the host's time source. Deadlines are checked against Now() on a
// 1 s tick, so a sleep across a deadline fires on resume.
type Clock interface{ Now() time.Time }

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now() }

// SessionEvent is a Windows session state change the host reacts to.
type SessionEvent int

const (
	SessionLocked SessionEvent = iota + 1
	SessionUnlocked
)

func listEntryID(promptID string, o Owner) string { return promptID + "#" + o.PrincipalKey() }
