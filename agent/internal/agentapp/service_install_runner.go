package agentapp

import "github.com/breeze-rmm/agent/internal/procspawn"

// commandRunner runs an external command and returns its combined output.
// Production code uses execCommandRunner; tests substitute a recorder so the
// exact argv sequence an install issues can be asserted (#5252).
type commandRunner func(name string, args ...string) ([]byte, error)

// execCommandRunner is the production commandRunner.
func execCommandRunner(name string, args ...string) ([]byte, error) {
	return procspawn.Command(name, args...).CombinedOutput()
}
