package agentapp

import (
	"errors"
	"reflect"
	"testing"
)

// #7829: FixConfigPermissions group-owns helper_token.yaml by the breeze group.
// The group must be ensured (or repaired) first, or a group the daemon repairs
// on this start would only reach the token file on the NEXT restart, leaving
// the desktop helper unable to read its token in between.
func TestRepairStartupPermissionsEnsuresGroupFirst(t *testing.T) {
	cases := []struct {
		name        string
		supportMode bool
		ensureErr   error
		want        []string
	}{
		{"ensures the group before fixing permissions", false, nil, []string{"ensure", "fix"}},
		{"a group failure still fixes the rest", false, errors.New("dscl wedged"), []string{"ensure", "fix"}},
		{"support mode touches neither", true, nil, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			repairStartupPermissions(tc.supportMode,
				func() error { got = append(got, "ensure"); return tc.ensureErr },
				func() { got = append(got, "fix") })
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("calls = %v, want %v", got, tc.want)
			}
		})
	}
}
