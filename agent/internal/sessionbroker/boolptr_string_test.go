package sessionbroker

import "testing"

func TestBoolPtrString(t *testing.T) {
	tr, fa := true, false
	cases := []struct {
		name string
		in   *bool
		want string
	}{
		{"nil", nil, "unknown"},
		{"true", &tr, "true"},
		{"false", &fa, "false"},
	}
	for _, c := range cases {
		if got := boolPtrString(c.in); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}
