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
// existing ipc.RateLimiter. This is purely agent-side noise suppression —
// the server applies its own per-device rate limit on ingest but does not
// coalesce duplicates (it inserts a fresh row per accepted request), so
// there is no parity contract and the keys/windows are unrelated.
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
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/privilege"
)

var log = logging.L("etwlua")

// dropObserved tracks suppressed-event observability while the 'pam' config
// policy has interception disabled: one Info log on the first drop of each
// disable interval (not per event — a busy desktop would spam), and a counter
// so the re-enable transition can quantify the window. Package-level because
// handleEvent is a free function; reset by the re-enable path in handleEvent.
var (
	dropLogged  atomic.Bool
	dropCounter atomic.Int64
)

// Event is the platform-neutral representation of a UAC consent prompt.
// Windows-side decoders populate it from ConsentUI ETW events; the cross-
// platform tests construct it directly via the fake Subscriber.
type Event struct {
	// SubjectUsername is the user whose context raised the consent UI.
	// "DOMAIN\\user" on domain-joined machines, ".\\user" or just "user"
	// on standalone machines. Required.
	SubjectUsername string `json:"subject_username"`

	// SubjectSessionID is the local Windows session that owns the consent UI.
	// It is used to route PAM locally and must not be sent to the server.
	SubjectSessionID uint32 `json:"-"`

	// TargetExecutablePath is the absolute path of the binary about to be
	// elevated. Required.
	TargetExecutablePath string `json:"target_executable_path"`

	// TargetExecutableHash is the SHA-256 of the binary file as hex. Empty
	// if hashing failed (file gone, permission denied) — server accepts
	// nullable hash.
	TargetExecutableHash string `json:"target_executable_hash,omitempty"`

	// TargetExecutableSigner is the Authenticode subject CN (best-effort).
	// Empty when unsigned or read failed. WEAK signer tier on the server: a
	// subject CN is attacker-choosable, so CN-only matching is spoofable.
	TargetExecutableSigner string `json:"target_executable_signer,omitempty"`

	// TargetExecutableSignerThumbprint is the SHA-256 Authenticode leaf-cert
	// thumbprint as lowercase 64-char hex (#1776). STRONG signer tier: the
	// server pins this for tamper-proof publisher matching (a forged cert with
	// a trusted CN but a different key has a different thumbprint and is
	// rejected). Empty when unsigned, on read failure, or until the Windows
	// extraction lands — the server treats absence as "no thumbprint" and a
	// thumbprint-pinned rule then fails closed. Normalize via
	// NormalizeThumbprint before populating.
	TargetExecutableSignerThumbprint string `json:"target_executable_signer_thumbprint,omitempty"`

	// PID, ParentImage, CommandLine are process metadata included for
	// forensics. CommandLine is best-effort and may be empty on locked-
	// down systems where the agent can't open the process for read.
	PID         uint32 `json:"pid,omitempty"`
	ParentImage string `json:"parent_image,omitempty"`
	CommandLine string `json:"command_line,omitempty"`

	// ObservedAt is when the agent saw the event (UTC, RFC3339 in JSON).
	ObservedAt time.Time `json:"observed_at"`
}

// ElevationStatus is the server's ingest decision for a uac_intercept request.
type ElevationStatus string

const (
	ElevationPending      ElevationStatus = "pending"
	ElevationAutoApproved ElevationStatus = "auto_approved"
	ElevationDenied       ElevationStatus = "denied"
	ElevationIgnored      ElevationStatus = "ignored"
)

// ElevationOutcome is the server's synchronous ingest decision for a posted
// uac_intercept elevation request, parsed from the POST response body
// {"id":"<uuid>","status":"<status>"}. Status is one of "pending",
// "auto_approved", "denied", or "ignored". RequestID is empty when the
// server suppressed the request (status "ignored", id null).
type ElevationOutcome struct {
	RequestID string
	Status    ElevationStatus
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
	// SendElevationRequest posts the detected prompt and returns the
	// server's ingest decision. A non-nil error means the post failed
	// (network/5xx) and the event should be queued for retry.
	SendElevationRequest(req Event) (ElevationOutcome, error)
	// IsUACInterceptionEnabled reports the server-resolved 'pam' config
	// policy state. While false, handleEvent drops events entirely (no
	// post, no offline queue) and the periodic queue drain is paused.
	IsUACInterceptionEnabled() bool
}

// PamRunner drives the local elevation flow (dialog → decision →
// actuate/deny) for one detected UAC prompt, using the server's ingest
// decision. It is the single edge from etwlua into the session broker +
// actuator, kept behind an interface so etwlua stays unit-testable without
// a live broker or Windows. A nil PamRunner disables the flow (detection +
// post only) — used on non-Windows builds and when the broker is absent.
//
// Implementations must be non-blocking-forever: bound the dialog round-trip
// to consent.exe's lifetime. RunPamFlow is called synchronously from the
// event loop; UAC prompts are modal and serial, so one in-flight flow at a
// time is correct.
type PamRunner interface {
	RunPamFlow(ctx context.Context, ev Event, outcome ElevationOutcome)
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
func Start(ctx context.Context, sub Subscriber, hb HeartbeatPoster, pam PamRunner) error {
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
			handleEvent(ctx, ev, limiter, hb, q, pam)

		case <-ticker.C:
			if q != nil && hb.IsUACInterceptionEnabled() {
				if drained, err := q.Drain(hb); err != nil {
					log.Debug("etwlua: periodic drain failed", "error", err.Error())
				} else if drained > 0 {
					log.Info("etwlua: periodic drain succeeded", "events", drained)
				}
			} else if q != nil {
				log.Debug("etwlua: periodic drain paused — interception disabled by configuration policy")
			}
		}
	}
}

// handleEvent is the per-event hot path, extracted so tests can exercise it
// without spinning up the full Start loop.
func handleEvent(ctx context.Context, ev Event, limiter *ipc.RateLimiter, hb HeartbeatPoster, q *Queue, pam PamRunner) {
	if !hb.IsUACInterceptionEnabled() {
		dropCounter.Add(1)
		if dropLogged.CompareAndSwap(false, true) {
			log.Info("etwlua: dropping UAC events — interception disabled by configuration policy")
		}
		return
	}

	// Interception is enabled. If a disable window just ended, log the
	// re-enable transition with the count of events dropped. This fires
	// lazily on the first event after re-enable, not at the exact moment
	// the policy flips — acceptable for diagnostic purposes.
	if dropLogged.Load() {
		dropped := dropCounter.Swap(0)
		dropLogged.Store(false)
		log.Info("etwlua: interception re-enabled by configuration policy", "dropped_during_disable", dropped)
	}

	key := dedupeKey(ev)
	if !limiter.Allow(key) {
		log.Debug("etwlua: event deduped",
			"user", ev.SubjectUsername,
			"path", ev.TargetExecutablePath,
		)
		return
	}

	outcome, err := hb.SendElevationRequest(ev)
	if err != nil {
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

	// Drive the local elevation flow. The dedupe above prevents stacked dialogs
	// for re-fired ETW events that arrive *before* the flow starts, but the
	// window is re-asserted at flow-end (below) to also cover flows that run
	// longer than dedupeWindow. Note this only fires for live posts: events
	// replayed later via Queue.Drain discard the outcome and deliberately skip
	// the flow — a drained event is a stale prompt whose consent.exe dialog is
	// long gone, so actuating it is wrong.
	if pam != nil && outcome.RequestID != "" && outcome.Status != ElevationIgnored {
		pam.RunPamFlow(ctx, ev, outcome)
		// RunPamFlow can block on the PAM dialog up to ~90s — longer than the
		// 30s dedupeWindow — so the arrival entry recorded above may have
		// expired by now. Re-record the key so a re-fired *live* ETW event
		// arriving right after the flow completes is suppressed. This only
		// effectively restarts the window from flow-end when the flow OUTLASTS
		// dedupeWindow; for a short flow the arrival entry is still live and
		// this Allow is a no-op (the window stays anchored at arrival) — still
		// correct, just unnecessary. A genuine retry after the window still
		// gets through. Result discarded — we're recording, not gating.
		_ = limiter.Allow(key)
	}

	// Opportunistic drain on every successful post — quickly catches up
	// after a network blip.
	// Mirror the ticker-drain gate: both drain sites must check the policy flag.
	if q != nil && hb.IsUACInterceptionEnabled() {
		if _, err := q.Drain(hb); err != nil {
			log.Debug("etwlua: opportunistic drain failed", "error", err.Error())
		}
	}
}

// NormalizeThumbprint canonicalizes a raw SHA-256 certificate thumbprint into
// the lowercase 64-char hex form the server matches on (#1776). It drops the
// separators Windows/CryptoAPI and PowerShell render between byte pairs (spaces,
// colons, dashes, tabs/newlines, NUL padding) and lowercases A-F. It returns
// ("", false) unless the result is EXACTLY 64 hex chars, and rejects any other
// character outright — a malformed or wrong-length value is never sent, so the
// server can't match on a half-formed pin (fail closed). The Windows
// Authenticode extraction (still deferred — see etwlua_windows.go) will pass
// its computed thumbprint through this before assigning Event.TargetExecutableSignerThumbprint.
func NormalizeThumbprint(raw string) (string, bool) {
	var b strings.Builder
	b.Grow(len(raw))
	for _, r := range raw {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'f':
			b.WriteRune(r)
		case r >= 'A' && r <= 'F':
			b.WriteRune(r + ('a' - 'A'))
		case r == ' ' || r == ':' || r == '-' || r == '\t' || r == '\n' || r == '\r' || r == 0x00:
			// separator / whitespace / NUL padding between byte pairs — skip
		default:
			// Any other character makes the whole value suspect → reject.
			return "", false
		}
	}
	s := b.String()
	if len(s) != 64 {
		return "", false
	}
	return s, true
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
