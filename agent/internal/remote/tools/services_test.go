package tools

import "testing"

func TestValidateServiceName(t *testing.T) {
	t.Parallel()

	t.Run("valid", func(t *testing.T) {
		t.Parallel()

		cases := []string{
			"sshd",
			"com.breeze.agent",
			"postgresql@15-main",
			"Mesh Agent",
			"Bonjour Service",
			"Sophos Endpoint Defense Service",
		}
		for _, name := range cases {
			name := name
			t.Run(name, func(t *testing.T) {
				t.Parallel()
				got, err := validateServiceName(name)
				if err != nil {
					t.Fatalf("validateServiceName(%q): unexpected error: %v", name, err)
				}
				if got != name {
					t.Fatalf("validateServiceName(%q) = %q, want %q", name, got, name)
				}
			})
		}
	})

	t.Run("invalid", func(t *testing.T) {
		t.Parallel()

		cases := map[string]string{
			"empty":             "",
			"leading space":     " bad",
			"trailing space":    "bad ",
			"dot-dot traversal": "../launchd",
			"forward slash":     "system/evil",
			"backslash":         `system\evil`,
			"newline":           "line\nbreak",
			"carriage return":   "line\rbreak",
			"tab":               "line\ttab",
			"null byte":         "line\x00null",
		}
		for label, name := range cases {
			label, name := label, name
			t.Run(label, func(t *testing.T) {
				t.Parallel()
				if got, err := validateServiceName(name); err == nil {
					t.Fatalf("validateServiceName(%q) = %q, want error", name, got)
				}
			})
		}
	})
}
