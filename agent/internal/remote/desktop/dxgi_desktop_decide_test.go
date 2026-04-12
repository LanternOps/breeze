package desktop

import "testing"

func TestIsSecureDesktop(t *testing.T) {
	tests := []struct {
		name        string
		desktopName string
		want        bool
	}{
		// Empty name: Win32 couldn't read it — treat as NOT secure so
		// callers retry DXGI. If DXGI truly can't attach it will fail on
		// its own and the caller falls to GDI then. Treating empty as
		// secure caused permanent GDI fallback on transient Win32 failures.
		{"empty", "", false},
		// Normal desktop — canonical casing.
		{"Default", "Default", false},
		// Case-insensitive matches for "Default".
		{"default lowercase", "default", false},
		{"DEFAULT uppercase", "DEFAULT", false},
		// Secure desktops go to GDI.
		{"Winlogon", "Winlogon", true},
		{"Screen-saver", "Screen-saver", true},
		{"random string", "some-random-string", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := isSecureDesktop(tc.desktopName)
			if got != tc.want {
				t.Fatalf("isSecureDesktop(%q) = %v, want %v", tc.desktopName, got, tc.want)
			}
		})
	}
}
