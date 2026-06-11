package procoutput

import "testing"

func TestApplyEnvAddsUTF8WhenMissing(t *testing.T) {
	env := ApplyEnv([]string{"PATH=/bin"})
	if !envContains(env, "LANG=C.UTF-8") {
		t.Fatalf("expected LANG=C.UTF-8, got %v", env)
	}
}

func TestApplyEnvPreservesExistingUTF8(t *testing.T) {
	original := []string{"LANG=fr_FR.UTF-8", "PATH=/bin"}
	env := ApplyEnv(original)
	if len(env) != len(original) {
		t.Fatalf("expected no extra vars, got %v", env)
	}
}

func TestApplyEnvIgnoresNonUTF8Locale(t *testing.T) {
	env := ApplyEnv([]string{"LANG=C", "LC_ALL=POSIX"})
	if !envContains(env, "LANG=C.UTF-8") {
		t.Fatalf("expected UTF-8 locale vars to be appended, got %v", env)
	}
}

func envContains(env []string, want string) bool {
	for _, entry := range env {
		if entry == want {
			return true
		}
	}
	return false
}
