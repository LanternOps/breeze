//go:build windows

package patching

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// RebootState tracks the current reboot scheduling state.
type RebootState struct {
	PendingReboot    bool      `json:"pendingReboot"`
	RebootScheduled  bool      `json:"rebootScheduled"`
	ScheduledAt      time.Time `json:"scheduledAt,omitempty"`
	Deadline         time.Time `json:"deadline,omitempty"`
	Reason           string    `json:"reason,omitempty"`
	NotifiedUser     bool      `json:"notifiedUser"`
	NotificationSent time.Time `json:"notificationSent,omitempty"`
	Source           string    `json:"source"` // "patch_install", "manual", "policy"
}

// NotifyFunc is called to send a notification to the logged-in user.
type NotifyFunc func(title, body, urgency string)

// RebootManager handles reboot scheduling, notification, and execution.
type RebootManager struct {
	mu               sync.Mutex
	state            RebootState
	scheduledTimer   *time.Timer
	notifyTimers     []*time.Timer
	notifyFn         NotifyFunc
	stopChan         chan struct{}
	stopped          bool
	maxRebootsPerDay int
	rebootHistory    []time.Time
}

// NewRebootManager creates a new RebootManager with circuit breaker protection.
func NewRebootManager(notifyFn NotifyFunc, maxRebootsPerDay int) *RebootManager {
	if maxRebootsPerDay <= 0 {
		maxRebootsPerDay = 3
	}
	rm := &RebootManager{
		notifyFn:         notifyFn,
		stopChan:         make(chan struct{}),
		maxRebootsPerDay: maxRebootsPerDay,
	}
	rm.loadRebootHistory()
	return rm
}

// State returns the current reboot state.
func (r *RebootManager) State() RebootState {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Refresh pending reboot detection
	pending, _ := DetectPendingReboot()
	r.state.PendingReboot = pending
	return r.state
}

// Schedule schedules a reboot after the given delay with a hard deadline.
func (r *RebootManager) Schedule(delay time.Duration, deadline time.Time, reason, source string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.stopped {
		return fmt.Errorf("reboot manager is stopped")
	}

	// Cancel any existing schedule
	r.cancelLocked()

	rebootAt := time.Now().Add(delay)
	r.state = RebootState{
		PendingReboot:   true,
		RebootScheduled: true,
		ScheduledAt:     rebootAt,
		Deadline:        deadline,
		Reason:          reason,
		Source:          source,
	}

	// Schedule the actual reboot
	r.scheduledTimer = time.AfterFunc(delay, func() {
		r.executeReboot()
	})

	// Schedule user notifications
	r.scheduleNotifications(delay)

	return nil
}

// Cancel cancels a scheduled reboot.
func (r *RebootManager) Cancel() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if !r.state.RebootScheduled {
		return fmt.Errorf("no reboot scheduled")
	}

	r.cancelLocked()

	// Abort any pending Windows shutdown
	exec.Command("shutdown", "/a").Run()

	r.state.RebootScheduled = false
	r.state.ScheduledAt = time.Time{}
	r.state.Deadline = time.Time{}

	return nil
}

// Stop stops the reboot manager and cancels any pending reboot.
func (r *RebootManager) Stop() {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.stopped = true
	r.cancelLocked()
	close(r.stopChan)
}

func (r *RebootManager) cancelLocked() {
	if r.scheduledTimer != nil {
		r.scheduledTimer.Stop()
		r.scheduledTimer = nil
	}
	for _, t := range r.notifyTimers {
		t.Stop()
	}
	r.notifyTimers = nil
}

func (r *RebootManager) scheduleNotifications(totalDelay time.Duration) {
	type notification struct {
		before  time.Duration
		title   string
		body    string
		urgency string
	}

	notifications := []notification{
		{60 * time.Minute, "Reboot Scheduled", "A system reboot is scheduled in 1 hour for system updates. Please save your work.", "normal"},
		{15 * time.Minute, "Reboot Soon", "A system reboot is scheduled in 15 minutes. Please save your work.", "normal"},
		{5 * time.Minute, "Reboot Imminent", "System will reboot in 5 minutes. Save all work now.", "critical"},
	}

	for _, n := range notifications {
		if totalDelay > n.before {
			delay := totalDelay - n.before
			notif := n // capture for closure
			timer := time.AfterFunc(delay, func() {
				if r.notifyFn != nil {
					r.notifyFn(notif.title, notif.body, notif.urgency)
				}
				r.mu.Lock()
				r.state.NotifiedUser = true
				r.state.NotificationSent = time.Now()
				r.mu.Unlock()
			})
			r.notifyTimers = append(r.notifyTimers, timer)
		}
	}
}

func (r *RebootManager) executeReboot() {
	r.mu.Lock()

	// Circuit breaker: check reboot frequency
	now := time.Now()
	cutoff := now.Add(-24 * time.Hour)
	recentCount := 0
	for _, t := range r.rebootHistory {
		if t.After(cutoff) {
			recentCount++
		}
	}

	if recentCount >= r.maxRebootsPerDay {
		r.state.RebootScheduled = false
		r.mu.Unlock()

		log.Warn("reboot blocked by circuit breaker",
			"recentReboots", recentCount, "maxPerDay", r.maxRebootsPerDay)

		if r.notifyFn != nil {
			r.notifyFn("Reboot Blocked",
				fmt.Sprintf("Too many reboots detected (%d in 24h, max %d). Reboot cancelled to prevent reboot loop.",
					recentCount, r.maxRebootsPerDay),
				"critical")
		}
		return
	}

	// Record this reboot
	r.rebootHistory = append(r.rebootHistory, now)
	r.state.RebootScheduled = false
	r.mu.Unlock()

	// Persist history before rebooting
	r.saveRebootHistory()

	// Notify user of imminent reboot
	if r.notifyFn != nil {
		r.notifyFn("Rebooting Now", "System is rebooting for updates.", "critical")
	}

	// Execute reboot via Windows shutdown command
	exec.Command("shutdown", "/r", "/t", "0", "/d", "p:2:17").Run()
}

func rebootHistoryPath() string {
	return filepath.Join(config.GetDataDir(), "reboot_history.json")
}

func (r *RebootManager) loadRebootHistory() {
	data, err := os.ReadFile(rebootHistoryPath())
	if err != nil {
		return
	}

	var history []time.Time
	if err := json.Unmarshal(data, &history); err != nil {
		return
	}

	// Only keep entries from last 24 hours
	cutoff := time.Now().Add(-24 * time.Hour)
	filtered := make([]time.Time, 0, len(history))
	for _, t := range history {
		if t.After(cutoff) {
			filtered = append(filtered, t)
		}
	}

	r.rebootHistory = filtered
}

func (r *RebootManager) saveRebootHistory() {
	r.mu.Lock()
	history := make([]time.Time, len(r.rebootHistory))
	copy(history, r.rebootHistory)
	r.mu.Unlock()

	data, err := json.Marshal(history)
	if err != nil {
		return
	}

	dir := filepath.Dir(rebootHistoryPath())
	if err := os.MkdirAll(dir, 0700); err != nil {
		log.Debug("failed to create reboot history dir", "error", err)
		return
	}
	if err := os.WriteFile(rebootHistoryPath(), data, 0600); err != nil {
		log.Debug("failed to write reboot history", "error", err)
	}
}
