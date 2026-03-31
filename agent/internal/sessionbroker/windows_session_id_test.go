package sessionbroker

import "testing"

func TestParseWindowsSessionID(t *testing.T) {
	t.Parallel()

	got, err := parseWindowsSessionID("42")
	if err != nil {
		t.Fatalf("parseWindowsSessionID: %v", err)
	}
	if got != 42 {
		t.Fatalf("parseWindowsSessionID = %d, want 42", got)
	}

	invalid := []string{"", " 42", "4 2", "4a", "12345678901", "-1"}
	for _, value := range invalid {
		if _, err := parseWindowsSessionID(value); err == nil {
			t.Fatalf("expected %q to fail", value)
		}
	}
}
