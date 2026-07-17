//go:build windows

package etwlua

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
	"unsafe"

	"github.com/0xrawsec/golang-etw/etw"
)

// providerGUID is the Microsoft-Windows-LUA ETW provider (lives in
// appinfo.dll). Stable since Windows 7; we pin the literal GUID rather
// than name-resolving via TdhEnumerateProviders.
const providerGUID = "{93c05d69-51a3-485e-877f-1806a8731346}"

// consentRequestEventID is the Microsoft-Windows-LUA event that carries the
// elevation-request detail (the target executable path + command line) when
// AppInfo raises a UAC consent. Verified empirically on Windows 11 (build
// 26200) against a live trace, and via the provider manifest
// (`wevtutil gp Microsoft-Windows-LUA /ge`): the LUA provider defines events
// in the 15001-16002 range on the `ConsentUI/Diagnostic` channel. It does
// NOT define 4100/4101/4102 — the values this code previously watched, which
// matched nothing, so UAC discovery captured zero events on the entire
// Windows fleet. Event 15028 is the request detail; 16001 (shown) and 16002
// (result) bracket it but carry only a correlation id + the exe basename /
// result code, so 15028 is the one self-contained event with the target.
const consentRequestEventID uint16 = 15028

// etwSession wraps a golang-etw Consumer for the Microsoft-Windows-LUA
// provider. The session runs in its own goroutine started by run(); Stop
// signals the consumer to abort and waits for the goroutine to exit.
type etwSession struct {
	consumer *etw.Consumer
	session  *etw.RealTimeSession
	events   chan Event
	stopOnce sync.Once
	doneCh   chan struct{}
}

// NewETWSubscriber creates a live subscription to the Microsoft-Windows-LUA
// provider. Returns an error if the caller is not SYSTEM/Admin (the ETW
// session call fails with ERROR_ACCESS_DENIED).
//
// The returned Subscriber owns one RealTime session named
// "Breeze-LUA-Discovery". Two callers on the same machine would conflict;
// we assume only one agent process per host (enforced elsewhere).
func NewETWSubscriber() (Subscriber, error) {
	session := etw.NewRealTimeSession("Breeze-LUA-Discovery")
	provider, err := etw.ParseProvider(providerGUID)
	if err != nil {
		return nil, fmt.Errorf("etwlua: parse provider GUID: %w", err)
	}
	if err := session.EnableProvider(provider); err != nil {
		// Most common failure mode: ERROR_ACCESS_DENIED when not SYSTEM.
		_ = session.Stop()
		return nil, fmt.Errorf("etwlua: enable LUA provider: %w", err)
	}

	// NewRealTimeConsumer PANICS on a nil parent context; Background() is
	// torn down via consumer.Stop() in etwSession.Stop().
	consumer := etw.NewRealTimeConsumer(context.Background()).FromSessions(session)

	s := &etwSession{
		consumer: consumer,
		session:  session,
		events:   make(chan Event, 64),
		doneCh:   make(chan struct{}),
	}

	go s.run()
	return s, nil
}

// run installs the low-level EventRecordHelper callback and starts the
// consumer. We use the raw EventRecord path (not the high-level
// consumer.Events channel) because the target executable path lives in
// event 15028's UserData blob, which TDH does not surface as a named
// property — the high-level parser only exposes an opaque "Parameters"
// field. We read the raw UserData bytes directly and scan them.
func (s *etwSession) run() {
	defer close(s.doneCh)
	defer close(s.events)

	s.consumer.EventRecordHelperCallback = func(h *etw.EventRecordHelper) error {
		if h.EventID() != consentRequestEventID {
			h.Skip()
			return nil
		}
		er := h.EventRec
		n := int(er.UserDataLength)
		if er.UserData == 0 || n <= 0 {
			h.Skip()
			return nil
		}
		// UserData is only valid for the lifetime of this callback; decode
		// copies the strings out before we return, so no use-after-free.
		raw := unsafe.Slice((*byte)(unsafe.Pointer(er.UserData)), n)
		ev, ok := decodeConsentRequest(raw)
		h.Skip()
		if !ok {
			return nil
		}
		select {
		case s.events <- ev:
		default:
			// Buffer full — drop rather than block the ETW callback.
			log.Warn("etwlua: event channel full, dropping event",
				"path", ev.TargetExecutablePath,
			)
		}
		return nil
	}

	if err := s.consumer.Start(); err != nil {
		log.Error("etwlua: consumer start failed", "error", err.Error())
		return
	}
	// The callback above does all the work and Skip()s every event, so
	// nothing is pushed to consumer.Events. Ranging it blocks until Stop
	// closes the channel, which is how this goroutine exits.
	for range s.consumer.Events {
	}
}

// Events implements Subscriber.
func (s *etwSession) Events() <-chan Event { return s.events }

// Stop implements Subscriber. Idempotent.
func (s *etwSession) Stop() {
	s.stopOnce.Do(func() {
		if err := s.consumer.Stop(); err != nil {
			log.Warn("etwlua: consumer stop returned error", "error", err.Error())
		}
		if err := s.session.Stop(); err != nil {
			log.Warn("etwlua: session stop returned error", "error", err.Error())
		}
		<-s.doneCh
	})
}

// decodeConsentRequest extracts the target executable path + command line
// from event 15028's raw UserData. The payload is a header (request id,
// session token, string-offset table) followed by UTF-16LE strings: the
// full target path (twice) and the quoted command line. Rather than parse
// the version-specific offset table, we scan the blob for UTF-16 strings
// and pick the one that looks like a drive-rooted path (target) and the one
// that starts with a quote (command line). Verified against two live Win11
// samples (`"C:\…\app.exe" version` and `"C:\Windows\System32\notepad.exe" `).
//
// Returns ok=false if no path is found or the requesting user can't be
// resolved — the server requires a non-empty subject_username, so an event
// without one would be rejected on POST anyway.
func decodeConsentRequest(raw []byte) (Event, bool) {
	targetPath, commandLine := parseConsentPayload(raw)
	if targetPath == "" {
		log.Debug("etwlua: unable to parse consent request payload", "payloadBytes", len(raw))
		return Event{}, false
	}

	user, sessionID, attributionSource := resolveRequesterSession()
	if user == "" {
		log.Debug("etwlua: dropping consent request with unresolved subject",
			"attributionSource", attributionSource,
			"targetPath", targetPath,
		)
		return Event{}, false
	}

	ev := Event{
		SubjectUsername:      user,
		SubjectSessionID:     sessionID,
		TargetExecutablePath: targetPath,
		CommandLine:          commandLine,
		ObservedAt:           time.Now().UTC(),
	}
	if hash, err := hashFile(targetPath); err == nil {
		ev.TargetExecutableHash = hash
	}
	// Authenticode signer extraction is still deferred (WinTrust/CryptoAPI) —
	// see #1776. When wired in, this must populate BOTH the subject CN
	// (ev.TargetExecutableSigner, weak tier) and the SHA-256 leaf-cert
	// thumbprint (ev.TargetExecutableSignerThumbprint, strong tier) via
	// NormalizeThumbprint; the server/payload fields and matching already
	// accept the thumbprint. The actual extraction needs a Windows CI runner to
	// validate (same blocker as #1771), so it remains a follow-up. The server
	// schema accepts a NULL signer and a NULL thumbprint, and a thumbprint-pinned
	// rule fails closed until the agent emits one.
	return ev, true
}

// hashFile returns the SHA-256 of the file at path as hex.
func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
