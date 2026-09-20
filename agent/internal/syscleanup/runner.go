package syscleanup

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/procoutput"
)

// maxOutputBytes caps each captured stream. Cleaner output is a few lines of
// summary; anything larger is a runaway that must not ride a command result
// back to the API (spec §7.1).
const maxOutputBytes = 16 * 1024

// localeVariables are stripped and re-set to C before every parsed cleaner
// runs. DISM gets /English instead (its output ignores the POSIX locale).
var localeVariables = []string{"LC_ALL", "LANG", "LC_CTYPE", "LC_MESSAGES", "LC_NUMERIC"}

// cLocaleEnv pins the child's output locale to C.
//
// NOT procoutput.ApplyEnv: that helper only APPENDS a C.UTF-8 locale when the
// inherited environment has no UTF-8 locale at all, so on a host with
// LC_ALL=fr_FR.UTF-8 it is a no-op, apt/dnf/journalctl emit French, and every
// parser in this package falls back to estimateKnown:false with no visible
// cause. Overriding is the only behaviour that makes the parsers deterministic.
func cLocaleEnv(base []string) []string {
	out := make([]string, 0, len(base)+len(localeVariables))
	for _, entry := range base {
		key, _, ok := strings.Cut(entry, "=")
		if ok && containsFold(localeVariables, key) {
			continue
		}
		out = append(out, entry)
	}
	for _, name := range localeVariables {
		out = append(out, name+"=C")
	}
	return out
}

func containsFold(list []string, value string) bool {
	for _, entry := range list {
		if strings.EqualFold(entry, value) {
			return true
		}
	}
	return false
}

// capOutput trims and caps one stream, keeping the TAIL and marking truncation
// so a parser (and a human reading outputTail) can tell a short answer from a
// clipped one.
//
// Tail, not head (spec §13 #14): every parser in this package matches a
// trailing summary line — `Freed space:`, `This operation would free
// approximately`, `Archived and active journals take up` — and a failing
// cleaner puts its error last as well. Keeping the first 16 KiB of a chatty
// `apt-get clean` or a DISM progress bar discards precisely the bytes the
// estimate and the diagnosis depend on, and does it silently.
func capOutput(b []byte) string {
	text := strings.TrimSpace(procoutput.BytesToUTF8(b))
	if len(text) <= maxOutputBytes {
		return text
	}
	// Cut on a rune boundary so the kept tail is valid UTF-8.
	tail := text[len(text)-maxOutputBytes:]
	for len(tail) > 0 && !utf8.RuneStart(tail[0]) {
		tail = tail[1:]
	}
	return "[truncated] " + strings.TrimSpace(tail)
}

// resolveBinary returns the first candidate that exists and is a regular file.
// Candidates are ABSOLUTE paths from a fixed list — never an exec.LookPath,
// which would let a $PATH entry decide which binary root runs (spec §7.1).
func resolveBinary(candidates ...string) (string, bool) {
	for _, candidate := range candidates {
		if candidate == "" || !filepath.IsAbs(candidate) {
			continue
		}
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() {
			continue
		}
		return candidate, true
	}
	return "", false
}

// ProcResult is one process invocation's outcome.
type ProcResult struct {
	Path     string
	Args     []string
	Stdout   string
	Stderr   string
	ExitCode int
	Duration time.Duration
	TimedOut bool
	Err      error
}

// lockedBuffer collects a stream safely across the copy goroutines os/exec
// leaves running when Wait returns early. Same reason as the installer twin's.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.buf.Bytes()...)
}

// runProcess executes one cleaner with a deadline, a C locale, capped streams
// and process-TREE containment.
//
// It never uses a shell, never resolves through $PATH, and refuses a
// non-absolute path outright — the last line of defence behind the closed
// catalogue and the server-side id validation.
func runProcess(ctx context.Context, timeout time.Duration, path string, args ...string) ProcResult {
	started := time.Now()
	result := ProcResult{Path: path, Args: args}
	if !filepath.IsAbs(path) {
		result.Err = fmt.Errorf("refusing to run %q: cleaner binaries must be an absolute path", path)
		result.ExitCode = 1
		result.Duration = time.Since(started)
		return result
	}

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, path, args...)
	cmd.Env = cLocaleEnv(os.Environ())

	var stdout, stderr lockedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	// Without WaitDelay, Wait blocks on pipe EOF until every descendant exits
	// — which for cleanmgr's hidden session-0 UI can be well past the deadline.
	cmd.WaitDelay = 30 * time.Second

	tree := newProcessTree()
	defer tree.release()
	tree.prepare(cmd)
	// CommandContext cancels while Wait is draining the output pipes. Kill
	// descendants here: waiting until Wait returns lets them hold those pipes
	// open for the entire WaitDelay. Adoption must finish before cancellation
	// touches the platform tree.
	adopted := make(chan struct{})
	cmd.Cancel = func() error {
		<-adopted
		tree.kill(cmd)
		return cmd.Process.Kill()
	}

	if err := cmd.Start(); err != nil {
		result.Err = err
		result.ExitCode = 1
		result.Duration = time.Since(started)
		return result
	}
	tree.adopt(cmd)
	close(adopted)
	waitErr := cmd.Wait()

	result.Stdout = capOutput(stdout.Bytes())
	result.Stderr = capOutput(stderr.Bytes())
	result.Duration = time.Since(started)

	var exitErr *exec.ExitError
	switch {
	case waitErr == nil:
		result.ExitCode = 0
	case errors.As(waitErr, &exitErr):
		result.ExitCode = exitErr.ExitCode()
	case errors.Is(waitErr, exec.ErrWaitDelay):
		// The leader exited; only abandoned descendants held the pipes.
		if cmd.ProcessState != nil {
			result.ExitCode = cmd.ProcessState.ExitCode()
		}
	default:
		result.ExitCode = 1
		result.Err = waitErr
	}

	if runCtx.Err() == context.DeadlineExceeded {
		result.TimedOut = true
		result.Err = fmt.Errorf("%s timed out after %s and its process tree was terminated",
			filepath.Base(path), timeout)
	}
	return result
}
