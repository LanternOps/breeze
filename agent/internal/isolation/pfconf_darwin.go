//go:build darwin

package isolation

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

const (
	pfctlBinary = "/sbin/pfctl"
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
	cmd := procspawn.CommandContext(ctx, binary, args...)
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

// EgressInterfaces lists the live interfaces traffic could leave through.
func (execPFRunner) EgressInterfaces() ([]string, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, fmt.Errorf("list the network interfaces: %w", err)
	}
	var names []string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			return nil, fmt.Errorf("read the addresses of %s: %w", iface.Name, err)
		}
		if len(addrs) > 0 {
			names = append(names, iface.Name)
		}
	}
	return uniqueSorted(names), nil
}
