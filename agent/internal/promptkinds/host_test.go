package promptkinds

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

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

type settableClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *settableClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *settableClock) set(t time.Time) {
	c.mu.Lock()
	c.t = t
	c.mu.Unlock()
}

// A session-ended notice whose session has only a legacy renderer (an old
// Assist that advertised nothing) is gone from the host after its 24 h
// lifetime: session ids are unique, so a kept record would grow forever.
func TestLegacyOnlySessionEndedNoticeIsGoneAfterItsDeadline(t *testing.T) {
	old := prompthost.RendererSession{Key: "assist-old", Role: ipc.HelperRoleAssist, Owner: testOwner}
	dir := &oneRenderer{r: old}
	clock := &settableClock{t: testNow}
	h := prompthost.New(prompthost.Deps{Broker: dir, Inbox: &entries{m: map[string]prompthost.ListEntry{}}, Clock: clock})
	Register(h)
	h.SetEnabledKinds([]string{"notice.info"})
	rec := &legacyRecorder{}
	p := newNotices(rec).RemoteSessionEndedNotice("6f1c2d9e", 5*time.Minute, "")
	p.Owners = []prompthost.Owner{testOwner}
	if err := h.Show(p); err != nil {
		t.Fatal(err)
	}
	if len(rec.notifies) != 1 || !h.IsOpen(p.ID) {
		t.Fatalf("legacy toast %d, open %v", len(rec.notifies), h.IsOpen(p.ID))
	}
	clock.set(testNow.Add(24*time.Hour + time.Second))
	h.Tick()
	if h.IsOpen(p.ID) {
		t.Fatal("the legacy-only session-ended notice is still in memory after its deadline")
	}
	if dir.count(ipc.TypePromptClose) != 0 || len(rec.notifies) != 1 {
		t.Fatalf("the reap sent a close (%d) or re-toasted (%d)", dir.count(ipc.TypePromptClose), len(rec.notifies))
	}
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
	n.Now = time.Now // the host runs on the real clock

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
	// A second click (the person closed System Settings too early) opens
	// it again.
	if res := act(t, h, "native-1", s, "open_settings"); res.Result != ipc.PromptActionAccepted || len(rec.settings) != 2 {
		t.Fatalf("second open_settings = %+v, opened %d times", res, len(rec.settings))
	}

	// ok: accepted, closed, and the list keeps an outcome without actions.
	safe := n.SafeModeRebootNotice(time.Hour, time.Now().Add(time.Hour))
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
