//go:build !darwin || !cgo

package userhelper

import "github.com/breeze-rmm/agent/internal/ipc"

// CheckTCCPermissions is a no-op on non-macOS platforms or when CGO is disabled.
func CheckTCCPermissions() *ipc.TCCStatus {
	return nil
}

// RequestScreenRecording is a no-op on non-macOS platforms or when CGO is disabled.
func RequestScreenRecording() bool {
	return false
}

// RunTCCCheckLoop is a no-op on non-macOS platforms or when CGO is disabled.
func RunTCCCheckLoop(conn *ipc.Conn, stopChan chan struct{}) {}
