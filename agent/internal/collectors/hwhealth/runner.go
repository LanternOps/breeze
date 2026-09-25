package hwhealth

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"time"
)

type execResult struct {
	Stdout, Stderr []byte
	ExitCode       int
	Truncated      bool
	Duration       time.Duration
}

type toolRunner func(context.Context, time.Duration, string, ...string) (execResult, error)

type limitBuffer struct {
	buf      bytes.Buffer
	limit    int
	overflow bool
}

func (b *limitBuffer) Len() int      { return b.buf.Len() }
func (b *limitBuffer) Bytes() []byte { return b.buf.Bytes() }
func (b *limitBuffer) Write(p []byte) (int, error) {
	n := len(p)
	left := b.limit - b.Len()
	if n > left {
		b.overflow = true
		p = p[:left]
	}
	_, _ = b.buf.Write(p)
	return n, nil
}

func runTool(parent context.Context, timeout time.Duration, path string, args ...string) (execResult, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	start := time.Now()
	cmd := exec.CommandContext(ctx, path, args...)
	out := &limitBuffer{limit: 4 * 1024 * 1024}
	errout := &limitBuffer{limit: 64 * 1024}
	cmd.Stdout = out
	cmd.Stderr = errout
	cmd.WaitDelay = 10 * time.Second
	e := cmd.Run()
	r := execResult{Stdout: out.Bytes(), Stderr: errout.Bytes(), ExitCode: -1, Truncated: out.overflow || errout.overflow, Duration: time.Since(start)}
	if cmd.ProcessState != nil {
		r.ExitCode = cmd.ProcessState.ExitCode()
	}
	if ctx.Err() != nil {
		return r, ctx.Err()
	}
	if r.Truncated {
		return r, fmt.Errorf("output exceeds capture limit")
	}
	var exit *exec.ExitError
	if errors.As(e, &exit) {
		return r, nil
	}
	if errors.Is(e, exec.ErrWaitDelay) {
		return r, fmt.Errorf("output pipe did not close: %w", e)
	}
	return r, e
}
