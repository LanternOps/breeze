package prompthost

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
	"github.com/breeze-rmm/agent/internal/promptidentity"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

type fakeIdentity struct {
	mu sync.Mutex
	id *promptidentity.Identity
}

func (f *fakeIdentity) Current() (promptidentity.Identity, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.id == nil {
		return promptidentity.Identity{}, false
	}
	return *f.id, true
}

func (f *fakeIdentity) set(id *promptidentity.Identity) {
	f.mu.Lock()
	f.id = id
	f.mu.Unlock()
}

func brandingSent(msgs []sentMsg) map[string][]ipc.PromptBrandingSync {
	out := map[string][]ipc.PromptBrandingSync{}
	for _, m := range msgs {
		if m.Type != ipc.TypePromptBrandingSync {
			continue
		}
		out[m.Key] = append(out[m.Key], m.Payload.(ipc.PromptBrandingSync))
	}
	return out
}

func fixtureIdentity(t *testing.T) (*promptidentity.Identity, []byte) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixtureDir, "branding_sync.set.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx ipc.PromptBrandingSync
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	data, err := base64.StdEncoding.DecodeString(fx.Logo.Data)
	if err != nil {
		t.Fatal(err)
	}
	return &promptidentity.Identity{
		ScopeID:      fx.ScopeID,
		PartnerName:  fx.PartnerName,
		PrimaryColor: fx.PrimaryColor,
		Logo:         &promptidentity.Logo{Sha256: fx.Logo.Sha256, Mime: fx.Logo.Mime, Data: data},
	}, raw
}

func newBrandingHost(dir *fakeDir, ident IdentitySource, osLocale func() string) *Host {
	return New(Deps{Broker: dir, Inbox: newFakeInbox(), Clock: &fakeClock{t: t0}, Identity: ident, OSLocale: osLocale})
}

func TestBrandingSyncOnConnectAndChange(t *testing.T) {
	id, fixture := fixtureIdentity(t)
	ident := &fakeIdentity{}
	a := assistRenderer("assist-1", "notice.info@1")
	a.UILocale = "de-DE"
	legacy := assistRenderer("assist-legacy") // advertised nothing: no prompt scope
	dir := &fakeDir{renderers: []RendererSession{a, legacy}}
	h := newBrandingHost(dir, ident, nil)

	// Connect with no identity: {cleared:true, locale}.
	h.RendererConnected(a)
	h.Tick()
	got := brandingSent(dir.take())
	if len(got["assist-1"]) != 1 {
		t.Fatalf("branding on connect = %+v", got)
	}
	out, _ := json.Marshal(got["assist-1"][0])
	if string(out) != `{"cleared":true,"locale":"de-DE"}` {
		t.Fatalf("cleared sync = %s", out)
	}

	// The identity arrives: every prompt-scoped renderer gets it, nobody else.
	ident.set(id)
	h.IdentityChanged()
	got = brandingSent(dir.take())
	if len(got["assist-legacy"]) != 0 {
		t.Fatal("branding sent to a session holding no prompt scope")
	}
	if len(got["assist-1"]) != 1 {
		t.Fatalf("branding on change = %+v", got)
	}
	// Byte-for-byte the W02 golden fixture (same identity, de-DE).
	out, _ = json.Marshal(got["assist-1"][0])
	if canonicalJSON(t, out) != canonicalJSON(t, fixture) {
		t.Fatalf("branding sync\n got %s\nwant %s", out, fixture)
	}

	// A renderer that connects later gets it before any replayed prompt.
	b := nativeRenderer("native-1", "notice.info@1")
	dir.add(b)
	calls := &promptCalls{}
	if err := h.Show(noticePrompt(t, "notice:1", calls)); err != nil {
		t.Fatal(err)
	}
	dir.take()
	h.RendererConnected(b)
	h.Tick()
	var first string
	for _, m := range dir.take() {
		if m.Key == "native-1" {
			first = m.Type
			break
		}
	}
	if first != ipc.TypePromptBrandingSync {
		t.Fatalf("first message to a connecting renderer = %q, want the branding sync", first)
	}
}

func TestBrandingSyncGenericNameAndNoIdentitySource(t *testing.T) {
	a := assistRenderer("assist-1", "notice.info@1")
	a.UILocale = "fr_CA.UTF-8"
	dir := &fakeDir{renderers: []RendererSession{a}}
	ident := &fakeIdentity{}
	ident.set(&promptidentity.Identity{ScopeID: "0f1e2d3c4b5a69788796a5b4c3d2e1f0"})
	h := newBrandingHost(dir, ident, nil)
	h.IdentityChanged()
	got := brandingSent(dir.take())["assist-1"]
	if len(got) != 1 {
		t.Fatalf("sent %+v", got)
	}
	want, err := promptcatalog.Render("fr-CA", "common", "identity.generic", nil)
	if err != nil || want == "" {
		t.Fatal(err)
	}
	if got[0].Cleared || got[0].PartnerName != want || got[0].Locale != "fr-CA" || got[0].Logo != nil {
		t.Fatalf("generic sync = %+v, want name %q", got[0], want)
	}
	out, _ := json.Marshal(got[0])
	if bytes.Contains(out, []byte(`"logo"`)) || bytes.Contains(out, []byte(`"primaryColor"`)) {
		t.Fatalf("absent fields emitted: %s", out)
	}

	// No identity source at all: cleared.
	h2 := newBrandingHost(dir, nil, nil)
	h2.IdentityChanged()
	if got := brandingSent(dir.take())["assist-1"]; len(got) != 1 || !got[0].Cleared {
		t.Fatalf("nil identity source = %+v", got)
	}
}

func TestNegotiatedLocalePerSession(t *testing.T) {
	user2 := RendererSession{Key: "u2", Role: ipc.HelperRoleUser, Owner: Owner{WinSessionID: 2, UserSID: "S-1-5-21-2"}, UILocale: "pt_PT.UTF-8"}
	sys2 := RendererSession{Key: "s2", Role: ipc.HelperRoleSystem, Owner: Owner{WinSessionID: 2}, UILocale: "en-US"}
	sys3 := RendererSession{Key: "s3", Role: ipc.HelperRoleSystem, Owner: Owner{WinSessionID: 3}, UILocale: "it-IT"}
	sys4 := RendererSession{Key: "s4", Role: ipc.HelperRoleSystem, Owner: Owner{WinSessionID: 4}}
	assist := RendererSession{Key: "a1", Role: ipc.HelperRoleAssist, Owner: testOwner, UILocale: "de-AT"}
	unknown := RendererSession{Key: "a2", Role: ipc.HelperRoleAssist, Owner: Owner{WinSessionID: 5, UserSID: "S-1-5-21-5"}}
	garbage := RendererSession{Key: "a3", Role: ipc.HelperRoleAssist, Owner: Owner{WinSessionID: 6, UserSID: "S-1-5-21-6"}, UILocale: "zh-CN"}
	posix := RendererSession{Key: "a4", Role: ipc.HelperRoleUser, Owner: Owner{UID: 1000}, UILocale: "de_AT.UTF-8"}
	dir := &fakeDir{renderers: []RendererSession{user2, sys2, sys3, sys4, assist, unknown, garbage, posix}}

	withOS := newBrandingHost(dir, nil, func() string { return "es_MX" })
	noOS := newBrandingHost(dir, nil, nil)
	cases := []struct {
		h    *Host
		r    RendererSession
		want promptcatalog.Locale
	}{
		{withOS, assist, "de-DE"},
		{withOS, user2, "pt-BR"},
		{withOS, sys2, "pt-BR"}, // SYSTEM borrows the user session's language
		{withOS, sys3, "it-IT"}, // nobody to borrow from: its own report
		{withOS, sys4, "es-419"},
		{withOS, unknown, "es-419"}, // no report: the machine's language
		{noOS, unknown, "en"},
		{noOS, sys4, "en"},
		{withOS, garbage, "en"},  // a reported language outside the eight is en, not the OS
		{withOS, posix, "de-DE"}, // POSIX form from a Linux helper
	}
	for _, tc := range cases {
		if got := tc.h.SessionLocale(tc.r); got != tc.want {
			t.Errorf("%s: locale = %q, want %q", tc.r.Key, got, tc.want)
		}
	}

	// The branding sync carries each session's negotiated locale.
	a := assistRenderer("assist-de", "notice.info@1")
	a.UILocale = "de-CH"
	b := RendererSession{Key: "assist-tr", Role: ipc.HelperRoleAssist, Owner: Owner{WinSessionID: 2, UserSID: "S-1-5-21-2"}, Protocol: 1, KindAds: []string{"notice.info@1"}, UILocale: "tr"}
	d2 := &fakeDir{renderers: []RendererSession{a, b}}
	h := newBrandingHost(d2, nil, nil)
	h.IdentityChanged()
	got := brandingSent(d2.take())
	if got["assist-de"][0].Locale != "de-DE" || got["assist-tr"][0].Locale != "tr-TR" {
		t.Fatalf("per-session locales = %+v", got)
	}
}

// The session's reported language reaches the host through the broker
// session, set by the auth path (W02's test seam applies it the same way).
func TestRendererFromSessionCarriesUILocale(t *testing.T) {
	s := &sessionbroker.Session{SessionID: "assist-1", HelperRole: ipc.HelperRoleAssist, WinSessionID: "1", IdentityKey: "S-1-5-21-1001"}
	s.ApplyPromptAuthForTest(ipc.HelperRoleAssist, ipc.AuthRequest{ProtocolVersion: 1, PromptProtocolVersion: 1, PromptKinds: []string{"notice.info@1"}, UILocale: "it_IT.UTF-8"})
	r := RendererFromSession(s, "windows")
	if r.UILocale != "it_IT.UTF-8" {
		t.Fatalf("renderer UILocale = %q", r.UILocale)
	}
	h := newBrandingHost(&fakeDir{}, nil, nil)
	if got := h.SessionLocale(r); got != "it-IT" {
		t.Fatalf("locale = %q", got)
	}
}

// W03 production: renderers advertise no kind, so nobody holds a prompt
// scope and an identity change sends nothing.
func TestBrandingSyncDormantWithoutPromptScope(t *testing.T) {
	id, _ := fixtureIdentity(t)
	ident := &fakeIdentity{}
	ident.set(id)
	dir := &fakeDir{renderers: []RendererSession{assistRenderer("assist-1"), nativeRenderer("user-1")}}
	h := newBrandingHost(dir, ident, nil)
	h.IdentityChanged()
	h.Tick()
	if msgs := dir.take(); len(msgs) != 0 {
		t.Fatalf("a dormant host sent %+v", msgs)
	}
}

func canonicalJSON(t *testing.T, raw []byte) string {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(v)
	return string(out)
}
