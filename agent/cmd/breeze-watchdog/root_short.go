package main

import "github.com/breeze-rmm/agent/internal/branding"

// watchdogRootShort is the help text of the root command: the operator's
// brand when the build carries one (see internal/branding), else the default.
// Display only.
func watchdogRootShort() string {
	return branding.Or(branding.WatchdogCLIShort, "Breeze RMM Agent Watchdog")
}
