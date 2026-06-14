//go:build linux

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// reconcileStatusPath records the outcome of the most recent failed systemd
// unit auto-heal so the running agent can surface it to the fleet. It lives
// under the agent data dir (a var, not const, so tests can point it elsewhere).
//
// Why a file: the heal failure can originate in two processes — the agent
// itself (reconcileServiceUnitIfNeeded, before the log shipper is up) and the
// transient `reconcile-unit` subcommand spawned under PID 1 (whose stderr lands
// in a --collect'd transient-unit journal that's GC'd). Neither path can ship a
// log directly, so they drop a breadcrumb here and the running agent ships it
// once its log shipper is initialized. See issue #1201.
var reconcileStatusPath = filepath.Join(linuxDataDir, "reconcile-status")

const (
	reconcileStatusPrefix       = "failed\t"
	reconcileReportWindow       = 3 * time.Minute
	reconcileReportPollInterval = 10 * time.Second
)

// recordReconcileFailure persists a heal-failure reason. Best-effort: if we
// can't write it, the failure still surfaced to journald via the caller's
// stderr warning — this only adds the fleet-visible signal on top.
func recordReconcileFailure(reason string) {
	_ = os.MkdirAll(linuxDataDir, 0o755)
	line := reconcileStatusPrefix + strings.ReplaceAll(strings.TrimSpace(reason), "\n", " ") +
		"\t" + time.Now().UTC().Format(time.RFC3339)
	if err := os.WriteFile(reconcileStatusPath, []byte(line+"\n"), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not record reconcile-status breadcrumb: %v\n", err)
	}
}

// clearReconcileStatus removes a stale failure breadcrumb after a later success.
func clearReconcileStatus() {
	if err := os.Remove(reconcileStatusPath); err != nil && !os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "Warning: could not clear reconcile-status breadcrumb: %v\n", err)
	}
}

// readReconcileFailure returns the recorded failure reason, if any.
func readReconcileFailure() (reason string, ok bool) {
	data, err := os.ReadFile(reconcileStatusPath)
	if err != nil {
		return "", false
	}
	line := strings.TrimSpace(string(data))
	if !strings.HasPrefix(line, reconcileStatusPrefix) {
		return "", false
	}
	fields := strings.Split(strings.TrimPrefix(line, reconcileStatusPrefix), "\t")
	if len(fields) == 0 || strings.TrimSpace(fields[0]) == "" {
		return "", false
	}
	return fields[0], true
}

// startReconcileFailureReporter ships a recorded heal failure to the fleet
// (agent_logs) once the log shipper is up. It polls briefly rather than reading
// once: the transient reconcile subcommand runs a few seconds after the agent
// launches it, and in the worst case (unit rewritten but `systemctl restart`
// failed) the old, still-sandboxed agent keeps running — so a one-shot check
// would race the subcommand. The window is bounded so we never poll forever; by
// then the heal has either succeeded (breadcrumb cleared) or been reported.
func startReconcileFailureReporter() {
	go func() {
		deadline := time.Now().Add(reconcileReportWindow)
		for {
			if reason, ok := readReconcileFailure(); ok {
				log.Error(
					"systemd unit auto-heal failed; remote terminal/scripts may hit privilege "+
						"errors until 'sudo breeze-agent service install' is run",
					"component", "service-reconcile",
					"reason", reason,
				)
				clearReconcileStatus()
				return
			}
			if time.Now().After(deadline) {
				return
			}
			time.Sleep(reconcileReportPollInterval)
		}
	}()
}
