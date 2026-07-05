package patching

import "testing"

func TestDecideBootstrap(t *testing.T) {
	cases := []struct {
		name string
		in   bootstrapInputs
		want bootstrapAction
	}{
		{"present and new enough", bootstrapInputs{locatedVersion: "1.22.0.0", located: true, minVersion: minWingetVersion, appxStackPresent: true}, actionUseExisting},
		{"present but too old", bootstrapInputs{locatedVersion: "1.5.0.0", located: true, minVersion: minWingetVersion, appxStackPresent: true}, actionProvision},
		{"absent but appx stack present", bootstrapInputs{located: false, minVersion: minWingetVersion, appxStackPresent: true}, actionProvision},
		{"absent and no appx stack (server core)", bootstrapInputs{located: false, minVersion: minWingetVersion, appxStackPresent: false}, actionUnavailable},
		{"too old and no appx stack", bootstrapInputs{locatedVersion: "1.5.0.0", located: true, minVersion: minWingetVersion, appxStackPresent: false}, actionUseExisting},
	}
	for _, c := range cases {
		if got := decideBootstrap(c.in); got != c.want {
			t.Fatalf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}
