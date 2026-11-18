//go:build linux

package wayland

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/patching/linuxsession"
	"github.com/breeze-rmm/agent/internal/procspawn"
	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

const shareWait = 60 * time.Second

// ErrShareStopped is returned once a delivered stream ends because the user
// stopped sharing, the screen locked, or the capture pipeline exited cleanly.
var ErrShareStopped = errors.New("the user stopped sharing")

// logGate drops repeated lines so a noisy helper cannot flood the agent log.
type logGate struct {
	mu         sync.Mutex
	next       time.Time
	suppressed int
}

func (g *logGate) allow() (emit bool, skipped int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	if now.Before(g.next) {
		g.suppressed++
		return false, 0
	}
	skipped = g.suppressed
	g.suppressed = 0
	g.next = now.Add(2 * time.Second)
	return true, skipped
}

var (
	stderrGate logGate
	jpegGate   logGate
)

func trimLog(s string) string {
	const max = 300
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

// Capturer is the Linux Wayland screen capturer. Capture blocks until the
// user allows the portal dialog, then returns decoded frames.
type Capturer struct {
	p *pipe
}

type pipe struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	out   *bufio.Writer

	mu      sync.Mutex
	writeMu sync.Mutex
	frame   *image.RGBA
	fail    error
	detail  string
	ready   chan struct{}
	once    sync.Once
	refs    int
	stopped bool
	dead    atomic.Bool
}

var (
	liveMu sync.Mutex
	live   *pipe
)

// Open starts the in-session capture helper if one is not already running.
// The share dialog appears when the helper reaches RemoteDesktop.Start.
func Open() (*Capturer, error) {
	liveMu.Lock()
	defer liveMu.Unlock()
	if live != nil && !live.dead.Load() {
		live.refs++
		return &Capturer{p: live}, nil
	}
	if live != nil {
		live.stop()
		live = nil
	}
	p, err := startPipe()
	if err != nil {
		return nil, err
	}
	p.refs = 1
	live = p
	return &Capturer{p: p}, nil
}

func (c *Capturer) Close() error {
	if c == nil || c.p == nil {
		return nil
	}
	liveMu.Lock()
	p := c.p
	c.p = nil
	p.refs--
	stop := p.refs <= 0
	if stop && live == p {
		live = nil
	}
	liveMu.Unlock()
	if stop {
		p.stop()
	}
	return nil
}

func (c *Capturer) Capture() (*image.RGBA, error) {
	if c == nil || c.p == nil {
		return nil, errors.New("wayland capture is closed")
	}
	if err := c.p.waitReady(); err != nil {
		return nil, err
	}
	c.p.mu.Lock()
	src := c.p.frame
	fail := c.p.fail
	c.p.mu.Unlock()
	if fail != nil {
		return nil, fail
	}
	if src == nil {
		return nil, errors.New("wayland capture produced no frame")
	}
	dst := image.NewRGBA(src.Rect)
	copy(dst.Pix, src.Pix)
	return dst, nil
}

func (c *Capturer) CaptureRegion(x, y, width, height int) (*image.RGBA, error) {
	img, err := c.Capture()
	if err != nil {
		return nil, err
	}
	r := image.Rect(x, y, x+width, y+height).Intersect(img.Bounds())
	if r.Empty() {
		return nil, fmt.Errorf("region outside the frame")
	}
	dst := image.NewRGBA(image.Rect(0, 0, r.Dx(), r.Dy()))
	draw.Draw(dst, dst.Bounds(), img, r.Min, draw.Src)
	return dst, nil
}

func (c *Capturer) GetScreenBounds() (int, int, error) {
	if c == nil || c.p == nil {
		return 0, 0, errors.New("wayland capture is closed")
	}
	if err := c.p.waitReady(); err != nil {
		return 0, 0, err
	}
	c.p.mu.Lock()
	defer c.p.mu.Unlock()
	if c.p.fail != nil {
		return 0, 0, c.p.fail
	}
	if c.p.frame == nil {
		return 0, 0, errors.New("wayland capture produced no frame")
	}
	return c.p.frame.Rect.Dx(), c.p.frame.Rect.Dy(), nil
}

// LastCaptureError is the terminal failure Capture is now returning, so the
// no-video watchdog can show it to the technician instead of a generic stall.
func (c *Capturer) LastCaptureError() error {
	if c == nil || c.p == nil {
		return nil
	}
	c.p.mu.Lock()
	defer c.p.mu.Unlock()
	return c.p.fail
}

func (p *pipe) waitReady() error {
	select {
	case <-p.ready:
		return nil
	case <-time.After(shareWait):
		return errors.New("timed out waiting for the desktop share prompt")
	}
}

func (p *pipe) signal() {
	p.once.Do(func() { close(p.ready) })
}

func (p *pipe) stop() {
	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		return
	}
	p.stopped = true
	in := p.stdin
	p.stdin = nil
	p.mu.Unlock()
	p.dead.Store(true)
	if in != nil {
		_, _ = in.Write([]byte("{\"op\":\"stop\"}\n"))
		_ = in.Close()
	}
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	p.mu.Lock()
	if p.fail == nil {
		p.fail = errors.New("wayland capture stopped")
	}
	p.mu.Unlock()
	p.signal()
}

func startPipe() (*pipe, error) {
	sess, err := lookupSession()
	if err != nil {
		return nil, err
	}
	if !sess.wayland || !sess.active || sess.name == "" {
		return nil, errors.New("no active wayland session")
	}
	if sess.locked {
		return nil, errors.New("the desktop is locked; unlock it, then connect again")
	}
	if !validUser(sess.name) {
		return nil, fmt.Errorf("refusing session name %q", sess.name)
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	bin, err := linuxsession.ResolveSystemBinary("systemd-run")
	if err != nil {
		return nil, fmt.Errorf("systemd-run: %w", err)
	}
	cmd := procspawn.Command(bin,
		"--user", "-M", sess.name+"@",
		"--pipe", "--wait", "--collect",
		"--", exe, "wayland-capture",
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("systemd-run: %w", err)
	}
	p := &pipe{
		cmd:   cmd,
		stdin: stdin,
		out:   bufio.NewWriter(stdin),
		ready: make(chan struct{}),
	}
	// Wait closes the pipes. Calling it while these readers are still going
	// drops the helper's final error. The process exit delivers EOF on its
	// own, so the readers finish first and Wait only reaps the status.
	var readers sync.WaitGroup
	readers.Add(2)
	go func() {
		defer readers.Done()
		p.readStderr(stderr)
	}()
	go func() {
		defer readers.Done()
		p.readStdout(stdout)
	}()
	go func() {
		readers.Wait()
		err := cmd.Wait()
		p.noteExit(err)
		p.signal()
	}()
	return p, nil
}

func (p *pipe) readStderr(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 4096), 256<<10)
	for sc.Scan() {
		line := trimLog(sc.Text())
		p.mu.Lock()
		if p.detail == "" && (strings.Contains(line, "wayland-capture:") || strings.HasPrefix(line, "Failed")) {
			p.detail = line
		}
		p.mu.Unlock()
		if ok, skipped := stderrGate.allow(); ok {
			if skipped > 0 {
				slog.Info("wayland capture", "stderr", line, "suppressed", skipped)
			} else {
				slog.Info("wayland capture", "stderr", line)
			}
		}
	}
	// A line past the scanner limit stops Scan without consuming the rest.
	// Leave the pipe undrained and gstreamer blocks on its next write.
	_, _ = io.Copy(io.Discard, r)
}

func (p *pipe) readStdout(r io.Reader) {
	sr := newStreamReader(r)
	for {
		kind, payload, err := sr.Next()
		if err != nil {
			p.mu.Lock()
			haveFrame := p.frame != nil
			p.mu.Unlock()
			if !haveFrame {
				time.Sleep(150 * time.Millisecond)
			}
			p.noteStreamEnd(err)
			p.signal()
			return
		}
		if kind == msgError {
			p.dead.Store(true)
			p.mu.Lock()
			if p.fail == nil {
				p.fail = errors.New(trimLog(string(payload)))
			}
			p.mu.Unlock()
			p.signal()
			return
		}
		rgba, err := decodeFrame(payload)
		if err != nil {
			if ok, skipped := jpegGate.allow(); ok {
				if skipped > 0 {
					slog.Warn("wayland capture: bad jpeg", "error", err.Error(), "bytes", len(payload), "suppressed", skipped)
				} else {
					slog.Warn("wayland capture: bad jpeg", "error", err.Error(), "bytes", len(payload))
				}
			}
			continue
		}
		b := rgba.Bounds()
		p.mu.Lock()
		first := p.frame == nil
		p.frame = rgba
		p.mu.Unlock()
		if first {
			slog.Info("wayland capture frame", "width", b.Dx(), "height", b.Dy(), "bytes", len(payload))
			p.signal()
		}
	}
}

// noteStreamEnd records a terminal failure as soon as the helper's stdout
// closes, including when a frame was already delivered. A later noteExit may
// replace ErrShareStopped with a non-zero helper status.
func (p *pipe) noteStreamEnd(readErr error) {
	p.dead.Store(true)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.fail != nil || p.stopped {
		return
	}
	if p.frame == nil && p.detail != "" {
		p.fail = errors.New(p.detail)
		return
	}
	if p.frame != nil && (readErr == nil || errors.Is(readErr, io.EOF)) {
		p.fail = ErrShareStopped
		return
	}
	if readErr != nil {
		p.fail = fmt.Errorf("wayland capture ended: %v", readErr)
		return
	}
	p.fail = errors.New("wayland capture helper exited")
}

func (p *pipe) noteExit(err error) {
	p.dead.Store(true)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stopped {
		if p.fail == nil {
			p.fail = errors.New("wayland capture stopped")
		}
		return
	}
	if err != nil && (p.fail == nil || errors.Is(p.fail, ErrShareStopped)) {
		p.fail = fmt.Errorf("wayland capture helper exited: %w", err)
		return
	}
	if p.fail != nil {
		return
	}
	if p.frame == nil && p.detail != "" {
		p.fail = errors.New(p.detail)
		return
	}
	if p.frame != nil {
		p.fail = ErrShareStopped
		return
	}
	p.fail = errors.New("wayland capture helper exited")
}

func (p *pipe) send(c inputCmd) error {
	if p == nil || p.dead.Load() || p.out == nil {
		return errors.New("wayland capture is not running")
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if err := json.NewEncoder(p.out).Encode(c); err != nil {
		return err
	}
	return p.out.Flush()
}

func currentPipe() *pipe {
	liveMu.Lock()
	defer liveMu.Unlock()
	if live == nil || live.dead.Load() {
		return nil
	}
	return live
}

func currentSend(c inputCmd) error {
	p := currentPipe()
	if p == nil {
		return errors.New("wayland capture is not running")
	}
	return p.send(c)
}

// Move injects an absolute pointer position in frame pixels.
func Move(x, y int) error {
	return currentSend(inputCmd{Op: "move", X: float64(x), Y: float64(y)})
}

// Pointer injects a button press or release.
func Pointer(button string, down bool) error {
	state := uint32(0)
	if down {
		state = 1
	}
	return currentSend(inputCmd{Op: "button", Button: buttonCode(button), State: state})
}

// Scroll injects discrete wheel steps. Positive delta matches the X11 path
// (scroll up). Portal vertical steps are positive downward.
func Scroll(delta, deltaX int) error {
	if delta != 0 {
		if err := currentSend(inputCmd{Op: "scroll", Axis: 0, Steps: int32(-delta)}); err != nil {
			return err
		}
	}
	if deltaX != 0 {
		if err := currentSend(inputCmd{Op: "scroll", Axis: 1, Steps: int32(deltaX)}); err != nil {
			return err
		}
	}
	return nil
}

// Key injects one key down or up as an X keysym. The portal method is
// NotifyKeyboardKeysym, so this accepts the same names as the X11 path,
// including shifted and non-ASCII characters.
func Key(name string, down bool) error {
	sym, ok := x11.KeysymForName(name)
	if !ok || sym == 0 {
		return fmt.Errorf("unknown key %q", name)
	}
	state := uint32(0)
	if down {
		state = 1
	}
	return currentSend(inputCmd{Op: "key", Keysym: sym, State: state})
}

// KeyPress holds modifiers, taps key, then releases the modifiers.
func KeyPress(key string, mods []string) error {
	for _, m := range mods {
		if err := Key(m, true); err != nil {
			return err
		}
	}
	if err := Key(key, true); err != nil {
		return err
	}
	if err := Key(key, false); err != nil {
		return err
	}
	for i := len(mods) - 1; i >= 0; i-- {
		if err := Key(mods[i], false); err != nil {
			return err
		}
	}
	return nil
}

func validUser(name string) bool {
	if name == "" || len(name) > 64 {
		return false
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '.' || r == '_' || r == '-':
		default:
			return false
		}
	}
	return true
}
