//go:build linux

package wayland

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync/atomic"
)

// inputCmd is one pointer or keyboard event from the root agent.
type inputCmd struct {
	Op     string  `json:"op"`
	X      float64 `json:"x,omitempty"`
	Y      float64 `json:"y,omitempty"`
	Button uint32  `json:"button,omitempty"`
	State  uint32  `json:"state,omitempty"`
	Axis   uint32  `json:"axis,omitempty"`
	Steps  int32   `json:"steps,omitempty"`
	Code   uint32  `json:"code,omitempty"`
}

// RunHelper is `breeze-agent wayland-capture`. systemd-run starts it inside
// the graphical user's session; the root agent only speaks framed JPEGs on
// stdout and JSON events on stdin.
func RunHelper() {
	out := bufio.NewWriter(os.Stdout)
	if err := runHelper(out); err != nil {
		_ = writeMsg(out, msgError, []byte(err.Error()))
		fmt.Fprintf(os.Stderr, "wayland-capture: %s\n", err)
		os.Exit(1)
	}
}

func runHelper(out *bufio.Writer) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var current atomic.Pointer[portalSession]
	go readInput(cancel, &current)

	session, err := handshake(ctx)
	if err != nil {
		return err
	}
	defer session.Close()
	current.Store(session)

	gst, err := exec.LookPath("gst-launch-1.0")
	if err != nil {
		gst = "/usr/bin/gst-launch-1.0"
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		return err
	}
	defer reader.Close()

	cmd := exec.CommandContext(ctx, gst, "-q",
		"pipewiresrc", "fd=3", fmt.Sprintf("path=%d", session.node), "do-timestamp=true",
		"!", "videoconvert",
		"!", "videorate",
		"!", "video/x-raw,framerate=10/1",
		"!", "jpegenc", "quality=60",
		"!", "fdsink", "fd=1", "sync=false",
	)
	cmd.Stdout = writer
	cmd.Stderr = os.Stderr
	cmd.ExtraFiles = []*os.File{session.pw}
	if err := cmd.Start(); err != nil {
		writer.Close()
		return fmt.Errorf("gst-launch: %w", err)
	}
	writer.Close()
	// The child inherited a dup. Closing our copy must not close the child's.
	if session.pw != nil {
		_ = session.pw.Close()
		session.pw = nil
	}
	defer func() { _ = cmd.Wait() }()

	buf := make([]byte, 0, 256<<10)
	tmp := make([]byte, 64<<10)
	for {
		n, rerr := reader.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		for {
			frame, rest, ok := takeJPEG(buf)
			buf = rest
			if !ok {
				break
			}
			if err := writeMsg(out, msgFrame, frame); err != nil {
				return err
			}
		}
		if rerr != nil {
			if rerr == io.EOF {
				return nil
			}
			return fmt.Errorf("gstreamer: %w", rerr)
		}
	}
}

func readInput(cancel context.CancelFunc, current *atomic.Pointer[portalSession]) {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 4096), 1<<20)
	for sc.Scan() {
		var c inputCmd
		if err := json.Unmarshal(sc.Bytes(), &c); err != nil {
			continue
		}
		if c.Op == "stop" {
			cancel()
			return
		}
		if s := current.Load(); s != nil {
			s.input(c)
		}
	}
	cancel()
}
