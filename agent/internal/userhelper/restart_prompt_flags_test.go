package userhelper

import "testing"

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
