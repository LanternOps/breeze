package prompthost

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func TestPrincipalSID(t *testing.T) {
	cases := map[string]string{
		"windows:S-1-5-21-1001:session:2": "S-1-5-21-1001",
		"S-1-5-21-1001":                   "S-1-5-21-1001",
		"501":                             "501",
		"windows:odd":                     "windows:odd",
	}
	for in, want := range cases {
		if got := principalSID(in); got != want {
			t.Errorf("principalSID(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRendererFromSessionOwner(t *testing.T) {
	s := &sessionbroker.Session{SessionID: "user-1", HelperRole: ipc.HelperRoleUser, WinSessionID: "2", IdentityKey: "windows:S-1-5-21-1001:session:2", UID: 0}
	r := RendererFromSession(s, "windows")
	if r.Key != "user-1" || r.Owner.WinSessionID != 2 || r.Owner.UserSID != "S-1-5-21-1001" {
		t.Fatalf("windows renderer = %+v", r)
	}
	if !rendererServes(r, Owner{WinSessionID: 2, UserSID: "S-1-5-21-1001"}) {
		t.Fatal("renderer does not serve its own principal")
	}
	if rendererServes(r, Owner{WinSessionID: 2, UserSID: "S-1-5-21-2002"}) {
		t.Fatal("a user-role renderer served another user in the same session")
	}
	if rendererServes(r, Owner{WinSessionID: 3, UserSID: "S-1-5-21-1001"}) {
		t.Fatal("a renderer served another session")
	}

	sys := RendererFromSession(&sessionbroker.Session{SessionID: "sys-2", HelperRole: ipc.HelperRoleSystem, WinSessionID: "2", IdentityKey: "windows:S-1-5-18:session:2"}, "windows")
	if !rendererServes(sys, Owner{WinSessionID: 2, UserSID: "S-1-5-21-1001"}) {
		t.Fatal("the SYSTEM helper serves every principal of its session")
	}
	if rendererServes(sys, Owner{WinSessionID: 3, UserSID: "S-1-5-21-1001"}) {
		t.Fatal("the SYSTEM helper served another session")
	}

	unix := RendererFromSession(&sessionbroker.Session{SessionID: "assist-501", HelperRole: ipc.HelperRoleAssist, UID: 501}, "darwin")
	if !rendererServes(unix, Owner{UID: 501}) || rendererServes(unix, Owner{UID: 502}) {
		t.Fatalf("unix ownership wrong: %+v", unix.Owner)
	}
	// A W02 renderer (no advertisement) is visible but never selected.
	if c := selectRenderer("notice.info", []int{1}, []RendererSession{unix}, parseEnabledKinds([]string{"notice.info"}), nil, true, false); c.Path != PathLegacy {
		t.Fatalf("an unadvertised renderer was selected: %+v", c)
	}
}

func TestDormantHostSendsNothing(t *testing.T) {
	// Production wiring in W02: no kind enabled server-side and no renderer
	// advertising one. Every prompt takes the legacy path.
	dir := &fakeDir{renderers: []RendererSession{assistRenderer("assist-1"), nativeRenderer("user-1")}}
	h := New(Deps{Broker: dir, Clock: &fakeClock{t: t0}})
	calls := &promptCalls{}
	if err := h.Show(noticePrompt(t, "notice:test:1", calls)); err != nil {
		t.Fatal(err)
	}
	h.Tick()
	if msgs := dir.take(); len(msgs) != 0 {
		t.Fatalf("a dormant host sent prompt messages: %+v", msgs)
	}
	if n, _, _ := calls.counts(); n != 1 {
		t.Fatalf("legacy calls = %d, want 1", n)
	}
}
