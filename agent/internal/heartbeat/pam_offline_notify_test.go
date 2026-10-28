package heartbeat

import (
	"os"
	"path/filepath"
	"testing"

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
