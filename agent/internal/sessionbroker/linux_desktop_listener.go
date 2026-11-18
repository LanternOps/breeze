package sessionbroker

// Per-uid broker endpoints for the Linux per-session desktop helper (#12117).
//
// The shared socket is 0660 root:breeze, and a user manager started before
// the user joined that group keeps its old group list, so a helper spawned
// into it may not reach the shared socket at all. Root therefore opens one
// endpoint per target uid, /run/breeze/desktop/<uid>.sock, owned by that uid.
// The file mode is advisory (the owner can chmod it); what admits a peer is
// the kernel uid check, made before a byte is read, and then the spawn
// ticket. The endpoint admits nothing but a ticketed Linux desktop helper,
// and the shared socket no longer accepts a ticket at all.

import (
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

const (
	defaultLinuxDesktopSocketDir = "/run/breeze/desktop"
	// maxLinuxDesktopHandshakesPerUID bounds unauthenticated connections in
	// flight on one uid's endpoint; a further connection is closed unread.
	maxLinuxDesktopHandshakesPerUID = 2
	linuxDesktopEndpointDirMode     = 0o755
	linuxDesktopEndpointSocketMode  = 0o600
)

var (
	errLinuxDesktopEndpointUnsafe = errors.New("linux desktop endpoint path is not what root expects")
	errLinuxDesktopEndpointClosed = errors.New("broker is not accepting connections")
)

// linuxDesktopListener is one uid's endpoint.
type linuxDesktopListener struct {
	uid  uint32
	path string
	ln   net.Listener
	// dev/ino identify the socket file root created, so root never removes
	// a file it did not create.
	dev, ino uint64

	mu         sync.Mutex
	closed     bool
	handshakes int
	sessions   map[*Session]struct{}
}

func (l *linuxDesktopListener) tryBeginHandshake() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || l.handshakes >= maxLinuxDesktopHandshakesPerUID {
		return false
	}
	l.handshakes++
	return true
}

func (l *linuxDesktopListener) endHandshake() {
	l.mu.Lock()
	if l.handshakes > 0 {
		l.handshakes--
	}
	l.mu.Unlock()
}

// addSession records an admitted session; false once the endpoint closed,
// in which case the caller must not register the session.
func (l *linuxDesktopListener) addSession(s *Session) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return false
	}
	l.sessions[s] = struct{}{}
	return true
}

func (l *linuxDesktopListener) removeSession(s *Session) {
	l.mu.Lock()
	delete(l.sessions, s)
	l.mu.Unlock()
}

func (l *linuxDesktopListener) isClosed() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.closed
}

// shutdown stops accepting, removes the socket file root created, and
// returns the sessions admitted through it. Unlinking a socket does not end
// connections already made through it, so the caller closes those.
func (l *linuxDesktopListener) shutdown() []*Session {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil
	}
	l.closed = true
	sessions := make([]*Session, 0, len(l.sessions))
	for s := range l.sessions {
		sessions = append(sessions, s)
	}
	l.mu.Unlock()
	_ = l.ln.Close()
	if fi, err := os.Lstat(l.path); err == nil {
		if dev, ino, _, ok := fileIdentity(fi); ok && dev == l.dev && ino == l.ino {
			_ = os.Remove(l.path)
		}
	}
	return sessions
}

// stillOwnsPath reports whether the socket file at l.path is still the one
// root created for this listener.
func (l *linuxDesktopListener) stillOwnsPath() bool {
	if l.isClosed() {
		return false
	}
	fi, err := os.Lstat(l.path)
	if err != nil || fi.Mode()&os.ModeSocket == 0 {
		return false
	}
	dev, ino, _, ok := fileIdentity(fi)
	return ok && dev == l.dev && ino == l.ino
}

// linuxDesktopEndpointReject is the per-endpoint rule, checked once the auth
// request is read: the per-uid endpoint admits only a ticketed Linux desktop
// helper, and on Linux the shared socket admits no ticket and no logind
// session claim. "" means the request may proceed to admission.
func linuxDesktopEndpointReject(goos string, onDesktopEndpoint bool, role ipc.HelperRole, req ipc.AuthRequest) string {
	if onDesktopEndpoint {
		if role != ipc.HelperRoleUser || req.BinaryKind != ipc.HelperBinaryDesktopHelper || req.SpawnTicket == "" {
			return "this endpoint admits only a Linux desktop helper with a spawn ticket"
		}
		return ""
	}
	if goos == "linux" && (req.SpawnTicket != "" || req.LogindSessionID != "") {
		return "a spawn ticket is accepted only on the per-user desktop endpoint"
	}
	return ""
}

func (b *Broker) linuxDesktopDir() string {
	if b.linuxDesktopSocketDir != "" {
		return b.linuxDesktopSocketDir
	}
	return defaultLinuxDesktopSocketDir
}

// EnsureLinuxDesktopListener returns uid's endpoint, creating it when it
// does not exist or its socket file is no longer the one root created.
// Creation fails closed: an existing directory or path that is not exactly
// what root expects is refused, never followed, and only ever removed when
// it is a socket.
func (b *Broker) EnsureLinuxDesktopListener(uid uint32) (string, error) {
	if uid == 0 {
		return "", fmt.Errorf("%w: uid 0", errLinuxDesktopEndpointUnsafe)
	}
	b.linuxDesktopMu.Lock()
	if b.linuxDesktopClosed || b.acceptingStopped() {
		b.linuxDesktopMu.Unlock()
		return "", errLinuxDesktopEndpointClosed
	}
	var stale *linuxDesktopListener
	if l := b.linuxDesktopListeners[uid]; l != nil {
		if l.stillOwnsPath() {
			b.linuxDesktopMu.Unlock()
			return l.path, nil
		}
		delete(b.linuxDesktopListeners, uid)
		stale = l
	}
	// Replacing a listener closes the old one first, sessions included.
	if stale != nil {
		b.linuxDesktopMu.Unlock()
		// Only root can change this directory, so a vanished or swapped
		// socket file is worth an operator's attention.
		sessions := stale.shutdown()
		log.Warn("Linux desktop endpoint socket is no longer the one root created; replacing it",
			"uid", uid, "path", stale.path, "sessionsClosed", len(sessions))
		b.closeLinuxDesktopSessions(sessions)
		b.linuxDesktopMu.Lock()
		if b.linuxDesktopClosed || b.acceptingStopped() {
			b.linuxDesktopMu.Unlock()
			return "", errLinuxDesktopEndpointClosed
		}
		if l := b.linuxDesktopListeners[uid]; l != nil && l.stillOwnsPath() {
			b.linuxDesktopMu.Unlock()
			return l.path, nil
		}
	}
	defer b.linuxDesktopMu.Unlock()

	l, err := b.openLinuxDesktopListener(uid)
	if err != nil {
		return "", err
	}
	if b.linuxDesktopListeners == nil {
		b.linuxDesktopListeners = make(map[uint32]*linuxDesktopListener)
	}
	b.linuxDesktopListeners[uid] = l
	go b.acceptLinuxDesktop(l)
	log.Info("Linux desktop helper endpoint listening", "uid", uid, "path", l.path)
	return l.path, nil
}

// openLinuxDesktopListener creates the directory (if needed) and the socket.
// Caller holds linuxDesktopMu.
func (b *Broker) openLinuxDesktopListener(uid uint32) (*linuxDesktopListener, error) {
	dir := b.linuxDesktopDir()
	if err := b.ensureLinuxDesktopDir(dir); err != nil {
		return nil, err
	}
	path := linuxDesktopSocketPathFor(dir, uid)
	if fi, err := os.Lstat(path); err == nil {
		if fi.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("%w: %s exists and is not a socket", errLinuxDesktopEndpointUnsafe, path)
		}
		if err := os.Remove(path); err != nil {
			return nil, fmt.Errorf("remove stale endpoint %s: %w", path, err)
		}
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("stat %s: %w", path, err)
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("listen %s: %w", path, err)
	}
	if ul, ok := ln.(*net.UnixListener); ok {
		// Removal is root's decision (shutdown checks the inode), never a
		// side effect of Close.
		ul.SetUnlinkOnClose(false)
	}
	fail := func(err error) (*linuxDesktopListener, error) {
		_ = ln.Close()
		_ = os.Remove(path)
		return nil, err
	}
	if err := os.Chmod(path, linuxDesktopEndpointSocketMode); err != nil {
		return fail(fmt.Errorf("chmod %s: %w", path, err))
	}
	chown := b.linuxDesktopChown
	if chown == nil {
		chown = defaultLinuxDesktopChown
	}
	if err := chown(path, uid); err != nil {
		return fail(fmt.Errorf("chown %s to uid %d: %w", path, uid, err))
	}
	fi, err := os.Lstat(path)
	if err != nil || fi.Mode()&os.ModeSocket == 0 {
		return fail(fmt.Errorf("%w: %s changed after creation", errLinuxDesktopEndpointUnsafe, path))
	}
	dev, ino, _, ok := fileIdentity(fi)
	if !ok {
		return fail(fmt.Errorf("%w: cannot identify %s", errLinuxDesktopEndpointUnsafe, path))
	}
	return &linuxDesktopListener{
		uid: uid, path: path, ln: ln, dev: dev, ino: ino,
		sessions: make(map[*Session]struct{}),
	}, nil
}

// ensureLinuxDesktopDir creates dir 0755 owned by the daemon, or accepts an
// existing one only when it is exactly that. Never follows a symlink.
func (b *Broker) ensureLinuxDesktopDir(dir string) error {
	if err := os.Mkdir(dir, linuxDesktopEndpointDirMode); err == nil {
		// Mkdir is subject to the umask; set the exact mode.
		if err := os.Chmod(dir, linuxDesktopEndpointDirMode); err != nil {
			return fmt.Errorf("chmod %s: %w", dir, err)
		}
	} else if !os.IsExist(err) {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		return fmt.Errorf("stat %s: %w", dir, err)
	}
	if !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: %s is not a directory", errLinuxDesktopEndpointUnsafe, dir)
	}
	if fi.Mode()&(os.ModePerm|os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != linuxDesktopEndpointDirMode {
		return fmt.Errorf("%w: %s has mode %v", errLinuxDesktopEndpointUnsafe, dir, fi.Mode())
	}
	_, _, owner, ok := fileIdentity(fi)
	if !ok || owner != b.linuxDesktopDirOwner {
		return fmt.Errorf("%w: %s is not owned by uid %d", errLinuxDesktopEndpointUnsafe, dir, b.linuxDesktopDirOwner)
	}
	return nil
}

func (b *Broker) acceptLinuxDesktop(l *linuxDesktopListener) {
	for {
		conn, err := l.ln.Accept()
		if err != nil {
			if l.isClosed() || b.acceptingStopped() || errors.Is(err, net.ErrClosed) {
				return
			}
			log.Warn("Linux desktop endpoint accept error", "uid", l.uid, "error", err.Error())
			time.Sleep(100 * time.Millisecond) // e.g. EMFILE: do not spin
			continue
		}
		if !l.tryBeginHandshake() {
			log.Warn("Linux desktop endpoint: too many concurrent handshakes; closing connection unread", "uid", l.uid)
			_ = conn.Close()
			continue
		}
		if !b.startAcceptedConnectionFrom(conn, l) {
			l.endHandshake()
		}
	}
}

// CloseLinuxDesktopListener closes uid's endpoint and every session admitted
// through it.
func (b *Broker) CloseLinuxDesktopListener(uid uint32) {
	b.linuxDesktopMu.Lock()
	l := b.linuxDesktopListeners[uid]
	delete(b.linuxDesktopListeners, uid)
	b.linuxDesktopMu.Unlock()
	if l == nil {
		return
	}
	b.closeLinuxDesktopSessions(l.shutdown())
	log.Info("Linux desktop helper endpoint closed", "uid", uid)
}

// closeLinuxDesktopListenersForShutdown closes every endpoint and refuses
// new ones. Sessions are closed by Broker.Close with all the others.
func (b *Broker) closeLinuxDesktopListenersForShutdown() {
	b.linuxDesktopMu.Lock()
	b.linuxDesktopClosed = true
	listeners := make([]*linuxDesktopListener, 0, len(b.linuxDesktopListeners))
	for uid, l := range b.linuxDesktopListeners {
		listeners = append(listeners, l)
		delete(b.linuxDesktopListeners, uid)
	}
	b.linuxDesktopMu.Unlock()
	for _, l := range listeners {
		l.shutdown()
	}
}

func (b *Broker) closeLinuxDesktopSessions(sessions []*Session) {
	for _, s := range sessions {
		_ = s.Close()
	}
}
