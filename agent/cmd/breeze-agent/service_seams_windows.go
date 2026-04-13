//go:build windows

package main

import "golang.org/x/sys/windows/svc"

// runServiceLoopFn is the package-level test seam for the post-startup
// SCM control loop. Production assigns it to runServiceLoop (defined
// in service_windows.go); tests in service_windows_test.go override
// it to skip the real loop (which would dereference comps.hb and
// comps.wsClient in shutdownAgent).
var runServiceLoopFn func(
	comps *agentComponents,
	r <-chan svc.ChangeRequest,
	changes chan<- svc.Status,
) (bool, uint32) = runServiceLoop
