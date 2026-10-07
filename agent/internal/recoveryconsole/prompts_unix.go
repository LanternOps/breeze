//go:build !windows

package recoveryconsole

import (
	"fmt"
	"os"
	"os/exec"
	"time"
)

// readOneKey reads at most one byte within d using stty's non-canonical
// timed read mode. Returns ok=false on timeout or any error.
// sttyCommand builds an stty invocation that acts on the console this
// process is reading from. stty configures the terminal on ITS stdin, so
// Stdin must be os.Stdin; with Stdin left nil (the original W04b code) it
// configured /dev/null, the console stayed in canonical mode, and
// readOneKey's os.Stdin.Read blocked until a newline — the "Rebooting in
// 10 s" countdown on the KIT proof never fired (2026-09-12).
func sttyCommand(args ...string) *exec.Cmd {
	cmd := exec.Command("stty", args...)
	cmd.Stdin = os.Stdin
	return cmd
}

func readOneKey(d time.Duration) (rune, bool) {
	deciseconds := int(d / (100 * time.Millisecond))
	if deciseconds < 1 {
		deciseconds = 1
	}
	_ = sttyCommand("-echo", "-icanon", "min", "0", "time", fmt.Sprintf("%d", deciseconds)).Run() // best-effort; a failure here just means we won't detect a keypress

	buf := make([]byte, 1)
	n, err := os.Stdin.Read(buf)
	_ = sttyCommand("sane").Run()
	if err != nil || n == 0 {
		return 0, false
	}
	return rune(buf[0]), true
}
