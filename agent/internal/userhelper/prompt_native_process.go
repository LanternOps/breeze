//go:build darwin || linux

package userhelper

import "time"

// macOS and Linux draw a native prompt with a child process (osascript,
// zenity); Windows draws in process and reports from TDN_CREATED.

// nativeStartupWindow is how long a dialog process must keep running before
// it is reported on screen: one that cannot draw (a script error, no
// display) exits within it (#12794 review).
const nativeStartupWindow = time.Second

// runNativeProcess waits for a started dialog process (wait is its
// cmd.Wait). presented is called once the process has outlived window, and
// never for one that exits sooner; reported says whether it was called. A
// caller whose process exited quickly with a real answer reports it
// presented itself, before the answer.
func runNativeProcess(wait func() error, window time.Duration, presented func()) (reported bool, err error) {
	done := make(chan error, 1)
	go func() { done <- wait() }()
	t := time.NewTimer(window)
	defer t.Stop()
	select {
	case err := <-done:
		return false, err
	case <-t.C:
		presented()
		return true, <-done
	}
}
