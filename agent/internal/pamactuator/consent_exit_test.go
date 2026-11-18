package pamactuator

import (
	"errors"
	"testing"
	"time"
)

// #10190 W07: while the elevation first question is open on Assist next to
// UAC, the agent (a session-0 service, not the requester's helper) watches
// the request's own consent.exe; when it is gone the question is superseded.
// Unlike consentProcessMatches, the session comparison does not apply (the
// agent is never in the requester's session), and only positive evidence of
// an exit counts.
func TestConsentProcessExited(t *testing.T) {
	created := time.Unix(1_800_000_000, 0)
	inst := ConsentInstance{PID: 4242, CreatedAt: created}
	live := consentProcessFacts{CreatedAt: created, ExitCode: stillActiveExitCode, ImagePath: `C:\Windows\System32\consent.exe`, Session: 2, HelperSession: 0}
	for _, tc := range []struct {
		name    string
		facts   consentProcessFacts
		wantGo  bool
		wantErr bool
	}{
		{"running in another session than the agent", live, false, false},
		{"exited", func() consentProcessFacts { f := live; f.ExitCode = 0; return f }(), true, false},
		{"pid reused by a later process", func() consentProcessFacts { f := live; f.CreatedAt = created.Add(time.Second); return f }(), true, false},
		{"pid now another image (same creation time)", func() consentProcessFacts { f := live; f.ImagePath = `C:\x\evil.exe`; return f }(), false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gone, err := consentProcessExited(inst, tc.facts)
			if gone != tc.wantGo || (err != nil) != tc.wantErr {
				t.Fatalf("gone=%v err=%v, want gone=%v err=%v", gone, err, tc.wantGo, tc.wantErr)
			}
		})
	}
	if _, err := ConsentInstanceExited(ConsentInstance{}); err == nil {
		t.Fatal("an invalid instance must not read as gone or live")
	}
}

func TestConsentInstanceExitedNoProcessIsGone(t *testing.T) {
	gone, err := consentExitedFrom(ConsentInstance{PID: 7, CreatedAt: time.Unix(1, 0)}, func(uint32) (consentProcessFacts, error) {
		return consentProcessFacts{}, errConsentProcessGone
	})
	if !gone || err != nil {
		t.Fatalf("no process with the PID: gone=%v err=%v", gone, err)
	}
	gone, err = consentExitedFrom(ConsentInstance{PID: 7, CreatedAt: time.Unix(1, 0)}, func(uint32) (consentProcessFacts, error) {
		return consentProcessFacts{}, errors.New("access denied")
	})
	if gone || err == nil {
		t.Fatalf("an unreadable process is not gone: gone=%v err=%v", gone, err)
	}
}
