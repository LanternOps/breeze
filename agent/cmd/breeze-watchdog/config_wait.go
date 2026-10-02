package main

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	breezeeventlog "github.com/breeze-rmm/agent/internal/eventlog"
)

// Seams for tests.
var (
	watchdogLoadConfigFn          = func() (*config.Config, error) { return config.Load("") }
	watchdogConfigRetryAfterFn    = time.After
	watchdogReportConfigRefusalFn = reportWatchdogConfigRefusal
)

const (
	watchdogConfigRetryFirstDelay = 5 * time.Second
	watchdogConfigRetryMaxDelay   = 2 * time.Minute
)

// reportWatchdogConfigRefusal records a refused config where an admin can
// find it after the fact: the Windows Event Log (a no-op elsewhere) and
// stderr/slog. The health journal is not open yet at this point.
func reportWatchdogConfigRefusal(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	slog.Warn(msg)
	breezeeventlog.Warning("BreezeWatchdog", msg)
}

// loadWatchdogConfig loads the machine config. When the loader refuses it
// because another account could have written it, the watchdog neither runs
// on it nor repairs it — the agent service is the folder's only owner, and
// it keeps taking the folder back until it can — but waits, retrying with a
// delay that doubles from 5 s to at most 2 minutes, and records the reason
// durably (again only when it changes). It returns (nil, nil) when stop is
// closed while waiting, and any other load error at once, as before.
func loadWatchdogConfig(stop <-chan struct{}) (*config.Config, error) {
	delay := watchdogConfigRetryFirstDelay
	lastReason := ""
	for {
		cfg, err := watchdogLoadConfigFn()
		if err == nil {
			return cfg, nil
		}
		if !errors.Is(err, config.ErrConfigDirUntrusted) {
			return nil, err
		}
		if reason := err.Error(); reason != lastReason {
			watchdogReportConfigRefusalFn("Breeze watchdog is not using the agent config and will retry: " + reason)
			lastReason = reason
		}
		select {
		case <-stop:
			return nil, nil
		case <-watchdogConfigRetryAfterFn(delay):
		}
		if delay *= 2; delay > watchdogConfigRetryMaxDelay {
			delay = watchdogConfigRetryMaxDelay
		}
	}
}
