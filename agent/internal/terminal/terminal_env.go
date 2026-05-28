package terminal

import (
	"github.com/breeze-rmm/agent/internal/procoutput"
)

// applyShellEnv returns a shell environment with UTF-8 locale (when missing),
// TERM, and any extra variables appended last.
func applyShellEnv(base []string, extra ...string) []string {
	env := procoutput.ApplyEnv(append([]string{}, base...))
	env = append(env, "TERM=xterm-256color")
	env = append(env, extra...)
	return env
}
