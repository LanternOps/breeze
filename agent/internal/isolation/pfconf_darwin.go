//go:build darwin

package isolation

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

const (
	pfctlBinary = "/sbin/pfctl"
	routeBinary = "/sbin/route"
	// pfCommandTimeout bounds one pfctl call. An apply must finish well inside
	// the provisional window, and a hung pfctl must not hold the machine lock.
	pfCommandTimeout = 30 * time.Second
)

// execPFRunner is the real PFRunner. Binaries are named by absolute path: this
// runs as root, so PATH is not an input.
type execPFRunner struct{ ctx context.Context }

func (r execPFRunner) run(stdin, binary string, args ...string) (string, string, error) {
	ctx, cancel := context.WithTimeout(r.ctx, pfCommandTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return stdout.String(), stderr.String(), fmt.Errorf("%s %s: %w: %s", binary, strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), stderr.String(), nil
}

func (r execPFRunner) Pfctl(stdin string, args ...string) (string, string, error) {
	return r.run(stdin, pfctlBinary, args...)
}

func (execPFRunner) ReadPFConf() (string, error) {
	b, err := os.ReadFile(pfConfPath)
	return string(b), err
}

// EgressInterfaces asks the routing table. `route get` exits non-zero when a
// family has no default route, which is an answer and not a failure, so only a
// context failure or a missing binary is reported.
func (r execPFRunner) EgressInterfaces() ([]string, error) {
	if _, err := os.Stat(routeBinary); err != nil {
		return nil, err
	}
	var names []string
	for _, args := range [][]string{{"-n", "get", "default"}, {"-n", "get", "-inet6", "default"}} {
		stdout, _, err := r.run("", routeBinary, args...)
		if ctxErr := r.ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		if err != nil {
			continue
		}
		if name := parseRouteInterface(stdout); name != "" {
			names = append(names, name)
		}
	}
	return uniqueSorted(names), nil
}
