// Native session pill for remote.session@1 (#10190 W06, spec §3.5): the
// user-helper's renderer for the session indicator, drawn on the same
// top-center pill as the legacy banner (banner_windows.go).
//
// Untagged on purpose (the prompt_native.go precedent): what the pill says,
// whether it takes clicks, and how a click becomes an action live here, so
// every OS's CI run checks them. The Windows file only draws.
//
// The pill is hit-test invisible (WS_EX_TRANSPARENT) unless End session is
// offered, which the agent does only when the remote access policy allows
// it. A click never ends anything by itself: it sends end_session, and the
// agent answers with the confirm step, which this renderer draws as a native
// dialog whose default — and Esc — is Keep session. Report a problem is
// Breeze Assist's (Request Support) and is not drawn here.
package userhelper

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Extended window styles of the pill (winuser.h).
const (
	pillExTopmost     = 0x00000008
	pillExTransparent = 0x00000020 // hit-test invisible: clicks pass through
	pillExToolwindow  = 0x00000080
	pillExLayered     = 0x00080000
	pillExNoactivate  = 0x08000000
)

// pillExStyle is the pill's extended style: always on top, out of the task
// bar and never activated; click-through unless it is clickable.
func pillExStyle(clickable bool) uint32 {
	style := uint32(pillExTopmost | pillExToolwindow | pillExNoactivate | pillExLayered)
	if !clickable {
		style |= pillExTransparent
	}
	return style
}

// pillStyleChangeFailed reports whether toggling the pill's style in place
// failed: SetWindowLongPtrW returned 0 with a last error (0 alone can be a
// previous style of 0), or SetWindowPos returned 0.
func pillStyleChangeFailed(setLongRet uintptr, setLongErr error, setPosRet uintptr) bool {
	failed, _ := pillStyleOutcome(setLongRet, setLongErr, setPosRet)
	return failed
}

// pillStyleOutcome decides an in-place style change: failed, and whether the
// previous extended style (SetWindowLongPtrW's return) must be put back —
// only when SetWindowLongPtrW took the new style and SetWindowPos then
// failed, so a pill left on screen keeps the click-through state its flags
// say it has.
func pillStyleOutcome(setLongRet uintptr, setLongErr error, setPosRet uintptr) (failed, restorePrev bool) {
	longOK := setLongRet != 0 || setLongErr == nil
	if !longOK {
		var errno syscall.Errno
		longOK = errors.As(setLongErr, &errno) && errno == 0
	}
	switch {
	case !longOK:
		return true, false
	case setPosRet == 0:
		return true, true
	}
	return false, false
}

const (
	indicatorEndSession  = "end_session"
	indicatorEndConfirm  = "end_confirm"
	indicatorKeepSession = "keep_session"
)

// nativeIndicatorModel is one pill, platform-neutral.
type nativeIndicatorModel struct {
	PromptID        string
	Label           string
	StartedAtUnixMs int64 // 0 hides the elapsed clock
	// Clickable: End session is offered, so a click asks to end.
	Clickable bool
	// Confirm is the agent's confirm step, drawn as a native dialog (nil
	// outside it).
	Confirm *nativePromptModel
}

var indicatorStartedPattern = regexp.MustCompile(`\{time:([0-9]{1,16})\}`)

// nativeIndicatorModelFor turns a remote.session prompt_show into a pill,
// refusing anything a renderer must refuse.
func nativeIndicatorModelFor(p ipc.PromptShow, now time.Time, loc *time.Location) (nativeIndicatorModel, error) {
	if p.Presentation != ipc.PromptPresentationIndicator {
		return nativeIndicatorModel{}, errors.New("prompt: not an indicator")
	}
	if p.Copy.OperatorNote != "" {
		return nativeIndicatorModel{}, errOperatorTextOnBreezeKind
	}
	if err := ipc.ValidatePromptShow(p); err != nil {
		return nativeIndicatorModel{}, err
	}
	if loc == nil {
		loc = time.Local
	}
	m := nativeIndicatorModel{PromptID: p.PromptID, Label: applyNativePlaceholders(p.Copy.Title, time.Time{}, now, loc)}
	for _, f := range p.Facts {
		if sub := indicatorStartedPattern.FindStringSubmatch(f.Value); sub != nil {
			if ms, err := strconv.ParseInt(sub[1], 10, 64); err == nil {
				m.StartedAtUnixMs = ms
				break
			}
		}
	}
	var endLabel string
	confirming := false
	for _, a := range p.Actions {
		switch a.ID {
		case indicatorEndSession:
			m.Clickable, endLabel = true, a.Label
		case indicatorEndConfirm:
			confirming = true
		}
	}
	if m.Clickable && !confirming {
		m.Label += " · " + endLabel
	} else {
		m.Clickable = false
	}
	if confirming {
		// The confirm step is a decision on the person's own click: draw it
		// as one, so Keep session (its safe action) is the default and Esc.
		d := p
		d.Presentation = ipc.PromptPresentationModal
		dm, err := buildNativePromptModel(d, now, loc)
		if err != nil {
			return nativeIndicatorModel{}, err
		}
		m.Confirm = &dm
	}
	return m, nil
}

// nativeIndicatorState is one live pill's renderer-side state.
type nativeIndicatorState struct {
	ctx            context.Context
	presentedLease ipc.PromptLease
	confirmRev     uint64 // rev of the confirm dialog on screen (0 = none)
	confirmCancel  context.CancelFunc
}

// drawIndicator draws (or updates in place) the pill for p and runs its
// confirm dialog when the agent asked for one.
func (r *nativePromptRenderer) drawIndicator(p ipc.PromptShow) {
	m, err := nativeIndicatorModelFor(p, r.now(), nil)
	if err != nil {
		log.Warn("native renderer refused a session indicator", "promptId", p.PromptID, "error", err.Error())
		r.takeDown(p.PromptID)
		r.renderFailed(p, "invalid_prompt")
		return
	}
	r.mu.Lock()
	act := r.active[p.PromptID]
	var prev *nativeActive
	if act == nil || act.indicator == nil {
		prev = act
		ctx, cancel := context.WithCancel(context.Background())
		ind := &nativeIndicatorState{ctx: ctx}
		id := p.PromptID
		act = &nativeActive{indicator: ind, cancel: func() {
			cancel()
			r.indicatorHide(id)
		}}
		r.active[p.PromptID] = act
	}
	act.show = p
	ind := act.indicator
	present := ind.presentedLease != p.Lease
	ind.presentedLease = p.Lease
	// The confirm dialog: start it for a new confirm step, take it down
	// when the step is over.
	var startConfirm bool
	var confirmCtx context.Context
	switch {
	case m.Confirm == nil && ind.confirmCancel != nil:
		ind.confirmCancel()
		ind.confirmCancel, ind.confirmRev = nil, 0
	case m.Confirm != nil && ind.confirmRev == 0:
		confirmCtx, ind.confirmCancel = context.WithCancel(ind.ctx)
		ind.confirmRev = p.Rev
		startConfirm = true
	}
	r.mu.Unlock()
	if prev != nil {
		prev.cancel() // a dialog for this id (never expected): one window per prompt
	}

	if !r.indicatorShow(p.PromptID, m, func() { r.indicatorClicked(p.PromptID) }) {
		log.Warn("native session indicator could not be drawn", "promptId", p.PromptID)
		r.takeDown(p.PromptID)
		r.renderFailed(p, "window_failed")
		return
	}
	if present {
		r.reply(ipc.TypePromptPresented, ipc.PromptPresented{PromptID: p.PromptID, Rev: p.Rev, Lease: p.Lease, Visible: true})
	}
	if startConfirm {
		go r.runIndicatorConfirm(confirmCtx, p.PromptID, *m.Confirm)
	}
}

// indicatorClicked turns a click on a clickable pill into end_session at the
// pill's current rev and lease. A pill without End session ignores clicks.
func (r *nativePromptRenderer) indicatorClicked(promptID string) {
	r.mu.Lock()
	act := r.active[promptID]
	if act == nil || act.indicator == nil {
		r.mu.Unlock()
		return
	}
	show := act.show
	r.mu.Unlock()
	m, err := nativeIndicatorModelFor(show, r.now(), nil)
	if err != nil || !m.Clickable {
		return
	}
	r.reply(ipc.TypePromptAction, ipc.PromptActionRequest{PromptID: show.PromptID, Rev: show.Rev, Lease: show.Lease, ActionID: indicatorEndSession, Via: ipc.PromptViaClick})
}

// runIndicatorConfirm draws the confirm step and reports the answer on the
// rev it was drawn for. A dialog that fails to draw answers Keep session,
// so the pill never stays stuck in the confirm step.
func (r *nativePromptRenderer) runIndicatorConfirm(ctx context.Context, promptID string, m nativePromptModel) {
	var out nativeOutcome
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				out = nativeOutcome{Err: errors.New("native confirm dialog panicked")}
			}
		}()
		out = r.show(ctx, m, func() {})
	}()
	r.mu.Lock()
	act := r.active[promptID]
	var show ipc.PromptShow
	current := act != nil && act.indicator != nil && ctx.Err() == nil
	if current {
		show = act.show
		act.indicator.confirmCancel, act.indicator.confirmRev = nil, 0
	}
	r.mu.Unlock()
	if !current {
		return // the step ended or the pill was closed: report nothing
	}
	action := out.ActionID
	if out.Err != nil {
		log.Warn("native confirm dialog could not be drawn; keeping the session", "promptId", promptID, "error", out.Err.Error())
		action = indicatorKeepSession
	}
	if action == "" {
		return // timed out or hidden: the agent keeps the step
	}
	r.reply(ipc.TypePromptAction, ipc.PromptActionRequest{PromptID: promptID, Rev: show.Rev, Lease: show.Lease, ActionID: action, Via: ipc.PromptViaClick})
}

// showNativeIndicator draws the pill for a prompt through the shared banner
// window (one pill at a time; the most recent owner holds it).
func showNativeIndicator(promptID string, m nativeIndicatorModel, onClick func()) bool {
	bannerOpMu.Lock()
	defer bannerOpMu.Unlock()
	if !showPillFn(stripControl(trimNotifyField(m.Label, maxNotifyTitleBytes)), m.StartedAtUnixMs, m.Clickable, onClick) {
		return false
	}
	bannerSessionID = indicatorBannerOwner(promptID)
	return true
}

// hideNativeIndicator takes the pill down if this prompt still holds it.
func hideNativeIndicator(promptID string) { handleBannerHide(indicatorBannerOwner(promptID)) }

func indicatorBannerOwner(promptID string) string { return "prompt:" + promptID }
