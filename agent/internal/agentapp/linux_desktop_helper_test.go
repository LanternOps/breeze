package agentapp

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/userhelper"
)

func linuxHelperTicket(t *testing.T) string {
	t.Helper()
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

type fakeProcEnv struct {
	vals map[string]string
}

func (f *fakeProcEnv) getenv(k string) string { return f.vals[k] }
func (f *fakeProcEnv) unsetenv(k string) error {
	delete(f.vals, k)
	return nil
}

func TestLinuxDesktopHelperEnv_NotSpawnedByAgent(t *testing.T) {
	f := &fakeProcEnv{vals: map[string]string{}}
	_, err := linuxDesktopHelperEnv(f.getenv, f.unsetenv)
	if !errors.Is(err, errLinuxDesktopHelperNotSpawned) {
		t.Fatalf("err = %v, want errLinuxDesktopHelperNotSpawned", err)
	}
}

func TestLinuxDesktopHelperEnv_ScrubsTicket(t *testing.T) {
	ticket := linuxHelperTicket(t)
	f := &fakeProcEnv{vals: map[string]string{
		userhelper.EnvLinuxDesktopLogindSession: "c3",
		userhelper.EnvLinuxDesktopSpawnTicket:   ticket,
		userhelper.EnvLinuxDesktopIPCSocket:     "/run/breeze/desktop/1000.sock",
	}}
	env, err := linuxDesktopHelperEnv(f.getenv, f.unsetenv)
	if err != nil {
		t.Fatalf("linuxDesktopHelperEnv: %v", err)
	}
	if env.SpawnTicket != ticket || env.LogindSessionID != "c3" || env.SocketPath != "/run/breeze/desktop/1000.sock" {
		t.Fatal("parsed env does not match the process environment")
	}
	if _, still := f.vals[userhelper.EnvLinuxDesktopSpawnTicket]; still {
		t.Fatal("the spawn ticket must be scrubbed from the process environment")
	}
}

func TestLinuxDesktopHelperEnv_InvalidStillScrubs(t *testing.T) {
	ticket := linuxHelperTicket(t)
	f := &fakeProcEnv{vals: map[string]string{
		userhelper.EnvLinuxDesktopLogindSession: "c3",
		userhelper.EnvLinuxDesktopSpawnTicket:   ticket,
		userhelper.EnvLinuxDesktopIPCSocket:     "/tmp/x.sock",
	}}
	_, err := linuxDesktopHelperEnv(f.getenv, f.unsetenv)
	if !errors.Is(err, userhelper.ErrLinuxDesktopSocket) {
		t.Fatalf("err = %v, want ErrLinuxDesktopSocket", err)
	}
	if strings.Contains(err.Error(), ticket[:16]) {
		t.Fatal("error must not carry the spawn ticket")
	}
	if _, still := f.vals[userhelper.EnvLinuxDesktopSpawnTicket]; still {
		t.Fatal("the spawn ticket must be scrubbed even when the environment is invalid")
	}
}
