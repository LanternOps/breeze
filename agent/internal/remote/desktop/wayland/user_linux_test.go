//go:build linux

package wayland

import "testing"

func TestSystemdHelpSupportsPipe(t *testing.T) {
	if !systemdHelpSupportsPipe("--pipe\n--collect\n") {
		t.Fatal("current systemd-run help should count as supported")
	}
	if systemdHelpSupportsPipe("--wait\n") {
		t.Fatal("help without --pipe and --collect is too old")
	}
	if systemdHelpSupportsPipe("--pipe\n") {
		t.Fatal("--pipe without --collect cannot run this helper")
	}
}
