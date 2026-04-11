package desktop

import "testing"

func TestDecideReattach(t *testing.T) {
	tests := []struct {
		name        string
		desktopName string
		want        reattachAction
	}{
		// Empty name: Win32 couldn't read it — assume secure, use GDI.
		{"empty", "", reattachUseGDI},
		// Normal desktop — canonical casing.
		{"Default", "Default", reattachUseDXGI},
		// Case-insensitive matches for "Default".
		{"default lowercase", "default", reattachUseDXGI},
		{"DEFAULT uppercase", "DEFAULT", reattachUseDXGI},
		// Secure desktops go to GDI.
		{"Winlogon", "Winlogon", reattachUseGDI},
		{"Screen-saver", "Screen-saver", reattachUseGDI},
		{"random string", "some-random-string", reattachUseGDI},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := decideReattach(tc.desktopName)
			if got != tc.want {
				t.Fatalf("decideReattach(%q) = %v, want %v", tc.desktopName, got, tc.want)
			}
		})
	}
}
