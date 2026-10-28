// Native prompt renderer (#10190 W02, spec §2 "Native fallback matrix",
// §5): the user-helper's renderer for the prompt host contract.
//
// Untagged on purpose (the consent_dialog_spec.go precedent): everything
// that decides WHAT a native dialog shows — its buttons, which one is the
// default, what Esc means, the countdown, the copy, how a result maps back to
// an action — lives on this side of the build tag, so every OS's CI run
// checks every platform's dialog. The windows/darwin/linux files only draw.
//
// The native fallback must never default to the proceed action, turn a
// timeout into a decision, render operator text on a breeze-class kind, keep
// a dialog up the agent closed, or draw a second copy of a prompt.
//
// W04 advertises notice.info@1 and W05 restart.prompt@1 / restart.final@1
// (the user helper only); any other kind that arrives anyway is answered
// prompt_closed{render_failed} (spec §3.1 rule 4). A kind is live only where
// the server also enables it.
package userhelper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

var (
	errNoSafeDefault            = errors.New("prompt: a decision needs exactly one safe action as its default")
	errOperatorTextOnBreezeKind = errors.New("prompt: operator text on a breeze-class kind")
)

var (
	promptMessageSeq   atomic.Uint64
	rendererVersionVal atomic.Value // string
)

// SetRendererVersion records the build version the helper reports as its
// prompt renderer version (AuthRequest.RendererVersion).
func SetRendererVersion(v string) { rendererVersionVal.Store(v) }

func helperRendererVersion() string {
	v, _ := rendererVersionVal.Load().(string)
	return v
}

// advertisedNativePromptKinds is what the native renderer advertises at
// auth ("<kind>@<n>"). Kinds are added by the wave that ships each one (plan
// P2): W04 adds notice.info@1 for the user helper, W05 the restart card and
// its closing card (drawn natively as a TaskDialogIndirect / display dialog /
// zenity question with the safe action — Postpone or OK — as the default).
// The SYSTEM helper's renderer (elevation) ships in W07 (P14).
func advertisedNativePromptKinds(role ipc.HelperRole) []string {
	if role == ipc.HelperRoleUser {
		return []string{
			"notice.info@1",
			"restart.prompt@1", // W05
			"restart.final@1",  // W05
		}
	}
	return []string{}
}

// NativePromptAdvertisement is what a native helper of this build advertises
// at auth for a role: AuthRequest.PromptProtocolVersion and PromptKinds.
func NativePromptAdvertisement(role ipc.HelperRole) (protocol int, kinds []string) {
	return nativePromptProtocolFor(role), advertisedNativePromptKinds(role)
}

// nativePromptProtocolFor is the prompt protocol a helper role advertises.
// The SYSTEM helper's renderer (elevation) ships in W07 (plan P14).
func nativePromptProtocolFor(role ipc.HelperRole) int {
	if role == ipc.HelperRoleUser {
		return ipc.PromptProtocolVersion
	}
	return 0
}

type nativeButton struct {
	ID    string
	Label string
	Role  ipc.PromptActionRole
}

// nativePromptModel is one native dialog, platform-neutral.
type nativePromptModel struct {
	PromptID string
	Title    string
	Body     string
	Buttons  []nativeButton // safe first, then proceed, then neutral
	// DefaultID is the button focused by default (the safe action on a decision).
	DefaultID string
	// CancelID is what Esc and the close box mean: the safe action on a
	// pending decision, "" (hide, not an action) everywhere else.
	CancelID string
	Decision bool
	Deadline time.Time     // absolute response deadline (zero = none)
	Response time.Duration // response window from presentation, when no Deadline
}

func (m nativePromptModel) button(id string) (nativeButton, bool) {
	for _, b := range m.Buttons {
		if b.ID == id {
			return b, true
		}
	}
	return nativeButton{}, false
}

// buildNativePromptModel turns a prompt_show into a native dialog, refusing
// anything a renderer must refuse.
func buildNativePromptModel(p ipc.PromptShow, now time.Time, loc *time.Location) (nativePromptModel, error) {
	if class, ok := ipc.PromptKindClass(p.Kind); (!ok || class == ipc.PromptCopyBreeze) && p.Copy.OperatorNote != "" {
		return nativePromptModel{}, errOperatorTextOnBreezeKind
	}
	decision := ipc.IsPromptDecision(p.State, p.Presentation)
	if decision {
		safe, count := "", 0
		for _, a := range p.Actions {
			if a.Role == ipc.PromptRoleSafe {
				safe, count = a.ID, count+1
			}
		}
		if count != 1 || p.DefaultActionID != safe {
			return nativePromptModel{}, errNoSafeDefault
		}
	}
	if err := ipc.ValidatePromptShow(p); err != nil {
		return nativePromptModel{}, fmt.Errorf("prompt: %w", err)
	}
	if loc == nil {
		loc = time.Local
	}
	m := nativePromptModel{PromptID: p.PromptID, Decision: decision}
	if p.Timing.DeadlineUnixMs > 0 {
		m.Deadline = time.UnixMilli(p.Timing.DeadlineUnixMs)
	} else if p.Timing.ResponseMs > 0 {
		m.Response = time.Duration(p.Timing.ResponseMs) * time.Millisecond
	}
	textDeadline := m.Deadline
	if textDeadline.IsZero() && m.Response > 0 {
		textDeadline = now.Add(m.Response)
	}
	render := func(s string) string { return applyNativePlaceholders(s, textDeadline, now, loc) }

	m.Title = render(p.Copy.Title)
	var parts []string
	if p.Copy.Body != "" {
		parts = append(parts, render(p.Copy.Body))
	}
	if len(p.Facts) > 0 {
		lines := make([]string, 0, len(p.Facts))
		for _, f := range p.Facts {
			lines = append(lines, f.Label+": "+f.Value)
		}
		parts = append(parts, strings.Join(lines, "\n"))
	}
	for _, s := range []string{p.Copy.Consequence, p.Copy.StateDetail} {
		if s != "" {
			parts = append(parts, render(s))
		}
	}
	if p.Copy.OperatorNote != "" {
		parts = append(parts, p.Copy.OperatorNote) // MSP copy, verbatim
	}
	m.Body = strings.Join(parts, "\n\n")

	for _, role := range []ipc.PromptActionRole{ipc.PromptRoleSafe, ipc.PromptRoleProceed, ipc.PromptRoleNeutral} {
		for _, a := range p.Actions {
			if a.Role == role {
				m.Buttons = append(m.Buttons, nativeButton{ID: a.ID, Label: render(a.Label), Role: a.Role})
			}
		}
	}
	switch {
	case decision:
		m.DefaultID, m.CancelID = p.DefaultActionID, p.DefaultActionID
	case p.DefaultActionID != "":
		m.DefaultID = p.DefaultActionID
	case len(m.Buttons) > 0:
		m.DefaultID = m.Buttons[0].ID
	}
	return m, nil
}

var nativePlaceholder = regexp.MustCompile(`\{remaining\}|\{time:([0-9]{1,16})\}`)

// applyNativePlaceholders fills the two renderer-owned placeholders:
// {remaining} (M:SS until deadline, never negative) and {time:<unixMs>}
// (local wall clock; with the date when not today). Anything else in braces,
// including operator {{countdown}}, stays literal.
func applyNativePlaceholders(text string, deadline, now time.Time, loc *time.Location) string {
	return nativePlaceholder.ReplaceAllStringFunc(text, func(tok string) string {
		if tok == "{remaining}" {
			if deadline.IsZero() {
				return tok
			}
			left := deadline.Sub(now)
			if left < 0 {
				left = 0
			}
			secs := int(left / time.Second)
			return fmt.Sprintf("%d:%02d", secs/60, secs%60)
		}
		ms, err := strconv.ParseInt(tok[len("{time:"):len(tok)-1], 10, 64)
		if err != nil {
			return tok
		}
		at := time.UnixMilli(ms).In(loc)
		n := now.In(loc)
		if at.Year() == n.Year() && at.YearDay() == n.YearDay() {
			return at.Format("15:04")
		}
		return at.Format("Jan 2 15:04")
	})
}

// nativeTimeout is how long the dialog may stay up before its own countdown
// gives up (0 = no countdown). Expiry is still the agent's decision; this
// only stops a stale dialog lingering.
func nativeTimeout(m nativePromptModel, now time.Time) time.Duration {
	switch {
	case !m.Deadline.IsZero():
		if left := m.Deadline.Sub(now); left > time.Second {
			return left
		}
		return time.Second
	case m.Response > 0:
		return m.Response
	}
	return 0
}

// twoButtons is what a two-button dialog (macOS, Linux) can draw: the
// default action and the most significant other one. A neutral third action
// is dropped there (it stays reachable from Breeze Assist's list).
func (m nativePromptModel) twoButtons() []nativeButton {
	if len(m.Buttons) <= 2 {
		return m.Buttons
	}
	def, _ := m.button(m.DefaultID)
	out := []nativeButton{def}
	for _, b := range m.Buttons {
		if b.ID != def.ID {
			return append(out, b) // buttons are ordered safe, proceed, neutral
		}
	}
	return out
}

// --- Windows: TaskDialogIndirect, with a MessageBoxTimeoutW fallback ---

type nativeTaskButton struct {
	ControlID int32
	ID        string
	Label     string
}

type nativeTaskDialogSpec struct {
	Title, Instruction, Content string
	Buttons                     []nativeTaskButton
	DefaultControlID            int32
	// AllowCancel sets TDF_ALLOW_DIALOG_CANCELLATION: Esc and the close box
	// end the dialog with IDCANCEL, which maps to the model's CancelID.
	AllowCancel bool
}

const nativeTaskButtonBase = 1000

func nativeTaskDialogSpecFor(m nativePromptModel) nativeTaskDialogSpec {
	s := nativeTaskDialogSpec{Title: m.Title, Instruction: m.Title, Content: m.Body, AllowCancel: true}
	for i, b := range m.Buttons {
		id := int32(nativeTaskButtonBase + i)
		s.Buttons = append(s.Buttons, nativeTaskButton{ControlID: id, ID: b.ID, Label: b.Label})
		if b.ID == m.DefaultID {
			s.DefaultControlID = id
		}
	}
	return s
}

// DefaultButtonIndex is the index of the default button (-1 if none).
func (s nativeTaskDialogSpec) DefaultButtonIndex() int {
	for i, b := range s.Buttons {
		if b.ControlID == s.DefaultControlID {
			return i
		}
	}
	return -1
}

// actionFor maps a TaskDialogIndirect pnButton back to an action id.
func (s nativeTaskDialogSpec) actionFor(controlID int32) (string, bool) {
	for _, b := range s.Buttons {
		if b.ControlID == controlID {
			return b.ID, true
		}
	}
	return "", false
}

// MessageBoxTimeoutW fallback (comctl32 v6 / TaskDialogIndirect unavailable):
// it cannot relabel buttons, so a decision becomes Yes (the other action) /
// No (the safe action, the default) with the body saying what each means; a
// non-decision becomes OK for its default action.
type nativeMessageBoxSpec struct {
	Title, Body string
	Flags       uint32
	YesID, NoID string // MB_YESNO
	OKID        string // MB_OK
}

const (
	nativeMBOK     = 0x00000000
	nativeIDOK     = 1
	nativeIDCancel = 2
)

func nativeMessageBoxSpecFor(m nativePromptModel) nativeMessageBoxSpec {
	s := nativeMessageBoxSpec{Title: m.Title, Body: m.Body}
	btns := m.twoButtons()
	if m.Decision && len(btns) == 2 {
		safe, other := btns[0], btns[1]
		s.YesID, s.NoID = other.ID, safe.ID
		s.Body += fmt.Sprintf("\r\n\r\nSelect Yes to %s, or No to %s.", strings.ToLower(other.Label), strings.ToLower(safe.Label))
		s.Flags = consentMBYesNo | consentMBDefButton2 | consentMBIconQuestion | consentMBTopMost | consentMBSetForeground
		return s
	}
	s.OKID = m.DefaultID
	s.Flags = nativeMBOK | consentMBTopMost | consentMBSetForeground
	return s
}

// --- macOS: osascript display dialog ---

func nativePromptOsascript(m nativePromptModel, now time.Time) string {
	btns := m.twoButtons()
	labels := make([]string, 0, len(btns))
	def := ""
	// The default goes last (rightmost), as macOS dialogs place it.
	for i := len(btns) - 1; i >= 0; i-- {
		if btns[i].ID == m.DefaultID {
			def = btns[i].Label
			continue
		}
		labels = append(labels, `"`+escapeAppleScript(btns[i].Label)+`"`)
	}
	if def != "" {
		labels = append(labels, `"`+escapeAppleScript(def)+`"`)
	}
	script := fmt.Sprintf(`display dialog "%s" with title "%s" buttons {%s}`,
		escapeAppleScript(m.Body), escapeAppleScript(m.Title), strings.Join(labels, ", "))
	if def != "" {
		script += fmt.Sprintf(` default button "%s"`, escapeAppleScript(def))
	}
	if cancel, ok := m.button(m.CancelID); ok {
		script += fmt.Sprintf(` cancel button "%s"`, escapeAppleScript(cancel.Label))
	}
	if t := nativeTimeout(m, now); t > 0 {
		script += fmt.Sprintf(" giving up after %d", int((t+time.Second-1)/time.Second))
	}
	return script
}

// classifyNativeOsascript maps an osascript run: -128 is the cancel button
// (or Esc), "gave up" a timeout, "button returned:<label>" a button.
func classifyNativeOsascript(m nativePromptModel, output string, failed bool) nativeOutcome {
	if failed {
		if strings.Contains(output, "-128") {
			return classifyNativeResult(m, nativeResultCancel, "")
		}
		return nativeOutcome{Err: fmt.Errorf("osascript: %s", strings.TrimSpace(output))}
	}
	if strings.Contains(output, "gave up:true") {
		return classifyNativeResult(m, nativeResultTimeout, "")
	}
	const marker = "button returned:"
	if i := strings.Index(output, marker); i >= 0 {
		label := output[i+len(marker):]
		if j := strings.Index(label, ", gave up:"); j >= 0 {
			label = label[:j]
		}
		label = strings.TrimRight(label, "\r\n")
		for _, b := range m.twoButtons() {
			if b.Label == label {
				return classifyNativeResult(m, nativeResultButton, b.ID)
			}
		}
	}
	return nativeOutcome{Err: fmt.Errorf("osascript: unrecognised result %q", strings.TrimSpace(output))}
}

// --- Linux: zenity ---

func nativePromptZenityArgs(m nativePromptModel, now time.Time) []string {
	btns := m.twoButtons()
	var args []string
	if m.Decision && len(btns) == 2 {
		args = []string{"--question", "--no-markup", "--title", m.Title, "--text", m.Body,
			"--ok-label", btns[1].Label, "--cancel-label", btns[0].Label, "--default-cancel"}
	} else {
		label := "OK"
		if b, ok := m.button(m.DefaultID); ok {
			label = b.Label
		}
		args = []string{"--info", "--no-markup", "--title", m.Title, "--text", m.Body, "--ok-label", label}
	}
	if t := nativeTimeout(m, now); t > 0 {
		args = append(args, fmt.Sprintf("--timeout=%d", int((t+time.Second-1)/time.Second)))
	}
	return args
}

// classifyNativeZenityRun maps a zenity run. GTK also exits 1 when it cannot
// open the display, which must never read as the user's cancel (on a decision
// that would answer the safe action for them).
func classifyNativeZenityRun(m nativePromptModel, exitCode int, stderr string) nativeOutcome {
	if exitCode == 1 && (strings.Contains(stderr, "cannot open display") || strings.Contains(stderr, "Gtk-WARNING")) {
		return nativeOutcome{Err: fmt.Errorf("zenity could not open the display: %s", strings.TrimSpace(stderr))}
	}
	return classifyNativeZenity(m, exitCode)
}

// classifyNativeZenity maps a zenity exit: 0 = OK, 1 = Cancel / Esc / close,
// 5 = timeout, anything else = could not draw.
func classifyNativeZenity(m nativePromptModel, exitCode int) nativeOutcome {
	btns := m.twoButtons()
	question := m.Decision && len(btns) == 2
	switch exitCode {
	case 0:
		if question {
			return classifyNativeResult(m, nativeResultButton, btns[1].ID)
		}
		return classifyNativeResult(m, nativeResultButton, m.DefaultID)
	case 1:
		return classifyNativeResult(m, nativeResultCancel, "")
	case 5:
		return classifyNativeResult(m, nativeResultTimeout, "")
	}
	return nativeOutcome{Err: fmt.Errorf("zenity exited %d", exitCode)}
}

// --- results ---

type nativeResultKind int

const (
	nativeResultButton nativeResultKind = iota + 1
	nativeResultCancel
	nativeResultTimeout
)

// nativeOutcome is what a native dialog ended with.
type nativeOutcome struct {
	ActionID string // a button (or Esc on a decision -> the safe action)
	Hidden   bool   // closed without an action
	TimedOut bool   // its own countdown ran out: never a decision
	Err      error  // it could not be drawn
}

func classifyNativeResult(m nativePromptModel, kind nativeResultKind, buttonID string) nativeOutcome {
	switch kind {
	case nativeResultButton:
		if _, ok := m.button(buttonID); ok && buttonID != "" {
			return nativeOutcome{ActionID: buttonID}
		}
		return nativeOutcome{Err: fmt.Errorf("native dialog returned unknown button %q", buttonID)}
	case nativeResultCancel:
		if m.CancelID != "" {
			return nativeOutcome{ActionID: m.CancelID}
		}
		return nativeOutcome{Hidden: true}
	case nativeResultTimeout:
		return nativeOutcome{TimedOut: true}
	}
	return nativeOutcome{Err: errors.New("native dialog: unknown result")}
}

// --- runtime ---

type nativeShowFunc func(ctx context.Context, m nativePromptModel, presented func()) nativeOutcome

type nativeActive struct {
	show   ipc.PromptShow
	cancel context.CancelFunc
}

// maxEndedNativePrompts bounds the memory of dialogs that ended on screen.
const maxEndedNativePrompts = 64

// nativePromptRenderer runs the native side of the prompt contract: one
// dialog per prompt, presented / action / closed reported on the prompt's
// lease, a prompt_close (or a newer rev) taking the dialog down silently.
type nativePromptRenderer struct {
	advertised map[string]bool
	show       nativeShowFunc
	send       func(msgType string, payload any) error
	now        func() time.Time

	mu     sync.Mutex
	active map[string]*nativeActive
	// ended remembers prompts whose dialog ended on screen (answered,
	// hidden, timed out), so a later update is applied (redraw while still
	// open, ignore once terminal) instead of being refused as unknown — a
	// refusal would make the agent reroute a prompt the user already
	// answered.
	ended      map[string]ipc.PromptShow
	endedOrder []string

	// Notice delivery (notice_delivery.go): the session's notification
	// state (nil where the platform has no such query: the notice is the
	// dialog), the toast, and the re-poll interval of a held notice.
	noticeState  func() (uint32, error)
	toast        func(ipc.NotifyRequest) bool
	noticeRepoll time.Duration
	// noticeStateFailing / noticeStateWarnings (guarded by mu): the query
	// is failing, and how many failure streaks were warned about.
	noticeStateFailing  bool
	noticeStateWarnings int
}

func newNativePromptRenderer(advertised []string, show nativeShowFunc, send func(string, any) error, now func() time.Time) *nativePromptRenderer {
	r := &nativePromptRenderer{advertised: map[string]bool{}, show: show, send: send, now: now, active: map[string]*nativeActive{}, ended: map[string]ipc.PromptShow{},
		noticeState: platformNotificationState, toast: showNotification, noticeRepoll: defaultNoticeRepoll}
	for _, ad := range advertised {
		r.advertised[ad] = true
	}
	if r.now == nil {
		r.now = time.Now
	}
	return r
}

// closeAll takes every dialog down without reporting anything: the
// connection ended, and the agent re-shows what is still open on reconnect.
func (r *nativePromptRenderer) closeAll() {
	r.mu.Lock()
	active := r.active
	r.active = map[string]*nativeActive{}
	r.mu.Unlock()
	for _, a := range active {
		a.cancel()
	}
}

// rememberEndedLocked records a dialog that ended on screen. Caller holds mu.
func (r *nativePromptRenderer) rememberEndedLocked(p ipc.PromptShow) {
	if _, seen := r.ended[p.PromptID]; !seen {
		r.endedOrder = append(r.endedOrder, p.PromptID)
	}
	r.ended[p.PromptID] = p
	for len(r.endedOrder) > maxEndedNativePrompts {
		delete(r.ended, r.endedOrder[0])
		r.endedOrder = r.endedOrder[1:]
	}
}

func (r *nativePromptRenderer) activeCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.active)
}

func (r *nativePromptRenderer) reply(typ string, payload any) {
	if err := r.send(typ, payload); err != nil {
		log.Warn("prompt reply not sent", "type", typ, "error", err.Error())
	}
}

func (r *nativePromptRenderer) renderFailed(p ipc.PromptShow, detail string) {
	r.reply(ipc.TypePromptClosed, ipc.PromptClosed{PromptID: p.PromptID, Rev: max(p.Rev, 1), Lease: p.Lease, Reason: ipc.PromptClosedRenderFailed, Detail: detail})
}

// handle processes one agent -> renderer prompt message.
func (r *nativePromptRenderer) handle(env *ipc.Envelope) {
	switch env.Type {
	case ipc.TypePromptShow:
		var p ipc.PromptShow
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			// Unknown is never silent for a decision (rule 4): answer what we
			// can identify so the agent falls back now, not after its budget.
			var ref struct {
				PromptID string          `json:"promptId"`
				Rev      uint64          `json:"rev"`
				Lease    ipc.PromptLease `json:"lease"`
			}
			_ = json.Unmarshal(env.Payload, &ref)
			log.Warn("malformed prompt_show", "promptId", ref.PromptID, "error", err.Error())
			if ref.PromptID != "" {
				r.renderFailed(ipc.PromptShow{PromptID: ref.PromptID, Rev: ref.Rev, Lease: ref.Lease}, "malformed")
			}
			return
		}
		r.onShow(p)
	case ipc.TypePromptUpdate:
		var u ipc.PromptUpdate
		if err := json.Unmarshal(env.Payload, &u); err != nil {
			log.Warn("malformed prompt_update", "error", err.Error())
			return
		}
		r.onUpdate(u)
	case ipc.TypePromptClose:
		var c ipc.PromptClose
		if err := json.Unmarshal(env.Payload, &c); err != nil {
			log.Warn("malformed prompt_close", "error", err.Error())
			return
		}
		r.onClose(c)
	case ipc.TypePromptActionResult:
		// A native dialog has no "working" state: it already closed. A refusal
		// means the click did not count; the agent re-shows the prompt if it
		// is still open.
		var res ipc.PromptActionResult
		if err := json.Unmarshal(env.Payload, &res); err == nil && res.Result != ipc.PromptActionAccepted {
			log.Warn("native prompt action not accepted", "promptId", res.PromptID, "action", res.ActionID, "result", res.Result)
		}
	case ipc.TypePromptBrandingSync:
		// A native dialog draws no identity header.
	default:
		log.Warn("unsupported prompt message type", "type", env.Type)
	}
}

func (r *nativePromptRenderer) onShow(p ipc.PromptShow) {
	if !r.advertised[fmt.Sprintf("%s@%d", p.Kind, p.KindVersion)] {
		r.renderFailed(p, "unadvertised_kind")
		return
	}
	r.mu.Lock()
	if cur := r.active[p.PromptID]; cur != nil && p.Rev <= cur.show.Rev {
		adopt := p.Rev == cur.show.Rev && p.Lease != cur.show.Lease
		if adopt {
			// A replay of the same rev under a new lease: keep the window,
			// answer on the new lease, and confirm it is on screen.
			cur.show.Lease = p.Lease
		}
		r.mu.Unlock()
		if adopt {
			r.reply(ipc.TypePromptPresented, ipc.PromptPresented{PromptID: p.PromptID, Rev: p.Rev, Lease: p.Lease, Visible: true})
		}
		return // stale or duplicate: the dialog for this prompt is already up
	}
	r.mu.Unlock()
	r.draw(p)
}

func (r *nativePromptRenderer) onUpdate(u ipc.PromptUpdate) {
	r.mu.Lock()
	var base ipc.PromptShow
	cur := r.active[u.PromptID]
	ended, wasEnded := r.ended[u.PromptID]
	switch {
	case cur != nil:
		base = cur.show
	case wasEnded:
		base = ended
	}
	r.mu.Unlock()
	if cur == nil && !wasEnded {
		r.renderFailed(ipc.PromptShow{PromptID: u.PromptID, Rev: u.Rev, Lease: u.Lease}, "unknown_prompt")
		return
	}
	if u.Rev <= base.Rev {
		return
	}
	merged, err := ipc.ApplyPromptUpdate(base, u)
	if err != nil {
		r.renderFailed(ipc.PromptShow{PromptID: u.PromptID, Rev: u.Rev, Lease: u.Lease}, "invalid_update")
		r.takeDown(u.PromptID)
		return
	}
	if merged.State.Terminal() {
		// The native fallback shows no terminal card; the outcome is in the
		// agent's list. Take the question down (nothing to do if it ended).
		r.takeDown(u.PromptID)
		r.mu.Lock()
		if _, ok := r.ended[u.PromptID]; ok {
			r.rememberEndedLocked(merged)
		}
		r.mu.Unlock()
		return
	}
	// A native dialog cannot change in place: redraw it.
	r.draw(merged)
}

func (r *nativePromptRenderer) onClose(c ipc.PromptClose) {
	r.mu.Lock()
	cur := r.active[c.PromptID]
	r.mu.Unlock()
	if cur == nil || c.Rev < cur.show.Rev {
		return
	}
	r.takeDown(c.PromptID)
}

// takeDown cancels a dialog without reporting anything: the agent closed it.
func (r *nativePromptRenderer) takeDown(promptID string) {
	r.mu.Lock()
	cur := r.active[promptID]
	delete(r.active, promptID)
	r.mu.Unlock()
	if cur != nil {
		cur.cancel()
	}
}

func (r *nativePromptRenderer) draw(p ipc.PromptShow) {
	if p.Presentation == ipc.PromptPresentationListOnly || p.State.Terminal() {
		// A list entry (a reconnect replay, a rate-limited card) or a
		// finished outcome: a native helper has no list, so nothing is
		// drawn and nothing is re-toasted. It is remembered so a later
		// update or a restored card at a newer rev is handled.
		r.takeDown(p.PromptID)
		r.mu.Lock()
		r.rememberEndedLocked(p)
		r.mu.Unlock()
		return
	}
	m, err := buildNativePromptModel(p, r.now(), nil)
	if err != nil {
		detail := "invalid_prompt"
		switch {
		case errors.Is(err, errNoSafeDefault):
			detail = "no_safe_default"
		case errors.Is(err, errOperatorTextOnBreezeKind):
			detail = "operator_text_on_breeze_kind"
		}
		log.Warn("native renderer refused a prompt", "promptId", p.PromptID, "error", err.Error())
		r.takeDown(p.PromptID) // never leave an older copy up
		r.renderFailed(p, detail)
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	act := &nativeActive{show: p, cancel: cancel}
	r.mu.Lock()
	prev := r.active[p.PromptID]
	r.active[p.PromptID] = act
	r.mu.Unlock()
	if prev != nil {
		prev.cancel() // one window per prompt: the redraw replaces it
	}
	lease := func() ipc.PromptLease {
		r.mu.Lock()
		defer r.mu.Unlock()
		return act.show.Lease // a replay may have moved it
	}
	go func() {
		if r.usesNotificationState(p) && r.deliverNotice(ctx, p, m, lease) {
			// Toasted, or the hold ended (withdrawn, expired): no dialog,
			// nothing more to report. The agent's list keeps the entry.
			r.mu.Lock()
			if r.active[p.PromptID] == act {
				delete(r.active, p.PromptID)
				if ctx.Err() == nil {
					r.rememberEndedLocked(act.show)
				}
			}
			r.mu.Unlock()
			return
		}
		var out nativeOutcome
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					out = nativeOutcome{Err: fmt.Errorf("native dialog panicked: %v", rec)}
				}
			}()
			out = r.show(ctx, m, func() {
				r.reply(ipc.TypePromptPresented, ipc.PromptPresented{PromptID: p.PromptID, Rev: p.Rev, Lease: lease(), Visible: true})
			})
		}()
		r.mu.Lock()
		current := r.active[p.PromptID] == act
		if current {
			delete(r.active, p.PromptID)
			if out.Err == nil {
				r.rememberEndedLocked(act.show)
			}
		}
		l := act.show.Lease
		r.mu.Unlock()
		p.Lease = l
		if !current || ctx.Err() != nil {
			return // closed or replaced by the agent: report nothing
		}
		switch {
		case out.Err != nil:
			log.Warn("native prompt could not be drawn", "promptId", p.PromptID, "error", out.Err.Error())
			r.renderFailed(p, "window_failed")
		case out.ActionID != "":
			r.reply(ipc.TypePromptAction, ipc.PromptActionRequest{PromptID: p.PromptID, Rev: p.Rev, Lease: p.Lease, ActionID: out.ActionID, Via: ipc.PromptViaClick})
		case out.Hidden:
			r.reply(ipc.TypePromptClosed, ipc.PromptClosed{PromptID: p.PromptID, Rev: p.Rev, Lease: p.Lease, Reason: ipc.PromptClosedHidden})
		case out.TimedOut:
			// Report nothing: the agent's own timer decides expiry.
			log.Debug("native prompt dialog timed out", "promptId", p.PromptID)
		}
	}()
}
