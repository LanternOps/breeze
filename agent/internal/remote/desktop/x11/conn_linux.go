//go:build linux

package x11

import (
	"encoding/hex"
	"fmt"
	"math"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/shm"
	"github.com/jezek/xgb/xproto"
	"golang.org/x/sys/unix"
)

// Conn is a per-instance X11 connection with an optional MIT-SHM capture path.
type Conn struct {
	mu     sync.Mutex
	x      *xgb.Conn
	root   xproto.Window
	width  int
	height int

	useShm bool
	shmID  int
	shmBuf []byte
	shmSeg shm.Seg

	// ownerUID is the uid of the session/X-server owner (from DisplayTarget).
	// The agent runs as root but the X server on xrdp/GDM runs as this
	// non-root user, so the SHM segment must be chowned to it after
	// creation for the server to be able to attach.
	ownerUID int
}

// openShared performs the dial + cookie auth + connection setup that both Open
// and OpenBare need, stopping short of any MIT-SHM provisioning. Failures are
// classified so callers can distinguish a socket-level failure (ErrConnectFailed)
// from a rejected handshake/authentication (ErrAuthFailed); the original message
// text is preserved as the %v detail.
func openShared(target DisplayTarget) (*Conn, error) {
	num, err := displayNumber(target.Display)
	if err != nil {
		return nil, err
	}
	sock, err := net.Dial("unix", "/tmp/.X11-unix/X"+num)
	if err != nil {
		return nil, fmt.Errorf("%w: dial X socket: %v", ErrConnectFailed, err)
	}

	cookieHex := ""
	if target.XauthPath != "" {
		if blob, rerr := os.ReadFile(target.XauthPath); rerr == nil {
			host, _ := os.Hostname()
			if cookie, ferr := FindMitMagicCookie(blob, num, host); ferr == nil {
				cookieHex = hex.EncodeToString(cookie)
			}
		}
	}

	x, err := xgb.NewConnNetWithCookieHex(sock, cookieHex)
	if err != nil {
		_ = sock.Close()
		return nil, fmt.Errorf("%w: x11 auth/connect: %v", ErrAuthFailed, err)
	}

	setup := xproto.Setup(x)
	screen := setup.DefaultScreen(x)
	return &Conn{
		x:        x,
		root:     screen.Root,
		width:    int(screen.WidthInPixels),
		height:   int(screen.HeightInPixels),
		ownerUID: target.OwnerUID,
	}, nil
}

// Open dials the display's unix socket, injects the MIT-MAGIC-COOKIE-1, and
// negotiates MIT-SHM. All state lives on the returned Conn — nothing global.
func Open(target DisplayTarget) (*Conn, error) {
	c, err := openShared(target)
	if err != nil {
		return nil, err
	}
	c.initShm()
	return c, nil
}

// OpenBare is Open without MIT-SHM provisioning. Connections that never capture
// a frame (the cursor tracker, the input injector, and the capability probe)
// use it to avoid allocating a SysV shared-memory segment per session. useShm
// stays false, so a Conn from OpenBare that ever did capture would transparently
// fall back to the core-protocol path.
func OpenBare(target DisplayTarget) (*Conn, error) {
	return openShared(target)
}

func displayNumber(display string) (string, error) {
	d := strings.TrimPrefix(display, ":")
	if i := strings.IndexByte(d, '.'); i >= 0 {
		d = d[:i]
	}
	if _, err := strconv.Atoi(d); err != nil {
		return "", fmt.Errorf("bad display %q", display)
	}
	return d, nil
}

func (c *Conn) initShm() {
	if err := shm.Init(c.x); err != nil {
		c.useShm = false
		return
	}
	size := c.width * c.height * 4
	id, err := unix.SysvShmGet(unix.IPC_PRIVATE, size, unix.IPC_CREAT|0o600)
	if err != nil {
		c.useShm = false
		return
	}
	// The agent runs as root, but on xrdp/GDM the X server that must attach
	// to this segment runs as the non-root session owner. Chown the segment
	// to that uid so root (agent) and the owner (X server) can both attach,
	// while other local users cannot read the framebuffer. Best-effort: if
	// this fails (or ownerUID is unknown), shm.AttachChecked below fails
	// cleanly and initShm falls back to the core-protocol capture path.
	if c.ownerUID > 0 && c.ownerUID <= math.MaxUint32 {
		var desc unix.SysvShmDesc
		if _, serr := unix.SysvShmCtl(id, unix.IPC_STAT, &desc); serr == nil {
			desc.Perm.Uid = uint32(c.ownerUID)
			_, _ = unix.SysvShmCtl(id, unix.IPC_SET, &desc)
		}
	}
	buf, err := unix.SysvShmAttach(id, 0, 0)
	if err != nil {
		_, _ = unix.SysvShmCtl(id, unix.IPC_RMID, nil)
		c.useShm = false
		return
	}
	seg, err := shm.NewSegId(c.x)
	if err != nil {
		_ = unix.SysvShmDetach(buf)
		_, _ = unix.SysvShmCtl(id, unix.IPC_RMID, nil)
		c.useShm = false
		return
	}
	if err := shm.AttachChecked(c.x, seg, uint32(id), false).Check(); err != nil {
		_ = unix.SysvShmDetach(buf)
		_, _ = unix.SysvShmCtl(id, unix.IPC_RMID, nil)
		c.useShm = false
		return
	}
	// Mark for deletion now; the segment persists until both ends detach.
	_, _ = unix.SysvShmCtl(id, unix.IPC_RMID, nil)
	c.useShm = true
	c.shmID = id
	c.shmBuf = buf
	c.shmSeg = seg
}

// Bounds returns the current root-window dimensions.
func (c *Conn) Bounds() (int, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.width, c.height
}

// XConn exposes the underlying connection for input/cursor/monitor helpers.
func (c *Conn) XConn() *xgb.Conn    { return c.x }
func (c *Conn) Root() xproto.Window { return c.root }

// CaptureBGRX grabs a full-screen frame. With SHM the pixels land in the shared
// segment (returned slice is owned by the Conn); the fallback allocates.
func (c *Conn) CaptureBGRX() ([]byte, int, int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	w, h := c.width, c.height
	if c.useShm {
		_, err := shm.GetImage(c.x, xproto.Drawable(c.root), 0, 0, uint16(w), uint16(h),
			0xffffffff, byte(xproto.ImageFormatZPixmap), c.shmSeg, 0).Reply()
		if err != nil {
			return nil, 0, 0, fmt.Errorf("shm getimage: %w", err)
		}
		return c.shmBuf[:w*h*4], w, h, nil
	}
	reply, err := xproto.GetImage(c.x, xproto.ImageFormatZPixmap, xproto.Drawable(c.root),
		0, 0, uint16(w), uint16(h), 0xffffffff).Reply()
	if err != nil {
		return nil, 0, 0, fmt.Errorf("getimage: %w", err)
	}
	return reply.Data, w, h, nil
}

// CaptureRegionBGRX grabs a sub-region via the core protocol (always allocates).
func (c *Conn) CaptureRegionBGRX(x, y, w, h int) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	reply, err := xproto.GetImage(c.x, xproto.ImageFormatZPixmap, xproto.Drawable(c.root),
		int16(x), int16(y), uint16(w), uint16(h), 0xffffffff).Reply()
	if err != nil {
		return nil, fmt.Errorf("getimage region: %w", err)
	}
	return reply.Data, nil
}

// Close detaches SHM and closes the X connection. Safe to call twice.
func (c *Conn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.useShm {
		_ = shm.Detach(c.x, c.shmSeg)
		_ = unix.SysvShmDetach(c.shmBuf)
		c.useShm = false
	}
	if c.x != nil {
		c.x.Close()
		c.x = nil
	}
	return nil
}
