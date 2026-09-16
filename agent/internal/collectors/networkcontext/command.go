package networkcontext

import (
	"bytes"
	"context"
	"io"
	"os/exec"
	"time"
)

type CommandRunner interface {
	Output(context.Context, string, ...string) ([]byte, error)
}
type boundedRunner struct{}
type outputLimit struct {
	bytes.Buffer
	exceeded bool
}

func (b *outputLimit) Write(p []byte) (int, error) {
	n := len(p)
	remaining := 1024*1024 - b.Len()
	if n > remaining {
		b.exceeded = true
		p = p[:remaining]
	}
	_, _ = b.Buffer.Write(p)
	return n, nil
}
func (boundedRunner) Output(parent context.Context, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	out := &outputLimit{}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	cmd.WaitDelay = time.Second
	e := cmd.Run()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if out.exceeded {
		return nil, ErrLimit
	}
	return out.Bytes(), e
}
