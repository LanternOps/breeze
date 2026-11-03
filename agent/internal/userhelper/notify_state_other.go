//go:build !windows

package userhelper

// platformNotificationState is nil off Windows: macOS and Linux have no
// notification-state query in this design (spec §3.2), so a notice is drawn
// as the native dialog, like every other prompt.
var platformNotificationState func() (uint32, error)
