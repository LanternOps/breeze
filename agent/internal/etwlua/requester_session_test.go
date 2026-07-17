package etwlua

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestSelectNewestConsentProcess(t *testing.T) {
	now := time.Date(2026, time.July, 16, 12, 0, 0, 0, time.UTC)
	trustedPath := `C:\Windows\System32\consent.exe`
	valid := consentProcessCandidate{
		PID:       100,
		SessionID: 2,
		ImagePath: trustedPath,
		StartedAt: now.Add(-5 * time.Second),
	}

	tests := []struct {
		name       string
		candidates []consentProcessCandidate
		wantPID    uint32
		wantOK     bool
	}{
		{
			name: "newest recent trusted process wins",
			candidates: []consentProcessCandidate{
				valid,
				{PID: 101, SessionID: 3, ImagePath: trustedPath, StartedAt: now.Add(-time.Second)},
			},
			wantPID: 101,
			wantOK:  true,
		},
		{
			name: "matching is case insensitive and accepts Win32 prefix",
			candidates: []consentProcessCandidate{
				{PID: 102, SessionID: 4, ImagePath: `  \\?\c:/WINDOWS/System32/CONSENT.EXE\  `, StartedAt: now.Add(-time.Second)},
			},
			wantPID: 102,
			wantOK:  true,
		},
		{
			name: "newer same-name process outside System32 is ignored",
			candidates: []consentProcessCandidate{
				valid,
				{PID: 103, SessionID: 5, ImagePath: `C:\Temp\consent.exe`, StartedAt: now.Add(-time.Second)},
			},
			wantPID: 100,
			wantOK:  true,
		},
		{
			name: "process older than dedupe window is ignored",
			candidates: []consentProcessCandidate{
				{PID: 104, SessionID: 6, ImagePath: trustedPath, StartedAt: now.Add(-dedupeWindow - time.Nanosecond)},
			},
			wantOK: false,
		},
		{
			name: "process in session zero is ignored",
			candidates: []consentProcessCandidate{
				{PID: 105, SessionID: 0, ImagePath: trustedPath, StartedAt: now.Add(-time.Second)},
			},
			wantOK: false,
		},
		{
			name: "process with invalid session is ignored",
			candidates: []consentProcessCandidate{
				{PID: 106, SessionID: 0xFFFFFFFF, ImagePath: trustedPath, StartedAt: now.Add(-time.Second)},
			},
			wantOK: false,
		},
		{
			name: "process with zero creation time is ignored",
			candidates: []consentProcessCandidate{
				{PID: 107, SessionID: 7, ImagePath: trustedPath},
			},
			wantOK: false,
		},
		{
			name: "process created after observation time is ignored",
			candidates: []consentProcessCandidate{
				{PID: 108, SessionID: 8, ImagePath: trustedPath, StartedAt: now.Add(time.Nanosecond)},
			},
			wantOK: false,
		},
		{
			name: "highest PID breaks an exact creation-time tie",
			candidates: []consentProcessCandidate{
				{PID: 109, SessionID: 9, ImagePath: trustedPath, StartedAt: now.Add(-time.Second)},
				{PID: 110, SessionID: 10, ImagePath: trustedPath, StartedAt: now.Add(-time.Second)},
			},
			wantPID: 110,
			wantOK:  true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := selectNewestConsentProcess(tc.candidates, trustedPath, now)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (candidate = %+v)", ok, tc.wantOK, got)
			}
			if ok && got.PID != tc.wantPID {
				t.Fatalf("PID = %d, want %d", got.PID, tc.wantPID)
			}
		})
	}
}

func TestResolveRequesterSessionWith(t *testing.T) {
	now := time.Date(2026, time.July, 16, 12, 0, 0, 0, time.UTC)
	trustedPath := `C:\Windows\System32\consent.exe`
	candidates := []consentProcessCandidate{
		{PID: 200, SessionID: 2, ImagePath: trustedPath, StartedAt: now.Add(-5 * time.Second)},
		{PID: 201, SessionID: 3, ImagePath: trustedPath, StartedAt: now.Add(-time.Second)},
	}

	tests := []struct {
		name             string
		candidates       []consentProcessCandidate
		consoleSessionID uint32
		users            map[uint32]string
		wantUsername     string
		wantSessionID    uint32
		wantSource       string
		wantLookups      []uint32
	}{
		{
			name:             "newest consent session resolves requester",
			candidates:       candidates,
			consoleSessionID: 1,
			users:            map[uint32]string{3: `DOMAIN\requester`, 1: `DOMAIN\console`},
			wantUsername:     `DOMAIN\requester`,
			wantSessionID:    3,
			wantSource:       "consent_process",
			wantLookups:      []uint32{3},
		},
		{
			name:             "unresolved consent session falls back to console",
			candidates:       candidates,
			consoleSessionID: 1,
			users:            map[uint32]string{1: `DOMAIN\console`},
			wantUsername:     `DOMAIN\console`,
			wantSessionID:    1,
			wantSource:       "console_fallback",
			wantLookups:      []uint32{3, 1},
		},
		{
			name:             "no consent candidate uses console fallback",
			consoleSessionID: 1,
			users:            map[uint32]string{1: `DOMAIN\console`},
			wantUsername:     `DOMAIN\console`,
			wantSessionID:    1,
			wantSource:       "console_fallback",
			wantLookups:      []uint32{1},
		},
		{
			name:             "no consent user and no console user is unresolved",
			candidates:       candidates,
			consoleSessionID: 1,
			users:            map[uint32]string{},
			wantSource:       "unresolved",
			wantLookups:      []uint32{3, 1},
		},
		{
			name:             "invalid console session is not queried",
			consoleSessionID: 0xFFFFFFFF,
			users:            map[uint32]string{},
			wantSource:       "unresolved",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var lookups []uint32
			lookupUser := func(sessionID uint32) string {
				lookups = append(lookups, sessionID)
				return tc.users[sessionID]
			}

			username, sessionID, source := resolveRequesterSessionWith(
				tc.candidates,
				trustedPath,
				now,
				tc.consoleSessionID,
				lookupUser,
			)
			if username != tc.wantUsername || sessionID != tc.wantSessionID || source != tc.wantSource {
				t.Fatalf(
					"resolution = (%q, %d, %q), want (%q, %d, %q)",
					username, sessionID, source,
					tc.wantUsername, tc.wantSessionID, tc.wantSource,
				)
			}
			if !reflect.DeepEqual(lookups, tc.wantLookups) {
				t.Fatalf("session lookups = %v, want %v", lookups, tc.wantLookups)
			}
		})
	}
}

func TestResolveRequesterSessionAfterEnumerationDiscardsPartialResultsOnError(t *testing.T) {
	now := time.Date(2026, time.July, 16, 12, 0, 0, 0, time.UTC)
	trustedPath := `C:\Windows\System32\consent.exe`
	partialCandidates := []consentProcessCandidate{
		{PID: 300, SessionID: 3, ImagePath: trustedPath, StartedAt: now.Add(-time.Second)},
	}
	var lookups []uint32

	username, sessionID, source := resolveRequesterSessionAfterEnumeration(
		partialCandidates,
		errors.New("Process32Next failed"),
		trustedPath,
		now,
		1,
		func(sessionID uint32) string {
			lookups = append(lookups, sessionID)
			return map[uint32]string{
				1: `DOMAIN\console`,
				3: `DOMAIN\requester`,
			}[sessionID]
		},
	)

	if username != `DOMAIN\console` || sessionID != 1 || source != requesterSourceConsoleFallback {
		t.Fatalf(
			"resolution = (%q, %d, %q), want (%q, %d, %q)",
			username, sessionID, source,
			`DOMAIN\console`, 1, requesterSourceConsoleFallback,
		)
	}
	if !reflect.DeepEqual(lookups, []uint32{1}) {
		t.Fatalf("session lookups = %v, want console fallback only", lookups)
	}
}

func TestEventSubjectSessionIDIsLocalOnly(t *testing.T) {
	payload, err := json.Marshal(Event{
		SubjectUsername:      `DOMAIN\requester`,
		SubjectSessionID:     42,
		TargetExecutablePath: `C:\Windows\System32\cmd.exe`,
		ObservedAt:           time.Date(2026, time.July, 16, 12, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("Marshal Event: %v", err)
	}

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		t.Fatalf("Unmarshal Event JSON: %v", err)
	}
	if _, ok := fields["subject_session_id"]; ok {
		t.Fatalf("subject_session_id must not be serialized: %s", payload)
	}
}
