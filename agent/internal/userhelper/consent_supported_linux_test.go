//go:build linux

package userhelper

import (
	"errors"
	"testing"
)

func TestConsentUISupportedLinux(t *testing.T) {
	origLookPath := lookPathFn
	defer func() { lookPathFn = origLookPath }()

	t.Run("zenity missing", func(t *testing.T) {
		lookPathFn = func(file string) (string, error) { return "", errors.New("not found") }
		t.Setenv("DISPLAY", ":0")
		t.Setenv("WAYLAND_DISPLAY", "")
		if consentUISupported() {
			t.Fatal("expected false when zenity is not on PATH")
		}
	})

	t.Run("zenity present but no display", func(t *testing.T) {
		lookPathFn = func(file string) (string, error) { return "/usr/bin/zenity", nil }
		t.Setenv("DISPLAY", "")
		t.Setenv("WAYLAND_DISPLAY", "")
		if consentUISupported() {
			t.Fatal("expected false when neither DISPLAY nor WAYLAND_DISPLAY is set")
		}
	})

	t.Run("zenity present with DISPLAY set", func(t *testing.T) {
		lookPathFn = func(file string) (string, error) { return "/usr/bin/zenity", nil }
		t.Setenv("DISPLAY", ":0")
		t.Setenv("WAYLAND_DISPLAY", "")
		if !consentUISupported() {
			t.Fatal("expected true when zenity is present and DISPLAY is set")
		}
	})
}
