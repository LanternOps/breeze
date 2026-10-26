// Package prompthost owns every prompt the agent shows the person at the
// keyboard (#10190, spec §3.1/§3.2/§3.7). It decides per prompt and per
// session which renderer draws it (Breeze Assist, the native user-helper,
// the SYSTEM helper for elevation, or the legacy path), fences stale
// renderers with leases, applies actions once, keeps deadlines on the
// agent's own clock, and replays open prompts into a reconnecting renderer
// without activating anything.
//
// W02 ships the host dormant: no kind is registered in production, every
// renderer advertises zero kinds, and the server enables none, so every
// prompt still takes its legacy path.
package prompthost

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
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
	// OnExpire runs once when the response budget runs out. If the prompt is
	// still open (not terminal) afterwards, the host closes it as expired.
	OnExpire func()
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
