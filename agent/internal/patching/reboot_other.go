//go:build !windows

package patching

import "time"

// DetectPendingReboot is a no-op on non-Windows platforms.
func DetectPendingReboot() (bool, []string) {
	return false, nil
}

// RebootState tracks the current reboot scheduling state.
type RebootState struct {
	PendingReboot    bool      `json:"pendingReboot"`
	RebootScheduled  bool      `json:"rebootScheduled"`
	ScheduledAt      time.Time `json:"scheduledAt,omitempty"`
	Deadline         time.Time `json:"deadline,omitempty"`
	Reason           string    `json:"reason,omitempty"`
	NotifiedUser     bool      `json:"notifiedUser"`
	NotificationSent time.Time `json:"notificationSent,omitempty"`
	Source           string    `json:"source"`
}

// NotifyFunc is called to send a notification to the logged-in user.
type NotifyFunc func(title, body, urgency string)

// RebootManager handles reboot scheduling on non-Windows (stub).
type RebootManager struct{}

// NewRebootManager creates a no-op RebootManager on non-Windows.
func NewRebootManager(_ NotifyFunc, _ int) *RebootManager {
	return &RebootManager{}
}

func (r *RebootManager) State() RebootState                                             { return RebootState{} }
func (r *RebootManager) Schedule(_ time.Duration, _ time.Time, _, _ string) error { return nil }
func (r *RebootManager) Cancel() error                                                   { return nil }
func (r *RebootManager) Stop()                                                           {}
