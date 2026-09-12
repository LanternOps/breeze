package recoveryconsole

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"time"
)

// termIO is the real IO implementation: line I/O over the given
// reader/writer (in production, os.Stdin/os.Stdout — the console runs
// directly on a getty-owned tty, so no terminal framework is needed), and
// single-keypress reads for the reboot countdown via `stty` (agent/go.mod
// carries no golang.org/x/term dependency, and adding one for a single
// raw-mode read is not worth it on media that already ships `stty` as part
// of util-linux/coreutils).
type termIO struct {
	r *bufio.Reader
	w io.Writer
}

// NewTerminalIO builds the real IO used by `breeze-backup recovery-console`.
func NewTerminalIO(r io.Reader, w io.Writer) IO {
	return &termIO{r: bufio.NewReader(r), w: w}
}

func (t *termIO) Print(format string, args ...any) {
	_, _ = fmt.Fprintf(t.w, format, args...)
}

func (t *termIO) ReadLine(prompt string) (string, error) {
	if prompt != "" {
		_, _ = fmt.Fprint(t.w, prompt)
	}
	line, err := t.r.ReadString('\n')
	if err != nil && line == "" {
		return "", err
	}
	for len(line) > 0 && (line[len(line)-1] == '\n' || line[len(line)-1] == '\r') {
		line = line[:len(line)-1]
	}
	return line, nil
}

// ReadKeyWithTimeout waits up to d for a single keypress on the controlling
// tty using `stty -echo -icanon min 0 time <deciseconds>` plus `dd`, which
// is available on every recovery-media image (util-linux/coreutils). It
// polls in <=1s slices so the countdown display (owned by the caller) can
// still advance; any error (not a tty, stty missing) degrades to "no key
// pressed" rather than failing the whole console.
func (t *termIO) ReadKeyWithTimeout(d time.Duration) (rune, bool) {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		remaining := time.Until(deadline)
		slice := remaining
		if slice > time.Second {
			slice = time.Second
		}
		key, ok := readOneKey(slice)
		if ok {
			return key, true
		}
	}
	return 0, false
}

// readOneKey reads at most one byte within d using stty's non-canonical
// timed read mode. Returns ok=false on timeout or any error.
func readOneKey(d time.Duration) (rune, bool) {
	deciseconds := int(d / (100 * time.Millisecond))
	if deciseconds < 1 {
		deciseconds = 1
	}
	cmd := exec.Command("stty", "-echo", "-icanon", "min", "0", "time", fmt.Sprintf("%d", deciseconds))
	cmd.Stdin = nil
	_ = cmd.Run() // best-effort; a failure here just means we won't detect a keypress

	buf := make([]byte, 1)
	n, err := os.Stdin.Read(buf)
	restoreCmd := exec.Command("stty", "sane")
	_ = restoreCmd.Run()
	if err != nil || n == 0 {
		return 0, false
	}
	return rune(buf[0]), true
}
