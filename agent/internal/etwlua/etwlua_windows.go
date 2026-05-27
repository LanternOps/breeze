//go:build windows

package etwlua

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/0xrawsec/golang-etw/etw"
)

// providerGUID is the Microsoft-Windows-LUA ETW provider. Documented in
// the Windows SDK (microsoft-windows-lua.manifest) and stable since
// Windows 7. We pin the literal GUID here rather than name-resolving via
// TdhEnumerateProviders — the GUID will never change and resolution adds
// a runtime dependency we don't want.
const providerGUID = "{93c05d69-51a3-485e-877f-1806a8731346}"

// consentEventIDs are the ETW event IDs raised when the consent UI is
// shown for elevation. Sourced from the Windows-Internals reference for
// the LUA provider: 4100/4101/4102 cover the "consent prompted" /
// "consent granted" / "consent denied" tuple. We watch all three so a
// denied prompt also produces a discovery event (Tracks 4-6 will use
// the denial signal to drive policy tuning).
var consentEventIDs = map[uint16]string{
	4100: "consent_prompted",
	4101: "consent_granted",
	4102: "consent_denied",
}

// etwSession wraps a golang-etw Consumer for the Microsoft-Windows-LUA
// provider. The session runs in its own goroutine started by Subscribe;
// Stop signals the consumer to abort and waits for the goroutine to exit.
type etwSession struct {
	consumer *etw.Consumer
	session  *etw.RealTimeSession
	events   chan Event
	stopOnce sync.Once
	doneCh   chan struct{}
}

// NewETWSubscriber creates a live subscription to the Microsoft-Windows-LUA
// provider. Returns ErrNotPrivileged if the caller is not SYSTEM/Admin
// (the ETW session call would fail with ERROR_ACCESS_DENIED anyway, but
// we surface the cause clearly).
//
// The returned Subscriber owns one TraceLogging RealTime session named
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

	consumer := etw.NewRealTimeConsumer(nil).FromSessions(session)

	s := &etwSession{
		consumer: consumer,
		session:  session,
		events:   make(chan Event, 64),
		doneCh:   make(chan struct{}),
	}

	go s.run()
	return s, nil
}

// run pumps events from the consumer's channel through decode() into
// s.events until Stop closes the consumer. Exits when the consumer's
// channel is closed.
func (s *etwSession) run() {
	defer close(s.doneCh)
	defer close(s.events)

	if err := s.consumer.Start(); err != nil {
		log.Error("etwlua: consumer start failed", "error", err.Error())
		return
	}

	for ee := range s.consumer.Events {
		// Filter by event ID before doing any expensive decode work.
		if _, ok := consentEventIDs[ee.System.EventID]; !ok {
			continue
		}
		ev, ok := decodeConsentEvent(ee)
		if !ok {
			continue
		}
		select {
		case s.events <- ev:
		default:
			// Buffer full — drop the event rather than block ETW. ETW
			// real-time sessions tolerate slow consumers but a blocked
			// reader will eventually start losing kernel events, which
			// is worse than losing one user-mode UAC event here.
			log.Warn("etwlua: event channel full, dropping event",
				"path", ev.TargetExecutablePath,
			)
		}
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

// decodeConsentEvent extracts the fields we care about from a parsed ETW
// event. Returns ok=false if required fields are missing — better to drop
// than emit a half-decoded event.
//
// The LUA provider's ConsentUI events expose these properties (names
// stable across Windows 10/11):
//
//	SubjectUserName / SubjectUserSid  — who raised the prompt
//	ApplicationName                   — target executable path
//	CommandLine                       — full command line (may be empty)
//	ProcessId / ParentProcessName     — process metadata
//
// We hash the target file at observation time. The hash is best-effort:
// on a fast machine the file is already paged in, but if it's on a slow
// mount or has been deleted between the prompt and our read, the hash
// is empty (server accepts nullable).
func decodeConsentEvent(ee *etw.Event) (Event, bool) {
	props := ee.EventData
	if props == nil {
		// Some LUA events use UserData instead of EventData.
		props = ee.UserData
	}
	if props == nil {
		return Event{}, false
	}

	exePath := stringProp(props, "ApplicationName")
	user := stringProp(props, "SubjectUserName")
	if exePath == "" || user == "" {
		return Event{}, false
	}

	ev := Event{
		SubjectUsername:      user,
		TargetExecutablePath: exePath,
		CommandLine:          stringProp(props, "CommandLine"),
		ParentImage:          stringProp(props, "ParentProcessName"),
		ObservedAt:           time.Now().UTC(),
	}

	if pidStr := stringProp(props, "ProcessId"); pidStr != "" {
		var pid uint32
		if _, err := fmt.Sscanf(pidStr, "%d", &pid); err == nil {
			ev.PID = pid
		}
	}

	if hash, err := hashFile(exePath); err == nil {
		ev.TargetExecutableHash = hash
	}

	// Authenticode signer extraction would require WinTrust/CryptoAPI
	// (golang-x/sys/windows.WinVerifyTrust) — significant code surface
	// and a tested-on-Windows-only path. Track 3 leaves this empty;
	// signer is a "best-effort" field and the server schema accepts
	// NULL. A follow-up PR can wire it in once we have a Windows CI
	// runner to validate.

	return ev, true
}

// stringProp pulls a string value from an ETW property bag, tolerating
// either map[string]any or map[string]string shapes that golang-etw may
// emit depending on event manifest types.
func stringProp(props map[string]any, key string) string {
	v, ok := props[key]
	if !ok {
		return ""
	}
	switch s := v.(type) {
	case string:
		return strings.TrimSpace(s)
	case fmt.Stringer:
		return strings.TrimSpace(s.String())
	}
	return strings.TrimSpace(fmt.Sprintf("%v", v))
}

// hashFile returns the SHA-256 of the file at path as hex. Returns an
// error if the file cannot be opened or read.
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
