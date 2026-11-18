//go:build windows

package sessionbroker

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// #10379: with nobody signed in, the Assist launch fell through to the SYSTEM
// token and Breeze Assist exited 101 in the logon-screen session. The
// user-only path must fail with ErrNoInteractiveUser and never reach SYSTEM.

func stubUserTokenStrategies(t *testing.T, strategies []userTokenStrategy) *int {
	t.Helper()
	origStrategies, origSystem := interactiveUserTokenStrategies, systemTokenForSession
	t.Cleanup(func() { interactiveUserTokenStrategies, systemTokenForSession = origStrategies, origSystem })
	interactiveUserTokenStrategies = strategies
	systemCalls := 0
	systemTokenForSession = func(uint32) (windows.Token, *uint16, error) {
		systemCalls++
		return 0, nil, errors.New("stub: no SYSTEM token in tests")
	}
	return &systemCalls
}

func failingStrategy(name, msg string) userTokenStrategy {
	return userTokenStrategy{name: name, acquire: func(uint32) (windows.Token, *uint16, error) {
		return 0, nil, errors.New(msg)
	}}
}

func TestAcquireInteractiveUserTokenNeverFallsBackToSystem(t *testing.T) {
	systemCalls := stubUserTokenStrategies(t, []userTokenStrategy{
		failingStrategy("user (WTS)", "WTSQueryUserToken: An attempt was made to reference a token that does not exist."),
		failingStrategy("user (explorer)", "no explorer.exe found in session 1"),
	})

	_, _, identity, err := AcquireInteractiveUserToken(1)

	if !errors.Is(err, ErrNoInteractiveUser) {
		t.Fatalf("err = %v, want ErrNoInteractiveUser", err)
	}
	if identity != "" {
		t.Fatalf("identity = %q, want none", identity)
	}
	if *systemCalls != 0 {
		t.Fatalf("SYSTEM token requested %d times; the user-only path must never ask", *systemCalls)
	}
	for _, want := range []string{"user (WTS)", "user (explorer)", "no explorer.exe"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q should name each failed strategy (%q)", err, want)
		}
	}
}

func TestAcquireInteractiveUserTokenUsesFirstWorkingStrategy(t *testing.T) {
	stubUserTokenStrategies(t, []userTokenStrategy{
		failingStrategy("user (WTS)", "WTSQueryUserToken failed"),
		{name: "user (explorer)", acquire: func(uint32) (windows.Token, *uint16, error) { return 0, nil, nil }},
	})

	_, _, identity, err := AcquireInteractiveUserToken(1)

	if err != nil || identity != "user (explorer)" {
		t.Fatalf("identity=%q err=%v, want user (explorer) and no error", identity, err)
	}
}

func TestAcquireInteractiveUserTokenStopsAtTheFirstWorkingStrategy(t *testing.T) {
	secondCalls := 0
	stubUserTokenStrategies(t, []userTokenStrategy{
		{name: "user (WTS)", acquire: func(uint32) (windows.Token, *uint16, error) { return 0, nil, nil }},
		{name: "user (explorer)", acquire: func(uint32) (windows.Token, *uint16, error) {
			secondCalls++
			return 0, nil, errors.New("must not run")
		}},
	})

	_, _, identity, err := AcquireInteractiveUserToken(1)

	if err != nil || identity != "user (WTS)" || secondCalls != 0 {
		t.Fatalf("identity=%q err=%v secondCalls=%d, want user (WTS), no error, 0", identity, err, secondCalls)
	}
}

// The desktop helper spawner keeps its SYSTEM fallback; only the user-only
// path changed.
func TestAcquireUserTokenStillFallsBackToSystem(t *testing.T) {
	systemCalls := stubUserTokenStrategies(t, []userTokenStrategy{failingStrategy("user (WTS)", "no token")})

	_, _, _, _ = acquireUserToken(1)

	if *systemCalls != 1 {
		t.Fatalf("SYSTEM fallback calls = %d, want 1", *systemCalls)
	}
}

// The Assist launch path: binary present, nobody signed in → no launch.
func TestSpawnProcessInSessionWithArgsNoSignedInUser(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "breeze-helper.exe")
	if err := os.WriteFile(binary, []byte("stub"), 0o755); err != nil {
		t.Fatal(err)
	}
	systemCalls := stubUserTokenStrategies(t, []userTokenStrategy{failingStrategy("user (WTS)", "no token")})
	launch := stubCreateProcessAsUser(t, 3104, nil)

	pid, err := SpawnProcessInSessionWithArgs(binary, []string{"--config", "x"}, 1)

	if !errors.Is(err, ErrNoInteractiveUser) {
		t.Fatalf("err = %v, want ErrNoInteractiveUser", err)
	}
	if *systemCalls != 0 {
		t.Fatalf("Assist launch asked for a SYSTEM token %d times", *systemCalls)
	}
	if pid != 0 || launch.calls != 0 {
		t.Fatalf("pid=%d launches=%d, want no launch", pid, launch.calls)
	}
}
