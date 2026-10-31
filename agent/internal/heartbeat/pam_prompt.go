package heartbeat

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/pamactuator"
	"github.com/breeze-rmm/agent/internal/pamdecline"
	"github.com/breeze-rmm/agent/internal/prompthost"
	"github.com/breeze-rmm/agent/internal/promptkinds"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// elevation.request@1 call sites (#10190 W07, plan Task 7.2, spec §3.4).
//
// A `pending` (require-approval) elevation asks its first question through
// the prompt host only when all three switches are on for the requester's
// session (compatibility order step 2): this build constructs the kind, a
// live renderer that may draw it advertised it, and the server enables it.
// Which renderer may draw the first question depends on where UAC is:
//
//   - PromptOnSecureDesktop = 1 (or missing): only the SYSTEM helper, which
//     draws on the input desktop next to UAC (Assist cannot be seen there);
//   - PromptOnSecureDesktop = 0: Assist as a modal next to UAC, the SYSTEM
//     helper as fallback.
//
// Otherwise the flow makes exactly today's pam_request_dialog call. The
// answer feeds the unchanged #8971 decision record and decline / dismiss
// logic in RunPamFlow. After Send request the agent dismisses the request's
// own UAC prompt (#10177's targeted dismissal) and shows the waiting card on
// Assist with a new lease; the outcome (approved, failed, denied, expired,
// cancelled) replaces it. With no Assist in the session the #8928 outcome
// notices are shown as before. The end-user-allowed verdict is unchanged.

const (
	// elevationWaitingFallback is the server's pending TTL (pamJobs.ts), used
	// when the ingest answer carried no pendingExpiresAt.
	elevationWaitingFallback = 15 * time.Minute
	// elevationAnswerGrace bounds the wait for the first answer past its
	// presentation and response budgets (guards a callback that never comes).
	elevationAnswerGrace = 15 * time.Second
	// defaultElevationConsentPoll is how often the first question checks that
	// the request's consent.exe is still up.
	defaultElevationConsentPoll = time.Second
	// elevationFlowTTL bounds how long a flow is remembered (the #8928
	// tracker's window).
	elevationFlowTTL = pamTrackedRequestTTL
)

// Renderer labels sent to the API (renderer / first_question_renderer).
const (
	elevationRendererAssist = "assist"
	elevationRendererNative = "native"
)

func elevationRendererLabel(role ipc.HelperRole) string {
	if role == ipc.HelperRoleAssist {
		return elevationRendererAssist
	}
	return elevationRendererNative
}

type elevationPhase int

const (
	elevationFirst   elevationPhase = iota // the first question is open
	elevationSent                          // answered Send request; dismissing UAC
	elevationWaiting                       // the waiting card is up
	elevationDone                          // an outcome was shown, or the flow ended
)

// elevationAnswer is the first question's answer as RunPamFlow consumes it.
type elevationAnswer struct {
	dialog ipc.PamDialogResult
	err    error
	// decline overrides the decline reason pamWithdrawReason would derive.
	decline pamdecline.Reason
	// renderer drew the answer (assist | native).
	renderer string
	// superseded: a server decision or the UAC prompt's own exit ended the
	// question; nothing was asked of the person.
	superseded bool
}

type elevationFlow struct {
	requestID string
	e         *promptkinds.Elevation
	owner     prompthost.Owner
	answers   chan elevationAnswer
	created   time.Time

	mu       sync.Mutex
	phase    elevationPhase
	answered bool
	// applying counts pam_apply_v2 handlers past admission for this
	// request: Cancel request is refused while one is under way, so a
	// launch never lands behind a "cancelled" card.
	applying int

	// afterSettle (tests) runs after every settle, on the settling goroutine.
	afterSettle func()
}

func (f *elevationFlow) settle(a elevationAnswer) {
	select {
	case f.answers <- a:
	default: // the first answer wins
	}
	if f.afterSettle != nil {
		f.afterSettle()
	}
}

// elevationFlows are the open elevation prompts, keyed by request id.
type elevationFlows struct {
	mu sync.Mutex
	m  map[string]*elevationFlow
}

func (r *elevationFlows) put(f *elevationFlow) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.m == nil {
		r.m = map[string]*elevationFlow{}
	}
	for id, old := range r.m {
		if time.Since(old.created) > elevationFlowTTL {
			delete(r.m, id)
		}
	}
	r.m[f.requestID] = f
}

func (r *elevationFlows) get(requestID string) *elevationFlow {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.m[strings.ToLower(requestID)]
}

func (r *elevationFlows) remove(f *elevationFlow) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.m[f.requestID] == f {
		delete(r.m, f.requestID)
	}
}

// pamSecureDesktopOn reports whether UAC uses the secure desktop. A read
// failure answers true: then only the SYSTEM helper (which draws where UAC
// is) may ask, never an Assist window that might be hidden behind it.
func (h *Heartbeat) pamSecureDesktopOn() bool {
	read := h.pamSecureDesktop
	if read == nil {
		read = readPromptOnSecureDesktop
	}
	on, err := read()
	if err != nil {
		log.Warn("pam: could not read PromptOnSecureDesktop; assuming the secure desktop", "error", err.Error())
		return true
	}
	return on
}

// elevationOwner is the prompt-host owner for the requester's Windows
// session: the user principal of a non-SYSTEM helper there (Assist or the
// user helper), else the session alone (only the SYSTEM helper can then
// serve it).
func (h *Heartbeat) elevationOwner(winSession string) (prompthost.Owner, bool) {
	if h.pamElevationOwner != nil {
		return h.pamElevationOwner(winSession)
	}
	ws, err := strconv.ParseUint(winSession, 10, 32)
	if err != nil || ws == 0 || h.sessionBroker == nil {
		return prompthost.Owner{}, false
	}
	var best *sessionbroker.Session
	consider := func(sessions []*sessionbroker.Session) {
		for _, s := range sessions {
			if s.HelperRole == ipc.HelperRoleSystem || s.WinSessionID != winSession {
				continue
			}
			if best == nil || s.ConnectedAt.After(best.ConnectedAt) {
				best = s
			}
		}
	}
	for _, scope := range []string{ipc.ScopePrompt, ipc.ScopePromptOperator, ipc.ScopeAssist} {
		consider(h.sessionBroker.SessionsWithScope(scope))
	}
	consider(h.sessionBroker.NotifyTargetsExcept(""))
	if best != nil {
		return noticeOwner(best), true
	}
	return prompthost.Owner{WinSessionID: uint32(ws)}, true
}

// elevationPartner is the MSP name the copy names: the prompt identity's
// sanitized partner name, else the ingest's support name, else "" (generic).
func (h *Heartbeat) elevationPartner(supportName string) string {
	if h.promptIdentity != nil {
		if id, ok := h.promptIdentity.Current(); ok && id.PartnerName != "" {
			return id.PartnerName
		}
	}
	return clampSupportName(supportName)
}

// firstQuestionRendererFor predicts, at submit time, which renderer will ask
// the first question for a request from winSession if the server answers
// pending: "assist" only when UAC is off the secure desktop and Assist can
// draw it; otherwise "native" (the SYSTEM helper's prompt or today's
// dialog). "" when there is no session to predict for.
func (h *Heartbeat) firstQuestionRendererFor(winSession string) string {
	if winSession == "" {
		return ""
	}
	if h.promptHost == nil || h.pamSecureDesktopOn() {
		return elevationRendererNative
	}
	owner, ok := h.elevationOwner(winSession)
	k := promptkinds.ElevationRequestKind
	if ok && h.promptHost.PromptPathAvailableVia(k.Name, k.Version, owner, []ipc.HelperRole{ipc.HelperRoleAssist}) {
		return elevationRendererAssist
	}
	return elevationRendererNative
}

// askElevationPrompt asks the first question through the prompt host. ok is
// false when the prompt path is not available (or the host would not take
// the prompt): the caller then makes today's pam_request_dialog call.
func (h *Heartbeat) askElevationPrompt(ctx context.Context, winSession string, outcome etwlua.ElevationOutcome, ev etwlua.Event) (elevationAnswer, *elevationFlow, bool) {
	host := h.promptHost
	if host == nil || outcome.Status != etwlua.ElevationPending {
		return elevationAnswer{}, nil, false
	}
	owner, ok := h.elevationOwner(winSession)
	if !ok {
		return elevationAnswer{}, nil, false
	}
	roles := promptkinds.FirstQuestionRoles(h.pamSecureDesktopOn())
	k := promptkinds.ElevationRequestKind
	if !host.PromptPathAvailableVia(k.Name, k.Version, owner, roles) {
		return elevationAnswer{}, nil, false
	}

	deadline := outcome.PendingExpiresAt
	if deadline.IsZero() || !deadline.After(time.Now()) {
		deadline = time.Now().Add(elevationWaitingFallback)
	}
	flow := &elevationFlow{
		requestID:   strings.ToLower(outcome.RequestID),
		owner:       owner,
		answers:     make(chan elevationAnswer, 1),
		created:     time.Now(),
		afterSettle: h.elevationAfterSettle,
	}
	flow.e = promptkinds.NewElevation(promptkinds.ElevationParams{
		RequestID:          outcome.RequestID,
		ProgramPath:        ev.TargetExecutablePath,
		Publisher:          ev.TargetExecutableSigner,
		CommandLine:        ev.CommandLine,
		Partner:            h.elevationPartner(outcome.SupportName),
		FirstQuestionRoles: roles,
		WaitingDeadline:    deadline,
	}, promptkinds.ElevationHooks{
		// Answered records the answer at once (a consent exit or a server
		// outcome arriving now must not supersede it); RunPamFlow is woken
		// only by AnswerApplied, once the host has applied the answer, so the
		// waiting card it places is never fenced by Send request's own patch
		// (#10734).
		Answered: func(actionID string, role ipc.HelperRole) {
			flow.mu.Lock()
			flow.answered = true
			if actionID == promptkinds.ActionSendRequest {
				flow.phase = elevationSent
			}
			flow.mu.Unlock()
		},
		AnswerApplied: func(actionID string, role ipc.HelperRole) {
			a := elevationAnswer{renderer: elevationRendererLabel(role)}
			if actionID == promptkinds.ActionSendRequest {
				a.dialog = ipc.PamDialogResult{Approved: true}
			} else {
				a.dialog = ipc.PamDialogResult{Approved: false, DismissedByUser: true, Reason: "user_cancelled_first_question"}
			}
			flow.settle(a)
		},
		CancelRequest: func(role ipc.HelperRole) bool { return h.cancelElevationRequest(flow, role) },
		Expired: func(state ipc.PromptState) {
			switch state {
			case ipc.PromptStatePending:
				flow.settle(elevationAnswer{err: fmt.Errorf("elevation first question: %w", sessionbroker.ErrCommandTimeout)})
			case ipc.PromptStateWaiting:
				// The server's expiry passed on the agent's clock: say so now
				// (a pam_request_notify that follows finds the flow done).
				h.elevationOutcomeLocked(flow, ipc.PromptStateExpired, "", "")
			}
		},
		Lost: func(info prompthost.PlacementInfo, reason string) {
			flow.settle(elevationAnswer{err: fmt.Errorf("elevation first question renderer lost: %s", reason), renderer: elevationRendererLabel(info.Role)})
		},
	})
	p := flow.e.Prompt()
	p.Owners = []prompthost.Owner{owner}
	h.pamElevations.put(flow)
	if err := h.showStamped(&p); err != nil {
		h.pamElevations.remove(flow)
		log.Warn("pam: elevation prompt not shown through the prompt host; sending today's dialog", "elevationRequestId", outcome.RequestID, "error", err.Error())
		return elevationAnswer{}, nil, false
	}
	if host.WithdrawUnplaced(flow.e.ID()) {
		h.pamElevations.remove(flow)
		log.Info("pam: elevation prompt had no renderer after all; sending today's dialog", "elevationRequestId", outcome.RequestID)
		return elevationAnswer{}, nil, false
	}
	log.Info("pam: elevation first question asked through the prompt host", "elevationRequestId", outcome.RequestID, "secureDesktopRoles", fmt.Sprint(roles))

	a := h.awaitElevationAnswer(ctx, flow, ev.Consent)
	if a.renderer != "" {
		h.rememberPamWithdrawRenderer(flow.requestID, a.renderer)
	}
	if !a.dialog.Approved {
		// Every way out but Send request ends the flow here; RunPamFlow
		// declines and dismisses exactly as for today's dialog.
		flow.mu.Lock()
		if flow.phase == elevationFirst || flow.phase == elevationSent {
			flow.phase = elevationDone
		}
		flow.mu.Unlock()
		h.pamElevations.remove(flow)
	}
	return a, flow, true
}

// awaitElevationAnswer waits for the first answer. It also watches the
// request's own consent.exe: once UAC has gone (the person answered it
// themselves), the question is superseded and the request withdrawn as
// user_cancelled.
func (h *Heartbeat) awaitElevationAnswer(ctx context.Context, flow *elevationFlow, consent etwlua.ConsentInstance) elevationAnswer {
	id := flow.e.ID()
	bound := time.NewTimer(time.Duration(promptkinds.ElevationFirstQuestionMs)*time.Millisecond + 10*time.Second + elevationAnswerGrace)
	defer bound.Stop()
	poll := h.elevationConsentPoll
	if poll <= 0 {
		poll = defaultElevationConsentPoll
	}
	var tick <-chan time.Time
	if consent.PID != 0 && !consent.CreatedAt.IsZero() {
		t := time.NewTicker(poll)
		defer t.Stop()
		tick = t.C
	}
	exited := h.pamConsentExited
	if exited == nil {
		exited = func(c etwlua.ConsentInstance) (bool, error) {
			return pamactuator.ConsentInstanceExited(pamactuator.ConsentInstance{PID: c.PID, CreatedAt: c.CreatedAt})
		}
	}
	for {
		select {
		case a := <-flow.answers:
			return a
		case <-ctx.Done():
			_ = h.promptHost.Close(id, ipc.PromptCloseWithdrawn)
			return elevationAnswer{err: fmt.Errorf("elevation first question: %w", ctx.Err())}
		case <-bound.C:
			log.Warn("pam: elevation first question produced no answer in time; withdrawing it", "elevationRequestId", flow.requestID)
			_ = h.promptHost.Close(id, ipc.PromptCloseWithdrawn)
			select {
			case late := <-flow.answers:
				return late
			default:
			}
			return elevationAnswer{err: fmt.Errorf("elevation first question: %w", sessionbroker.ErrCommandTimeout)}
		case <-tick:
			gone, err := exited(consent)
			if err != nil || !gone {
				continue // unknown is never "gone"
			}
			flow.mu.Lock()
			answered := flow.answered
			flow.mu.Unlock()
			if answered {
				continue // the answer is on its way
			}
			log.Info("pam: the user's UAC prompt closed while the elevation question was open; superseded",
				"elevationRequestId", flow.requestID, "consentPid", consent.PID)
			_ = h.promptHost.Close(id, ipc.PromptCloseSuperseded)
			select {
			case late := <-flow.answers:
				return late
			default:
			}
			return elevationAnswer{
				dialog:     ipc.PamDialogResult{Approved: false, DismissedByUser: true, Reason: "uac_prompt_closed"},
				decline:    pamdecline.ReasonUserCancelled,
				superseded: true,
			}
		}
	}
}

// elevationSendRequested runs after the host applied Send request: it dismisses
// the request's own UAC prompt (#10177), then places the waiting card on
// Assist with a new lease. An unproven dismissal says so on the card and
// never engages the fail-closed gate.
func (h *Heartbeat) elevationSendRequested(flow *elevationFlow) {
	proven := h.dismissRecordedPamConsent(flow.requestID, "request sent to IT", "-sent-consent")
	// Move to waiting first, then update outside flow.mu (Update sends to
	// renderers and may run host callbacks): an outcome landing in between
	// replaces the card, and the waiting Update then fails harmlessly.
	flow.mu.Lock()
	if flow.phase != elevationSent {
		flow.mu.Unlock()
		return // an outcome won meanwhile
	}
	flow.phase = elevationWaiting
	flow.mu.Unlock()
	patch, err := flow.e.WaitingPatch(proven)
	if err == nil {
		err = h.promptHost.Update(flow.e.ID(), patch)
	}
	if err != nil {
		// No card: end the flow so every outcome takes the #8928 notice.
		flow.mu.Lock()
		if flow.phase == elevationWaiting {
			flow.phase = elevationDone
		}
		flow.mu.Unlock()
		h.pamElevations.remove(flow)
		log.Warn("pam: elevation waiting card not shown; outcomes fall back to the notices", "elevationRequestId", flow.requestID, "error", err.Error())
		return
	}
	log.Info("pam: elevation waiting card shown", "elevationRequestId", flow.requestID, "uacDismissProven", proven,
		"onAssist", h.elevationOnAssist(flow))
}

// elevationOnAssist reports whether Assist holds the flow's prompt.
func (h *Heartbeat) elevationOnAssist(flow *elevationFlow) bool {
	info, ok := h.promptHost.PlacementOf(flow.e.ID(), flow.owner)
	return ok && info.Path == prompthost.PathPrompt && info.Role == ipc.HelperRoleAssist
}

// elevationOutcome shows a decision on the request's prompt, if this agent
// asked it through the prompt host. It reports whether Assist holds the
// outcome card (the caller then skips the #8928 notice). A first question
// still open is superseded: nothing more is asked.
func (h *Heartbeat) elevationOutcome(requestID string, state ipc.PromptState, technician, reason string) bool {
	if h.promptHost == nil {
		return false
	}
	flow := h.pamElevations.get(requestID)
	if flow == nil {
		return false
	}
	return h.elevationOutcomeLocked(flow, state, technician, reason)
}

func (h *Heartbeat) elevationOutcomeLocked(flow *elevationFlow, state ipc.PromptState, technician, reason string) bool {
	flow.mu.Lock()
	if flow.phase == elevationDone {
		flow.mu.Unlock()
		return false
	}
	superseded := flow.phase == elevationFirst && !flow.answered
	flow.phase = elevationDone
	flow.mu.Unlock()
	h.pamElevations.remove(flow)

	patch, err := flow.e.OutcomePatch(state, technician, reason)
	if err == nil {
		err = h.promptHost.Update(flow.e.ID(), patch)
	}
	if superseded {
		flow.settle(elevationAnswer{
			dialog:     ipc.PamDialogResult{Approved: false, DismissedByUser: true, Reason: "decided_by_server"},
			superseded: true,
		})
	}
	if err != nil {
		log.Warn("pam: elevation outcome not shown on the prompt", "elevationRequestId", flow.requestID, "state", string(state), "error", err.Error())
		return false
	}
	onAssist := h.elevationOnAssist(flow)
	log.Info("pam: elevation outcome shown", "elevationRequestId", flow.requestID, "state", string(state),
		"onAssist", onAssist, "supersededFirstQuestion", superseded)
	return onAssist
}

// cancelElevationRequest is Cancel request on the waiting card: the request
// is declined locally (an apply arriving now is refused) and withdrawn on
// the server as user_cancelled. It refuses once an outcome was shown.
func (h *Heartbeat) cancelElevationRequest(flow *elevationFlow, role ipc.HelperRole) bool {
	flow.mu.Lock()
	if flow.phase != elevationWaiting || flow.applying > 0 {
		// Decided, or an approved launch is already under way (its outcome
		// will replace the card).
		flow.mu.Unlock()
		return false
	}
	// Record the decline before the flow reads as done, under flow.mu, so an
	// apply that starts after this point is refused by the decline record
	// (elevationApplyStarted waits on flow.mu).
	store := h.pamDeclineStore()
	// The hand-off removed the awaiting entry: record it as a pending
	// request again, then decline it, so the withdraw drain sends it.
	if _, err := store.BeginAwaiting(flow.requestID, "pending"); err != nil && !errors.Is(err, pamdecline.ErrPersist) {
		log.Error("pam: could not record the cancelled elevation request", "elevationRequestId", flow.requestID, "error", err.Error())
	}
	if err := store.Decline(flow.requestID, pamdecline.ReasonUserCancelled); err != nil {
		// A persist failure still refuses in this process.
		log.Error("pam: could not persist the cancelled elevation request", "elevationRequestId", flow.requestID, "error", err.Error())
	}
	flow.phase = elevationDone
	flow.mu.Unlock()
	h.pamElevations.remove(flow)

	h.rememberPamWithdrawRenderer(flow.requestID, elevationRendererLabel(role))
	h.pamTracker().Remove(flow.requestID)
	// A UAC prompt whose dismissal was not proven at Send request is still
	// recorded: try again now (outside the host's action lock; the
	// dismissal can take pamDismissTimeout). Nothing is left recorded for
	// an approved launch that will never come.
	if _, recorded := h.pamPendingConsents.peek(flow.requestID); recorded {
		h.elevationCancelDismissWG.Add(1)
		go func() {
			defer h.elevationCancelDismissWG.Done()
			if !h.dismissRecordedPamConsent(flow.requestID, "request cancelled by the user", "-cancel-consent") {
				h.pamPendingConsents.take(flow.requestID)
			}
		}()
	}
	h.kickPamWithdrawDrain()
	log.Info("pam: the user cancelled the elevation request; withdrawing it", "elevationRequestId", flow.requestID,
		"renderer", elevationRendererLabel(role))
	return true
}

// elevationApplyStarted marks a pam_apply_v2 for requestID as under way
// (Cancel request is refused meanwhile) and returns the function that ends
// the mark. A cancel that won first already recorded its decline, which the
// apply's own decline check then refuses.
func (h *Heartbeat) elevationApplyStarted(requestID string) (done func()) {
	flow := h.pamElevations.get(requestID)
	if flow == nil {
		return func() {}
	}
	flow.mu.Lock()
	flow.applying++
	flow.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			flow.mu.Lock()
			flow.applying--
			flow.mu.Unlock()
		})
	}
}

// finishElevationFlow runs when RunPamFlow returns: a flow that never got
// past Send request (an early return or a recovered panic before the
// waiting card) is withdrawn, so no prompt or registry entry is left
// behind; outcomes then take the #8928 notices.
func (h *Heartbeat) finishElevationFlow(flow *elevationFlow) {
	if flow == nil {
		return
	}
	flow.mu.Lock()
	stuck := flow.phase == elevationFirst || flow.phase == elevationSent
	if stuck {
		flow.phase = elevationDone
	}
	flow.mu.Unlock()
	if !stuck {
		return
	}
	h.pamElevations.remove(flow)
	if h.promptHost != nil {
		_ = h.promptHost.Close(flow.e.ID(), ipc.PromptCloseWithdrawn)
	}
	log.Warn("pam: elevation flow ended before its waiting card; prompt withdrawn", "elevationRequestId", flow.requestID)
}

// pamWithdrawRenderers remembers, in memory only, which renderer carried a
// decision, for the withdraw body (best effort: lost on restart).
func (h *Heartbeat) rememberPamWithdrawRenderer(requestID, renderer string) {
	if renderer == "" {
		return
	}
	now := time.Now()
	// Bounded: a withdraw is sent within minutes; a day-old label is dead.
	h.pamWithdrawRenderersMap.Range(func(k, v any) bool {
		if r, ok := v.(withdrawRenderer); !ok || now.Sub(r.at) > pamWithdrawRendererTTL {
			h.pamWithdrawRenderersMap.Delete(k)
		}
		return true
	})
	h.pamWithdrawRenderersMap.Store(strings.ToLower(requestID), withdrawRenderer{label: renderer, at: now})
}

// pamWithdrawRendererTTL bounds how long a renderer label is remembered.
const pamWithdrawRendererTTL = 24 * time.Hour

type withdrawRenderer struct {
	label string
	at    time.Time
}

func (h *Heartbeat) pamWithdrawRenderer(requestID string) string {
	v, ok := h.pamWithdrawRenderersMap.Load(strings.ToLower(requestID))
	if !ok {
		return ""
	}
	r, _ := v.(withdrawRenderer)
	return r.label
}
