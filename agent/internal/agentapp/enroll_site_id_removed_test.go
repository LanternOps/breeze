package agentapp

import (
	"bytes"
	"strings"
	"testing"
)

// `enroll --site-id` was removed (#8493). Passing it must fail with a message
// that says what replaced it, not a bare "unknown flag".
func TestEnrollSiteIDFlag_RemovedWithClearError(t *testing.T) {
	if f := enrollCmd.Flags().Lookup("site-id"); f != nil {
		t.Fatal("--site-id must no longer be registered on enroll")
	}
	var out bytes.Buffer
	enrollCmd.SetOut(&out)
	enrollCmd.SetErr(&out)
	t.Cleanup(func() { enrollCmd.SetOut(nil); enrollCmd.SetErr(nil) })

	err := enrollCmd.ParseFlags([]string{"--site-id", "x"})
	if err == nil {
		t.Fatal("--site-id must be rejected")
	}
	err = enrollCmd.FlagErrorFunc()(enrollCmd, err)
	if !strings.Contains(err.Error(), "--site-id was removed") ||
		!strings.Contains(err.Error(), "enrollment key") {
		t.Errorf("error should explain the removal and point at the enrollment key, got %q", err)
	}
}

func TestEnrollOtherUnknownFlag_ErrorUnchanged(t *testing.T) {
	err := enrollCmd.ParseFlags([]string{"--bogus"})
	if err == nil {
		t.Fatal("expected error")
	}
	got := enrollCmd.FlagErrorFunc()(enrollCmd, err)
	if strings.Contains(got.Error(), "site-id") {
		t.Errorf("unrelated flag error must not mention site-id: %q", got)
	}
}
