package userhelper

import (
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// mbDefMask is winuser.h MB_DEFMASK: the uType bits that pick the default button.
const mbDefMask = 0x00000F00

// messageBoxDefaultReturn is what MessageBoxTimeoutW returns when the user
// presses Enter on a box built with flags: the default button's ID.
func messageBoxDefaultReturn(t *testing.T, flags uintptr) uintptr {
	t.Helper()
	if flags&0xF != consentMBYesNo {
		t.Fatalf("consent box is not MB_YESNO (flags %#x); the button-ID mapping below assumes it", flags)
	}
	switch flags & mbDefMask {
	case 0x000: // MB_DEFBUTTON1: Yes
		return consentIDYes
	case 0x100: // MB_DEFBUTTON2: No
		return consentIDNo
	default: // MB_DEFBUTTON3/4 name buttons an MB_YESNO box does not have
		return 0
	}
}

var (
	osascriptDefaultButton = regexp.MustCompile(`default button "([^"]*)"`)
	osascriptCancelButton  = regexp.MustCompile(`cancel button "([^"]*)"`)
)

// osascriptDefaultOutput is what osascript reports when the user presses
// Return on the dialog script describes. The default button that is also the
// cancel button ends the run with error -128, like Esc does.
func osascriptDefaultOutput(t *testing.T, script string) (output string, failed bool) {
	t.Helper()
	def := osascriptDefaultButton.FindStringSubmatch(script)
	if def == nil {
		t.Fatalf("macOS consent dialog names no default button: %s", script)
	}
	if cancel := osascriptCancelButton.FindStringSubmatch(script); cancel != nil && cancel[1] == def[1] {
		return "execution error: User canceled. (-128)", true
	}
	return "button returned:" + def[1] + ", gave up:false", false
}

// zenityDefaultExit is zenity's exit code when the user presses Enter on a
// --question dialog run with args: Cancel (1) under --default-cancel, else OK (0).
func zenityDefaultExit(args []string) int {
	if slices.Contains(args, "--default-cancel") {
		return 1
	}
	return 0
}

// #10187: every native consent dialog must make Deny the default, so Enter (a
// user dismissing "something that popped up") never grants remote control,
// and its countdown expiry must never come back as a grant. These are the
// fallbacks behind Breeze Assist, which already focuses Deny.
func TestNativeConsentDialogsDefaultToDeny(t *testing.T) {
	req := sanitizeConsentRequest(ipc.ConsentRequest{
		TechnicianName: "Billy", OrgName: "Olive Technology",
		TimeoutMs: 30_000, OnTimeout: "block",
	})

	tests := []struct {
		name string
		// enter is the outcome of pressing Enter/Return on the dialog as built.
		enter func(t *testing.T) dialogOutcome
		// expiry is the outcome the platform reports when its countdown ends.
		expiry dialogOutcome
	}{
		{
			name: "windows MessageBoxTimeoutW",
			enter: func(t *testing.T) dialogOutcome {
				return classifyMessageBoxReturn(messageBoxDefaultReturn(t, consentMessageBoxFlags))
			},
			expiry: classifyMessageBoxReturn(consentIDTimeout),
		},
		{
			name: "macos osascript display dialog",
			enter: func(t *testing.T) dialogOutcome {
				return classifyOsascriptResult(osascriptDefaultOutput(t, consentOsascriptScript(req)))
			},
			// Verified output of a `giving up after` run on macOS.
			expiry: classifyOsascriptResult("button returned:, gave up:true", false),
		},
		{
			name: "linux zenity --question",
			enter: func(t *testing.T) dialogOutcome {
				return classifyZenityExit(zenityDefaultExit(consentZenityArgs(req)), true, "")
			},
			expiry: classifyZenityExit(5, true, ""),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.enter(t); got != dialogDenied {
				t.Errorf("pressing Enter on the dialog = %v, want dialogDenied: Deny must be the default button", got)
			}
			if tt.expiry != dialogExpired {
				t.Errorf("countdown expiry = %v, want dialogExpired (never a grant)", tt.expiry)
			}
			if got := tt.expiry.wireValue(); got != ipc.ConsentOutcomePresentedExpired {
				t.Errorf("expiry wire value = %q, want %q", got, ipc.ConsentOutcomePresentedExpired)
			}
		})
	}
}

// Esc and the close box must also land on Deny where the platform has them.
// Windows needs no row: an MB_YESNO box has no Cancel button, so Esc and the
// close box are disabled and the countdown is the only way out besides a click.
func TestNativeConsentDialogsEscapeIsDeny(t *testing.T) {
	req := sanitizeConsentRequest(ipc.ConsentRequest{TimeoutMs: 30_000})

	cancel := osascriptCancelButton.FindStringSubmatch(consentOsascriptScript(req))
	if cancel == nil || cancel[1] != "Deny" {
		t.Errorf("macOS consent dialog cancel button = %v, want \"Deny\" so Esc denies", cancel)
	}

	args := consentZenityArgs(req)
	i := slices.Index(args, "--cancel-label")
	if i < 0 || i+1 >= len(args) || args[i+1] != "Deny" {
		t.Errorf("zenity consent dialog --cancel-label is not Deny (Esc and the close box exit 1): %v", args)
	}
	if got := classifyZenityExit(1, true, ""); got != dialogDenied {
		t.Errorf("zenity Esc/close (exit 1) = %v, want dialogDenied", got)
	}
}

// The countdown the copy promises must actually be armed on every platform,
// and a prompt without one must not get one.
func TestNativeConsentDialogsArmTheCountdown(t *testing.T) {
	timed := sanitizeConsentRequest(ipc.ConsentRequest{TimeoutMs: 30_000})
	if got := consentMessageBoxTimeoutMs(timed); got != 30_000 {
		t.Errorf("windows MessageBoxTimeoutW timeout = %d, want 30000", got)
	}
	if script := consentOsascriptScript(timed); !strings.HasSuffix(script, " giving up after 30") {
		t.Errorf("macOS consent dialog has no 30 s countdown: %s", script)
	}
	if args := consentZenityArgs(timed); !slices.Contains(args, "--timeout=30") {
		t.Errorf("zenity consent dialog has no 30 s countdown: %v", args)
	}

	untimed := sanitizeConsentRequest(ipc.ConsentRequest{})
	if got := consentMessageBoxTimeoutMs(untimed); got != consentInfiniteMs {
		t.Errorf("windows MessageBoxTimeoutW timeout without a countdown = %#x, want INFINITE", got)
	}
	if script := consentOsascriptScript(untimed); strings.Contains(script, "giving up after") {
		t.Errorf("macOS consent dialog got a countdown the request did not ask for: %s", script)
	}
	for _, a := range consentZenityArgs(untimed) {
		if strings.HasPrefix(a, "--timeout") {
			t.Errorf("zenity consent dialog got a countdown the request did not ask for: %v", consentZenityArgs(untimed))
		}
	}
}

// The native dialogs cannot tick down like the Assist card's "Declining
// automatically in 0:30", so each states once what happens if the user does
// nothing, and says "allowed" only under a "proceed" policy: exactly when
// legacyConsentDecision turns an expiry into "allow" (decideConsent applies
// the same rule to a prompt it can confirm was on screen).
func TestNativeConsentDialogsStateTheExpiryOutcome(t *testing.T) {
	tests := []struct {
		name      string
		req       ipc.ConsentRequest
		want      string
		wantEmpty bool
	}{
		{"block declines", ipc.ConsentRequest{TimeoutMs: 30_000, OnTimeout: "block"}, "declined automatically in 30 seconds", false},
		{"empty policy declines", ipc.ConsentRequest{TimeoutMs: 30_000}, "declined automatically in 30 seconds", false},
		{"unknown policy declines", ipc.ConsentRequest{TimeoutMs: 30_000, OnTimeout: "maybe"}, "declined automatically in 30 seconds", false},
		{"proceed allows", ipc.ConsentRequest{TimeoutMs: 30_000, OnTimeout: "PROCEED"}, "allowed automatically in 30 seconds", false},
		{"rounds up", ipc.ConsentRequest{TimeoutMs: 1_500}, "declined automatically in 2 seconds", false},
		{"singular", ipc.ConsentRequest{TimeoutMs: 1_000}, "declined automatically in 1 second.", false},
		{"no countdown says nothing", ipc.ConsentRequest{}, "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := sanitizeConsentRequest(tt.req)
			notice := consentCountdownNotice(req)
			if tt.wantEmpty {
				if notice != "" {
					t.Fatalf("notice = %q, want none for a prompt without a countdown", notice)
				}
				return
			}
			if !strings.Contains(notice, tt.want) {
				t.Fatalf("notice = %q, want it to contain %q", notice, tt.want)
			}
			decision, _ := legacyConsentDecision(dialogExpired, req.OnTimeout)
			if saysAllowed := strings.Contains(notice, "allowed automatically"); saysAllowed != (decision == "allow") {
				t.Errorf("notice %q disagrees with the expiry decision %q", notice, decision)
			}
			_, winBody := consentMessageBoxText(req)
			surfaces := map[string]string{
				"windows": winBody,
				"macos":   consentOsascriptScript(req),
				"linux":   strings.Join(consentZenityArgs(req), " "),
			}
			for os, text := range surfaces {
				if !strings.Contains(text, tt.want) {
					t.Errorf("%s consent dialog does not state the expiry outcome %q: %q", os, tt.want, text)
				}
			}
		})
	}
}
