package promptkinds

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
	"github.com/breeze-rmm/agent/internal/prompthost"
)

// #10351 review follow-ups.

// A stop that failed after End session re-shows the pill with the normal
// actions and says the session is still active.
func TestEndFailedIndicatorSaysTheSessionIsStillActive(t *testing.T) {
	cfg := consentCfg("block", 30_000)
	cfg.AllowUserEndSession = true
	p := WithEndFailed(RemoteSession("s-failed", cfg, time.Now(), SessionHooks{}))
	const want = "Couldn't end the session. It is still active."
	if p.Show.Copy.StateDetail != want || !p.Reshowable {
		t.Fatalf("stateDetail %q reshowable %v", p.Show.Copy.StateDetail, p.Reshowable)
	}
	if _, ok := actionByID(p.Show, "end_session"); !ok {
		t.Fatalf("the person can retry: %+v", p.Show.Actions)
	}
	l, err := p.Localize(promptcatalog.Locale("de-DE"))
	if err != nil || l.Copy.StateDetail != "Die Sitzung konnte nicht beendet werden. Sie ist weiterhin aktiv." {
		t.Fatalf("de-DE = %q, %v", l.Copy.StateDetail, err)
	}
	h, dir := consentHost(t, "remote.session@1")
	p.Owners = []prompthost.Owner{testOwner}
	if err := h.Show(p); err != nil {
		t.Fatal(err)
	}
	s := dir.lastShow(t)
	res := act(t, h, "native-1", s, "end_session")
	if u := dir.lastUpdate(t); u.Copy == nil || u.Copy.StateDetail != "End this remote session? The technician will be disconnected." {
		t.Fatalf("the confirm step replaces the notice: %+v", u.Copy)
	}
	s.Rev = res.Rev
	act(t, h, "native-1", s, "keep_session")
	if u := dir.lastUpdate(t); u.Copy == nil || u.Copy.StateDetail != want {
		t.Fatalf("back from the confirm step the notice stays: %+v", u.Copy)
	}
}

// A confirm step whose copy cannot be rendered is never entered: no raw
// end_confirm / keep_session ids reach a renderer.
func TestConfirmStepRefusedWhenItsCopyCannotRender(t *testing.T) {
	cfg := consentCfg("block", 30_000)
	cfg.AllowUserEndSession = true
	p := RemoteSession("s-norender", cfg, time.Now(), SessionHooks{EndConfirmed: func() { t.Error("ended") }})
	p.Owners = []prompthost.Owner{testOwner}
	h, dir := consentHost(t, "remote.session@1")
	if err := h.Show(p); err != nil {
		t.Fatal(err)
	}
	prev := remoteRender
	remoteRender = func(loc promptcatalog.Locale, ns, key string, params map[string]string) (string, error) {
		if key == "session.confirmEnd" {
			return "", promptcatalog.ErrUnknownKey
		}
		return prev(loc, ns, key, params)
	}
	t.Cleanup(func() { remoteRender = prev })
	s := dir.lastShow(t)
	if res := act(t, h, "native-1", s, "end_session"); res.Result != ipc.PromptActionRejectedInvalid {
		t.Fatalf("end_session with unrenderable copy = %+v, want rejected_invalid", res)
	}
	if n := dir.count(ipc.TypePromptUpdate); n != 0 {
		t.Fatalf("%d updates sent", n)
	}
	if out, _ := p.OnAction("end_confirm", testOwner); out.Accepted {
		t.Fatal("the confirm step was entered")
	}
}
