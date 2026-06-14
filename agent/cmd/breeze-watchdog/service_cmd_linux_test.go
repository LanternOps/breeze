//go:build linux

package main

import (
	"strings"
	"testing"
)

// TestWatchdogUnitDeclaresRuntimeDirectory guards the #1297 fix on the watchdog.
//
// Unlike the agent (which is intentionally unsandboxed since #1197), the
// watchdog stays hardened: ProtectSystem=strict + ReadWritePaths=/var/run/breeze.
// systemd builds that mount namespace by bind-mounting every ReadWritePaths
// entry, which REQUIRES the path to already exist. /run is tmpfs and wiped on
// reboot, so on a host whose tmpfiles.d snippet was never installed /run/breeze
// is absent at boot and the watchdog fails sandbox setup with 226/NAMESPACE —
// the same wedge the agent hit before #1197. With both the agent and the
// watchdog wedged, nothing on the host can self-heal.
//
// RuntimeDirectory=breeze makes systemd create /run/breeze BEFORE building the
// namespace, eliminating that dependency. systemd reference-counts the runtime
// directory across breeze-agent + breeze-watchdog, so it persists while either
// unit is active.
func TestWatchdogUnitDeclaresRuntimeDirectory(t *testing.T) {
	if !strings.Contains(watchdogUnit, "RuntimeDirectory=breeze") {
		t.Error("watchdogUnit must declare RuntimeDirectory=breeze so systemd creates " +
			"/run/breeze before its hardened mount namespace is built (#1297)")
	}
	if !strings.Contains(watchdogUnit, "RuntimeDirectoryMode=0770") {
		t.Error("watchdogUnit must declare RuntimeDirectoryMode=0770 to match the agent unit")
	}
	// RuntimeDirectoryPreserve defaults to 'no' (remove on stop). Without it, a
	// watchdog restart on a partially-upgraded host would remove /run/breeze out
	// from under a still-running breeze-agent, re-wedging it at 226/NAMESPACE.
	if !strings.Contains(watchdogUnit, "RuntimeDirectoryPreserve=yes") {
		t.Error("watchdogUnit must declare RuntimeDirectoryPreserve=yes so a watchdog restart " +
			"does not remove /run/breeze out from under a still-running agent (#1297)")
	}
}

// TestWatchdogUnitStillReferencesRunBreeze documents the invariant that makes the
// RuntimeDirectory directive load-bearing: as long as the watchdog keeps
// /var/run/breeze in ReadWritePaths, that path MUST be guaranteed to exist at
// boot. If a future change drops the ReadWritePaths entry, the RuntimeDirectory
// requirement could be revisited — but until then they must travel together.
func TestWatchdogUnitStillReferencesRunBreeze(t *testing.T) {
	if strings.Contains(watchdogUnit, "ReadWritePaths=") &&
		strings.Contains(watchdogUnit, "/var/run/breeze") &&
		!strings.Contains(watchdogUnit, "RuntimeDirectory=breeze") {
		t.Error("watchdogUnit binds /var/run/breeze via ReadWritePaths but no longer " +
			"declares RuntimeDirectory=breeze — it will wedge at 226/NAMESPACE on reboot (#1297)")
	}
}
