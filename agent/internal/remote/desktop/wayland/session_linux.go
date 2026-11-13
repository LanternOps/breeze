//go:build linux

package wayland

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/jpeg"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const shareWait = 60 * time.Second

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
	if src == nil {
		if fail != nil {
			return nil, fail
		}
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
	if c.p.frame == nil {
		if c.p.fail != nil {
			return 0, 0, c.p.fail
		}
		return 0, 0, errors.New("wayland capture produced no frame")
	}
	return c.p.frame.Rect.Dx(), c.p.frame.Rect.Dy(), nil
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
	if p.fail == nil && p.frame == nil {
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
	bin, err := exec.LookPath("systemd-run")
	if err != nil {
		bin = "/usr/bin/systemd-run"
	}
	cmd := exec.Command(bin,
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
	go p.readStderr(stderr)
	go p.readStdout(stdout)
	go func() {
		err := cmd.Wait()
		p.dead.Store(true)
		p.mu.Lock()
		if p.frame == nil && p.fail == nil {
			if err != nil {
				p.fail = fmt.Errorf("wayland capture helper exited: %w", err)
			} else {
				p.fail = errors.New("wayland capture helper exited")
			}
		}
		p.mu.Unlock()
		p.signal()
	}()
	return p, nil
}

func (p *pipe) readStderr(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 4096), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		slog.Info("wayland capture", "stderr", line)
		p.mu.Lock()
		if p.fail == nil && (strings.Contains(line, "wayland-capture:") || strings.HasPrefix(line, "Failed")) {
			p.detail = line
		}
		p.mu.Unlock()
	}
}

func (p *pipe) readStdout(r io.Reader) {
	sr := newStreamReader(r)
	for {
		kind, payload, err := sr.Next()
		if err != nil {
			if p.frame == nil {
				time.Sleep(150 * time.Millisecond)
			}
			p.mu.Lock()
			if p.frame == nil && p.fail == nil {
				if p.detail != "" {
					p.fail = errors.New(p.detail)
				} else {
					p.fail = fmt.Errorf("wayland capture ended: %v", err)
				}
			}
			p.mu.Unlock()
			p.signal()
			return
		}
		if kind == msgError {
			p.mu.Lock()
			p.fail = errors.New(string(payload))
			p.mu.Unlock()
			p.signal()
			return
		}
		img, err := jpeg.Decode(bytes.NewReader(payload))
		if err != nil {
			slog.Warn("wayland capture: bad jpeg", "error", err.Error(), "bytes", len(payload))
			continue
		}
		b := img.Bounds()
		rgba := image.NewRGBA(b)
		draw.Draw(rgba, b, img, b.Min, draw.Src)
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

// Active reports that input should go to the portal session rather than X11.
func Active() bool {
	if currentPipe() != nil {
		return true
	}
	return IsGraphical()
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

// Key injects one evdev key down or up.
func Key(name string, down bool) error {
	code, ok := Keycode(name)
	if !ok {
		return fmt.Errorf("unknown key %q", name)
	}
	state := uint32(0)
	if down {
		state = 1
	}
	return currentSend(inputCmd{Op: "key", Code: code, State: state})
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
