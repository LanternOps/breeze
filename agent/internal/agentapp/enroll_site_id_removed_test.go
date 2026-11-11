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

func TestEnrollSiteIDFlag_EqualsFormAndPrefixLookalike(t *testing.T) {
	cases := []struct {
		arg  string
		want bool
	}{
		{"--site-id=x", true},
		{"--site-identifier=x", false},
	}
	for _, c := range cases {
		err := enrollCmd.ParseFlags([]string{c.arg})
		if err == nil {
			t.Fatalf("%s: expected parse error", c.arg)
		}
		got := enrollCmd.FlagErrorFunc()(enrollCmd, err)
		if has := strings.Contains(got.Error(), "--site-id was removed"); has != c.want {
			t.Errorf("%s: rewritten=%v want %v (%q)", c.arg, has, c.want, got)
		}
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
