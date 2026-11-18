package heartbeat

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/etwlua"
)

func offlineTestEvent(session uint32, user, path string) etwlua.Event {
	return etwlua.Event{SubjectSessionID: session, SubjectUsername: user, TargetExecutablePath: path}
}

const offlineITBody = "Breeze couldn't send the request for mmc.exe. If you have administrator credentials, enter them in the Windows prompt."

// D3: at most one offline notice per program and user per 5 minutes.
func TestOfflineToastRateLimited(t *testing.T) {
	h := &Heartbeat{}
	rec := recordPamNotices(h)
	mmc := `C:\Windows\System32\mmc.exe`

	h.NotifyElevationSubmitFailed(offlineTestEvent(3, `CORP\alice`, mmc))
	h.NotifyElevationSubmitFailed(offlineTestEvent(3, `CORP\alice`, mmc))
	// Same program with different path casing is the same program on Windows.
	h.NotifyElevationSubmitFailed(offlineTestEvent(3, `CORP\alice`, `c:\WINDOWS\system32\MMC.EXE`))

	calls := rec.Calls()
	want := pamNotifyCall{Title: "Couldn't reach IT", Body: offlineITBody, WinSession: "3"}
	if len(calls) != 1 || calls[0] != want {
		t.Fatalf("notices = %+v, want exactly [%+v]", calls, want)
	}

	// A different user, or a different program, is its own key.
	h.NotifyElevationSubmitFailed(offlineTestEvent(4, `CORP\bob`, mmc))
	h.NotifyElevationSubmitFailed(offlineTestEvent(3, `CORP\alice`, `C:\Windows\System32\cmd.exe`))
	calls = rec.Calls()
	if len(calls) != 3 {
		t.Fatalf("notices = %+v, want 3 (alice/mmc, bob/mmc, alice/cmd)", calls)
	}
	if calls[1].WinSession != "4" || calls[2].Body != "Breeze couldn't send the request for cmd.exe. If you have administrator credentials, enter them in the Windows prompt." {
		t.Fatalf("unexpected notices %+v", calls[1:])
	}
}

// An unresolved requester session (0, or Windows' 0xFFFFFFFF sentinel) would
// route the notice to whoever holds the console — possibly someone else. Skip
// it, and do not spend the rate-limit slot on a notice nobody saw.
func TestOfflineToastUnknownSessionSkipped(t *testing.T) {
	h := &Heartbeat{}
	rec := recordPamNotices(h)
	mmc := `C:\Windows\System32\mmc.exe`

	h.NotifyElevationSubmitFailed(offlineTestEvent(0, `CORP\alice`, mmc))
	h.NotifyElevationSubmitFailed(offlineTestEvent(0xFFFFFFFF, `CORP\alice`, mmc))
	if calls := rec.Calls(); len(calls) != 0 {
		t.Fatalf("unknown-session notices = %+v, want none", calls)
	}

	h.NotifyElevationSubmitFailed(offlineTestEvent(0xFFFFFFFE, `CORP\alice`, mmc))
	calls := rec.Calls()
	if len(calls) != 1 || calls[0].WinSession != "4294967294" {
		t.Fatalf("notices = %+v, want one to session 4294967294", calls)
	}
}

func TestOfflineToastUsesPersistedSupportName(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, pamSupportNameFile), []byte(`{"supportName":"Contoso IT"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	h := &Heartbeat{}
	h.SetStatePath(filepath.Join(dir, "agent.state"))
	rec := recordPamNotices(h)

	h.NotifyElevationSubmitFailed(offlineTestEvent(3, `CORP\alice`, `C:\Windows\System32\mmc.exe`))
	want := pamNotifyCall{Title: "Couldn't reach Contoso IT", Body: offlineITBody, WinSession: "3"}
	if calls := rec.Calls(); len(calls) != 1 || calls[0] != want {
		t.Fatalf("notices = %+v, want [%+v]", calls, want)
	}
}

// The offline notice is not an outcome notice: it never touches the tracker.
func TestOfflineToastDoesNotTrack(t *testing.T) {
	h := &Heartbeat{}
	_ = recordPamNotices(h)
	h.NotifyElevationSubmitFailed(offlineTestEvent(3, `CORP\alice`, `C:\Windows\System32\mmc.exe`))
	if n := h.pamTracker().lenForTest(); n != 0 {
		t.Fatalf("tracker holds %d entries after an offline notice, want 0", n)
	}
}

// The rate-limit slot is spent only by a notice that was shown: a send that
// failed (no helper in the session yet) leaves the next attempt free to show.
func TestOfflineToastFailedSendDoesNotSpendSlot(t *testing.T) {
	h := &Heartbeat{}
	rec := recordPamNotices(h)
	mmc := `C:\Windows\System32\mmc.exe`

	rec.FailWith(errors.New("pipe closed"))
	h.NotifyElevationSubmitFailed(offlineTestEvent(3, `CORP\alice`, mmc))
	if rec.Attempts() != 1 || len(rec.Calls()) != 0 {
		t.Fatalf("failed send: attempts=%d shown=%+v", rec.Attempts(), rec.Calls())
	}

	rec.FailWith(nil)
	h.NotifyElevationSubmitFailed(offlineTestEvent(3, `CORP\alice`, mmc))
	h.NotifyElevationSubmitFailed(offlineTestEvent(3, `CORP\alice`, mmc))
	if calls := rec.Calls(); len(calls) != 1 || calls[0].Body != offlineITBody {
		t.Fatalf("notices = %+v, want one offline notice after the failed send", calls)
	}
}

// The window ends: after pamOfflineNoticeWindow the same program and user may
// be told again.
func TestOfflineToastAllowedAgainAfterWindow(t *testing.T) {
	clock := newPamFakeClock()
	h := &Heartbeat{}
	h.pamOfflineLimiter = newPamOfflineNoticeLimiter(clock.Now)
	rec := recordPamNotices(h)
	mmc := `C:\Windows\System32\mmc.exe`

	h.NotifyElevationSubmitFailed(offlineTestEvent(3, `CORP\alice`, mmc))
	clock.Advance(pamOfflineNoticeWindow - time.Second)
	h.NotifyElevationSubmitFailed(offlineTestEvent(3, `CORP\alice`, mmc))
	if n := len(rec.Calls()); n != 1 {
		t.Fatalf("inside the window: %d notices, want 1", n)
	}
	clock.Advance(time.Second)
	h.NotifyElevationSubmitFailed(offlineTestEvent(3, `CORP\alice`, mmc))
	if n := len(rec.Calls()); n != 2 {
		t.Fatalf("after the window: %d notices, want 2", n)
	}
}
