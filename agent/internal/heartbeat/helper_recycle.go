package heartbeat

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// The service half of replacing a helper that can no longer use DXGI capture
// (#12624). The helper asks; the lifecycle manager owns the budget, the exact
// process and the respawn; the helper itself says whether it is idle.

// helperRecyclePrepareTimeout bounds the wait for the helper's answer. A var,
// not a const, so tests can shrink it.
var helperRecyclePrepareTimeout = 5 * time.Second

// maxHelperRecycleReasonBytes bounds the helper-supplied text that is logged.
const maxHelperRecycleReasonBytes = 400

func helperRecycleReason(raw string) string {
	clean := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, raw)
	if len(clean) > maxHelperRecycleReasonBytes {
		clean = strings.ToValidUTF8(clean[:maxHelperRecycleReasonBytes], "")
	}
	if strings.TrimSpace(clean) == "" {
		return "unspecified"
	}
	return clean
}

func desktopStartInFlight() bool {
	found := false
	desktopStartInflight.Range(func(any, any) bool {
		found = true
		return false
	})
	return found
}

func (h *Heartbeat) handleHelperRecycleRequest(session *sessionbroker.Session, env *ipc.Envelope) {
	var req ipc.HelperRecycleRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		log.Warn("invalid helper recycle request payload", "error", err.Error())
		return
	}
	reason := helperRecycleReason(req.Reason)
	lc := h.lifecycleController()
	if lc == nil {
		log.Info("helper asked to be replaced but no lifecycle manager runs here",
			"helperSession", session.SessionID, "reason", reason)
		return
	}
	// A start on its way to this helper is work it cannot see yet. On an
	// on-demand host that start is not retried, so it must not lose its
	// helper. The helper asks again.
	if desktopStartInFlight() {
		log.Info("not replacing a helper while a desktop start is in flight",
			"helperSession", session.SessionID, "reason", reason)
		return
	}
	err := lc.RecycleHelper(session, reason, func() error { return prepareHelperRecycle(session) })
	if err != nil {
		// The outcomes that need someone to look (the budget is spent, the
		// kill failed) are logged at Warn by the lifecycle manager.
		log.Info("helper not replaced", "helperSession", session.SessionID, "reason", reason, "error", err.Error())
	}
}

// prepareHelperRecycle asks the helper to stop taking work. Anything but an
// explicit Ready means it must not be ended.
func prepareHelperRecycle(session *sessionbroker.Session) error {
	resp, err := session.SendCommand("helper-recycle-prepare", ipc.TypeHelperRecyclePrepare, struct{}{}, helperRecyclePrepareTimeout)
	if err != nil {
		return fmt.Errorf("helper did not answer the replacement request: %w", err)
	}
	if resp.Error != "" {
		return errors.New(resp.Error)
	}
	var res ipc.HelperRecyclePrepareResult
	if err := json.Unmarshal(resp.Payload, &res); err != nil {
		return fmt.Errorf("invalid helper_recycle_prepare answer: %w", err)
	}
	if !res.Ready {
		return fmt.Errorf("helper is busy: %s", helperRecycleReason(res.Busy))
	}
	return nil
}
