package heartbeat

import (
	"math/rand/v2"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/health"
	"github.com/breeze-rmm/agent/internal/userhelpertask"
)

// User-helper logon task repair (#12580), Windows only: the loop is started
// by user_helper_task_windows.go; elsewhere startUserHelperTaskRepair is a
// no-op. The schedule and the reporting live here, untagged, so they are
// tested on every host.
//
// Cadence: the task matters at the next logon, and is lost rarely, so one
// check shortly after the service starts and then every few hours is enough;
// the jitter keeps a fleet from checking in step. A task that went missing
// together with the helper executable is checked again as soon as the 30-minute
// helper reconcile has put the executable back (kickUserHelperTaskCheck), not
// hours later. A check that could not tell whether the task exists (Task
// Scheduler not up yet early in boot) is retried sooner.

// userHelperTaskComponent is the agent health component (healthStatus in the
// heartbeat) that carries the outcome. Reasons are userhelpertask.Outcome
// codes, never error text.
const userHelperTaskComponent = "user_helper_task"

type userHelperTaskTiming struct {
	startDelay time.Duration // first check after start, plus up to the same again
	interval   time.Duration // between checks, plus up to jitter
	jitter     time.Duration
	retry      time.Duration // after check_failed
}

var defaultUserHelperTaskTiming = userHelperTaskTiming{
	startDelay: time.Minute,
	interval:   4 * time.Hour,
	jitter:     30 * time.Minute,
	retry:      10 * time.Minute,
}

// userHelperTaskChecker is *userhelpertask.Repairer.
type userHelperTaskChecker interface {
	Check() (userhelpertask.Outcome, error)
	RepairsInWindow() int
}

// selfUninstallInProgress is set while a self_uninstall is being handed off
// and stays set once it has been: the task repair must never put back the
// task the teardown is removing. Cleared when the hand-off fails.
var selfUninstallInProgress atomic.Bool

// kickUserHelperTaskCheck asks the repair loop for a check now. It never
// blocks, and is a no-op when the loop is not running.
func (h *Heartbeat) kickUserHelperTaskCheck() {
	if h.userHelperTaskKick == nil {
		return
	}
	select {
	case h.userHelperTaskKick <- struct{}{}:
	default:
	}
}

// runUserHelperTaskRepair checks on a schedule until stop closes.
func (h *Heartbeat) runUserHelperTaskRepair(c userHelperTaskChecker, t userHelperTaskTiming,
	rnd func(n int64) int64, stop <-chan struct{}, kick <-chan struct{}) {
	jitter := func(d time.Duration) time.Duration {
		if d <= 0 {
			return 0
		}
		return time.Duration(rnd(int64(d)))
	}
	wait := t.startDelay + jitter(t.startDelay)
	var last userhelpertask.Outcome
	for {
		timer := time.NewTimer(wait)
		select {
		case <-stop:
			timer.Stop()
			return
		case <-kick:
			timer.Stop()
		case <-timer.C:
		}
		outcome, err := c.Check()
		h.reportUserHelperTask(c, outcome, err, last)
		last = outcome
		if outcome == userhelpertask.OutcomeCheckFailed {
			wait = t.retry
		} else {
			wait = t.interval + jitter(t.jitter)
		}
	}
}

// reportUserHelperTask logs the outcome and sets the health component. A
// repair is logged every time; a standing condition only when it starts.
func (h *Heartbeat) reportUserHelperTask(c userHelperTaskChecker, outcome userhelpertask.Outcome, err error, last userhelpertask.Outcome) {
	changed := outcome != last
	errText := ""
	if err != nil {
		errText = err.Error()
	}
	var status health.Status
	switch outcome {
	case userhelpertask.OutcomePresent:
		status = health.Healthy
		if last != "" && changed {
			log.Info("user-helper logon task is registered", "task", userhelpertask.TaskName)
		}
	case userhelpertask.OutcomeRepaired:
		status = health.Degraded
		log.Warn("user-helper logon task was missing; registered it again from the installer's definition",
			"task", userhelpertask.TaskName, "helperPath", userhelpertask.HelperPath(),
			"repairsInWindow", c.RepairsInWindow(), "maxRepairs", userhelpertask.MaxRepairs,
			"window", userhelpertask.RepairWindow.String())
	case userhelpertask.OutcomeHelperMissing:
		status = health.Degraded
		if changed {
			log.Warn("user-helper logon task is missing and so is the helper executable; not registering the task",
				"task", userhelpertask.TaskName, "helperPath", userhelpertask.HelperPath())
		}
	case userhelpertask.OutcomeBackedOff:
		status = health.Unhealthy
		if changed {
			log.Error("user-helper logon task keeps going missing after repair; not registering it again until the agent restarts",
				"task", userhelpertask.TaskName, "maxRepairs", userhelpertask.MaxRepairs,
				"window", userhelpertask.RepairWindow.String())
		}
	case userhelpertask.OutcomeRepairFailed:
		status = health.Unhealthy
		log.Warn("user-helper logon task was missing and registering it failed",
			"task", userhelpertask.TaskName, "error", errText)
	case userhelpertask.OutcomeCheckFailed:
		status = health.Degraded
		if changed {
			log.Warn("could not check the user-helper logon task; retrying",
				"task", userhelpertask.TaskName, "error", errText)
		}
	case userhelpertask.OutcomeUninstalling:
		log.Debug("uninstall in progress; not checking the user-helper logon task")
		return
	default:
		log.Warn("unexpected user-helper logon task check outcome", "outcome", string(outcome), "error", errText)
		return
	}
	if h.healthMon == nil {
		return
	}
	reason := string(outcome)
	if outcome == userhelpertask.OutcomePresent {
		reason = ""
	}
	h.healthMon.Update(userHelperTaskComponent, status, reason)
}

func userHelperTaskRand(n int64) int64 { return rand.Int64N(n) }
