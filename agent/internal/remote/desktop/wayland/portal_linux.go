//go:build linux

package wayland

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
)

// portalSession is one RemoteDesktop + ScreenCast share. GNOME rejects
// persist_mode on this session ("Remote desktop sessions cannot persist"),
// so every connect shows the share dialog again. Do not set persist_mode
// or restore_token.
type portalSession struct {
	conn    *dbus.Conn
	bus     dbus.BusObject
	session dbus.ObjectPath
	node    uint32
	pw      *os.File
	mu      sync.Mutex
}

func (s *portalSession) Close() {
	if s == nil {
		return
	}
	if s.session != "" && s.conn != nil {
		obj := s.conn.Object("org.freedesktop.portal.Desktop", s.session)
		_ = obj.Call("org.freedesktop.portal.Session.Close", 0).Err
	}
	if s.pw != nil {
		_ = s.pw.Close()
		s.pw = nil
	}
	if s.conn != nil {
		_ = s.conn.Close()
		s.conn = nil
	}
}

func (s *portalSession) input(c inputCmd) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == nil || s.session == "" {
		return
	}
	opts := map[string]dbus.Variant{}
	var err error
	switch c.Op {
	case "move":
		err = s.bus.Call("org.freedesktop.portal.RemoteDesktop.NotifyPointerMotionAbsolute", 0,
			s.session, opts, s.node, c.X, c.Y).Err
	case "button":
		err = s.bus.Call("org.freedesktop.portal.RemoteDesktop.NotifyPointerButton", 0,
			s.session, opts, c.Button, c.State).Err
	case "key":
		err = s.bus.Call("org.freedesktop.portal.RemoteDesktop.NotifyKeyboardKeycode", 0,
			s.session, opts, c.Code, c.State).Err
	case "scroll":
		err = s.bus.Call("org.freedesktop.portal.RemoteDesktop.NotifyPointerAxisDiscrete", 0,
			s.session, opts, c.Axis, c.Steps).Err
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "wayland-capture: input %s: %v\n", c.Op, err)
	}
}

type portalResult struct {
	results map[string]dbus.Variant
	err     error
}

type dispatcher struct {
	mu      sync.Mutex
	waiters map[dbus.ObjectPath]chan portalResult
	early   map[dbus.ObjectPath]portalResult
}

func newDispatcher() *dispatcher {
	return &dispatcher{
		waiters: map[dbus.ObjectPath]chan portalResult{},
		early:   map[dbus.ObjectPath]portalResult{},
	}
}

func (d *dispatcher) deliver(path dbus.ObjectPath, res portalResult) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if ch, ok := d.waiters[path]; ok {
		ch <- res
		return
	}
	d.early[path] = res
}

func (d *dispatcher) arm(path dbus.ObjectPath) chan portalResult {
	d.mu.Lock()
	defer d.mu.Unlock()
	ch := make(chan portalResult, 1)
	if res, ok := d.early[path]; ok {
		delete(d.early, path)
		ch <- res
	}
	d.waiters[path] = ch
	return ch
}

func handshake(ctx context.Context) (*portalSession, error) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, fmt.Errorf("session bus: %w", err)
	}
	if err := conn.AddMatchSignal(
		dbus.WithMatchInterface("org.freedesktop.portal.Request"),
		dbus.WithMatchMember("Response"),
		dbus.WithMatchSender("org.freedesktop.portal.Desktop"),
	); err != nil {
		_ = conn.Close()
		return nil, err
	}
	signals := make(chan *dbus.Signal, 16)
	conn.Signal(signals)
	disp := newDispatcher()
	go func() {
		for sig := range signals {
			if sig == nil || sig.Name != "org.freedesktop.portal.Request.Response" {
				continue
			}
			res, err := decodeResponse(sig)
			disp.deliver(sig.Path, portalResult{results: res, err: err})
		}
	}()

	bus := conn.Object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop")
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	s := &portalSession{conn: conn, bus: bus}

	fmt.Fprintf(os.Stderr, "wayland-capture: creating-session\n")
	created, err := portalCall(ctx, conn, disp, bus, "org.freedesktop.portal.RemoteDesktop.CreateSession", "create"+suffix, 15*time.Second,
		map[string]dbus.Variant{
			"session_handle_token": dbus.MakeVariant("breeze" + suffix),
			"handle_token":         dbus.MakeVariant("create" + suffix),
		})
	if err != nil {
		s.Close()
		return nil, fmt.Errorf("CreateSession: %w", err)
	}
	session, err := objectPathResult(created, "session_handle")
	if err != nil {
		s.Close()
		return nil, fmt.Errorf("CreateSession: %w", err)
	}
	s.session = session
	fmt.Fprintf(os.Stderr, "wayland-capture: session %s\n", session)

	fmt.Fprintf(os.Stderr, "wayland-capture: select-sources\n")
	if _, err := portalCall(ctx, conn, disp, bus, "org.freedesktop.portal.ScreenCast.SelectSources", "select"+suffix, 15*time.Second,
		session, map[string]dbus.Variant{
			"types":        dbus.MakeVariant(uint32(1)), // monitors
			"multiple":     dbus.MakeVariant(false),
			"cursor_mode":  dbus.MakeVariant(uint32(2)), // embed the cursor
			"handle_token": dbus.MakeVariant("select" + suffix),
		}); err != nil {
		s.Close()
		return nil, fmt.Errorf("SelectSources: %w", err)
	}

	fmt.Fprintf(os.Stderr, "wayland-capture: select-devices\n")
	if _, err := portalCall(ctx, conn, disp, bus, "org.freedesktop.portal.RemoteDesktop.SelectDevices", "devices"+suffix, 15*time.Second,
		session, map[string]dbus.Variant{
			"types":        dbus.MakeVariant(uint32(3)), // keyboard | pointer
			"handle_token": dbus.MakeVariant("devices" + suffix),
		}); err != nil {
		s.Close()
		return nil, fmt.Errorf("SelectDevices: %w", err)
	}

	fmt.Fprintf(os.Stderr, "wayland-capture: waiting-for-dialog\n")
	started, err := portalCall(ctx, conn, disp, bus, "org.freedesktop.portal.RemoteDesktop.Start", "start"+suffix, 60*time.Second,
		session, "", map[string]dbus.Variant{
			"handle_token": dbus.MakeVariant("start" + suffix),
		})
	if err != nil {
		s.Close()
		return nil, fmt.Errorf("Start: %w", err)
	}
	node, err := firstStream(started)
	if err != nil {
		s.Close()
		return nil, err
	}
	s.node = node
	fmt.Fprintf(os.Stderr, "wayland-capture: node %d\n", node)

	var fd dbus.UnixFD
	if err := bus.CallWithContext(ctx, "org.freedesktop.portal.ScreenCast.OpenPipeWireRemote", 0,
		session, map[string]dbus.Variant{}).Store(&fd); err != nil {
		s.Close()
		return nil, fmt.Errorf("OpenPipeWireRemote: %w", err)
	}
	s.pw = os.NewFile(uintptr(fd), "pipewire")
	if s.pw == nil {
		s.Close()
		return nil, fmt.Errorf("OpenPipeWireRemote returned a bad fd")
	}
	return s, nil
}

func portalCall(ctx context.Context, conn *dbus.Conn, disp *dispatcher, bus dbus.BusObject, method, token string, wait time.Duration, args ...any) (map[string]dbus.Variant, error) {
	predicted := requestPath(conn, token)
	ch := disp.arm(predicted)
	callCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	call := bus.CallWithContext(callCtx, method, 0, args...)
	if call.Err != nil {
		return nil, call.Err
	}
	var got dbus.ObjectPath
	if err := call.Store(&got); err != nil {
		return nil, err
	}
	if got != predicted {
		ch = disp.arm(got)
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, fmt.Errorf("timed out waiting for %s", method)
	case res := <-ch:
		return res.results, res.err
	}
}

func requestPath(conn *dbus.Conn, token string) dbus.ObjectPath {
	name := ""
	for _, n := range conn.Names() {
		if strings.HasPrefix(n, ":") {
			name = strings.TrimPrefix(n, ":")
			break
		}
	}
	name = strings.ReplaceAll(name, ".", "_")
	return dbus.ObjectPath("/org/freedesktop/portal/desktop/request/" + name + "/" + token)
}

func decodeResponse(sig *dbus.Signal) (map[string]dbus.Variant, error) {
	if len(sig.Body) < 2 {
		return nil, fmt.Errorf("short portal response")
	}
	var code uint32
	switch n := sig.Body[0].(type) {
	case uint32:
		code = n
	case int32:
		code = uint32(n)
	default:
		return nil, fmt.Errorf("portal response code type %T", sig.Body[0])
	}
	results, ok := sig.Body[1].(map[string]dbus.Variant)
	if !ok {
		return nil, fmt.Errorf("portal response results type %T", sig.Body[1])
	}
	if code == 1 {
		return nil, fmt.Errorf("user cancelled the portal dialog")
	}
	if code != 0 {
		return nil, fmt.Errorf("portal response code %d", code)
	}
	return results, nil
}

func objectPathResult(results map[string]dbus.Variant, key string) (dbus.ObjectPath, error) {
	v, ok := results[key]
	if !ok {
		return "", fmt.Errorf("missing %s", key)
	}
	switch p := v.Value().(type) {
	case dbus.ObjectPath:
		return p, nil
	case string:
		return dbus.ObjectPath(p), nil
	default:
		return "", fmt.Errorf("%s has type %T", key, v.Value())
	}
}

func firstStream(results map[string]dbus.Variant) (uint32, error) {
	v, ok := results["streams"]
	if !ok {
		return 0, fmt.Errorf("Start returned no streams")
	}
	var streams []struct {
		NodeID uint32
		Props  map[string]dbus.Variant
	}
	if err := dbus.Store([]any{v.Value()}, &streams); err != nil {
		return 0, fmt.Errorf("decode streams: %w (%T)", err, v.Value())
	}
	if len(streams) == 0 || streams[0].NodeID == 0 {
		return 0, fmt.Errorf("Start returned an empty stream list")
	}
	return streams[0].NodeID, nil
}
