//go:build linux

package helper

import (
	"context"
	"slices"
	"testing"

	"github.com/breeze-rmm/agent/internal/patching/linuxsession"
)

// Launched with the service's environment, Assist's GTK cannot open the
// display and exits at once; the agent must hand it the user's desktop.
func TestDesktopSessionEnvUsesTheUsersDesktop(t *testing.T) {
	orig := listGraphicalSessions
	t.Cleanup(func() { listGraphicalSessions = orig })
	listGraphicalSessions = func(context.Context) ([]linuxsession.GraphicalSession, error) {
		return []linuxsession.GraphicalSession{
			{ID: "c1", Username: "other", UID: "1001", Type: "x11", Display: ":1"},
			{ID: "c2", Username: "jeff", UID: "1000", Type: "x11", Display: ":0", Home: "/home/jeff"},
		}, nil
	}

	env, err := desktopSessionEnv("1000")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"DISPLAY=:0", "XDG_RUNTIME_DIR=/run/user/1000", "HOME=/home/jeff", "USER=jeff"} {
		if !slices.Contains(env, want) {
			t.Errorf("env missing %q: %v", want, env)
		}
	}

	if _, err := desktopSessionEnv("1002"); err == nil {
		t.Error("want an error for a uid with no desktop session")
	}
}
