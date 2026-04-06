package tools

import "testing"

func TestValidateServiceName(t *testing.T) {
	t.Parallel()

	valid := []string{"sshd", "com.breeze.agent", "postgresql@15-main"}
	for _, name := range valid {
		got, err := validateServiceName(name)
		if err != nil {
			t.Fatalf("validateServiceName(%q): %v", name, err)
		}
		if got != name {
			t.Fatalf("validateServiceName(%q) = %q", name, got)
		}
	}

	invalid := []string{"", " bad", "../launchd", "system/evil", "line\nbreak", "name with space"}
	for _, name := range invalid {
		if _, err := validateServiceName(name); err == nil {
			t.Fatalf("expected %q to be rejected", name)
		}
	}
}
