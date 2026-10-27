package promptkinds

import (
	"encoding/json"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/prompthost"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// The notices through a real prompt host: ok closes the card and the list
// keeps the outcome; open_settings leaves the notice up.

type oneRenderer struct {
	mu   sync.Mutex
	r    prompthost.RendererSession
	sent []sent
}

type sent struct {
	typ     string
	payload any
}

func (d *oneRenderer) Renderers(o prompthost.Owner) []prompthost.RendererSession {
	if d.r.Owner.Key() == o.Key() {
		return []prompthost.RendererSession{d.r}
	}
	return nil
}

func (d *oneRenderer) Send(_, msgType, _ string, payload any) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.sent = append(d.sent, sent{msgType, payload})
	return nil
}

func (d *oneRenderer) lastShow(t *testing.T) ipc.PromptShow {
	t.Helper()
	d.mu.Lock()
	defer d.mu.Unlock()
	for i := len(d.sent) - 1; i >= 0; i-- {
		if s, ok := d.sent[i].payload.(ipc.PromptShow); ok {
			return s
		}
	}
	t.Fatal("no prompt_show sent")
	return ipc.PromptShow{}
}

func (d *oneRenderer) count(typ string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	n := 0
	for _, s := range d.sent {
		if s.typ == typ {
			n++
		}
	}
	return n
}

type entries struct {
	mu sync.Mutex
	m  map[string]prompthost.ListEntry
}

func (e *entries) PutPrompt(x prompthost.ListEntry) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.m[x.ID] = x
	return nil
}
func (e *entries) RetractPrompt(id string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.m, id)
	return nil
}
func (e *entries) TombstonePrompt(string) error                { return nil }
func (e *entries) PromptTombstoned(string) bool                { return false }
func (e *entries) PromptEntries(string) []prompthost.ListEntry { return nil }

func act(t *testing.T, h *prompthost.Host, key string, s ipc.PromptShow, action string) ipc.PromptActionResult {
	t.Helper()
	raw, _ := json.Marshal(ipc.PromptActionRequest{PromptID: s.PromptID, Rev: s.Rev, Lease: s.Lease, ActionID: action, Via: ipc.PromptViaClick})
	_, reply := h.HandleRendererMessage(&sessionbroker.Session{SessionID: key}, ipc.TypePromptAction, raw)
	return reply.(ipc.PromptActionResult)
}

func TestNoticeActionsThroughTheHost(t *testing.T) {
	r := prompthost.RendererSession{Key: "native-1", Role: ipc.HelperRoleUser, Owner: testOwner, Protocol: 1, KindAds: []string{"notice.info@1"}, UILocale: "de-DE"}
	dir := &oneRenderer{r: r}
	store := &entries{m: map[string]prompthost.ListEntry{}}
	h := prompthost.New(prompthost.Deps{Broker: dir, Inbox: store})
	Register(h)
	h.SetEnabledKinds([]string{"notice.info"})
	if !h.PromptPathAvailable(NoticeInfo.Name, NoticeInfo.Version, testOwner) {
		t.Fatal("all three switches are on")
	}
	rec := &legacyRecorder{}
	n := newNotices(rec)

	// open_settings: accepted, the notice stays pending and open.
	tcc := n.MacPermissionNotice([]string{PermissionFullDiskAccess})
	tcc.Owners = []prompthost.Owner{testOwner}
	if err := h.Show(tcc); err != nil {
		t.Fatal(err)
	}
	s := dir.lastShow(t)
	if s.Locale != "de-DE" || s.Actions[1].Label != "Einstellungen öffnen" {
		t.Fatalf("the renderer gets its session's language: %s %+v", s.Locale, s.Actions)
	}
	if res := act(t, h, "native-1", s, "open_settings"); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("open_settings = %+v", res)
	}
	if !h.IsOpen(tcc.ID) || len(rec.settings) != 1 || len(rec.notifies) != 0 {
		t.Fatalf("open_settings: open=%v settings=%v notifies=%d", h.IsOpen(tcc.ID), rec.settings, len(rec.notifies))
	}

	// ok: accepted, closed, and the list keeps an outcome without actions.
	safe := n.SafeModeRebootNotice(0, testNow)
	safe.Owners = []prompthost.Owner{testOwner}
	if err := h.Show(safe); err != nil {
		t.Fatal(err)
	}
	s = dir.lastShow(t)
	if res := act(t, h, "native-1", s, "ok"); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("ok = %+v", res)
	}
	if h.IsOpen(safe.ID) || dir.count(ipc.TypePromptClose) != 1 {
		t.Fatalf("ok must close the card (open=%v closes=%d)", h.IsOpen(safe.ID), dir.count(ipc.TypePromptClose))
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	e, ok := store.m[safe.ID+"#"+testOwner.PrincipalKey()]
	if !ok || e.Show.State != ipc.PromptStateApproved || len(e.Show.Actions) != 0 || e.Show.Locale != "de-DE" {
		t.Fatalf("list entry after ok = %+v (present %v)", e.Show, ok)
	}
	// An action the notice does not offer is refused by the host.
	if res := act(t, h, "native-1", dir.lastShow(t), "open_settings"); res.Result == ipc.PromptActionAccepted {
		t.Fatal("a closed notice accepted an action")
	}
}
