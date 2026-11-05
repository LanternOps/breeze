package userhelper

import (
	"os"
	"strings"
	"testing"
)

// The Windows restart box is windows-tagged and not run in CI: pin that it
// takes its flags from restartPromptFlags and builds none of its own, so a
// revert cannot quietly drop MB_DEFBUTTON2.
func TestWindowsRestartBoxUsesRestartPromptFlags(t *testing.T) {
	raw, err := os.ReadFile("notify_prompt_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	start := strings.Index(src, "func showNotifyPromptOS(")
	if start < 0 {
		t.Fatal("showNotifyPromptOS not found")
	}
	body := src[start:]
	if end := strings.Index(body, "\n}\n"); end > 0 {
		body = body[:end]
	}
	if !strings.Contains(body, "flags := uintptr(restartPromptFlags())") {
		t.Fatal("showNotifyPromptOS must take its uType from restartPromptFlags()")
	}
	if strings.Contains(body, "consentMBYesNo") || strings.Contains(body, "notifyPromptMBIconWarning") {
		t.Fatal("showNotifyPromptOS builds its own flags again; use restartPromptFlags()")
	}
}

// P8 (#10190 W05): the legacy restart Yes/No box defaults to its second
// button, No — the postponement the daemon sends as Actions[1] — whatever
// promptHost.enabledKinds says. Enter or a stray key press must never
// restart the machine; a countdown expiry still means no decision.
func TestLegacyRestartBoxDefaultsToSecondButton(t *testing.T) {
	flags := restartPromptFlags()
	if flags&0x00000F00 != consentMBDefButton2 {
		t.Fatalf("default button bits = %#x, want MB_DEFBUTTON2 (%#x)", flags&0x00000F00, consentMBDefButton2)
	}
	if flags&0x0000000F != consentMBYesNo {
		t.Fatalf("button set = %#x, want MB_YESNO", flags&0x0000000F)
	}
	for _, want := range []uint32{notifyPromptMBIconWarning, consentMBTopMost, consentMBSystemModal, consentMBSetForeground} {
		if flags&want == 0 {
			t.Fatalf("flags %#x lack %#x", flags, want)
		}
	}
	// No (the second button, the default) is the postponement.
	actions := []string{"Restart now", "Postpone 1 hour"}
	if got := notifyPromptAction(actions, 1); got != "Postpone 1 hour" {
		t.Fatalf("second button = %q, want the postponement", got)
	}
}
