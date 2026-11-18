package userhelper

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func testSpawnTicket(t *testing.T) string {
	t.Helper()
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func fakeEnv(vals map[string]string) func(string) string {
	return func(k string) string { return vals[k] }
}

func validLinuxDesktopEnvVars(t *testing.T) map[string]string {
	return map[string]string{
		EnvLinuxDesktopLogindSession: "c2",
		EnvLinuxDesktopSpawnTicket:   testSpawnTicket(t),
		EnvLinuxDesktopIPCSocket:     "/run/breeze/desktop/1000.sock",
	}
}

func TestParseLinuxDesktopEnv_Valid(t *testing.T) {
	vars := validLinuxDesktopEnvVars(t)
	env, err := ParseLinuxDesktopEnv(fakeEnv(vars))
	if err != nil {
		t.Fatalf("ParseLinuxDesktopEnv: %v", err)
	}
	if env.LogindSessionID != "c2" || env.SpawnTicket != vars[EnvLinuxDesktopSpawnTicket] ||
		env.SocketPath != "/run/breeze/desktop/1000.sock" {
		t.Fatalf("unexpected env: session=%q socket=%q ticketMatches=%v",
			env.LogindSessionID, env.SocketPath, env.SpawnTicket == vars[EnvLinuxDesktopSpawnTicket])
	}

	vars[EnvLinuxDesktopIPCSocket] = "/var/run/breeze/desktop/1000.sock"
	vars[EnvLinuxDesktopLogindSession] = strings.Repeat("a", 32)
	if _, err := ParseLinuxDesktopEnv(fakeEnv(vars)); err != nil {
		t.Fatalf("ParseLinuxDesktopEnv(/var/run, 32-char id): %v", err)
	}
}

func TestParseLinuxDesktopEnv_BadSessionID(t *testing.T) {
	for _, id := range []string{"", strings.Repeat("a", 33), "1;2", "../x", "c 2", "c2\n"} {
		vars := validLinuxDesktopEnvVars(t)
		vars[EnvLinuxDesktopLogindSession] = id
		_, err := ParseLinuxDesktopEnv(fakeEnv(vars))
		if !errors.Is(err, ErrLinuxDesktopSessionID) {
			t.Errorf("session id %q: err = %v, want ErrLinuxDesktopSessionID", id, err)
		}
		assertNoTicketInError(t, err, vars[EnvLinuxDesktopSpawnTicket])
	}
}

func TestParseLinuxDesktopEnv_BadTicket(t *testing.T) {
	good := testSpawnTicket(t)
	cases := map[string]string{
		"empty":     "",
		"short 42":  good[:42],
		"long 44":   good + "A",
		"plus":      "+" + good[1:],
		"slash":     "/" + good[1:],
		"padding":   good[:42] + "=",
		"space":     " " + good[1:],
		"non-ascii": "é" + good[2:],
	}
	for name, ticket := range cases {
		vars := validLinuxDesktopEnvVars(t)
		vars[EnvLinuxDesktopSpawnTicket] = ticket
		_, err := ParseLinuxDesktopEnv(fakeEnv(vars))
		if !errors.Is(err, ErrLinuxDesktopSpawnTicket) {
			t.Errorf("%s: err = %v, want ErrLinuxDesktopSpawnTicket", name, err)
		}
		assertNoTicketInError(t, err, ticket)
	}
}

func TestParseLinuxDesktopEnv_BadSocket(t *testing.T) {
	for _, sock := range []string{
		"",
		"run/breeze/desktop/1000.sock",
		"/tmp/x.sock",
		"/run/breezex/a.sock",
		"/run/breeze/../etc/x",
		"/run/breeze//desktop/1000.sock",
		"/run/breeze/desktop/",
		"/run/breeze/",
		"/run/breeze",
		"/var/run/breeze",
		"/run/breeze/./x.sock",
		"/run/breeze/desk\x00top.sock",
		"/run/breeze/" + strings.Repeat("a", 200) + ".sock",
	} {
		vars := validLinuxDesktopEnvVars(t)
		vars[EnvLinuxDesktopIPCSocket] = sock
		_, err := ParseLinuxDesktopEnv(fakeEnv(vars))
		if !errors.Is(err, ErrLinuxDesktopSocket) {
			t.Errorf("socket %q: err = %v, want ErrLinuxDesktopSocket", sock, err)
		}
		assertNoTicketInError(t, err, vars[EnvLinuxDesktopSpawnTicket])
	}
}

func assertNoTicketInError(t *testing.T, err error, ticket string) {
	t.Helper()
	if err == nil || ticket == "" {
		return
	}
	// Any 8-character run of the ticket appearing in the message counts.
	msg := err.Error()
	for i := 0; i+8 <= len(ticket); i++ {
		if strings.Contains(msg, ticket[i:i+8]) {
			t.Fatalf("error %q contains part of the spawn ticket", msg)
		}
	}
}

func TestDetectCapabilities_LinuxDesktopHelperNoBackend(t *testing.T) {
	restore := linuxSessionBackendRegistered
	t.Cleanup(func() { linuxSessionBackendRegistered = restore })
	linuxSessionBackendRegistered = func() bool { return false }

	for _, display := range []string{"wayland:wayland-0", "x11::0"} {
		caps := detectCapabilitiesForOS("linux", ipc.HelperBinaryDesktopHelper, ipc.DesktopContextUserSession, display)
		if caps.CanCapture || caps.CanNotify || caps.CanTray || caps.CanClipboard {
			t.Fatalf("display %q: caps = %+v, want capture/notify/tray/clipboard all false", display, caps)
		}
		if caps.DisplayServer != display {
			t.Fatalf("DisplayServer = %q, want %q", caps.DisplayServer, display)
		}
	}
}

func TestDetectCapabilities_LinuxDesktopHelperWithBackend(t *testing.T) {
	restore := linuxSessionBackendRegistered
	t.Cleanup(func() { linuxSessionBackendRegistered = restore })
	linuxSessionBackendRegistered = func() bool { return true }

	caps := detectCapabilitiesForOS("linux", ipc.HelperBinaryDesktopHelper, ipc.DesktopContextUserSession, "wayland:wayland-0")
	if !caps.CanCapture {
		t.Fatal("a registered session backend should let the Linux desktop helper report CanCapture")
	}
	if caps.CanNotify || caps.CanTray || caps.CanClipboard {
		t.Fatalf("caps = %+v, want notify/tray/clipboard false", caps)
	}
	// No display at all still cannot capture.
	if caps := detectCapabilitiesForOS("linux", ipc.HelperBinaryDesktopHelper, ipc.DesktopContextUserSession, ""); caps.CanCapture {
		t.Fatal("no display: CanCapture must be false")
	}
}

// The Linux user-helper is not a desktop helper; its capabilities are unchanged.
func TestDetectCapabilities_LinuxUserHelperUnchanged(t *testing.T) {
	restore := linuxSessionBackendRegistered
	t.Cleanup(func() { linuxSessionBackendRegistered = restore })
	linuxSessionBackendRegistered = func() bool { return false }

	caps := detectCapabilitiesForOS("linux", ipc.HelperBinaryUserHelper, "", "x11::0")
	if !caps.CanCapture || !caps.CanNotify || !caps.CanTray {
		t.Fatalf("user helper caps = %+v, want capture/notify/tray true with a display", caps)
	}
}
