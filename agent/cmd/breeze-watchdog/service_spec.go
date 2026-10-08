package main

import (
	"github.com/breeze-rmm/agent/internal/branding"
	"github.com/breeze-rmm/agent/internal/winsvcinstall"
)

// watchdogServiceSpec is what `service install` registers with the Windows
// Service Control Manager. name is the fixed service identifier and the
// arguments never change; the display name and the description are the
// operator's brand when the build carries one (see internal/branding), else
// today's text. It lives outside the Windows-only file so it is tested on
// every platform.
func watchdogServiceSpec(name string) winsvcinstall.Spec {
	return winsvcinstall.Spec{
		Name:        name,
		DisplayName: branding.OrValid(branding.WatchdogServiceDisplayName, "Breeze RMM Watchdog"),
		Description: branding.OrValid(branding.WatchdogServiceDescription, "Breeze Agent Watchdog - monitors and recovers the agent process"),
		Args:        []string{"run"},
	}
}
