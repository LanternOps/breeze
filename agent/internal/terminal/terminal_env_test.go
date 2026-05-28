package terminal

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/procoutput"
)

func TestApplyShellEnvAddsUTF8LocaleWhenMissing(t *testing.T) {
	env := applyShellEnv([]string{"PATH=/bin", "HOME=/root"})
	if !containsEnv(env, "LANG=C.UTF-8") {
		t.Fatalf("expected LANG=C.UTF-8, got %v", env)
	}
	if !containsEnv(env, "LC_ALL=C.UTF-8") {
		t.Fatalf("expected LC_ALL=C.UTF-8, got %v", env)
	}
	if !containsEnv(env, "LC_CTYPE=C.UTF-8") {
		t.Fatalf("expected LC_CTYPE=C.UTF-8, got %v", env)
	}
	if !containsEnv(env, "TERM=xterm-256color") {
		t.Fatalf("expected TERM=xterm-256color, got %v", env)
	}
}

func TestApplyShellEnvPreservesExistingUTF8(t *testing.T) {
	original := []string{"LANG=fr_FR.UTF-8", "LC_ALL=fr_FR.UTF-8"}
	env := applyShellEnv(original)
	if !containsEnv(env, "LANG=fr_FR.UTF-8") {
		t.Fatalf("expected existing UTF-8 locale to be preserved, got %v", env)
	}
	if containsEnv(env, "LANG=C.UTF-8") {
		t.Fatalf("expected LANG=C.UTF-8 not to be appended when UTF-8 locale exists, got %v", env)
	}
}

func TestApplyEnvReplacesNonUTF8Locale(t *testing.T) {
	env := procoutput.ApplyEnv([]string{"LANG=C", "LC_ALL=C"})
	if !containsEnv(env, "LANG=C.UTF-8") {
		t.Fatalf("expected LANG=C.UTF-8 to be appended, got %v", env)
	}
}

func containsEnv(env []string, want string) bool {
	for _, entry := range env {
		if entry == want {
			return true
		}
	}
	return false
}
