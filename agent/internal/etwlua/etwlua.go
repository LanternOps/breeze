// Package etwlua subscribes to the Microsoft-Windows-LUA ETW provider on
// Windows from the Go agent. When a non-elevated process triggers
// consent.exe (the UAC consent UI), we extract the subject user, target
// executable, hash, and signer, then POST an elevation_requests row with
// flow_type='uac_intercept' to the Breeze API. This is discovery-only —
// no actuation, no blocking. Tracks 4-6 build the actuation side.
//
// File layout:
//
//	etwlua.go             — cross-platform interface, Event struct, Start loop
//	etwlua_windows.go     — real ETW subscriber wrapping 0xrawsec/golang-etw
//	etwlua_other.go       — no-op stub for !windows builds
//	queue.go              — bounded on-disk JSONL ring buffer for offline events
//
// The cross-platform Subscriber interface lets the Linux CI test job exercise
// the dedupe + queue + post pipeline with a fake subscriber; the real ETW
// path is only ever compiled on Windows.
//
// # Threat model
//
// SYSTEM-privilege requirement. ETW kernel sessions for Microsoft-Windows-LUA
// require SeSecurityPrivilege, which is held only by the SYSTEM account (and
// members of the Performance Log Users group). The agent is installed as a
// service running under LocalSystem, so this is satisfied by construction.
// Start() refuses to subscribe if the process is not running as
// SYSTEM/Administrator (privilege.IsRunningAsRoot) — better to be a silent
// no-op than a noisy failure loop.
//
// Discovery-only, no blocking. The ETW provider is read-only: we observe
// the consent prompt being raised, we never inhibit it. Tracks 4-6 will
// add policy-driven approve/deny decisions via a different channel (the
// existing IPC + WebSocket command path). Keeping discovery isolated means
// a bug here cannot cause a missed-block: the worst we do is fail to
// record an event, never accidentally let or deny one.
//
// Dedupe rationale. Windows raises consent UI events redundantly under
// several conditions (UI repaint, user cancel + retry, parallel install
// scripts hitting the same MSI). Without dedupe a single legitimate
// admin-prompt can produce 5+ events. We key dedupe on
// sha256(exe_path) + ":" + subject_username with a 30s window using the
// existing ipc.RateLimiter — matches what Track 1's server-side dedupe
// will also do, so the wire is clean.
//
// Offline-queue rationale. The agent often runs on laptops behind captive
// portals or VPNs that drop briefly. The intercept event itself is short-
// lived (consent UI closes in seconds) and the user does not retry just
// because we missed a heartbeat. Losing the event would create a silent
// gap in the audit timeline. We persist to a JSONL ring buffer under the
// agent data dir, capped at 5 MB / 1000 events to bound disk usage. The
// drain happens opportunistically on each successful post.
//
// 7-day max staleness. Events older than 7 days are dropped on drain,
// not posted. Past that horizon the audit value is gone (technicians
// won't act on week-old UAC prompts) and the events would just delay
// fresh events behind a long-tail backlog. Matches the RefuseAfter horizon
// used by the PAM rules cache (pam/cache.go:82).
//
// ETW security descriptor (Win10 1809+). Microsoft-Windows-LUA's
// registration descriptor allows trace subscription by SYSTEM and the
// built-in Performance Log Users group. Earlier Windows builds (pre-1809)
// required custom WMI registration; we do not support those.
package etwlua

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/privilege"
)

var log = logging.L("etwlua")

// Event is the platform-neutral representation of a UAC consent prompt.
// Windows-side decoders populate it from ConsentUI ETW events; the cross-
// platform tests construct it directly via the fake Subscriber.
type Event struct {
	// SubjectUsername is the user whose context raised the consent UI.
	// "DOMAIN\\user" on domain-joined machines, ".\\user" or just "user"
	// on standalone machines. Required.
	SubjectUsername string `json:"subject_username"`

	// TargetExecutablePath is the absolute path of the binary about to be
	// elevated. Required.
	TargetExecutablePath string `json:"target_executable_path"`

	// TargetExecutableHash is the SHA-256 of the binary file as hex. Empty
	// if hashing failed (file gone, permission denied) — server accepts
	// nullable hash.
	TargetExecutableHash string `json:"target_executable_hash,omitempty"`

	// TargetExecutableSigner is the Authenticode subject (best-effort).
	// Empty when unsigned or read failed.
	TargetExecutableSigner string `json:"target_executable_signer,omitempty"`

	// PID, ParentImage, CommandLine are process metadata included for
	// forensics. CommandLine is best-effort and may be empty on locked-
	// down systems where the agent can't open the process for read.
	PID         uint32 `json:"pid,omitempty"`
	ParentImage string `json:"parent_image,omitempty"`
	CommandLine string `json:"command_line,omitempty"`

	// ObservedAt is when the agent saw the event (UTC, RFC3339 in JSON).
	ObservedAt time.Time `json:"observed_at"`
}

// Subscriber abstracts the ETW event source. Real Windows builds use
// etwSession from etwlua_windows.go; tests pass a fake.
type Subscriber interface {
	// Events returns a channel of decoded Event values. The channel is
	// closed by the subscriber when Stop is called or an unrecoverable
	// error occurs.
	Events() <-chan Event
	// Stop releases the underlying ETW session. Must be safe to call
	// multiple times.
	Stop()
}

// HeartbeatPoster is the subset of *heartbeat.Heartbeat that etwlua needs.
// Defined here so etwlua does not import the heartbeat package (which would
// create a cycle once heartbeat imports etwlua for the SendElevationRequest
// handler).
type HeartbeatPoster interface {
	SendElevationRequest(req Event) error
}

// ErrNotPrivileged is returned by Start when the process is not running as
// SYSTEM/Administrator. Callers should log+continue rather than crash.
var ErrNotPrivileged = errors.New("etwlua: process not running with admin/SYSTEM privileges; ETW subscribe skipped")

// ErrNotSupported is returned by NewETWSubscriber on non-Windows platforms.
// Callers (main.go) should treat this as "skip etwlua startup" rather than
// crash — etwlua is a Windows-only feature.
var ErrNotSupported = errors.New("etwlua: ETW subscriber not supported on this platform")

// dedupeWindow is the rate-limit window for "same exe + same user" events.
// 30s matches the Windows consent UI re-raise envelope; longer would
// drop legitimate retries by the same user.
const dedupeWindow = 30 * time.Second

// drainTickInterval is how often we attempt to flush the offline queue
// independent of new events arriving. Keeps the queue bounded even on
// machines where ETW events are sparse but the network has been down.
const drainTickInterval = 60 * time.Second

// Start runs the etwlua loop until ctx is cancelled. It reads events from
// sub.Events(), deduplicates them via a per-(exe_hash,user) rate limiter,
// posts them via hb.SendElevationRequest, and queues to disk on failure.
// Drain is attempted opportunistically on every successful post and on a
// 60s ticker.
//
// Start refuses to run if the process is not privileged. This mirrors the
// behavior of the pam package: rather than emit a noisy failure-loop log
// every minute, we log once and become a no-op. Callers may still call
// Start with a fake subscriber in tests by passing privileged=true via
// the underlying check (tests run as the build user, which is root in CI
// containers — IsRunningAsRoot returns true there).
//
// Start does not spawn its own goroutine; callers should `go etwlua.Start(...)`.
func Start(ctx context.Context, sub Subscriber, hb HeartbeatPoster) error {
	if !privilege.IsRunningAsRoot() {
		log.Warn(ErrNotPrivileged.Error())
		return ErrNotPrivileged
	}

	limiter := ipc.NewRateLimiter(1, dedupeWindow)
	q, err := NewQueue(DefaultQueuePath())
	if err != nil {
		log.Warn("etwlua: queue init failed, events will be lost on post failure", "error", err.Error())
		// Continue without a queue rather than refuse to run.
	}

	ticker := time.NewTicker(drainTickInterval)
	defer ticker.Stop()
	defer sub.Stop()

	log.Info("etwlua started",
		"queue_path", DefaultQueuePath(),
		"dedupe_window", dedupeWindow.String(),
	)

	for {
		select {
		case <-ctx.Done():
			log.Info("etwlua stopping")
			return nil

		case ev, ok := <-sub.Events():
			if !ok {
				log.Warn("etwlua: subscriber channel closed; exiting loop")
				return nil
			}
			if ev.ObservedAt.IsZero() {
				ev.ObservedAt = time.Now().UTC()
			}
			handleEvent(ev, limiter, hb, q)

		case <-ticker.C:
			if q != nil {
				if drained, err := q.Drain(hb); err != nil {
					log.Debug("etwlua: periodic drain failed", "error", err.Error())
				} else if drained > 0 {
					log.Info("etwlua: periodic drain succeeded", "events", drained)
				}
			}
		}
	}
}

// handleEvent is the per-event hot path, extracted so tests can exercise it
// without spinning up the full Start loop.
func handleEvent(ev Event, limiter *ipc.RateLimiter, hb HeartbeatPoster, q *Queue) {
	key := dedupeKey(ev)
	if !limiter.Allow(key) {
		log.Debug("etwlua: event deduped",
			"user", ev.SubjectUsername,
			"path", ev.TargetExecutablePath,
		)
		return
	}

	if err := hb.SendElevationRequest(ev); err != nil {
		log.Warn("etwlua: post failed, queueing",
			"user", ev.SubjectUsername,
			"path", ev.TargetExecutablePath,
			"error", err.Error(),
		)
		if q != nil {
			if qerr := q.Enqueue(ev); qerr != nil {
				log.Error("etwlua: enqueue failed; event dropped",
					"error", qerr.Error())
			}
		}
		return
	}

	log.Debug("etwlua: event posted",
		"user", ev.SubjectUsername,
		"path", ev.TargetExecutablePath,
	)
	// Opportunistic drain on every successful post — quickly catches up
	// after a network blip.
	if q != nil {
		if _, err := q.Drain(hb); err != nil {
			log.Debug("etwlua: opportunistic drain failed", "error", err.Error())
		}
	}
}

// dedupeKey returns sha256(exe_path) + ":" + subject_username. Hashing the
// path keeps the key short even for long UNC paths and is constant-time to
// compare in the limiter's internal map.
func dedupeKey(ev Event) string {
	sum := sha256.Sum256([]byte(ev.TargetExecutablePath))
	return hex.EncodeToString(sum[:]) + ":" + ev.SubjectUsername
}

// FakeSubscriber is exported for use in tests outside this package. The
// channel is unbuffered to keep Inject deterministic.
type FakeSubscriber struct {
	ch       chan Event
	once     sync.Once
	stopOnce sync.Once
}

// NewFakeSubscriber returns a Subscriber whose Events channel is fed by
// callers via Inject. Used by etwlua_test.go and (eventually) by
// integration tests in other packages.
func NewFakeSubscriber() *FakeSubscriber {
	return &FakeSubscriber{ch: make(chan Event, 16)}
}

// Events implements Subscriber.
func (f *FakeSubscriber) Events() <-chan Event { return f.ch }

// Stop implements Subscriber. Idempotent.
func (f *FakeSubscriber) Stop() {
	f.stopOnce.Do(func() { close(f.ch) })
}

// Inject sends ev on the events channel. Blocks if the channel buffer
// (16) is full — tests should Drain before Inject-storming.
func (f *FakeSubscriber) Inject(ev Event) {
	f.ch <- ev
}
