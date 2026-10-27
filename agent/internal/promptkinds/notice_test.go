package promptkinds

import (
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
	"github.com/breeze-rmm/agent/internal/prompthost"
)

var testOwner = prompthost.Owner{WinSessionID: 1, UserSID: "S-1-5-21-1001"}

var testNow = time.Date(2026, 10, 27, 15, 0, 0, 0, time.UTC)

type legacyRecorder struct {
	mu       sync.Mutex
	notifies []ipc.NotifyRequest
	owners   []prompthost.Owner
	settings []string
	err      error
}

func (r *legacyRecorder) notify(o prompthost.Owner, req ipc.NotifyRequest) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.notifies = append(r.notifies, req)
	r.owners = append(r.owners, o)
	return r.err
}

func (r *legacyRecorder) openSettings(o prompthost.Owner, permission string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.settings = append(r.settings, permission)
	r.owners = append(r.owners, o)
	return r.err
}

func newNotices(r *legacyRecorder) Notices {
	return Notices{Notify: r.notify, OpenSettings: r.openSettings, Now: func() time.Time { return testNow }}
}

func TestNoticeLifetimes(t *testing.T) {
	n := newNotices(&legacyRecorder{})
	at := testNow.Add(15 * time.Minute)
	cases := []struct {
		name       string
		p          prompthost.Prompt
		expires    time.Time
		reshowable bool
	}{
		// Safe mode: the warning means nothing after the reboot.
		{"safe mode ends at the reboot", n.SafeModeRebootNotice(15*time.Minute, at), at, false},
		// An immediate reboot still gets a minute on screen.
		{"immediate safe mode gets a minute", n.SafeModeRebootNotice(0, testNow), testNow.Add(time.Minute), false},
		// Permissions: 24 h, then it closes expired and, if still
		// missing, is shown again; only an acknowledgement suppresses it.
		{"permission notice lives 24 h and may come back", n.MacPermissionNotice([]string{PermissionFullDiskAccess}), testNow.Add(24 * time.Hour), true},
		{"session ended lives 24 h", n.RemoteSessionEndedNotice("s1", time.Minute, ""), testNow.Add(24 * time.Hour), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := wire(tc.p)
			if s.Timing.DeadlineUnixMs != tc.expires.UnixMilli() || s.ListEntry.ExpiresAtUnixMs != tc.expires.UnixMilli() {
				t.Fatalf("deadline %d / entry %d, want %d", s.Timing.DeadlineUnixMs, s.ListEntry.ExpiresAtUnixMs, tc.expires.UnixMilli())
			}
			if tc.p.Reshowable != tc.reshowable {
				t.Fatalf("Reshowable = %v, want %v", tc.p.Reshowable, tc.reshowable)
			}
		})
	}
}

// wire is p.Show as the host would send it (rev, lease filled in).
func wire(p prompthost.Prompt) ipc.PromptShow {
	s := p.Show
	s.Actions = append([]ipc.PromptAction(nil), p.Show.Actions...)
	s.Facts = append([]ipc.PromptFact(nil), p.Show.Facts...)
	s.PromptID = p.ID
	s.Kind = p.Kind.Name
	s.KindVersion = p.Kind.Version
	s.Rev = 1
	s.Lease = ipc.PromptLease{RendererSession: "test", Epoch: 1}
	return s
}

func localized(t *testing.T, p prompthost.Prompt, loc promptcatalog.Locale) ipc.PromptShow {
	t.Helper()
	if p.Localize == nil {
		t.Fatal("a notice must render its copy per session locale (Localize)")
	}
	l, err := p.Localize(loc)
	if err != nil {
		t.Fatalf("Localize(%s): %v", loc, err)
	}
	s := wire(p)
	s.Copy, s.Facts, s.Locale = l.Copy, l.Facts, string(loc)
	for i := range s.Actions {
		if label, ok := l.ActionLabels[s.Actions[i].ID]; ok {
			s.Actions[i].Label = label
		}
	}
	return s
}

// assertNoticeShape pins what every notice.info shares: a Breeze-owned card
// decision whose only safe action is ok, non-activating, persistent in the
// list, no response deadline, and valid in every locale.
func assertNoticeShape(t *testing.T, p prompthost.Prompt) {
	t.Helper()
	if p.Kind.Name != "notice.info" || p.Kind.Version != 1 {
		t.Fatalf("kind = %s@%d", p.Kind.Name, p.Kind.Version)
	}
	if p.ID == "" || p.Show.PromptID != p.ID {
		t.Fatalf("id %q / show.promptId %q", p.ID, p.Show.PromptID)
	}
	s := wire(p)
	if s.State != ipc.PromptStatePending || s.Presentation != ipc.PromptPresentationCard || s.Focus != ipc.PromptFocusNoActivate {
		t.Fatalf("state/presentation/focus = %s/%s/%s", s.State, s.Presentation, s.Focus)
	}
	if !s.ListEntry.Persistent {
		t.Fatal("a notice lives in the notification list")
	}
	// Every notice has a real lifetime: an absolute deadline (never one that
	// restarts at presentation), and the list entry ends with it, so a
	// record never stays open forever and a held native notice stops then.
	if s.Timing.DeadlineUnixMs <= 0 || s.Timing.ResponseMs != 0 || s.Timing.PresentWithinMs != 10_000 {
		t.Fatalf("timing = %+v", s.Timing)
	}
	if s.ListEntry.ExpiresAtUnixMs != s.Timing.DeadlineUnixMs {
		t.Fatalf("list entry expires %d, deadline %d: they must match", s.ListEntry.ExpiresAtUnixMs, s.Timing.DeadlineUnixMs)
	}
	if s.Timing.Expiry != nil {
		t.Fatal("a notice states no expiry consequence (spec: —)")
	}
	if s.DefaultActionID != "ok" || s.Actions[0].ID != "ok" || s.Actions[0].Role != ipc.PromptRoleSafe {
		t.Fatalf("actions = %+v default %q", s.Actions, s.DefaultActionID)
	}
	if s.Copy.OperatorNote != "" {
		t.Fatal("a breeze-class notice never carries operator text")
	}
	for _, loc := range promptcatalog.Locales {
		ls := localized(t, p, loc)
		if err := ipc.ValidatePromptShow(ls); err != nil {
			t.Fatalf("%s: %v", loc, err)
		}
		if loc != promptcatalog.LocaleEN && ls.Copy.Title == s.Copy.Title && ls.Copy.Body == s.Copy.Body {
			t.Errorf("%s copy is identical to en: %q", loc, ls.Copy.Title)
		}
	}
	if err := ipc.ValidatePromptShow(s); err != nil {
		t.Fatalf("as built: %v", err)
	}
	if p.Legacy == nil || p.OnAction == nil {
		t.Fatal("a notice needs its legacy call and an action handler")
	}
}

func TestSafeModeNoticeCopyAndID(t *testing.T) {
	rec := &legacyRecorder{}
	at := time.Date(2026, 10, 27, 15, 30, 0, 0, time.UTC)
	p := newNotices(rec).SafeModeRebootNotice(15*time.Minute, at)
	assertNoticeShape(t, p)

	if want := fmt.Sprintf("notice:safe_mode:%d", at.UnixMilli()); p.ID != want {
		t.Fatalf("id = %q, want %q", p.ID, want)
	}
	timeToken := fmt.Sprintf("{time:%d}", at.UnixMilli())
	en := wire(p)
	if en.Copy.Title != "Your computer will restart in safe mode" {
		t.Fatalf("title = %q", en.Copy.Title)
	}
	if !strings.Contains(en.Copy.Body, timeToken) || !strings.Contains(en.Copy.Body, "safe mode with networking") {
		t.Fatalf("body = %q: must name the mode and leave the time to the renderer (%s)", en.Copy.Body, timeToken)
	}
	if en.Locale != "en" || en.Direction != "ltr" {
		t.Fatalf("locale/direction = %q/%q", en.Locale, en.Direction)
	}
	de := localized(t, p, "de-DE")
	if !strings.Contains(de.Copy.Body, "abgesicherten Modus") || !strings.Contains(de.Copy.Body, timeToken) {
		t.Fatalf("de-DE body = %q", de.Copy.Body)
	}

	now := newNotices(rec).SafeModeRebootNotice(0, at)
	if body := wire(now).Copy.Body; strings.Contains(body, "{time:") || !strings.Contains(body, "now") {
		t.Fatalf("an immediate reboot says now, not a time: %q", body)
	}

	// Legacy is today's call: the same toast handleRebootSafeMode broadcast.
	if err := p.Legacy(testOwner); err != nil {
		t.Fatal(err)
	}
	want := ipc.NotifyRequest{Title: "Safe Mode Reboot", Body: "System will reboot into Safe Mode with Networking in 15 minutes. Please save all work.", Urgency: "critical"}
	if len(rec.notifies) != 1 || !reflect.DeepEqual(rec.notifies[0], want) {
		t.Fatalf("legacy notify = %+v, want %+v", rec.notifies, want)
	}
	if got := LegacySafeModeReboot(0); got.Body != "System is rebooting into Safe Mode with Networking. Please save all work." {
		t.Fatalf("immediate legacy body = %q", got.Body)
	}
	if got := LegacySafeModeReboot(time.Minute); got.Body != "System will reboot into Safe Mode with Networking in 1 minute. Please save all work." {
		t.Fatalf("one-minute legacy body = %q", got.Body)
	}
}

func TestSafeModeNoticeOKClosesWithTheOutcomeKept(t *testing.T) {
	p := newNotices(&legacyRecorder{}).SafeModeRebootNotice(time.Minute, time.Unix(1_800_000_000, 0))
	out, err := p.OnAction("ok", testOwner)
	if err != nil || !out.Accepted || out.Close == nil || *out.Close != ipc.PromptCloseResolved {
		t.Fatalf("ok -> %+v, %v", out, err)
	}
	if next := p.Kind.Transitions[ipc.PromptStatePending]["ok"]; !next.Terminal() {
		t.Fatalf("ok must move to a terminal state so the list keeps the entry, got %q", next)
	}
	if out, _ := p.OnAction("open_settings", testOwner); out.Accepted {
		t.Fatal("a safe-mode notice offers no open_settings")
	}
}

func TestMacPermissionNoticeIDActionsAndOpenSettings(t *testing.T) {
	rec := &legacyRecorder{}
	n := newNotices(rec)
	p := n.MacPermissionNotice([]string{"Screen Recording", "Full Disk Access"})
	assertNoticeShape(t, p)

	// The id is stable for a set, whatever its order.
	if q := n.MacPermissionNotice([]string{"Full Disk Access", "Screen Recording", "Full Disk Access"}); q.ID != p.ID {
		t.Fatalf("id depends on order or duplicates: %q vs %q", p.ID, q.ID)
	}
	if !regexp.MustCompile(`^notice:tcc:[0-9a-f]{8}$`).MatchString(p.ID) {
		t.Fatalf("id = %q, want notice:tcc:<sha8>", p.ID)
	}
	if other := n.MacPermissionNotice([]string{"Full Disk Access"}); other.ID == p.ID {
		t.Fatal("a different missing set must be a different notice")
	}

	s := wire(p)
	if len(s.Actions) != 2 || s.Actions[1].ID != "open_settings" || s.Actions[1].Role != ipc.PromptRoleNeutral || s.Actions[1].Label != "Open Settings" {
		t.Fatalf("actions = %+v", s.Actions)
	}
	if !strings.Contains(s.Copy.Body, "Full Disk Access") {
		t.Fatalf("body = %q", s.Copy.Body)
	}
	if len(s.Facts) != 1 || s.Facts[0].Value != "Full Disk Access, Screen Recording" {
		t.Fatalf("facts = %+v", s.Facts)
	}
	fr := localized(t, p, "fr-FR")
	if fr.Actions[1].Label != "Ouvrir les Réglages" || fr.Facts[0].Value != "Accès complet au disque, Enregistrement de l'écran" {
		t.Fatalf("fr-FR = %+v / %+v", fr.Actions, fr.Facts)
	}

	// open_settings opens the pane for the owner and keeps the notice up.
	out, err := p.OnAction("open_settings", testOwner)
	if err != nil || !out.Accepted || out.Close != nil || out.Patch != nil {
		t.Fatalf("open_settings -> %+v, %v", out, err)
	}
	if len(rec.settings) != 1 || rec.settings[0] != "Full Disk Access" {
		t.Fatalf("opened %v, want Full Disk Access first", rec.settings)
	}
	if next := p.Kind.Transitions[ipc.PromptStatePending]["open_settings"]; next != ipc.PromptStatePending {
		t.Fatalf("open_settings must leave the notice pending, got %q", next)
	}
	rec.err = errors.New("no GUI session")
	if _, err := p.OnAction("open_settings", testOwner); err == nil {
		t.Fatal("a failed open must not be accepted")
	}
	rec.err = nil

	// Without Full Disk Access missing, the copy names what is.
	others := wire(n.MacPermissionNotice([]string{"Accessibility"}))
	if strings.Contains(others.Copy.Body, "Full Disk Access") || !strings.Contains(others.Copy.Body, "Accessibility") {
		t.Fatalf("others body = %q", others.Copy.Body)
	}
	if out, _ := n.MacPermissionNotice([]string{"Accessibility"}).OnAction("open_settings", testOwner); !out.Accepted || rec.settings[len(rec.settings)-1] != "Accessibility" {
		t.Fatalf("open_settings without FDA opened %v", rec.settings)
	}

	// Legacy is the helper's own reminder toast.
	rec.err = nil
	if err := p.Legacy(testOwner); err != nil {
		t.Fatal(err)
	}
	if got := rec.notifies[len(rec.notifies)-1]; !reflect.DeepEqual(got, LegacyMacPermissionReminder([]string{"Full Disk Access", "Screen Recording"})) || got.Title != "Breeze: Permission Required" {
		t.Fatalf("legacy = %+v", got)
	}
}

func TestMacPermissionNoticeIgnoresUnknownPermissions(t *testing.T) {
	p := newNotices(&legacyRecorder{}).MacPermissionNotice([]string{"Full Disk Access", "Camera\u202e"})
	if s := wire(p); len(s.Facts) != 1 || s.Facts[0].Value != "Full Disk Access" {
		t.Fatalf("facts = %+v: only the three known permissions are named", s.Facts)
	}
}

func TestSessionEndedNoticeCopyAndID(t *testing.T) {
	rec := &legacyRecorder{}
	n := newNotices(rec)
	p := n.RemoteSessionEndedNotice("6f1c2d9e-0a4b-4c3d-9e8f-123456789abc", 12*time.Minute+40*time.Second, "Dana Reyes")
	assertNoticeShape(t, p)
	if p.ID != "notice:session_ended:6f1c2d9e-0a4b-4c3d-9e8f-123456789abc" {
		t.Fatalf("id = %q", p.ID)
	}
	s := wire(p)
	if s.Copy.Title != "Remote session ended" || s.Copy.Body != "Dana Reyes is no longer connected to your computer." {
		t.Fatalf("copy = %+v", s.Copy)
	}
	if len(s.Facts) != 1 || s.Facts[0] != (ipc.PromptFact{Label: "Duration", Value: "12 min"}) {
		t.Fatalf("facts = %+v", s.Facts)
	}
	if tr := localized(t, p, "tr-TR"); tr.Facts[0].Value != "12 dk" {
		t.Fatalf("tr-TR duration = %q", tr.Facts[0].Value)
	}

	short := wire(n.RemoteSessionEndedNotice("s1", 20*time.Second, ""))
	if short.Copy.Body != "The technician is no longer connected to your computer." || short.Facts[0].Value != "Less than a minute" {
		t.Fatalf("short session = %+v", short)
	}
	if unknown := wire(n.RemoteSessionEndedNotice("s2", 0, "")); len(unknown.Facts) != 0 {
		t.Fatalf("an unknown duration states none: %+v", unknown.Facts)
	}

	// A hostile session id or technician name never reaches the id or the
	// copy as given.
	hostile := n.RemoteSessionEndedNotice("../../etc/passwd <x>", time.Minute, "Dana\u202eReyes\u200b"+strings.Repeat("x", 300))
	if err := ipc.ValidatePromptShow(wire(hostile)); err != nil {
		t.Fatalf("hostile input produced an invalid prompt: %v", err)
	}
	if strings.ContainsAny(hostile.ID, " /<>") {
		t.Fatalf("id = %q", hostile.ID)
	}
	if body := wire(hostile).Copy.Body; strings.ContainsRune(body, '\u202e') || strings.ContainsRune(body, '\u200b') {
		t.Fatalf("body kept bidi/zero-width characters: %q", body)
	}

	// Legacy is today's call: the "Remote session ended" notice with its
	// fallback dialog.
	if err := p.Legacy(testOwner); err != nil {
		t.Fatal(err)
	}
	want := ipc.NotifyRequest{Title: "Breeze Agent", Body: "Remote session ended", Urgency: "normal", FallbackDialog: true}
	if len(rec.notifies) != 1 || !reflect.DeepEqual(rec.notifies[0], want) {
		t.Fatalf("legacy = %+v", rec.notifies)
	}
}

// The registry is append-only: W04 notice.info@1, then W06's remote kinds.
func TestRegisterSpeaksNoticeInfoV1(t *testing.T) {
	specs := Specs()
	var got []string
	for _, s := range specs {
		got = append(got, fmt.Sprintf("%s@%d", s.Name, s.Version))
		if class, ok := ipc.PromptKindClass(s.Name); !ok || class != ipc.PromptCopyBreeze {
			t.Fatalf("%s must be a breeze-class kind in the closed registry", s.Name)
		}
	}
	if want := []string{"notice.info@1", "remote.consent@1", "remote.session@1"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("specs = %v, want %v", got, want)
	}
}
