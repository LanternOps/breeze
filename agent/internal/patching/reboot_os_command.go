// The one place a shutdown(8)/shutdown.exe invocation is actually run.
//
// Untagged on purpose, like the rest of this package's shared reboot code: the
// three platform files are compiled and tested nowhere except their own OS, so
// keeping the exec here means the timeout, the kill and the error text are
// covered by tests that run in CI.
package patching

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// osRebootCommandTimeout bounds every shutdown invocation.
//
// It is load-bearing rather than defensive. RebootManager.runOSReboot holds
// osInvoking for exactly as long as execOSReboot runs, and Cancel, Defer and a
// re-schedule are all refused during it — so a shutdown binary that never
// returns (a wedged Windows service host, an unresponsive init) would leave the
// manager permanently refusing every operation with no way back. Thirty seconds
// is far beyond any real invocation: shutdown registers the countdown with the
// OS and returns immediately, it does not wait for the countdown itself.
//
// A var, not a const, so a test can shrink it rather than sleeping for thirty
// seconds. Production never writes it after init.
var osRebootCommandTimeout = 30 * time.Second

// runRebootCommand runs one shutdown invocation under a hard timeout, killing it
// if it overruns.
//
// Killing the child is safe for both the start and the abort: shutdown hands the
// countdown to the operating system and exits, so a process still alive after
// thirty seconds has not registered anything a kill could undo.
func runRebootCommand(name string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), osRebootCommandTimeout)
	defer cancel()

	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err == nil {
		return nil
	}
	cmdline := name
	if len(args) > 0 {
		cmdline += " " + strings.Join(args, " ")
	}
	if ctx.Err() != nil {
		// Distinguished from an ordinary failure because the consequences differ:
		// a command we killed may or may not have registered its countdown, so
		// the state it left behind is unknown rather than known-clean.
		return fmt.Errorf("%s: no response after %s, killed (%s)",
			cmdline, osRebootCommandTimeout, strings.TrimSpace(string(out)))
	}
	return fmt.Errorf("%s: %w (%s)", cmdline, err, strings.TrimSpace(string(out)))
}
