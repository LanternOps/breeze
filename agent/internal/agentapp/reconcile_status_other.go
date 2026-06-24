//go:build !linux

package agentapp

// startReconcileFailureReporter is a no-op off Linux. The systemd unit
// auto-heal and its failure-surfacing (issue #1201) are Linux-only;
// recordReconcileFailure / clearReconcileStatus are referenced solely from the
// Linux service path and are not defined here.
func startReconcileFailureReporter() {}
