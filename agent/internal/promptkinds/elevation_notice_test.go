package promptkinds

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
)

// TestElevationOutcomeNoticeCopy pins the notice text (#10696) per outcome in
// en and one non-en locale. The strings are written out, not rendered, so a
// key or sentence-choice change fails here.
func TestElevationOutcomeNoticeCopy(t *testing.T) {
	type want struct{ title, body string }
	for _, tc := range []struct {
		name                        string
		loc                         promptcatalog.Locale
		state                       ipc.PromptState
		partner, technician, reason string
		want                        want
	}{
		{"approved/en/partner", "en", ipc.PromptStateApproved, "Contoso IT", "", "",
			want{"Request approved", "Contoso IT approved mmc.exe. It is starting."}},
		{"approved/en/technician+partner", "en", ipc.PromptStateApproved, "Contoso IT", "Dana", "",
			want{"Request approved", "Dana at Contoso IT approved mmc.exe. It is starting."}},
		{"approved/en/technician only", "en", ipc.PromptStateApproved, "", "Dana", "",
			want{"Request approved", "Dana approved mmc.exe. It is starting."}},
		{"approved/en/generic", "en", ipc.PromptStateApproved, "", "", "",
			want{"Request approved", "Your IT support team approved mmc.exe. It is starting."}},
		{"approved/de", "de-DE", ipc.PromptStateApproved, "Contoso IT", "", "",
			want{"Anfrage genehmigt", "Contoso IT hat mmc.exe genehmigt. Das Programm wird gestartet."}},
		{"failed/en", "en", ipc.PromptStateFailed, "Contoso IT", "Dana", "",
			want{"The program couldn't start", "mmc.exe was approved but couldn't start. Contact Contoso IT."}},
		{"failed/en/generic", "en", ipc.PromptStateFailed, "", "", "",
			want{"The program couldn't start", "mmc.exe was approved but couldn't start. Contact your IT support team."}},
		{"denied/en/reason", "en", ipc.PromptStateDenied, "Contoso IT", "Dana", "Use the portal.",
			want{"Request denied", "Contoso IT denied the request for mmc.exe.\nReason: Use the portal."}},
		{"denied/en/no reason", "en", ipc.PromptStateDenied, "", "", "  ",
			want{"Request denied", "Your IT support team denied the request for mmc.exe."}},
		{"denied/fr-FR/reason", "fr-FR", ipc.PromptStateDenied, "Contoso IT", "", "Non",
			want{"Demande refusée", "Contoso IT a refusé la demande pour mmc.exe.\nMotif: Non"}},
		{"expired/en", "en", ipc.PromptStateExpired, "Contoso IT", "", "",
			want{"Request expired", "Your request for mmc.exe expired before Contoso IT answered."}},
		{"expired/it/generic", "it-IT", ipc.PromptStateExpired, "", "", "",
			want{"Richiesta scaduta", "La richiesta per mmc.exe è scaduta prima che il tuo team di assistenza IT rispondesse."}},
		{"cancelled/tr", "tr-TR", ipc.PromptStateCancelled, "Contoso IT", "", "",
			want{"İstek iptal edildi", "mmc.exe isteğini iptal ettiniz."}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			title, body, err := ElevationOutcomeNotice(tc.loc, tc.state, "mmc.exe", tc.partner, tc.technician, tc.reason)
			if err != nil {
				t.Fatalf("ElevationOutcomeNotice: %v", err)
			}
			if title != tc.want.title || body != tc.want.body {
				t.Fatalf("got (%q, %q), want (%q, %q)", title, body, tc.want.title, tc.want.body)
			}
		})
	}
}

// TestElevationOutcomeNoticeMatchesThePrompt: the notice is the same copy the
// elevation prompt shows for that outcome, in every locale.
func TestElevationOutcomeNoticeMatchesThePrompt(t *testing.T) {
	for _, loc := range promptcatalog.Locales {
		for _, state := range []ipc.PromptState{ipc.PromptStateApproved, ipc.PromptStateFailed, ipc.PromptStateDenied, ipc.PromptStateExpired, ipc.PromptStateCancelled} {
			e := NewElevation(ElevationParams{RequestID: "40000000-0000-4000-8000-000000000001", ProgramPath: `C:\Tools\mmc.exe`, Partner: "Contoso IT"}, ElevationHooks{})
			if _, err := e.OutcomePatch(state, "Dana", ""); err != nil {
				t.Fatalf("%s/%s OutcomePatch: %v", loc, state, err)
			}
			l, err := e.localize(loc)
			if err != nil {
				t.Fatalf("%s/%s localize: %v", loc, state, err)
			}
			title, body, err := ElevationOutcomeNotice(loc, state, `C:\Tools\mmc.exe`, "Contoso IT", "Dana", "")
			if err != nil {
				t.Fatalf("%s/%s notice: %v", loc, state, err)
			}
			if title != l.Copy.Title || body != l.Copy.Body {
				t.Fatalf("%s/%s notice (%q, %q) != prompt (%q, %q)", loc, state, title, body, l.Copy.Title, l.Copy.Body)
			}
		}
	}
}

// TestElevationOutcomeNoticeSanitizes: server and capture strings are never
// read as placeholders or carry line breaks into the title or sentence.
func TestElevationOutcomeNoticeSanitizes(t *testing.T) {
	_, body, err := ElevationOutcomeNotice("en", ipc.PromptStateDenied, "a{partner}\nb.exe", "Contoso IT", "", "line1\nline2 {program}")
	if err != nil {
		t.Fatal(err)
	}
	want := "Contoso IT denied the request for a｛partner｝ b.exe.\nReason: line1 line2 ｛program｝"
	if body != want {
		t.Fatalf("body = %q, want %q", body, want)
	}
}

func TestElevationOutcomeNoticeRefusesNonTerminalStates(t *testing.T) {
	for _, state := range []ipc.PromptState{ipc.PromptStatePending, ipc.PromptStateWaiting, ""} {
		if _, _, err := ElevationOutcomeNotice("en", state, "mmc.exe", "", "", ""); err == nil {
			t.Fatalf("%q: want an error", state)
		}
	}
}
