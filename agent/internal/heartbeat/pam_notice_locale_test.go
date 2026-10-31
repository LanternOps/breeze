package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/pamlifetime"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// setOSUILocaleForTest pins the machine UI language the notice falls back to.
func setOSUILocaleForTest(t *testing.T, tag string) {
	t.Helper()
	prev := osUILocale
	osUILocale = func() string { return tag }
	t.Cleanup(func() { osUILocale = prev })
}

// addLocaleHelper registers a helper in winSession that reported uiLocale at
// auth, as the auth path records it.
func addLocaleHelper(t *testing.T, b *sessionbroker.Broker, winSession string, role ipc.HelperRole, uiLocale string) {
	t.Helper()
	s := registerConsentTestSession(t, b, winSession, role, []string{"notify"})
	s.ApplyPromptAuthForTest(role, ipc.AuthRequest{ProtocolVersion: 1, UILocale: uiLocale})
}

// pamNoticeLocaleCases are the locale-selection rungs (#10696): the same
// order the prompt host uses for the SYSTEM helper (prompthost
// Host.SessionLocale) — a user-context helper's UI language in the notice's
// Windows session, then the machine's UI language, then en.
var pamNoticeLocaleCases = []struct {
	name    string
	setup   func(t *testing.T, b *sessionbroker.Broker)
	osTag   string
	wantLoc promptcatalog.Locale
}{
	{"user helper in the session", func(t *testing.T, b *sessionbroker.Broker) {
		addLocaleHelper(t, b, "5", ipc.HelperRoleUser, "de-DE")
	}, "it-IT", "de-DE"},
	{"assist helper POSIX tag", func(t *testing.T, b *sessionbroker.Broker) {
		addLocaleHelper(t, b, "5", ipc.HelperRoleAssist, "fr_CA.UTF-8")
	}, "en-US", "fr-CA"},
	{"unsupported user language is en, not the machine's", func(t *testing.T, b *sessionbroker.Broker) {
		addLocaleHelper(t, b, "5", ipc.HelperRoleUser, "ja-JP")
	}, "it-IT", "en"},
	{"no helper locale falls back to the machine", func(t *testing.T, b *sessionbroker.Broker) {
		addLocaleHelper(t, b, "5", ipc.HelperRoleUser, "")
	}, "it-IT", "it-IT"},
	{"SYSTEM helper's language is not the user's", func(t *testing.T, b *sessionbroker.Broker) {
		addLocaleHelper(t, b, "5", ipc.HelperRoleSystem, "tr-TR")
	}, "pt-BR", "pt-BR"},
	{"another session's user is ignored", func(t *testing.T, b *sessionbroker.Broker) {
		addLocaleHelper(t, b, "7", ipc.HelperRoleUser, "de-DE")
	}, "es-MX", "es-419"},
	{"nothing known is en", func(t *testing.T, b *sessionbroker.Broker) {}, "", "en"},
}

func TestPamNoticeLocale(t *testing.T) {
	for _, tc := range pamNoticeLocaleCases {
		t.Run(tc.name, func(t *testing.T) {
			setOSUILocaleForTest(t, tc.osTag)
			b := sessionbroker.New("pam-notice-locale", nil)
			tc.setup(t, b)
			h := &Heartbeat{sessionBroker: b}
			if got := h.pamNoticeLocale("5"); got != tc.wantLoc {
				t.Fatalf("pamNoticeLocale = %q, want %q", got, tc.wantLoc)
			}
		})
	}
	t.Run("no broker", func(t *testing.T) {
		setOSUILocaleForTest(t, "tr_TR.UTF-8")
		if got := (&Heartbeat{}).pamNoticeLocale("5"); got != "tr-TR" {
			t.Fatalf("pamNoticeLocale = %q, want tr-TR", got)
		}
	})
}

// renderNoticeKey renders one elevation.* key in loc for the expectations
// below; written per outcome, independent of the code under test.
func renderNoticeKey(t *testing.T, loc promptcatalog.Locale, key string, params map[string]string) string {
	t.Helper()
	s, err := promptcatalog.Render(loc, "elevation", key, params)
	if err != nil {
		t.Fatalf("render %s/%s: %v", loc, key, err)
	}
	return s
}

// TestPamOutcomeNoticesUseTheCatalog is the outcome × locale table (#10696):
// with no Assist, each outcome notice is the elevation.* catalog copy in the
// locale the prompt host would pick, never #8928's English.
func TestPamOutcomeNoticesUseTheCatalog(t *testing.T) {
	const program, partner = "mmc.exe", "Contoso IT"
	prog := map[string]string{"program": program, "partner": partner}
	outcomes := []struct {
		name string
		fire func(h *Heartbeat)
		want func(t *testing.T, loc promptcatalog.Locale) (string, string)
	}{
		{"approved", func(h *Heartbeat) {
			h.notifyPamApplyOutcome(pamNotifyTestRequestID, pamlifetime.Result{State: pamlifetime.ResultVerifiedActive}, "Dana")
		}, func(t *testing.T, loc promptcatalog.Locale) (string, string) {
			return renderNoticeKey(t, loc, "approved.title", nil),
				renderNoticeKey(t, loc, "approved.bodyFrom", map[string]string{"technician": "Dana", "partner": partner, "program": program})
		}},
		{"approved but couldn't start", func(h *Heartbeat) {
			h.notifyPamApplyOutcome(pamNotifyTestRequestID, pamlifetime.Result{State: pamlifetime.ResultFailed, FailureCode: "launch_failed"}, "")
		}, func(t *testing.T, loc promptcatalog.Locale) (string, string) {
			return renderNoticeKey(t, loc, "failed.title", nil), renderNoticeKey(t, loc, "failed.body", prog)
		}},
		{"denied with reason", func(h *Heartbeat) {
			handlePamRequestNotify(h, pamNotifyCommand(map[string]any{
				"requestId": pamNotifyTestRequestID, "outcome": "denied", "reason": "Use the portal.",
			}))
		}, func(t *testing.T, loc promptcatalog.Locale) (string, string) {
			return renderNoticeKey(t, loc, "denied.title", nil),
				renderNoticeKey(t, loc, "denied.body", prog) + "\n" + renderNoticeKey(t, loc, "fact.reason", nil) + ": Use the portal."
		}},
		{"expired", func(h *Heartbeat) {
			handlePamRequestNotify(h, pamNotifyCommand(map[string]any{
				"requestId": pamNotifyTestRequestID, "outcome": "expired",
			}))
		}, func(t *testing.T, loc promptcatalog.Locale) (string, string) {
			return renderNoticeKey(t, loc, "expired.title", nil), renderNoticeKey(t, loc, "expired.body", prog)
		}},
	}
	for _, oc := range outcomes {
		for _, lc := range pamNoticeLocaleCases {
			t.Run(oc.name+"/"+lc.name, func(t *testing.T) {
				setOSUILocaleForTest(t, lc.osTag)
				b := sessionbroker.New("pam-notice-catalog", nil)
				lc.setup(t, b)
				h := &Heartbeat{sessionBroker: b}
				rec := recordPamNotices(h)
				h.pamTracker().MarkAwaiting(pamNotifyTestRequestID, "5", program, partner)
				oc.fire(h)
				title, body := oc.want(t, lc.wantLoc)
				want := pamNotifyCall{Title: title, Body: body, WinSession: "5"}
				if calls := rec.Calls(); len(calls) != 1 || calls[0] != want {
					t.Fatalf("notices = %+v, want [%+v]", calls, want)
				}
			})
		}
	}
}

// TestPamOutcomeNoticeGermanLiteral pins one non-en notice as literal text,
// so a regression to English cannot hide behind a shared render helper.
func TestPamOutcomeNoticeGermanLiteral(t *testing.T) {
	setOSUILocaleForTest(t, "en-US")
	b := sessionbroker.New("pam-notice-de", nil)
	addLocaleHelper(t, b, "5", ipc.HelperRoleUser, "de-DE")
	h := &Heartbeat{sessionBroker: b}
	rec := recordPamNotices(h)
	h.pamTracker().MarkAwaiting(pamNotifyTestRequestID, "5", "mmc.exe", "")
	handlePamRequestNotify(h, pamNotifyCommand(map[string]any{
		"requestId": pamNotifyTestRequestID, "outcome": "denied", "reason": "Bitte das Portal nutzen.",
	}))
	want := pamNotifyCall{
		Title:      "Anfrage abgelehnt",
		Body:       "Ihr IT-Support-Team hat die Anfrage für mmc.exe abgelehnt.\nGrund: Bitte das Portal nutzen.",
		WinSession: "5",
	}
	if calls := rec.Calls(); len(calls) != 1 || calls[0] != want {
		t.Fatalf("notices = %+v, want [%+v]", calls, want)
	}
}
