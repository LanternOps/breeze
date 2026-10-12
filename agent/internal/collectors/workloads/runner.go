package workloads

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/hosttool"
)

// This file is the package's only process runner and the only file allowed to
// import the exec package (readonly_guard_test.go). Every command it runs must pass
// allowedCommand first: a fixed absolute program path plus an argv that can
// only read. The Hyper-V and Proxmox drivers build their argv from constants
// and one validated node name, so the allowlist is a second, independent check
// that a future edit cannot turn collection into a mutation.

const (
	// cmdTimeout bounds one command; the collector also gives the whole Detect
	// or Collect call a 30 s context.
	cmdTimeout = 25 * time.Second
	// maxCmdStdout bounds a command's JSON output. 1000 guests in the most
	// verbose list format are well under 2 MiB; anything larger is not a list.
	maxCmdStdout = 16 << 20
	// maxCmdStderr keeps a little diagnostic text; it is never reported.
	maxCmdStderr = 16 << 10
)

// cmdWaitDelay bounds how long a killed command's output pipes may stay open
// (held by a grandchild) before Wait gives up on them. A variable for tests.
var cmdWaitDelay = 5 * time.Second

// systemPowerShell is the host's own Windows PowerShell, resolved from the
// Windows directory the OS reports (never PATH or %SystemRoot%). It is the
// only PowerShell allowedCommand accepts and the one the Hyper-V driver runs.
var systemPowerShell = hosttool.SystemTool(`WindowsPowerShell\v1.0\powershell.exe`)

var errCommandRefused = errors.New("workloads: command is not on the read-only allowlist")

// cmdOutput is a finished command. A non-zero exit is not an error: drivers
// read ExitCode, because their scripts use exit codes to say why they failed.
type cmdOutput struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
}

// cmdRunner runs one allowlisted command. Drivers take it as a field so tests
// replace it with recorded output.
type cmdRunner func(ctx context.Context, path string, args ...string) (cmdOutput, error)

// pveshPathPattern is the only API path shape the Proxmox driver reads: the
// local node's qemu or lxc guest list. The node segment has the same charset
// validNodeName enforces, so it can never be "..", start with "-" or carry a
// separator.
var pveshPathPattern = regexp.MustCompile(`^/nodes/[A-Za-z0-9][A-Za-z0-9-]{0,62}/(qemu|lxc)$`)

// allowedCommand reports whether path+args is one of the read-only commands
// this package runs:
//
//   - the System32 Windows PowerShell with exactly hypervArgs (the fixed Get-VM
//     script);
//   - /usr/bin/pvesh get /nodes/<node>/(qemu|lxc) --output-format json.
func allowedCommand(path string, args []string) bool {
	switch {
	case isSystemPowerShell(path):
		return slices.Equal(args, hypervArgs)
	case path == proxmoxPvesh:
		return len(args) == 4 && args[0] == "get" && pveshPathPattern.MatchString(args[1]) &&
			args[2] == "--output-format" && args[3] == "json"
	}
	return false
}

// isSystemPowerShell accepts exactly the host's System32 PowerShell (Windows
// paths compare case-insensitively); a look-alike tree elsewhere, a relative
// name or a UNC path is refused.
func isSystemPowerShell(path string) bool {
	return systemPowerShell != "" && strings.EqualFold(path, systemPowerShell)
}

// runReadOnly is the production cmdRunner.
func runReadOnly(ctx context.Context, path string, args ...string) (cmdOutput, error) {
	if !allowedCommand(path, args) {
		return cmdOutput{}, errCommandRefused
	}
	return execBounded(ctx, cmdTimeout, maxCmdStdout, path, args...)
}

// limitBuffer keeps the first limit bytes and records that more were written.
// It always reports a full write so the child never blocks on a full pipe.
type limitBuffer struct {
	buf      bytes.Buffer
	limit    int
	overflow bool
}

func (b *limitBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if left := b.limit - b.buf.Len(); n > left {
		b.overflow = true
		p = p[:max(left, 0)]
	}
	_, _ = b.buf.Write(p)
	return n, nil
}

// execBounded runs path with args (argv, never a shell) under a timeout, with
// bounded stdout and stderr. It returns errTooLarge when stdout overflows, the
// context error on timeout or cancellation, and the exec error when the program
// could not start.
func execBounded(parent context.Context, timeout time.Duration, stdoutLimit int, path string, args ...string) (cmdOutput, error) {
	if err := parent.Err(); err != nil {
		return cmdOutput{}, err
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	out := &limitBuffer{limit: stdoutLimit}
	errout := &limitBuffer{limit: maxCmdStderr}
	cmd.Stdout, cmd.Stderr = out, errout
	cmd.WaitDelay = cmdWaitDelay
	runErr := cmd.Run()
	res := cmdOutput{Stdout: out.buf.Bytes(), Stderr: errout.buf.Bytes(), ExitCode: -1}
	if cmd.ProcessState != nil {
		res.ExitCode = cmd.ProcessState.ExitCode()
	}
	if err := ctx.Err(); err != nil {
		return cmdOutput{}, err
	}
	if out.overflow {
		return cmdOutput{}, errTooLarge
	}
	var exitErr *exec.ExitError
	if runErr == nil || errors.As(runErr, &exitErr) {
		return res, nil
	}
	return cmdOutput{}, runErr
}

// execFailure maps a runner error to a collection state and a short machine
// code. The raw error, which can carry command output, stays in the local log.
func execFailure(err error) Result {
	switch {
	case errors.Is(err, errCommandRefused):
		return Result{Collection: CollectionError, Error: "command_refused"}
	case errors.Is(err, errTooLarge):
		return Result{Collection: CollectionError, Error: "response_too_large"}
	case errors.Is(err, context.DeadlineExceeded):
		return Result{Collection: CollectionUnavailable, Error: ReasonTimeout}
	case errors.Is(err, fs.ErrNotExist) || errors.Is(err, exec.ErrNotFound):
		return Result{Collection: CollectionUnavailable, Error: "tool_missing"}
	case errors.Is(err, fs.ErrPermission):
		return Result{Collection: CollectionPermissionDenied, Error: ReasonPermissionDenied}
	default:
		return Result{Collection: CollectionError, Error: "exec_failed"}
	}
}
