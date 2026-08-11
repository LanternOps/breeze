// Reboot warning planning.
//
// This file is intentionally untagged so its tests run on every dev platform
// and, critically, in CI: the `test-agent` job builds for linux and the
// `test-agent-windows` job does not list ./internal/patching in its package
// allowlist, so anything behind //go:build windows is tested nowhere (issues
// #3019, #3046). Keeping the schedule arithmetic here — as pure data, with no
// logger and no exec — is what makes "the user always gets warned" a tested
// invariant instead of a coincidence. The package documents the same idiom at
// reboot_detect_unix.go.
//
// Issue #3197: the API used to queue schedule_reboot with a hardcoded 5-minute
// delay while the reminder ladder gated every warning on
// `totalDelay > threshold`. 5 > 5 is false, so a patched workstation rebooted
// with zero notice. The fix is structural rather than a `>` → `>=` tweak: a
// notification always fires the moment the reboot is scheduled, so at least
// one warning is emitted for ANY delay an operator can configure — including a
// 2-minute emergency reboot, which no before-the-reboot threshold can cover.
package patching

import (
	"fmt"
	"strconv"
	"time"
)

// rebootReminderOffsets are the "save your work" reminder points, measured
// backwards from the moment the machine goes down. Fixed rather than
// proportional to the delay on purpose: a proportional schedule fires three
// toasts inside five minutes at the short end, and at a 24-hour delay lands
// its first warning twelve hours after scheduling — missing exactly the person
// who was sitting at the machine when the patch installed.
var rebootReminderOffsets = []time.Duration{
	60 * time.Minute,
	15 * time.Minute,
	5 * time.Minute,
}

const (
	// minReminderGap is the minimum spacing a reminder must have from the
	// notification that precedes it. Without it the ladder degenerates just
	// above each offset: at a 61-minute delay the lead notification says "in 61
	// minutes" and the 60-minute reminder says "in 1 hour" sixty seconds later.
	// Suppressing on exact equality alone (the old strict `>`) does not catch
	// that, which is why flipping to `>=` would have been the wrong fix.
	minReminderGap = 5 * time.Minute

	// finalNoticeLead is how long before the reboot the critical closing notice
	// fires. It is also the grace handed to the OS shutdown command, so the
	// countdown the user is shown and the countdown the OS honours are the same
	// one. Previously the closing toast was fire-and-forget IPC on the line
	// before `shutdown /r /t 0`, so it raced session teardown and essentially
	// never rendered.
	finalNoticeLead = 60 * time.Second

	// minFinalGap is the minimum spacing between the last reminder and the
	// closing notice. Smaller than minReminderGap because the closing notice
	// carries different information ("save now", plus the OS countdown), so it
	// is not redundant the way two "please save your work" toasts are.
	minFinalGap = time.Minute

	// MinRebootDelay is the shortest delay the manager will schedule. Below it
	// there is no room for the closing notice to render before the OS takes the
	// session down. Both API-side bounds sit at or above it: the config policy
	// allows 1-1440 minutes and the schedule_reboot handler 1-10080.
	MinRebootDelay = time.Minute
)

// RebootNotification is one user-facing warning in a reboot's warning ladder.
type RebootNotification struct {
	// After is the offset from the scheduling instant at which this fires.
	After time.Duration
	// Title, Body and Urgency are passed straight through to NotifyFunc.
	Title   string
	Body    string
	Urgency string
}

// RebootPlan is the whole timeline for one scheduled reboot, computed up front
// as pure data so it can be asserted on without driving real timers.
type RebootPlan struct {
	// TotalDelay is the requested delay after normalisation; the machine goes
	// down this long after scheduling.
	TotalDelay time.Duration

	// Notifications are every warning to fire, in chronological order. Always
	// non-empty, and Notifications[0].After is always zero — that pair is the
	// #3197 invariant: no reboot is ever silent, at any delay.
	Notifications []RebootNotification

	// OSInvokeAt is the offset at which the OS shutdown command runs. It
	// coincides with the last notification, whose body quotes OSGrace.
	OSInvokeAt time.Duration

	// OSGrace is the countdown handed to the OS shutdown command at
	// OSInvokeAt. OSInvokeAt + OSGrace always equals TotalDelay.
	OSGrace time.Duration
}

// PlanReboot builds the warning timeline for a reboot scheduled totalDelay
// from now. Delays below MinRebootDelay are raised to it.
//
// Guarantees, each asserted in reboot_plan_test.go:
//   - Notifications is never empty and Notifications[0].After == 0, so the user
//     is always told at scheduling time.
//   - OSInvokeAt + OSGrace == TotalDelay, so the OS countdown ends when the
//     user was told it would.
//   - Notification offsets strictly increase, with at least minReminderGap
//     between reminders and at least minFinalGap before the closing notice, so
//     the user never gets two near-identical toasts.
func PlanReboot(totalDelay time.Duration) RebootPlan {
	if totalDelay < MinRebootDelay {
		totalDelay = MinRebootDelay
	}

	plan := RebootPlan{TotalDelay: totalDelay, OSGrace: finalNoticeLead}
	if plan.OSGrace > totalDelay {
		plan.OSGrace = totalDelay
	}
	plan.OSInvokeAt = totalDelay - plan.OSGrace

	closing := RebootNotification{
		After:   plan.OSInvokeAt,
		Title:   "Restarting Now",
		Body:    fmt.Sprintf("This computer restarts for updates in %s. Save your work now.", humanizeRebootDelay(plan.OSGrace)),
		Urgency: "critical",
	}

	// A reboot so imminent that the closing notice lands at (or effectively at)
	// scheduling time needs no separate lead: the closing notice already says
	// "save your work now" and quotes the whole remaining delay. Collapsing
	// here — rather than emitting two toasts in the same instant — is what
	// keeps Notifications[0].After == 0 true without duplication.
	if plan.OSInvokeAt < minFinalGap {
		plan.OSInvokeAt = 0
		plan.OSGrace = totalDelay
		closing.After = 0
		closing.Body = fmt.Sprintf("This computer restarts for updates in %s. Save your work now.", humanizeRebootDelay(totalDelay))
		plan.Notifications = []RebootNotification{closing}
		return plan
	}

	// Lead notification: the reboot has just been scheduled.
	plan.Notifications = append(plan.Notifications, RebootNotification{
		After: 0,
		// "Restart", not "Reboot", throughout: it is what both Windows and macOS
		// say in their own user-facing UI, and these strings go to an end user
		// rather than a technician.
		Title:   "Restart Scheduled",
		Body:    fmt.Sprintf("A system restart for updates is scheduled in %s. Please save your work.", humanizeRebootDelay(totalDelay)),
		Urgency: leadUrgency(totalDelay),
	})

	// Reminder ladder, longest lead first so offsets come out ascending.
	for _, before := range rebootReminderOffsets {
		at := totalDelay - before
		last := plan.Notifications[len(plan.Notifications)-1]
		if at-last.After < minReminderGap {
			continue // too close to the message the user just read
		}
		if plan.OSInvokeAt-at < minFinalGap {
			continue // too close to the closing notice
		}
		plan.Notifications = append(plan.Notifications, RebootNotification{
			After:   at,
			Title:   reminderTitle(before),
			Body:    fmt.Sprintf("A system restart for updates begins in %s. Please save your work.", humanizeRebootDelay(before)),
			Urgency: reminderUrgency(before),
		})
	}

	plan.Notifications = append(plan.Notifications, closing)
	return plan
}

// leadUrgency escalates the lead notification for short-notice reboots: it is
// the user's only warning that is not already inside the closing minute.
func leadUrgency(totalDelay time.Duration) string {
	if totalDelay <= 15*time.Minute {
		return "critical"
	}
	return "normal"
}

func reminderUrgency(before time.Duration) string {
	if before <= 5*time.Minute {
		return "critical"
	}
	return "normal"
}

func reminderTitle(before time.Duration) string {
	if before <= 5*time.Minute {
		return "Restart Imminent"
	}
	return "Restart Soon"
}

// humanizeRebootDelay renders a delay the way a person would say it.
// Deliberately minimal — the agent has no i18n and these strings surface in a
// desktop toast.
func humanizeRebootDelay(d time.Duration) string {
	if d < time.Minute {
		return pluralize(int(d.Round(time.Second)/time.Second), "second")
	}
	minutes := int(d.Round(time.Minute) / time.Minute)
	if minutes < 60 || minutes%60 != 0 {
		return pluralize(minutes, "minute")
	}
	return pluralize(minutes/60, "hour")
}

// graceMinutesAtLeastOne converts an OS grace to whole minutes, never returning
// zero. Used by the unix reboot invocations, where `shutdown -r +0` would take
// the session down before the closing toast rendered — the very race #3197
// fixes on Windows.
func graceMinutesAtLeastOne(grace time.Duration) int {
	minutes := int((grace + time.Minute - 1) / time.Minute) // ceil
	if minutes < 1 {
		return 1
	}
	return minutes
}

// windowsRebootArgs builds the `shutdown` arguments for a Windows reboot.
//
// Kept here, untagged, so the unit conversion is testable: `/t` takes SECONDS on
// Windows while every other platform and the whole wire contract are in MINUTES.
// That exact trap shipped once already as #3252 (a manual reboot with delay 15
// rebooted in 15 seconds on Windows and 15 minutes on Linux), and windows-tagged
// files are tested nowhere in CI (#3019, #3046) — so the arithmetic lives on this
// side of the build tag.
//
// The reason code p:2:17 is "Planned / Operating System / Installation
// (Planned)", which is what lands in the System log and Reliability Monitor.
func windowsRebootArgs(grace time.Duration) []string {
	seconds := int(grace.Round(time.Second) / time.Second)
	if seconds < 0 {
		seconds = 0
	}
	return []string{"/r", "/t", strconv.Itoa(seconds), "/d", "p:2:17"}
}

// unixRebootArgs builds the `shutdown` arguments for Linux and macOS, where
// `+N` is MINUTES. Never `+0`: that would take the session down before the
// closing toast rendered, which is the race #3197 fixes on Windows.
func unixRebootArgs(grace time.Duration) []string {
	return []string{"-r", fmt.Sprintf("+%d", graceMinutesAtLeastOne(grace)), "Restarting for system updates"}
}

func pluralize(n int, unit string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", unit)
	}
	return fmt.Sprintf("%d %ss", n, unit)
}
