package main

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

func stubWatchdogConfigWait(t *testing.T, load func(call int) (*config.Config, error)) (reports *[]string) {
	t.Helper()
	origLoad, origAfter, origReport := watchdogLoadConfigFn, watchdogConfigRetryAfterFn, watchdogReportConfigRefusalFn
	t.Cleanup(func() {
		watchdogLoadConfigFn, watchdogConfigRetryAfterFn, watchdogReportConfigRefusalFn = origLoad, origAfter, origReport
	})
	n := 0
	var r []string
	watchdogLoadConfigFn = func() (*config.Config, error) { n++; return load(n) }
	watchdogConfigRetryAfterFn = func(time.Duration) <-chan time.Time {
		ch := make(chan time.Time, 1)
		ch <- time.Now()
		return ch
	}
	watchdogReportConfigRefusalFn = func(msg string) { r = append(r, msg) }
	return &r
}

// TestWatchdogWaitsForATrustedConfig: a config the loader refuses (another
// account could have written it) does not stop the watchdog or get used: it
// records why durably, keeps waiting, and starts once the agent has taken
// the folder back. The watchdog does not repair the folder itself; the
// agent service is its only owner.
func TestWatchdogWaitsForATrustedConfig(t *testing.T) {
	reports := stubWatchdogConfigWait(t, func(call int) (*config.Config, error) {
		if call < 4 {
			return nil, fmt.Errorf("refusing to read agent.yaml: %w: owned by another account", config.ErrConfigDirUntrusted)
		}
		return &config.Config{AgentID: "a"}, nil
	})
	cfg, err := loadWatchdogConfig(make(chan struct{}))
	if err != nil || cfg == nil || cfg.AgentID != "a" {
		t.Fatalf("loadWatchdogConfig = %+v, %v", cfg, err)
	}
	if len(*reports) != 1 {
		t.Errorf("durable reports = %v, want one for the (unchanged) reason", *reports)
	}
}

func TestWatchdogStopsWaitingForAConfigOnStop(t *testing.T) {
	stubWatchdogConfigWait(t, func(int) (*config.Config, error) {
		return nil, fmt.Errorf("%w: held", config.ErrConfigDirUntrusted)
	})
	watchdogConfigRetryAfterFn = func(time.Duration) <-chan time.Time { return nil }
	stop := make(chan struct{})
	close(stop)
	if cfg, err := loadWatchdogConfig(stop); cfg != nil || err != nil {
		t.Errorf("loadWatchdogConfig = %+v, %v; want a clean stop", cfg, err)
	}
}

func TestWatchdogConfigErrorsOtherThanTrustFailAsBefore(t *testing.T) {
	reports := stubWatchdogConfigWait(t, func(int) (*config.Config, error) { return nil, errors.New("yaml: bad indentation") })
	if _, err := loadWatchdogConfig(make(chan struct{})); err == nil {
		t.Fatal("an unreadable config did not fail")
	}
	if len(*reports) != 0 {
		t.Errorf("reports = %v", *reports)
	}
}
