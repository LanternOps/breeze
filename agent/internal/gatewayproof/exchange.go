package gatewayproof

import (
	"context"
	"errors"
	"fmt"
	"net"
	"time"
)

// frameConn is a raw link-layer connection bound to one interface.
//
// ReadFrame contract (every implementation honours it): a frame that is
// already available is returned whatever the deadline, a deadline that has
// passed included; otherwise it waits until deadline and returns
// errReadTimeout. Any other error is a failure of the connection.
type frameConn interface {
	WriteFrame(frame []byte) error
	ReadFrame(deadline time.Time) ([]byte, error)
	Close() error
}

// exchange sends request on c and returns the MAC from the first frame for
// which match reports ok.
//
//  1. Drain: read with an already-passed deadline until errReadTimeout,
//     discarding everything queued before the request (an answer from
//     before the call never counts).
//  2. Until ctx is done: write the request at the start and then every
//     resendInterval; read with deadline = min(next resend, ctx deadline);
//     a matching frame returns its MAC; errReadTimeout continues; any other
//     read or write error is returned.
//  3. ctx deadline: ErrNoAnswer. ctx cancelled: ctx.Err().
func exchange(ctx context.Context, c frameConn, request []byte, match func([]byte) (net.HardwareAddr, bool)) (net.HardwareAddr, error) {
	if err := drain(ctx, c); err != nil {
		return nil, err
	}
	ctxDeadline, hasDeadline := ctx.Deadline()
	nextSend := time.Now()
	for {
		if err := ctx.Err(); err != nil {
			return nil, doneErr(err)
		}
		now := time.Now()
		if hasDeadline && !now.Before(ctxDeadline) {
			// The context's timer can fire a moment after its deadline;
			// do not spin on past-deadline reads until it does.
			return nil, ErrNoAnswer
		}
		if !now.Before(nextSend) {
			if err := c.WriteFrame(request); err != nil {
				return nil, fmt.Errorf("write request: %w", err)
			}
			// Keep the schedule anchored at the first send so it never
			// drifts later under load; skip slots already missed.
			for !nextSend.After(now) {
				nextSend = nextSend.Add(resendInterval)
			}
		}
		deadline := nextSend
		if hasDeadline && ctxDeadline.Before(deadline) {
			deadline = ctxDeadline
		}
		frame, err := c.ReadFrame(deadline)
		switch {
		case errors.Is(err, errReadTimeout):
			continue
		case err != nil:
			return nil, fmt.Errorf("read reply: %w", err)
		}
		if mac, ok := match(frame); ok {
			return mac, nil
		}
	}
}

// drain discards every frame that is already queued on c.
func drain(ctx context.Context, c frameConn) error {
	past := time.Unix(0, 0)
	for {
		// A flood that never empties the queue still ends at the deadline.
		if err := ctx.Err(); err != nil {
			return doneErr(err)
		}
		_, err := c.ReadFrame(past)
		switch {
		case errors.Is(err, errReadTimeout):
			return nil
		case err != nil:
			return fmt.Errorf("read reply: %w", err)
		}
	}
}

// doneErr maps a done context's error to the package's result: the deadline
// is ErrNoAnswer, a cancel is the context's own error.
func doneErr(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return ErrNoAnswer
	}
	return err
}
