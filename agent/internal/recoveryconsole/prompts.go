package recoveryconsole

import (
	"bufio"
	"fmt"
	"io"
	"time"
)

// termIO is the real IO implementation: line I/O over the given
// reader/writer (in production, os.Stdin/os.Stdout — the console runs
// directly on a getty-owned tty on Linux media, or on the winpeshl-started
// console on WinPE media, so no terminal framework is needed), and
// single-keypress reads for the reboot countdown via the per-OS readOneKey:
// `stty` on Linux (prompts_unix.go — agent/go.mod carries no
// golang.org/x/term dependency, and adding one for a single raw-mode read is
// not worth it on media that already ships `stty` as part of
// util-linux/coreutils), the console input handle on Windows
// (prompts_windows.go).
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

// ReadKeyWithTimeout waits up to d for a single keypress on the process's
// console via readOneKey (Linux: `stty -echo -icanon min 0 time
// <deciseconds>` plus a one-byte read, prompts_unix.go; Windows: a timed
// wait on the console input handle, prompts_windows.go). It polls in <=1s
// slices so the countdown display (owned by the caller) can still advance;
// any error (not a tty/console, stty missing) degrades to "no key pressed"
// rather than failing the whole console.
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
