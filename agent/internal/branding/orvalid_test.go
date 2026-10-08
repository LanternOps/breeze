package branding

import (
	"strings"
	"testing"
)

// OrValid is Or plus the build-time rules: a value that is not valid never
// reaches a service registration, even when it came in through a raw
// -ldflags -X build that skipped build-edition.sh.
func TestOrValid(t *testing.T) {
	cases := []struct {
		name, value, fallback, want string
	}{
		{"unset", "", "Default", "Default"},
		{"blank", "   ", "Default", "Default"},
		{"valid", "Example MSP Agent", "Default", "Example MSP Agent"},
		{"double quote", `Acme "Pro"`, "Default", "Default"},
		{"single quote", "Acme's", "Default", "Default"},
		{"percent", "100% Co", "Default", "Default"},
		{"backslash", `Acme\Pro`, "Default", "Default"},
		{"newline", "a\nb", "Default", "Default"},
		{"too long", strings.Repeat("a", MaxLen+1), "Default", "Default"},
		{"exactly max", strings.Repeat("a", MaxLen), "Default", strings.Repeat("a", MaxLen)},
	}
	for _, tc := range cases {
		if got := OrValid(tc.value, tc.fallback); got != tc.want {
			t.Errorf("%s: OrValid(%q) = %q, want %q", tc.name, tc.value, got, tc.want)
		}
	}
}
